import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { PicoConfig } from "../config/index.js";
import type { TtsAudioChunk } from "../modules/voice/index.js";
import type { VoicePlaybackSession, VoicePlaybackSink } from "./voice-playback.js";

const processTerminationGraceMs = 1_000;
const processKillGraceMs = 1_000;
const idleOperation = Promise.resolve();
const maximumFinalSilenceMs = 10_000;
const minimumPcmSampleRateHz = 8_000;
const maximumPcmSampleRateHz = 192_000;
const maximumPcmChannels = 8;
export const residentPlaybackFinalSilenceMs = 300;

export type ResidentAudioOutputPlan =
  | { readonly provider: "alsa"; readonly command: "aplay"; readonly device: string }
  | {
      readonly provider: "ffplay";
      readonly command: "ffplay";
      readonly route: "system_default";
    };

export type PlaybackCommandProbe = (
  command: string,
  arguments_: readonly string[],
  timeoutMs: number
) => Promise<void>;

export type ResidentContinuousPlaybackOptions = {
  readonly finalSilenceMs?: number;
};

type PlaybackChild = ChildProcessByStdio<Writable, Readable | null, null>;
type SpawnPlaybackProcess = (
  command: string,
  arguments_: readonly string[],
  options: { readonly stdio: ["pipe", "ignore", "inherit"] }
) => PlaybackChild;
type ProbeChild = Pick<ChildProcess, "kill" | "once" | "removeListener">;
type SpawnProbeProcess = (
  command: string,
  arguments_: readonly string[],
  options: { readonly stdio: "ignore" }
) => ProbeChild;

export function createResidentAudioOutputPlan(
  config: PicoConfig,
  platform: NodeJS.Platform = process.platform
): ResidentAudioOutputPlan {
  const output = config.voice.resident.audioOutput;
  if (output === undefined) {
    throw new Error("pico resident voice requires voice.resident.audioOutput config");
  }

  if (output.provider === "alsa") {
    requirePlaybackPlatform(platform, "linux", "pico resident voice ALSA output requires Linux");
    return { provider: "alsa", command: "aplay", device: output.device };
  }

  requirePlaybackPlatform(platform, "darwin", "pico resident voice ffplay output requires macOS");
  return { provider: "ffplay", command: "ffplay", route: output.route };
}

function requirePlaybackPlatform(
  platform: NodeJS.Platform,
  expected: NodeJS.Platform,
  message: string
): void {
  if (platform !== expected) throw new Error(message);
}

export function createResidentContinuousPlaybackSink(
  plan: ResidentAudioOutputPlan,
  spawnPlaybackProcess: SpawnPlaybackProcess = spawn,
  options: ResidentContinuousPlaybackOptions = {}
): VoicePlaybackSink {
  const finalSilenceMs = requireFinalSilenceMs(options.finalSilenceMs ?? 0);
  let active: ContinuousPlaybackSession | undefined;
  let closed = false;
  let lastStop = idleOperation;
  let closeOperation: Promise<void> | undefined;
  const release = (session: ContinuousPlaybackSession): void => {
    if (active === session) active = undefined;
  };
  const stop = (): Promise<void> => {
    if (active === undefined) return lastStop;
    lastStop = active.stop();
    return lastStop;
  };

  return {
    open(firstChunk, signal) {
      if (closed) throw new Error("pico resident voice playback sink is closed");
      if (active !== undefined) {
        throw new Error("pico resident voice playback is already active");
      }
      requireValidPcmChunk(firstChunk);
      if (signal?.aborted === true) {
        throw new Error(`pico resident voice ${plan.provider} output was aborted before startup`);
      }

      const child = spawnPlaybackProcess(plan.command, createPlaybackArguments(plan, firstChunk), {
        stdio: ["pipe", "ignore", "inherit"]
      });
      const session = new ContinuousPlaybackSession(
        plan,
        firstChunk,
        child,
        signal,
        release,
        finalSilenceMs
      );
      active = session;
      lastStop = idleOperation;
      return session;
    },
    stop,
    close() {
      if (closeOperation !== undefined) return closeOperation;
      closed = true;
      closeOperation = stop();
      return closeOperation;
    }
  };
}

class ContinuousPlaybackSession implements VoicePlaybackSession {
  readonly #plan: ResidentAudioOutputPlan;
  readonly #format: Pick<TtsAudioChunk, "encoding" | "sampleRateHz" | "channels">;
  readonly #child: PlaybackChild;
  readonly #stdin: Writable;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #release: (session: ContinuousPlaybackSession) => void;
  readonly #finalSilence: Uint8Array;
  readonly #operationController = new AbortController();
  readonly #closedOperation: Promise<void>;
  #resolveClosed: () => void = () => undefined;
  readonly #terminalOperation: Promise<void>;
  #resolveTerminal: () => void = () => undefined;
  #rejectTerminal: (error: Error) => void = () => undefined;
  #terminalFailure: Error | undefined;
  #writeTail = idleOperation;
  #pendingWrites = 0;
  #finishRequested = false;
  #inputEnded = false;
  #childClosed = false;
  #listenersCleaned = false;
  #stopRequested = false;
  #stopOperation: Promise<void> | undefined;
  #finishOperation: Promise<void> | undefined;

  constructor(
    plan: ResidentAudioOutputPlan,
    firstChunk: TtsAudioChunk,
    child: PlaybackChild,
    externalSignal: AbortSignal | undefined,
    release: (session: ContinuousPlaybackSession) => void,
    finalSilenceMs: number
  ) {
    this.#plan = plan;
    this.#format = firstChunk;
    this.#child = child;
    this.#stdin = child.stdin;
    this.#externalSignal = externalSignal;
    this.#release = release;
    this.#finalSilence = createPcm16Silence(firstChunk, finalSilenceMs);
    this.#closedOperation = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#terminalOperation = new Promise<void>((resolve, reject) => {
      this.#resolveTerminal = resolve;
      this.#rejectTerminal = reject;
    });
    void this.#terminalOperation.catch(() => undefined);
    child.once("error", this.#onChildError);
    child.once("exit", this.#onChildExit);
    child.once("close", this.#onChildClose);
    this.#stdin.once("error", this.#onStdinError);
    externalSignal?.addEventListener("abort", this.#onExternalAbort, { once: true });
  }

  write(chunk: TtsAudioChunk): Promise<void> {
    const stateFailure = this.#writeStateFailure();
    if (stateFailure !== undefined) return Promise.reject(stateFailure);
    const formatFailure = validateWrittenChunk(this.#format, chunk);
    if (formatFailure !== undefined) return Promise.reject(formatFailure);

    this.#pendingWrites += 1;
    const operation = this.#writeTail
      .then(() => this.#writeAudio(chunk.audio))
      .then(undefined, (error: unknown) => {
        const writeError = asError(error);
        this.#recordFailure(writeError);
        throw writeError;
      });
    const tracked = operation.then(
      () => {
        this.#pendingWrites -= 1;
      },
      (error: unknown) => {
        this.#pendingWrites -= 1;
        throw error;
      }
    );
    this.#writeTail = tracked.then(
      () => undefined,
      () => undefined
    );
    return tracked;
  }

  finish(): Promise<void> {
    if (this.#finishOperation !== undefined) return this.#finishOperation;
    this.#finishRequested = true;
    this.#finishOperation =
      this.#pendingWrites === 0
        ? this.#writeFinalSilenceAndEnd()
        : this.#writeTail.then(() => this.#writeFinalSilenceAndEnd());
    return this.#finishOperation;
  }

  stop(): Promise<void> {
    if (this.#stopOperation !== undefined) return this.#stopOperation;
    this.#stopRequested = true;
    this.#recordFailure(
      new Error(`pico resident voice ${this.#plan.provider} output playback was stopped`)
    );
    if (!this.#childClosed) this.#child.kill("SIGTERM");
    this.#stopOperation = stopPlaybackChild(
      this.#child,
      this.#closedOperation,
      `pico resident voice ${this.#plan.provider} output`
    ).then(
      () => undefined,
      (error: unknown) => {
        const stopError = asError(error);
        this.#forceTerminal(stopError);
        throw stopError;
      }
    );
    return this.#stopOperation;
  }

  readonly #onChildError = (error: Error): void => {
    this.#recordFailure(error);
  };

  readonly #onStdinError = (error: Error): void => {
    this.#recordFailure(error);
  };

  readonly #onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!isSuccessfulExit(code, signal) && !this.#stopRequested) {
      this.#recordFailure(createExitError(this.#plan.provider, code, signal));
    }
  };

  readonly #onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!isSuccessfulExit(code, signal) && !this.#stopRequested) {
      this.#recordFailure(createExitError(this.#plan.provider, code, signal));
    }
    if (isSuccessfulExit(code, signal) && !this.#inputEnded && !this.#stopRequested) {
      this.#recordFailure(
        new Error(`pico resident voice ${this.#plan.provider} output closed before input ended`)
      );
    }
    this.#childClosed = true;
    this.#cleanUpListeners();
    this.#resolveClosed();
    if (this.#terminalFailure === undefined) this.#resolveTerminal();
    else this.#rejectTerminal(this.#terminalFailure);
    this.#release(this);
  };

  readonly #onExternalAbort = (): void => {
    void this.stop().catch(() => undefined);
  };

  #writeStateFailure(): Error | undefined {
    if (this.#terminalFailure !== undefined) return this.#terminalFailure;
    if (this.#finishRequested) {
      return new Error(`pico resident voice ${this.#plan.provider} output input has ended`);
    }
    if (this.#childClosed) {
      return new Error(`pico resident voice ${this.#plan.provider} output is closed`);
    }
    return undefined;
  }

  #writeAudio(audio: Uint8Array): Promise<void> {
    const failure = this.#queuedWriteFailure();
    if (failure !== undefined) return Promise.reject(failure);
    const accepted = this.#stdin.write(audio);
    if (accepted) return Promise.resolve();
    return waitForDrain(this.#stdin, this.#operationController.signal, () =>
      this.#writeStateFailure()
    );
  }

  #endInputAndWait(): Promise<void> {
    if (this.#childClosed) return this.#terminalOperation;
    this.#inputEnded = true;
    const inputEnding = new Promise<void>((resolve) => {
      this.#stdin.end();
      resolve();
    });
    return inputEnding.then(
      () => this.#terminalOperation,
      (error: unknown) => {
        this.#recordFailure(asError(error));
        return this.#terminalOperation;
      }
    );
  }

  async #writeFinalSilenceAndEnd(): Promise<void> {
    if (this.#finalSilence.byteLength > 0) {
      try {
        await this.#writeAudio(this.#finalSilence);
      } catch (error) {
        this.#recordFailure(asError(error));
      }
    }

    return this.#endInputAndWait();
  }

  #queuedWriteFailure(): Error | undefined {
    if (this.#terminalFailure !== undefined) return this.#terminalFailure;
    if (this.#childClosed) {
      return new Error(`pico resident voice ${this.#plan.provider} output is closed`);
    }
    return undefined;
  }

  #recordFailure(error: Error): void {
    if (this.#terminalFailure !== undefined) return;
    this.#terminalFailure = error;
    this.#operationController.abort(error);
  }

  #forceTerminal(error: Error): void {
    if (this.#childClosed) return;
    this.#terminalFailure = error;
    this.#operationController.abort(error);
    this.#childClosed = true;
    this.#stdin.destroy();
    this.#cleanUpListeners();
    this.#resolveClosed();
    this.#rejectTerminal(error);
    this.#release(this);
  }

  #cleanUpListeners(): void {
    if (this.#listenersCleaned) return;
    this.#listenersCleaned = true;
    this.#child.removeListener("error", this.#onChildError);
    this.#child.removeListener("exit", this.#onChildExit);
    this.#child.removeListener("close", this.#onChildClose);
    this.#stdin.removeListener("error", this.#onStdinError);
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
  }
}

function requireFinalSilenceMs(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximumFinalSilenceMs) {
    throw new Error(
      `pico resident voice finalSilenceMs must be an integer from 0 to ${String(maximumFinalSilenceMs)}`
    );
  }

  return value;
}

function createPcm16Silence(
  format: Pick<TtsAudioChunk, "sampleRateHz" | "channels">,
  durationMs: number
): Uint8Array {
  const frames = Math.round((format.sampleRateHz * durationMs) / 1_000);
  return new Uint8Array(frames * format.channels * 2);
}

function waitForDrain(
  stdin: Writable,
  signal: AbortSignal,
  currentFailure: () => Error | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanUp = (): void => {
      stdin.removeListener("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanUp();
      resolve();
    };
    const onAbort = (): void => {
      cleanUp();
      reject(currentFailure() ?? new Error("pico resident voice playback write was aborted"));
    };
    stdin.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateWrittenChunk(
  format: Pick<TtsAudioChunk, "encoding" | "sampleRateHz" | "channels">,
  chunk: TtsAudioChunk
): Error | undefined {
  const encoding: string = chunk.encoding;
  const expectedEncoding: string = format.encoding;
  if (
    encoding !== expectedEncoding ||
    chunk.sampleRateHz !== format.sampleRateHz ||
    chunk.channels !== format.channels
  ) {
    return new Error("pico resident voice playback chunk format does not match the open session");
  }
  return pcmChunkError(chunk);
}

function requireValidPcmChunk(chunk: TtsAudioChunk): void {
  const error = pcmChunkError(chunk);
  if (error !== undefined) throw error;
}

function pcmChunkError(chunk: TtsAudioChunk): Error | undefined {
  const invalid =
    !hasValidPcmFormat(chunk) || !hasValidPcmAudio(chunk) || !hasValidChunkMetadata(chunk);
  return invalid
    ? new Error("pico resident voice playback received an invalid PCM chunk")
    : undefined;
}

function hasValidPcmFormat(chunk: TtsAudioChunk): boolean {
  const encoding: string = chunk.encoding;
  return (
    encoding === "pcm16le" &&
    Number.isInteger(chunk.sampleRateHz) &&
    chunk.sampleRateHz >= minimumPcmSampleRateHz &&
    chunk.sampleRateHz <= maximumPcmSampleRateHz &&
    Number.isInteger(chunk.channels) &&
    chunk.channels > 0 &&
    chunk.channels <= maximumPcmChannels
  );
}

function hasValidPcmAudio(chunk: TtsAudioChunk): boolean {
  const audio: unknown = chunk.audio;
  return (
    audio instanceof Uint8Array &&
    audio.byteLength > 0 &&
    audio.byteLength % (chunk.channels * 2) === 0
  );
}

function hasValidChunkMetadata(chunk: TtsAudioChunk): boolean {
  return (
    Number.isInteger(chunk.sentenceIndex) &&
    chunk.sentenceIndex >= 0 &&
    Number.isFinite(chunk.durationMs) &&
    chunk.durationMs > 0
  );
}

function createPlaybackArguments(
  plan: ResidentAudioOutputPlan,
  chunk: TtsAudioChunk
): readonly string[] {
  return plan.provider === "ffplay"
    ? [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(chunk.sampleRateHz),
        "-ch_layout",
        `${String(chunk.channels)}c`,
        "-i",
        "pipe:0"
      ]
    : [
        "-q",
        "-f",
        "S16_LE",
        "-r",
        String(chunk.sampleRateHz),
        "-c",
        String(chunk.channels),
        "-t",
        "raw",
        "-D",
        plan.device
      ];
}

function isSuccessfulExit(code: number | null, signal: NodeJS.Signals | null | undefined): boolean {
  return code === 0 && (signal === undefined || signal === null);
}

function createExitError(
  provider: ResidentAudioOutputPlan["provider"],
  code: number | null,
  signal: NodeJS.Signals | null | undefined
): Error {
  return new Error(
    `pico resident voice ${provider} output exited with code ${String(code)} signal ${String(signal)}`
  );
}

async function stopPlaybackChild(
  child: Pick<PlaybackChild, "kill">,
  closed: Promise<void>,
  label: string
): Promise<void> {
  if (await settlesWithin(closed, processTerminationGraceMs)) return;
  child.kill("SIGKILL");
  if (await settlesWithin(closed, processKillGraceMs)) return;
  throw new Error(`${label} did not stop after SIGKILL`);
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  return Promise.race([operation.then(() => true), timedOut]).then((settled) => {
    if (timeout !== undefined) clearTimeout(timeout);
    return settled;
  });
}

export async function assertResidentPlaybackReadiness(
  plan: ResidentAudioOutputPlan,
  run: PlaybackCommandProbe = runPlaybackCommandProbe
): Promise<void> {
  await run(plan.command, plan.provider === "ffplay" ? ["-version"] : ["--version"], 5_000);
}

export function runPlaybackCommandProbe(
  command: string,
  arguments_: readonly string[],
  timeoutMs: number,
  spawnProbeProcess: SpawnProbeProcess = spawn
): Promise<void> {
  let spawned = false;
  const probing = new Promise<void>((resolve, reject) => {
    const child = spawnProbeProcess(command, arguments_, { stdio: "ignore" });
    spawned = true;
    void observePlaybackCommand(child, command, timeoutMs).then(resolve, reject);
  });
  return probing.then(
    () => undefined,
    (error: unknown) => {
      if (!spawned) throw unavailableCommandError(command, error);
      throw error;
    }
  );
}

function observePlaybackCommand(
  child: ProbeChild,
  command: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let finalTimeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutError = new Error(
      `pico resident playback command ${command} timed out after ${String(timeoutMs)}ms`
    );
    const cleanUp = (): void => {
      clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      if (finalTimeout !== undefined) clearTimeout(finalTimeout);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const settleTimeout = (): void => {
      cleanUp();
      reject(timeoutError);
    };
    const onError = (error: Error): void => {
      cleanUp();
      reject(timedOut ? timeoutError : unavailableCommandError(command, error));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanUp();
      if (timedOut) reject(timeoutError);
      else if (isSuccessfulExit(code, signal)) resolve();
      else reject(commandExitError(command, code, signal));
    };
    child.once("error", onError);
    child.once("close", onClose);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        finalTimeout = setTimeout(settleTimeout, processKillGraceMs);
        finalTimeout.unref();
      }, processTerminationGraceMs);
      killTimeout.unref();
    }, timeoutMs);
    timeout.unref();
  });
}

function unavailableCommandError(command: string, cause: unknown): Error {
  return new Error(`pico resident playback command ${command} is unavailable`, { cause });
}

function commandExitError(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null
): Error {
  return new Error(
    `pico resident playback command ${command} exited with code ${String(code)} signal ${String(signal)}`
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
