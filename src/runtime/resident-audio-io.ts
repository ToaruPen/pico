import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { PicoConfig } from "../config/index.js";
import type { VoicePcmFrame } from "../modules/voice/echo-control.js";
import type { TtsAudioChunk } from "../modules/voice/index.js";
import type { VoicePlaybackSink } from "./voice-resident.js";

type Platform = NodeJS.Platform;

export type Pcm16leAudioLevel = {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly rmsDb: number;
  readonly peakDb: number;
};

export type ResidentAudioInputLevelOptions = {
  readonly captureMs: number;
  readonly minimumRmsDb: number;
  readonly timeoutMs?: number;
};

export type ResidentAudioInputLevel = Pcm16leAudioLevel & {
  readonly provider: ResidentAudioInputPlan["provider"];
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly capturedMs: number;
  readonly signalDetected: boolean;
};

export type ResidentAudioInputPlan =
  | {
      readonly provider: "alsa";
      readonly command: "arecord";
      readonly args: readonly string[];
      readonly frameByteLength: number;
      readonly frameIdPrefix: "alsa-mic";
    }
  | {
      readonly provider: "avfoundation";
      readonly command: "ffmpeg";
      readonly args: readonly string[];
      readonly frameByteLength: number;
      readonly frameIdPrefix: "avfoundation-mic";
    };

export type ResidentAudioOutputPlan =
  | {
      readonly provider: "alsa";
      readonly command: "aplay";
      readonly device: string;
    }
  | {
      readonly provider: "afplay";
      readonly command: "afplay";
      readonly route: "system_default";
    };

export type ResidentCaptureSession = {
  readonly frames: AsyncIterable<VoicePcmFrame>;
  readonly stop: () => Promise<void>;
};

export type ResidentAudioCapture = {
  readonly start: (signal: AbortSignal) => ResidentCaptureSession;
  readonly close: () => Promise<void>;
};

type SpawnAudioProcess = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly stdio: ["ignore", "pipe", "inherit"] | ["pipe", "ignore", "inherit"];
  }
) => ChildProcessByStdio<Writable | null, Readable | null, null>;

export function createResidentAudioInputPlan(
  config: PicoConfig,
  platform: Platform = process.platform
): ResidentAudioInputPlan {
  const input = requireAudioInputConfig(config);
  const echoControl = config.voice.echoControl;
  const frameByteLength = Math.round(
    (echoControl.sampleRateHz * echoControl.channels * 2 * echoControl.frameMs) / 1_000
  );

  if (input.provider === "alsa") {
    requirePlatform(platform, "linux", "pico resident voice ALSA input requires Linux");

    return {
      provider: "alsa",
      command: "arecord",
      args: [
        "-q",
        "-f",
        "S16_LE",
        "-r",
        String(echoControl.sampleRateHz),
        "-c",
        String(echoControl.channels),
        "-t",
        "raw",
        "-D",
        input.device
      ],
      frameByteLength,
      frameIdPrefix: "alsa-mic"
    };
  }

  requirePlatform(platform, "darwin", "pico resident voice AVFoundation input requires macOS");

  return {
    provider: "avfoundation",
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      input.device,
      "-ac",
      String(echoControl.channels),
      "-ar",
      String(echoControl.sampleRateHz),
      "-f",
      "s16le",
      "pipe:1"
    ],
    frameByteLength,
    frameIdPrefix: "avfoundation-mic"
  };
}

export function createResidentAudioOutputPlan(
  config: PicoConfig,
  platform: Platform = process.platform
): ResidentAudioOutputPlan {
  const output = requireAudioOutputConfig(config);

  if (output.provider === "alsa") {
    requirePlatform(platform, "linux", "pico resident voice ALSA output requires Linux");

    return {
      provider: "alsa",
      command: "aplay",
      device: output.device
    };
  }

  requirePlatform(platform, "darwin", "pico resident voice afplay output requires macOS");

  return {
    provider: "afplay",
    command: "afplay",
    route: output.route
  };
}

export function createResidentAudioCapture(
  config: PicoConfig,
  spawnAudioProcess: SpawnAudioProcess = spawn as SpawnAudioProcess,
  platform: Platform = process.platform,
  now: () => string = defaultNow
): ResidentAudioCapture {
  const plan = createResidentAudioInputPlan(config, platform);
  let active: ResidentCaptureSession | undefined;

  return {
    start(signal) {
      if (active !== undefined) {
        throw new Error("pico resident voice capture is already active");
      }

      if (signal.aborted) {
        throw new Error(`pico resident voice ${plan.provider} input was aborted before startup`);
      }

      const session = createResidentCaptureSession(
        plan,
        config,
        signal,
        spawnAudioProcess,
        now,
        () => {
          if (active === session) {
            active = undefined;
          }
        }
      );
      active = session;

      return session;
    },
    async close() {
      await active?.stop();
    }
  };
}

export async function measureResidentAudioInputLevel(
  config: PicoConfig,
  options: ResidentAudioInputLevelOptions,
  spawnAudioProcess: SpawnAudioProcess = spawn as SpawnAudioProcess,
  platform: Platform = process.platform
): Promise<ResidentAudioInputLevel> {
  const captureMs = requirePositiveInteger(options.captureMs, "resident audio captureMs");
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs ?? Math.max(captureMs + 1_000, 5_000),
    "resident audio timeoutMs"
  );
  const minimumRmsDatabase = requireFiniteNumber(
    options.minimumRmsDb,
    "resident audio minimumRmsDb"
  );
  const plan = createResidentAudioInputPlan(config, platform);
  const measured = await captureResidentAudioInputLevel(
    createResidentAudioInputLevelPlan(plan, captureMs),
    config,
    captureMs,
    timeoutMs,
    spawnAudioProcess
  );

  return {
    provider: plan.provider,
    sampleRateHz: config.voice.echoControl.sampleRateHz,
    channels: config.voice.echoControl.channels,
    capturedMs: measured.durationMs,
    ...measured,
    signalDetected: measured.rmsDb >= minimumRmsDatabase
  };
}

export function measurePcm16leAudioLevel(
  audio: Uint8Array,
  sampleRateHz: number,
  channels: number
): Pcm16leAudioLevel {
  const accumulator = createPcm16leAudioLevelAccumulator(sampleRateHz, channels);

  accumulator.accept(audio);

  return accumulator.measure();
}

export function createResidentPlaybackSink(
  config: PicoConfig,
  spawnAudioProcess: SpawnAudioProcess = spawn as SpawnAudioProcess,
  platform: Platform = process.platform
): VoicePlaybackSink {
  const plan = createResidentAudioOutputPlan(config, platform);
  let active:
    | {
        readonly abortController: AbortController;
        child: ReturnType<SpawnAudioProcess> | undefined;
        childKilled: boolean;
        completion: Promise<void> | undefined;
        stopOperation: Promise<void> | undefined;
      }
    | undefined;

  const stopActive = (): Promise<void> => {
    const owned = active;

    if (owned === undefined) {
      return Promise.resolve();
    }

    if (owned.stopOperation !== undefined) {
      return owned.stopOperation;
    }

    owned.abortController.abort();
    owned.stopOperation = owned.completion ?? Promise.resolve();
    return owned.stopOperation;
  };

  return {
    async play(chunk, _startedAt, signal) {
      if (active !== undefined) {
        throw new Error("pico resident voice playback is already active");
      }

      const abortController = new AbortController();
      const owned: {
        readonly abortController: AbortController;
        child: ReturnType<SpawnAudioProcess> | undefined;
        childKilled: boolean;
        completion: Promise<void> | undefined;
        stopOperation: Promise<void> | undefined;
      } = {
        abortController,
        child: undefined,
        childKilled: false,
        completion: undefined,
        stopOperation: undefined
      };
      const killChild = (): void => {
        if (owned.child === undefined || owned.childKilled) {
          return;
        }

        owned.childKilled = true;
        owned.child.kill("SIGTERM");
      };
      const onExternalAbort = (): void => abortController.abort(signal?.reason);
      const onChild = (child: ReturnType<SpawnAudioProcess>): void => {
        owned.child = child;

        if (abortController.signal.aborted) {
          killChild();
        }
      };
      abortController.signal.addEventListener("abort", killChild, { once: true });
      signal?.addEventListener("abort", onExternalAbort, { once: true });

      if (signal?.aborted === true) {
        onExternalAbort();
      }

      active = owned;
      const completion =
        plan.provider === "alsa"
          ? playRawPcm(plan, chunk, spawnAudioProcess, abortController.signal, onChild)
          : playWavFile(plan, chunk, spawnAudioProcess, abortController.signal, onChild);
      owned.completion = completion;

      try {
        await completion;
      } finally {
        signal?.removeEventListener("abort", onExternalAbort);
        abortController.signal.removeEventListener("abort", killChild);

        if (active === owned) {
          active = undefined;
        }
      }
    },
    stop: stopActive,
    close: stopActive
  };
}

type PlaybackChildOwner = (child: ReturnType<SpawnAudioProcess>) => void;

function settlePlaybackError(signal: AbortSignal, error: Error): Error | undefined {
  if (signal.aborted) {
    return undefined;
  }

  return error;
}

function throwIfPlaybackAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Resident playback was aborted", "AbortError");
  }
}

async function ignorePlaybackAbort(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
  }
}

function createPcm16leAudioLevelAccumulator(
  sampleRateHz: number,
  channels: number
): {
  readonly accept: (audio: Uint8Array) => void;
  readonly measure: () => Pcm16leAudioLevel;
} {
  const normalizedSampleRateHz = requirePositiveInteger(sampleRateHz, "PCM sampleRateHz");
  const normalizedChannels = requirePositiveInteger(channels, "PCM channels");
  let squareSum = 0;
  let peakAbs = 0;
  let sampleCount = 0;

  return {
    accept(audio) {
      const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
      const chunkSampleCount = Math.floor(audio.byteLength / 2);

      for (let index = 0; index < chunkSampleCount; index += 1) {
        const absolute = Math.abs(view.getInt16(index * 2, true) / 32_768);
        squareSum += absolute * absolute;
        peakAbs = Math.max(peakAbs, absolute);
      }

      sampleCount += chunkSampleCount;
    },
    measure() {
      return {
        sampleCount,
        durationMs: (sampleCount / normalizedChannels / normalizedSampleRateHz) * 1_000,
        rmsDb:
          sampleCount === 0 || squareSum === 0
            ? Number.NEGATIVE_INFINITY
            : 20 * Math.log10(Math.sqrt(squareSum / sampleCount)),
        peakDb: peakAbs === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peakAbs)
      };
    }
  };
}

function createResidentAudioInputLevelPlan(
  plan: ResidentAudioInputPlan,
  captureMs: number
): ResidentAudioInputPlan {
  if (plan.provider === "alsa") {
    return {
      ...plan,
      args: [...plan.args, "-d", String(Math.ceil(captureMs / 1_000))]
    };
  }

  const insertIndex = requireAvfoundationInputDeviceArgumentEnd(plan.args);

  return {
    ...plan,
    args: [
      ...plan.args.slice(0, insertIndex),
      "-t",
      formatCaptureSeconds(captureMs + 1_000),
      ...plan.args.slice(insertIndex)
    ]
  };
}

function requireAvfoundationInputDeviceArgumentEnd(arguments_: readonly string[]): number {
  const inputArgumentIndex = arguments_.indexOf("-i");
  const inputDeviceArgumentIndex = inputArgumentIndex + 1;

  if (inputArgumentIndex === -1 || arguments_[inputDeviceArgumentIndex] === undefined) {
    throw new Error("pico resident voice AVFoundation input plan is missing input device");
  }

  return inputDeviceArgumentIndex + 1;
}

function captureResidentAudioInputLevel(
  plan: ResidentAudioInputPlan,
  config: PicoConfig,
  captureMs: number,
  timeoutMs: number,
  spawnAudioProcess: SpawnAudioProcess
): Promise<Pcm16leAudioLevel> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const level = createPcm16leAudioLevelAccumulator(
      config.voice.echoControl.sampleRateHz,
      config.voice.echoControl.channels
    );
    const child = spawnAudioProcess(plan.command, plan.args, {
      stdio: ["ignore", "pipe", "inherit"]
    });
    const stdout = child.stdout;

    const settle = (error: Error | undefined, value?: Pcm16leAudioLevel): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve(value ?? level.measure());
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle(new Error(`pico resident voice ${plan.provider} input level capture timed out`));
    }, timeoutMs);
    timeout.unref();

    if (stdout === null) {
      settle(new Error(`pico resident voice ${plan.provider} input did not expose stdout`));
      return;
    }

    stdout.on("data", (chunk: Buffer) => {
      level.accept(new Uint8Array(chunk));
    });
    stdout.once("error", settle);
    child.once("error", settle);
    child.once("close", (code, signalName) => {
      if (code !== 0) {
        settle(
          new Error(
            `pico resident voice ${plan.provider} input exited with code ${String(
              code
            )} signal ${String(signalName)}`
          )
        );
        return;
      }

      const measured = level.measure();

      if (!isSufficientAudioInputLevelCapture(measured.durationMs, captureMs)) {
        settle(new Error(`pico resident voice ${plan.provider} input ended before level capture`));
        return;
      }

      settle(undefined, measured);
    });
  });
}

function isSufficientAudioInputLevelCapture(measuredMs: number, requestedMs: number): boolean {
  const timingToleranceMs = Math.min(100, requestedMs * 0.05);

  return measuredMs >= requestedMs - timingToleranceMs;
}

function formatCaptureSeconds(captureMs: number): string {
  return (captureMs / 1_000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function createResidentCaptureSession(
  plan: ResidentAudioInputPlan,
  config: PicoConfig,
  signal: AbortSignal,
  spawnAudioProcess: SpawnAudioProcess,
  now: () => string,
  onClose: () => void
): ResidentCaptureSession {
  const child = spawnAudioProcess(plan.command, plan.args, {
    stdio: ["ignore", "pipe", "inherit"]
  });
  const stdout = child.stdout;

  if (stdout === null) {
    child.kill("SIGTERM");
    throw new Error(`pico resident voice ${plan.provider} input did not expose stdout`);
  }

  let childFailure: Error | undefined;
  let stopping = false;
  let closed = false;
  let stopOperation: Promise<void> | undefined;
  let iteratorClaimed = false;
  const captureStartedAtMs = Date.parse(now());
  const closedOperation = new Promise<void>((resolve) => {
    child.once("close", (code, signalName) => {
      closed = true;
      const expectedStopExit =
        stopping &&
        (code === 0 ||
          signalName === "SIGTERM" ||
          (plan.provider === "avfoundation" && code === 255));

      if (code !== 0 && !expectedStopExit) {
        childFailure = new Error(
          `pico resident voice ${plan.provider} input exited with code ${String(
            code
          )} signal ${String(signalName)}`
        );
        stdout.destroy(childFailure);
      }

      signal.removeEventListener("abort", stopFromSignal);
      onClose();
      resolve();
    });
  });
  const stop = (): Promise<void> => {
    if (stopOperation !== undefined) {
      return stopOperation;
    }

    stopping = true;

    if (!closed) {
      child.kill("SIGTERM");
    }

    stopOperation = closedOperation;
    return stopOperation;
  };
  const stopFromSignal = (): void => {
    stop().catch(() => undefined);
  };

  child.once("error", (error) => {
    childFailure = error;
    stdout.destroy(error);
  });
  signal.addEventListener("abort", stopFromSignal, { once: true });

  return {
    frames: {
      async *[Symbol.asyncIterator]() {
        if (iteratorClaimed) {
          throw new Error("pico resident voice capture frames can only be consumed once");
        }

        iteratorClaimed = true;
        yield* readOwnedPcmFrames(
          plan,
          config,
          stdout,
          captureStartedAtMs,
          closedOperation,
          () => childFailure
        );
      }
    },
    stop
  };
}

async function* readOwnedPcmFrames(
  plan: ResidentAudioInputPlan,
  config: PicoConfig,
  stdout: Readable,
  captureStartedAtMs: number,
  closed: Promise<void>,
  childFailure: () => Error | undefined
): AsyncIterable<VoicePcmFrame> {
  if (Number.isNaN(captureStartedAtMs)) {
    throw new Error("pico resident voice capture clock returned an invalid ISO timestamp");
  }

  let frameIndex = 0;
  let pending = Buffer.alloc(0);

  for await (const chunk of stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);

    while (pending.byteLength >= plan.frameByteLength) {
      const audio = pending.subarray(0, plan.frameByteLength);
      pending = pending.subarray(plan.frameByteLength);
      frameIndex += 1;

      yield {
        id: `${plan.frameIdPrefix}-${frameIndex}`,
        direction: "near_end",
        audio: new Uint8Array(audio),
        encoding: "pcm16le",
        sampleRateHz: config.voice.echoControl.sampleRateHz,
        channels: config.voice.echoControl.channels,
        capturedAt: new Date(
          captureStartedAtMs + (frameIndex - 1) * config.voice.echoControl.frameMs
        ).toISOString(),
        durationMs: config.voice.echoControl.frameMs
      };
    }
  }

  await closed;
  const failure = childFailure();

  if (failure !== undefined) {
    throw failure;
  }
}

const defaultNow = (): string => new Date().toISOString();

function playRawPcm(
  plan: Extract<ResidentAudioOutputPlan, { readonly provider: "alsa" }>,
  chunk: TtsAudioChunk,
  spawnAudioProcess: SpawnAudioProcess,
  signal: AbortSignal,
  onChild: PlaybackChildOwner
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    };
    const child = spawnAudioProcess(plan.command, createAlsaPlaybackArguments(plan, chunk), {
      stdio: ["pipe", "ignore", "inherit"]
    });
    onChild(child);
    const stdin = child.stdin;

    if (stdin === null) {
      settle(
        settlePlaybackError(
          signal,
          new Error(`pico resident voice ${plan.provider} output did not expose stdin`)
        )
      );
      return;
    }

    child.once("error", (error) => settle(settlePlaybackError(signal, error)));
    stdin.once("error", (error) => settle(settlePlaybackError(signal, error)));
    child.once("exit", (code) => {
      if (code === 0 || signal.aborted) {
        settle(undefined);
        return;
      }

      settle(
        new Error(`pico resident voice ${plan.provider} output exited with code ${String(code)}`)
      );
    });
    stdin.end(chunk.audio);
  });
}

async function playWavFile(
  plan: Extract<ResidentAudioOutputPlan, { readonly provider: "afplay" }>,
  chunk: TtsAudioChunk,
  spawnAudioProcess: SpawnAudioProcess,
  signal: AbortSignal,
  onChild: PlaybackChildOwner
): Promise<void> {
  await ignorePlaybackAbort(async () => {
    throwIfPlaybackAborted(signal);
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-voice-"));
    const path = join(directory, "tts.wav");

    try {
      throwIfPlaybackAborted(signal);
      await writeFile(path, encodePcm16leWav(chunk.audio, chunk.sampleRateHz, chunk.channels));
      throwIfPlaybackAborted(signal);
      await playFile(plan.command, [path], spawnAudioProcess, signal, onChild);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function createAlsaPlaybackArguments(
  plan: Extract<ResidentAudioOutputPlan, { readonly provider: "alsa" }>,
  chunk: TtsAudioChunk
): readonly string[] {
  return [
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

function playFile(
  command: string,
  arguments_: readonly string[],
  spawnAudioProcess: SpawnAudioProcess,
  signal: AbortSignal,
  onChild: PlaybackChildOwner
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnAudioProcess(command, arguments_, {
      stdio: ["ignore", "pipe", "inherit"]
    });
    onChild(child);

    child.once("error", (error) => {
      const resolvedError = settlePlaybackError(signal, error);

      if (resolvedError === undefined) {
        resolve();
        return;
      }

      reject(resolvedError);
    });
    child.once("exit", (code) => {
      if (code === 0 || signal.aborted) {
        resolve();
        return;
      }

      reject(new Error(`pico resident voice ${command} output exited with code ${String(code)}`));
    });
  });
}

function encodePcm16leWav(audio: Uint8Array, sampleRateHz: number, channels: number): Buffer {
  const dataSize = audio.byteLength;
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 12 + 4);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(audio)]);
}

function requireAudioInputConfig(
  config: PicoConfig
): NonNullable<PicoConfig["voice"]["resident"]["audioInput"]> {
  const input = config.voice.resident.audioInput;

  if (input === undefined) {
    throw new Error("pico resident voice requires voice.resident.audioInput config");
  }

  return input;
}

function requireAudioOutputConfig(
  config: PicoConfig
): NonNullable<PicoConfig["voice"]["resident"]["audioOutput"]> {
  const output = config.voice.resident.audioOutput;

  if (output === undefined) {
    throw new Error("pico resident voice requires voice.resident.audioOutput config");
  }

  return output;
}

function requirePlatform(platform: Platform, expected: Platform, message: string): void {
  if (platform !== expected) {
    throw new Error(message);
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function requireFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}
