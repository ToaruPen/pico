import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { PicoMacKey } from "../config/index.js";
import type { VoicePcmFrame } from "../modules/voice/echo-control.js";
import type { ResidentAudioCapture, ResidentCaptureSession } from "./resident-audio-io.js";
import {
  encodeResidentIoMessage,
  type ResidentIoControlResult,
  ResidentIoDecoder,
  type ResidentIoMessage
} from "./resident-io-protocol.js";

export type MacOSResidentIoProcess = EventEmitter & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

export type MacOSResidentIoControlEvent = {
  readonly kind: "talk_pressed" | "talk_released" | "cancel_pressed";
  readonly physicalTimestampNanoseconds: string;
};

export type MacOSResidentIoControlOutcome = {
  readonly result: ResidentIoControlResult;
  readonly generation?: number;
};

export type MacOSResidentIoBridge = {
  readonly audioCapture: ResidentAudioCapture;
  readonly completion: Promise<void>;
  readonly suppressCapture: () => Promise<void>;
  readonly resumeCapture: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export type StartMacOSResidentIoBridgeOptions = {
  readonly input: {
    readonly deviceUid: string;
    readonly sampleRateHz: number;
    readonly channels: number;
    readonly frameMs: number;
    readonly releaseTailMs: number;
    readonly talkKey: PicoMacKey;
    readonly cancelKey: PicoMacKey;
  };
  readonly handleControl: (
    event: MacOSResidentIoControlEvent
  ) => MacOSResidentIoControlOutcome | Promise<MacOSResidentIoControlOutcome>;
  readonly handleTailComplete: (generation: number) => void | Promise<void>;
  readonly handleCaptureInvalidated?: (generation: number) => void | Promise<void>;
  readonly observeHealth?: (
    event: Extract<ResidentIoMessage, { kind: "health_event" }>
  ) => void | Promise<void>;
  readonly observeTiming?: (event: Extract<ResidentIoMessage, { kind: "timing_event" }>) => void;
  readonly observeUnexpectedPcmFrame?: () => void;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly readyTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly controlResultTimeoutMs?: number;
  readonly executablePath?: string;
  readonly spawnProcess?: (
    executable: string,
    arguments_: readonly string[]
  ) => MacOSResidentIoProcess;
  readonly now?: () => string;
};

const maximumDiagnosticBytes = 8_192;
const maximumPendingPcmFrames = 128;
const maximumLateCommandAcknowledgements = 64;
const controlResultWriteTimeoutMs = 400;
const terminationGraceMs = 1_000;
const terminationKillTimeoutMs = 1_000;

export function resolveMacOSResidentIoExecutablePath(): string {
  return fileURLToPath(
    new URL(
      "../../sidecars/macos-resident-io/.build/release/pico-macos-resident-io",
      import.meta.url
    )
  );
}

export async function startMacOSResidentIoBridge(
  options: StartMacOSResidentIoBridgeOptions
): Promise<MacOSResidentIoBridge> {
  validateStartup(options);
  const child = createProcess(options);
  const decoder = new ResidentIoDecoder();
  const capture = new NativeResidentAudioCapture(writeMessage);
  const now = options.now ?? (() => new Date().toISOString());
  const pendingCommands = new Map<
    number,
    {
      readonly kind: "suppress_capture" | "resume_capture";
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    }
  >();
  const lateCommandAcknowledgements = new Map<number, "suppress_capture" | "resume_capture">();
  let nextCommandId = 1;
  let diagnostics = "";
  let processing = Promise.resolve();
  let readySettled = false;
  let stopping = false;
  let closed = false;
  let processFailure: Error | undefined;
  let terminationOperation: Promise<void> | undefined;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  async function writeMessage(message: ResidentIoMessage): Promise<void> {
    if (closed) {
      throw new Error("pico macOS resident I/O process is closed");
    }
    const bytes = encodeResidentIoMessage(message);
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(bytes, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  const fail = (error: Error): void => {
    processFailure ??= error;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!stopping) {
      child.kill("SIGTERM");
    }
  };

  // The protocol owner handles each closed message variant in one ordered dispatch point.
  // eslint-disable-next-line complexity
  const handleMessage = async (message: ResidentIoMessage): Promise<void> => {
    switch (message.kind) {
      case "ready":
        if (readySettled) {
          throw new Error("pico macOS resident I/O emitted duplicate ready");
        }
        requireReadyFormat(message, options.input);
        readySettled = true;
        resolveReady();
        return;
      case "control_event": {
        const outcome = await options.handleControl({
          kind: message.controlKind,
          physicalTimestampNanoseconds: message.eventTimestampNanoseconds
        });
        await withTimeout(
          writeMessage({
            kind: "control_result",
            sequence: message.sequence,
            result: outcome.result,
            ...(outcome.generation === undefined ? {} : { generation: outcome.generation })
          }),
          options.controlResultTimeoutMs ?? controlResultWriteTimeoutMs,
          "pico macOS resident I/O control result write timed out"
        );
        return;
      }
      case "pcm_frame":
        if (!capture.receive(message, now())) {
          options.observeUnexpectedPcmFrame?.();
        }
        return;
      case "tail_complete":
        capture.completeTail(message.generation);
        await options.handleTailComplete(message.generation);
        return;
      case "suppress_capture":
      case "resume_capture":
        settleCommandAcknowledgement(message, pendingCommands, lateCommandAcknowledgements);
        return;
      case "health_event":
        await options.observeHealth?.(message);
        return;
      case "timing_event":
        options.observeTiming?.(message);
        return;
      case "cancel_generation":
        await options.handleCaptureInvalidated?.(message.generation);
        return;
      case "fatal":
        throw new Error(`pico macOS resident I/O failed: ${message.code}`);
      case "control_result":
      case "shutdown":
        throw new Error(`pico macOS resident I/O emitted unexpected ${message.kind}`);
    }
  };

  const onStdout = (chunk: Buffer | string): void => {
    try {
      decoder.append(Buffer.from(chunk));
      for (let message = decoder.next(); message !== undefined; message = decoder.next()) {
        processing = processing.then(() => handleMessage(message));
      }
      void processing.catch((error: unknown) => fail(asError(error)));
    } catch (error) {
      fail(asError(error));
    }
  };
  const onStderr = (chunk: Buffer | string): void => {
    if (diagnostics.length >= maximumDiagnosticBytes) return;
    diagnostics += Buffer.from(chunk)
      .toString("utf8")
      .slice(0, maximumDiagnosticBytes - diagnostics.length);
  };
  const onError = (error: Error): void => {
    fail(new Error(`pico macOS resident I/O process failed: ${error.message}`, { cause: error }));
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    closed = true;
    const finalize = (): void => {
      const unexpected =
        processFailure ??
        (!stopping
          ? new Error(
              `pico macOS resident I/O exited unexpectedly (${formatExit(code, signal)})${formatDiagnostics(diagnostics)}`
            )
          : undefined);
      capture.failAll(unexpected);
      rejectPendingCommands(
        pendingCommands,
        unexpected ?? new Error("pico macOS resident I/O process closed")
      );
      cleanup();
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          unexpected ??
            new Error(
              `pico macOS resident I/O exited before ready (${formatExit(code, signal)})${formatDiagnostics(diagnostics)}`
            )
        );
      }
      if (unexpected === undefined) resolveCompletion();
      else rejectCompletion(unexpected);
    };
    void processing.then(finalize, finalize);
  };
  const onAbort = (): void => {
    void terminate().catch(() => undefined);
  };
  const cleanup = (): void => {
    options.signal?.removeEventListener("abort", onAbort);
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
    child.off("error", onError);
    child.off("close", onClose);
  };

  async function sendBoundary(kind: "suppress_capture" | "resume_capture"): Promise<void> {
    const commandId = nextCommandId;
    nextCommandId += 1;
    let resolveAcknowledgement: () => void = () => undefined;
    let rejectAcknowledgement: (error: Error) => void = () => undefined;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve;
      rejectAcknowledgement = reject;
    });
    pendingCommands.set(commandId, {
      kind,
      resolve: resolveAcknowledgement,
      reject: rejectAcknowledgement
    });
    const timeoutMessage = `pico macOS resident I/O ${kind} acknowledgement timed out`;
    try {
      await writeMessage({ kind, commandId });
      await withTimeout(acknowledgement, options.commandTimeoutMs ?? 1_000, timeoutMessage);
    } catch (error) {
      if (error instanceof Error && error.message === timeoutMessage) {
        rememberLateCommandAcknowledgement(lateCommandAcknowledgements, commandId, kind);
      }
      throw error;
    } finally {
      pendingCommands.delete(commandId);
    }
  }

  function terminate(): Promise<void> {
    if (terminationOperation !== undefined) return terminationOperation;
    stopping = true;
    terminationOperation = (async () => {
      if (!closed) {
        await writeMessage({ kind: "shutdown" }).catch(() => undefined);
        child.kill("SIGTERM");
      }
      if (await settlesWithin(completion, terminationGraceMs)) return completion;
      child.kill("SIGKILL");
      if (await settlesWithin(completion, terminationKillTimeoutMs)) return completion;
      throw new Error("pico macOS resident I/O did not stop after SIGKILL");
    })();
    return terminationOperation;
  }

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.once("error", onError);
  child.once("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  await withTimeout(
    ready,
    options.readyTimeoutMs ?? 5_000,
    "pico macOS resident I/O did not become ready before timeout"
  ).catch(async (error: unknown) => {
    await terminate().catch(() => undefined);
    throw error;
  });

  return {
    audioCapture: capture,
    completion,
    suppressCapture: () => sendBoundary("suppress_capture"),
    resumeCapture: () => sendBoundary("resume_capture"),
    close: terminate
  };
}

class NativeResidentAudioCapture implements ResidentAudioCapture {
  readonly #write: (message: ResidentIoMessage) => Promise<void>;
  #active: NativeCaptureSession | undefined;

  constructor(write: (message: ResidentIoMessage) => Promise<void>) {
    this.#write = write;
  }

  start(signal: AbortSignal, generationId?: number): ResidentCaptureSession {
    if (generationId === undefined) {
      throw new Error("pico macOS resident I/O capture requires a generation");
    }
    if (this.#active !== undefined) {
      throw new Error("pico macOS resident I/O capture is already active");
    }
    const session = new NativeCaptureSession(generationId, signal, this.#write, () => {
      if (this.#active === session) this.#active = undefined;
    });
    this.#active = session;
    return session;
  }

  receive(message: Extract<ResidentIoMessage, { kind: "pcm_frame" }>, capturedAt: string): boolean {
    return this.#active?.receive(message, capturedAt) ?? false;
  }

  completeTail(generation: number): void {
    this.#active?.completeTail(generation);
  }

  failAll(error: Error | undefined): void {
    this.#active?.fail(error ?? new Error("pico macOS resident I/O capture ended"));
  }

  async close(): Promise<void> {
    await this.#active?.stop();
  }
}

class NativeCaptureSession implements ResidentCaptureSession {
  readonly frames: AsyncIterable<VoicePcmFrame>;
  readonly #generation: number;
  readonly #signal: AbortSignal;
  readonly #write: (message: ResidentIoMessage) => Promise<void>;
  readonly #channel = new AsyncFrameChannel();
  readonly #onClose: () => void;
  #closed = false;
  #frameIndex = 0;

  constructor(
    generation: number,
    signal: AbortSignal,
    write: (message: ResidentIoMessage) => Promise<void>,
    onClose: () => void
  ) {
    this.#generation = generation;
    this.#signal = signal;
    this.#write = write;
    this.#onClose = onClose;
    this.frames = this.#channel;
    signal.addEventListener("abort", this.#abort, { once: true });
  }

  receive(message: Extract<ResidentIoMessage, { kind: "pcm_frame" }>, capturedAt: string): boolean {
    if (this.#closed || message.generation !== this.#generation) return false;
    this.#frameIndex += 1;
    try {
      this.#channel.send({
        id: `avaudioengine-mic-${String(this.#frameIndex)}`,
        direction: "near_end",
        audio: new Uint8Array(message.audio),
        encoding: "pcm16le",
        sampleRateHz: message.sampleRateHz,
        channels: message.channels,
        capturedAt,
        durationMs: (message.frameCount / message.sampleRateHz) * 1_000
      });
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
    return true;
  }

  completeTail(generation: number): void {
    if (generation === this.#generation) this.#finish();
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    this.#channel.fail(error);
    this.#onClose();
  }

  stop = async (): Promise<void> => {
    if (this.#closed) return;
    await this.#write({ kind: "cancel_generation", generation: this.#generation });
    this.#finish();
  };

  readonly #abort = (): void => {
    void this.stop().catch((error: unknown) => this.fail(asError(error)));
  };

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    this.#channel.finish();
    this.#onClose();
  }
}

class AsyncFrameChannel implements AsyncIterable<VoicePcmFrame> {
  readonly #pending: VoicePcmFrame[] = [];
  readonly #waiters: Array<{
    readonly resolve: (value: IteratorResult<VoicePcmFrame>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #finished = false;
  #failure: Error | undefined;
  #claimed = false;

  send(frame: VoicePcmFrame): void {
    if (this.#finished || this.#failure !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: frame });
      return;
    }
    if (this.#pending.length >= maximumPendingPcmFrames) {
      const error = new Error(
        `pico macOS resident PCM backlog exceeded ${String(maximumPendingPcmFrames)} frames (resident_pcm_backlog)`
      );
      this.fail(error);
      throw error;
    }
    this.#pending.push(frame);
  }

  finish(): void {
    this.#finished = true;
    this.#settleWaiters();
  }

  fail(error: Error): void {
    if (this.#failure !== undefined || this.#finished) return;
    this.#failure = error;
    this.#pending.splice(0);
    this.#settleWaiters();
  }

  [Symbol.asyncIterator](): AsyncIterator<VoicePcmFrame> {
    if (this.#claimed) throw new Error("pico macOS resident I/O frames can only be consumed once");
    this.#claimed = true;
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<VoicePcmFrame>> {
    const frame = this.#pending.shift();
    if (frame !== undefined) return Promise.resolve({ done: false, value: frame });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#finished) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #settleWaiters(): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#failure === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(this.#failure);
    }
  }
}

function settleCommandAcknowledgement(
  message: Extract<ResidentIoMessage, { kind: "suppress_capture" | "resume_capture" }>,
  pending: Map<
    number,
    {
      readonly kind: "suppress_capture" | "resume_capture";
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    }
  >,
  late: Map<number, "suppress_capture" | "resume_capture">
): void {
  const command = pending.get(message.commandId);
  if (command === undefined) {
    if (late.get(message.commandId) === message.kind) {
      late.delete(message.commandId);
      return;
    }
    throw new Error(`pico macOS resident I/O emitted an unmatched ${message.kind} acknowledgement`);
  }
  if (command.kind !== message.kind) {
    throw new Error(`pico macOS resident I/O emitted an unmatched ${message.kind} acknowledgement`);
  }
  pending.delete(message.commandId);
  command.resolve();
}

function rememberLateCommandAcknowledgement(
  late: Map<number, "suppress_capture" | "resume_capture">,
  commandId: number,
  kind: "suppress_capture" | "resume_capture"
): void {
  if (late.size >= maximumLateCommandAcknowledgements) {
    const oldest = late.keys().next().value;
    if (oldest !== undefined) late.delete(oldest);
  }
  late.set(commandId, kind);
}

function rejectPendingCommands(
  pending: Map<number, { readonly reject: (error: Error) => void }>,
  error: Error
): void {
  for (const command of pending.values()) {
    command.reject(error);
  }
  pending.clear();
}

function validateStartup(options: StartMacOSResidentIoBridgeOptions): void {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("pico macOS resident I/O bridge requires macOS");
  }
  if (options.signal?.aborted) {
    throw new Error("pico macOS resident I/O bridge startup was aborted");
  }
}

function createProcess(options: StartMacOSResidentIoBridgeOptions): MacOSResidentIoProcess {
  const executable = options.executablePath ?? resolveMacOSResidentIoExecutablePath();
  const arguments_ = buildArguments(options.input);
  return (options.spawnProcess ?? spawnResidentIoProcess)(executable, arguments_);
}

function spawnResidentIoProcess(
  executable: string,
  arguments_: readonly string[]
): MacOSResidentIoProcess {
  return spawn(executable, arguments_, {
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable> as MacOSResidentIoProcess;
}

function buildArguments(input: StartMacOSResidentIoBridgeOptions["input"]): readonly string[] {
  return [
    "--device-uid",
    input.deviceUid,
    "--sample-rate-hz",
    String(input.sampleRateHz),
    "--channels",
    String(input.channels),
    "--frame-ms",
    String(input.frameMs),
    "--release-tail-ms",
    String(input.releaseTailMs),
    "--talk-key",
    input.talkKey,
    "--cancel-key",
    input.cancelKey
  ];
}

function requireReadyFormat(
  message: Extract<ResidentIoMessage, { kind: "ready" }>,
  input: StartMacOSResidentIoBridgeOptions["input"]
): void {
  if (message.sampleRateHz !== input.sampleRateHz || message.channels !== input.channels) {
    throw new Error("pico macOS resident I/O ready format does not match configured PCM format");
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
  });
  return Promise.race([operation, expired]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  try {
    await withTimeout(operation, timeoutMs, "timeout");
    return true;
  } catch {
    return false;
  }
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${signal ?? "unknown"}` : `code ${String(code)}`;
}

function formatDiagnostics(value: string): string {
  const normalized = value.trim();
  return normalized === "" ? "" : `: ${normalized}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
