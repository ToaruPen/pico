import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { createStructuredAuditLog } from "../../src/modules/audit/index.js";
import { openSessionMemoryCandidateQueue } from "../../src/modules/long-memory/index.js";
import { createSessionMemoryEnqueueWorker } from "../../src/modules/long-memory/session-worker.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  type EchoControlProvider
} from "../../src/modules/voice/echo-control.js";
import {
  createAivisSpeechTtsClient,
  createMlxWhisperSttClient,
  defineAivisSpeechService,
  defineMlxWhisperSidecar
} from "../../src/modules/voice/index.js";
import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";
import {
  createResidentPcmFrameSource,
  createResidentPlaybackSink
} from "../../src/runtime/resident-audio-io.js";
import { runVoiceResidentRuntime } from "../../src/runtime/voice-resident.js";

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
    frames: createResidentPcmFrameSource(config, signal),
    triggerPhrases: [
      ...config.session.startTriggers.wakeNames,
      ...config.session.startTriggers.greetings
    ],
    sessionLifecycle,
    echoControl: createConfiguredEchoControl(config),
    stt: createConfiguredStt(config),
    tts: createConfiguredTts(config),
    playback: createResidentPlaybackSink(config),
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

function acquireSingleInstanceLock(lockPath: string): () => void {
  const resolved = resolve(lockPath);

  mkdirSync(dirname(resolved), { recursive: true });
  writeSingleInstanceLock(resolved);

  return () => {
    rmSync(resolved, { force: true });
  };
}

function writeSingleInstanceLock(resolved: string): void {
  try {
    writeLockFile(resolved);
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }

    const existingPid = readLockPid(resolved);

    if (existingPid !== undefined && isProcessRunning(existingPid)) {
      throw new Error(`pico resident voice runtime is already running (pid: ${existingPid})`, {
        cause: error
      });
    }

    rmSync(resolved, { force: true });
    writeLockFile(resolved);
  }
}

function writeLockFile(resolved: string): void {
  const file = openSync(resolved, "wx");

  try {
    writeFileSync(file, String(process.pid));
  } finally {
    closeSync(file);
  }
}

function readLockPid(resolved: string): number | undefined {
  const parsed = Number(readFileSync(resolved, "utf8").trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return false;
    }

    if (isErrnoException(error) && error.code === "EPERM") {
      return true;
    }

    throw error;
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "EEXIST";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
