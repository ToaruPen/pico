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
  type AivisSpeechServiceConfig,
  checkAivisSpeechServiceHealth,
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
import {
  acquireResidentSingleInstanceLock,
  registerResidentSingleInstanceLockShutdownCleanup
} from "../../src/runtime/resident-single-instance-lock.js";
import { runVoiceResidentRuntime } from "../../src/runtime/voice-resident.js";

const config = loadPicoConfigFromEnvironment();

if (!config.voice.resident.enabled) {
  throw new Error("pico resident voice runtime requires voice.resident.enabled=true");
}

await assertResidentVoiceStartupReadiness(config);

const abortController = new AbortController();
const lock = acquireResidentSingleInstanceLock(config.voice.resident.singleInstanceLockPath);
const unregisterShutdownCleanup = registerResidentSingleInstanceLockShutdownCleanup(
  lock,
  abortController
);

try {
  await withShutdownGrace(
    runResidentVoice(config, abortController.signal),
    abortController.signal,
    config.voice.resident.shutdownGraceMs
  );
} finally {
  unregisterShutdownCleanup();
  lock.release();
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
    utteranceWindow: config.voice.resident.utteranceWindow,
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
  return createAivisSpeechTtsClient(buildAivisSpeechService(config));
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

async function assertResidentVoiceStartupReadiness(config: PicoConfig): Promise<void> {
  const health = await checkAivisSpeechServiceHealth(buildAivisSpeechService(config));

  if (!health.ok) {
    throw new Error(`pico resident voice TTS provider is unhealthy: ${health.message}`);
  }
}

function buildAivisSpeechService(config: PicoConfig): AivisSpeechServiceConfig {
  const aivis = config.voice.tts.aivis;

  if (aivis === undefined) {
    throw new Error("pico resident voice requires voice.tts.aivis config");
  }

  return defineAivisSpeechService({
    id: aivis.id ?? "local-aivis",
    provider: "aivis-speech",
    localBaseUrl: aivis.localBaseUrl,
    speakerId: aivis.speakerId,
    timeoutMs: aivis.timeoutMs ?? 30_000
  });
}
