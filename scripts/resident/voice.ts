import { homedir } from "node:os";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import type { AuditEvent } from "../../src/modules/audit/index.js";
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
import { createDeferredToolCoordinator } from "../../src/runtime/deferred-tool-coordinator.js";
import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";
import {
  createResidentPcmFrameSource,
  createResidentPlaybackSink
} from "../../src/runtime/resident-audio-io.js";
import {
  acquireResidentSingleInstanceLock,
  registerResidentSingleInstanceLockShutdownCleanup
} from "../../src/runtime/resident-single-instance-lock.js";
import {
  createResidentVoiceAuditLog,
  type ResidentVoiceAuditLogStdoutMode
} from "../../src/runtime/resident-voice-audit-log.js";
import { createResidentVoiceConsoleLog } from "../../src/runtime/resident-voice-console-log.js";
import {
  createResidentVoiceCompositeConsoleSink,
  createResidentVoiceFileLogSink,
  type ResidentVoiceLogRunMode,
  requireResidentVoiceRunId
} from "../../src/runtime/resident-voice-log-files.js";
import { warmResidentVoiceStartupProviders } from "../../src/runtime/resident-voice-startup-warmup.js";
import {
  createEnergySpeechActivityGate,
  createTenWasmSpeechActivityGate
} from "../../src/runtime/speech-activity-gate.js";
import { runVoiceResidentRuntime } from "../../src/runtime/voice-resident.js";

const config = loadPicoConfigFromEnvironment();
const residentVoiceMetricStages = new Set([
  "startup_warmup",
  "speech_gate",
  "utterance_window",
  "stt",
  "trigger_match",
  "session_start",
  "pi_turn",
  "tts_request_wall",
  "tts_audio_duration",
  "tts_synthesize",
  "tts_playback",
  "camera_capture",
  "vlm_scene_description",
  "session_cutoff_enqueue"
]);

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
  const stdoutProbeMode = readVoiceProbeStdoutMode(process.env.PICO_VOICE_PROBE_STDOUT);
  const logRunMode = readResidentVoiceLogRunMode(process.env.PICO_RESIDENT_VOICE_LOG_MODE);
  const runId = readResidentVoiceRunId(process.env.PICO_RESIDENT_VOICE_RUN_ID);
  const fileLog = createResidentVoiceFileLogSink({
    homeDirectory: homedir(),
    runMode: logRunMode,
    ...(runId === undefined ? {} : { runId })
  });
  const writeProcessLine = (line: string): void => {
    fileLog.writeProcessLine(line);

    if (stdoutProbeMode !== undefined) {
      process.stdout.write(line);
    }
  };
  const audit = config.voice.probes.enabled
    ? createResidentVoiceAuditLog({
        stdoutEnabled: true,
        writeStdout: writeProcessLine,
        writeEvent: (event) => {
          writeResidentVoiceMetricEvent(fileLog.writeAuditEvent, event);
        },
        ...(stdoutProbeMode === undefined ? {} : { stdoutMode: stdoutProbeMode })
      })
    : undefined;
  const sessionLifecycle = createSessionLifecycle({
    ending: config.session.ending,
    ...(audit === undefined ? {} : { audit })
  });
  const memoryWorker = createResidentMemoryWorker(config);
  const deferredTools = createDeferredToolCoordinator();
  const stt = createConfiguredStt(config);
  const tts = createConfiguredTts(config);

  await warmResidentVoiceStartupProviders({
    clients: {
      stt,
      tts
    },
    ...(audit === undefined ? {} : { probe: { audit } }),
    signal
  });

  await runVoiceResidentRuntime({
    frames: createResidentPcmFrameSource(config, signal),
    triggerPhrases: [
      ...config.session.startTriggers.wakeNames,
      ...config.session.startTriggers.greetings
    ],
    sessionLifecycle,
    echoControl: createConfiguredEchoControl(config),
    speechActivity: await createConfiguredSpeechActivityGate(config),
    stt,
    tts,
    playback: createResidentPlaybackSink(config),
    piAgent: createPiAgentTurnClient({
      cwd: process.cwd(),
      sessionLifecycle,
      deferredTools: {
        coordinator: deferredTools
      },
      ...(audit === undefined ? {} : { voiceProbe: { audit } })
    }),
    memoryWorker,
    deferredTools,
    wakeAcknowledgement: {
      enabled: true
    },
    farewell: {
      enabled: true
    },
    console: createResidentVoiceRuntimeConsoleSink(logRunMode, fileLog, stdoutProbeMode),
    minTriggerConfidence: config.voice.resident.minTriggerConfidence,
    utteranceWindow: config.voice.resident.utteranceWindow,
    ...(audit === undefined ? {} : { probe: { audit } }),
    signal
  });
}

function createResidentVoiceRuntimeConsoleSink(
  logRunMode: ResidentVoiceLogRunMode,
  fileLog: ReturnType<typeof createResidentVoiceFileLogSink>,
  stdoutProbeMode: ResidentVoiceAuditLogStdoutMode | undefined
) {
  if (stdoutProbeMode !== undefined && logRunMode === "development") {
    return createResidentVoiceCompositeConsoleSink([createResidentVoiceConsoleLog(), fileLog]);
  }

  return fileLog;
}

function readVoiceProbeStdoutMode(
  value: string | undefined
): ResidentVoiceAuditLogStdoutMode | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  if (value === "1" || value === "summary") {
    return "summary";
  }

  if (value === "verbose") {
    return "verbose";
  }

  throw new Error("PICO_VOICE_PROBE_STDOUT must be unset, 1, summary, or verbose");
}

function readResidentVoiceLogRunMode(value: string | undefined): ResidentVoiceLogRunMode {
  if (value === undefined || value.trim() === "") {
    return "normal";
  }

  if (value === "development" || value === "normal") {
    return value;
  }

  throw new Error("PICO_RESIDENT_VOICE_LOG_MODE must be unset, development, or normal");
}

function readResidentVoiceRunId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  try {
    return requireResidentVoiceRunId(value);
  } catch {
    throw new Error("PICO_RESIDENT_VOICE_RUN_ID must be a path-safe identifier");
  }
}

function writeResidentVoiceMetricEvent(
  writeAuditEvent: (event: AuditEvent) => void,
  event: AuditEvent
): void {
  const stage = event.attributes["pico.voice.stage"];

  if (
    event.name === "voice.runtime.stage" &&
    typeof stage === "string" &&
    residentVoiceMetricStages.has(stage)
  ) {
    writeAuditEvent(event);
  }
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

async function createConfiguredSpeechActivityGate(config: PicoConfig) {
  const vad = config.voice.resident.vad;

  if (vad.provider === "energy") {
    return createEnergySpeechActivityGate({
      minRmsDb: vad.minRmsDb
    });
  }

  return createTenWasmSpeechActivityGate({
    jsPath: vad.jsPath,
    wasmPath: vad.wasmPath,
    hopSize: vad.hopSize,
    threshold: vad.threshold
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
