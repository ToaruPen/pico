import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { createStructuredAuditLog } from "../../src/modules/audit/index.js";
import { openSessionMemoryCandidateQueue } from "../../src/modules/long-memory/index.js";
import { createSessionMemoryEnqueueWorker } from "../../src/modules/long-memory/session-worker.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../../src/modules/voice/echo-control.js";
import {
  createAivisSpeechTtsClient,
  createMlxWhisperSttClient,
  defineAivisSpeechService,
  defineMlxWhisperSidecar
} from "../../src/modules/voice/index.js";
import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";
import {
  runVoiceResidentRuntime,
  type VoicePlaybackSink
} from "../../src/runtime/voice-resident.js";

const config = loadPicoConfigFromEnvironment();

if (!config.voice.resident.enabled) {
  throw new Error("pico resident voice runtime requires voice.resident.enabled=true");
}

const abortController = new AbortController();
const releaseLock = acquireSingleInstanceLock(config.voice.resident.singleInstanceLockPath);

process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

try {
  await withShutdownGrace(
    runResidentVoice(config, abortController.signal),
    abortController.signal,
    config.voice.resident.shutdownGraceMs
  );
} finally {
  releaseLock();
}

async function runResidentVoice(config: PicoConfig, signal: AbortSignal): Promise<void> {
  const audit = config.voice.probes.enabled ? createStructuredAuditLog() : undefined;
  const sessionLifecycle = createSessionLifecycle({
    ending: config.session.ending,
    ...(audit === undefined ? {} : { audit })
  });
  const memoryWorker = createResidentMemoryWorker(config);

  await runVoiceResidentRuntime({
    frames: createAlsaPcmFrameSource(config, signal),
    triggerPhrases: [
      ...config.session.startTriggers.wakeNames,
      ...config.session.startTriggers.greetings
    ],
    sessionLifecycle,
    echoControl: createConfiguredEchoControl(config),
    stt: createConfiguredStt(config),
    tts: createConfiguredTts(config),
    playback: createAlsaPlaybackSink(config),
    piAgent: createPiAgentTurnClient({
      cwd: process.cwd(),
      sessionLifecycle
    }),
    memoryWorker,
    minTriggerConfidence: config.voice.resident.minTriggerConfidence,
    ...(audit === undefined ? {} : { probe: { audit } }),
    signal
  });
}

function withShutdownGrace<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  shutdownGraceMs: number
): Promise<T> {
  if (signal.aborted) {
    return operation;
  }

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
    const abort = (): void => {
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`pico resident voice shutdown exceeded ${shutdownGraceMs} ms`));
      }, shutdownGraceMs);
      timeout.unref();
    };

    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function createConfiguredEchoControl(config: PicoConfig): EchoControlProvider {
  const echoControl = config.voice.echoControl;

  if (!echoControl.enabled) {
    return createHalfDuplexEchoControl({
      tailMuteMs: echoControl.tailMuteMs
    });
  }

  if (echoControl.mode === "half_duplex") {
    return createHalfDuplexEchoControl({
      tailMuteMs: echoControl.tailMuteMs
    });
  }

  if (
    echoControl.provider === undefined ||
    echoControl.provider === "half_duplex" ||
    echoControl.providerEndpoint === undefined
  ) {
    throw new Error("pico resident voice AEC requires voice.echoControl.providerEndpoint");
  }

  return createHttpEchoControlProvider({
    provider: echoControl.provider,
    mode: echoControl.mode,
    providerEndpoint: echoControl.providerEndpoint
  });
}

function createConfiguredStt(config: PicoConfig) {
  const mlxWhisper = config.voice.stt.mlxWhisper;

  if (mlxWhisper === undefined) {
    throw new Error("pico resident voice requires voice.stt.mlxWhisper config");
  }

  return createMlxWhisperSttClient(
    defineMlxWhisperSidecar({
      id: mlxWhisper.id ?? "local-mlx-whisper",
      provider: "mlx-whisper",
      localBaseUrl: mlxWhisper.localBaseUrl,
      modelRepo: mlxWhisper.modelRepo ?? "mlx-community/whisper-large-v3-turbo",
      language: mlxWhisper.language ?? "ja",
      timeoutMs: mlxWhisper.timeoutMs ?? 30_000,
      warmup: {
        audioSeconds: mlxWhisper.warmupAudioSeconds ?? 0.25
      }
    })
  );
}

function createConfiguredTts(config: PicoConfig) {
  const aivis = config.voice.tts.aivis;

  if (aivis === undefined) {
    throw new Error("pico resident voice requires voice.tts.aivis config");
  }

  return createAivisSpeechTtsClient(
    defineAivisSpeechService({
      id: aivis.id ?? "local-aivis",
      provider: "aivis-speech",
      localBaseUrl: aivis.localBaseUrl,
      speakerId: aivis.speakerId,
      timeoutMs: aivis.timeoutMs ?? 30_000
    })
  );
}

function createResidentMemoryWorker(config: PicoConfig) {
  const mem0 = config.memory.mem0;

  if (!mem0.enabled || mem0.historyDbPath === undefined) {
    throw new Error("pico resident voice requires memory.mem0.enabled=true and historyDbPath");
  }

  const queue = openSessionMemoryCandidateQueue(mem0.historyDbPath);
  const worker = createSessionMemoryEnqueueWorker({
    queue
  });

  return {
    ...worker,
    close: () => queue.close()
  };
}

async function* createAlsaPcmFrameSource(
  config: PicoConfig,
  signal: AbortSignal
): AsyncIterable<VoicePcmFrame> {
  requireLinuxAlsa();
  const echoControl = config.voice.echoControl;
  const frameBytes = Math.round(
    (echoControl.sampleRateHz * echoControl.channels * 2 * echoControl.frameMs) / 1_000
  );
  const arguments_ = [
    "-q",
    "-f",
    "S16_LE",
    "-r",
    String(echoControl.sampleRateHz),
    "-c",
    String(echoControl.channels),
    "-t",
    "raw",
    ...(config.voice.resident.microphoneDevice === undefined
      ? []
      : ["-D", config.voice.resident.microphoneDevice])
  ];
  const child = spawn("arecord", arguments_, {
    stdio: ["ignore", "pipe", "inherit"]
  });
  let frameIndex = 0;
  let pending = Buffer.alloc(0);
  let childFailure: Error | undefined;
  const abort = (): void => {
    child.kill("SIGTERM");
  };
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signalName) => {
      if (!signal.aborted && code !== 0) {
        childFailure = new Error(
          `pico resident voice arecord exited with code ${String(code)} signal ${String(
            signalName
          )}`
        );
        child.stdout.destroy(childFailure);
      }

      resolve();
    });
  });

  child.once("error", (error) => {
    childFailure = error;
    child.stdout.destroy(error);
  });

  signal.addEventListener("abort", abort, { once: true });

  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk as Buffer]);

      while (pending.byteLength >= frameBytes) {
        const audio = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        frameIndex += 1;

        yield {
          id: `alsa-mic-${frameIndex}`,
          direction: "near_end",
          audio: new Uint8Array(audio),
          encoding: "pcm16le",
          sampleRateHz: echoControl.sampleRateHz,
          channels: echoControl.channels,
          capturedAt: new Date().toISOString(),
          durationMs: echoControl.frameMs
        };
      }
    }

    await closed;

    if (childFailure !== undefined) {
      throw childFailure;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    child.kill("SIGTERM");
  }
}

function createAlsaPlaybackSink(config: PicoConfig): VoicePlaybackSink {
  return {
    play(chunk) {
      requireLinuxAlsa();

      return new Promise((resolve, reject) => {
        const arguments_ = [
          "-q",
          "-f",
          "S16_LE",
          "-r",
          String(chunk.sampleRateHz),
          "-c",
          String(chunk.channels),
          "-t",
          "raw",
          ...(config.voice.resident.playbackDevice === undefined
            ? []
            : ["-D", config.voice.resident.playbackDevice])
        ];
        const child = spawn("aplay", arguments_, {
          stdio: ["pipe", "ignore", "inherit"]
        });

        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`pico resident voice aplay exited with code ${String(code)}`));
        });
        child.stdin.end(chunk.audio);
      });
    }
  };
}

function acquireSingleInstanceLock(lockPath: string): () => void {
  const resolved = resolve(lockPath);

  mkdirSync(dirname(resolved), { recursive: true });

  const file = openSync(resolved, "wx");
  writeFileSync(file, String(process.pid));

  return () => {
    rmSync(resolved, { force: true });
  };
}

function requireLinuxAlsa(): void {
  if (process.platform !== "linux") {
    throw new Error("pico resident voice ALSA I/O requires Linux");
  }
}
