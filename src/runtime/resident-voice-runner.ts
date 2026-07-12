import { homedir } from "node:os";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../config/index.js";
import type { AuditEvent } from "../modules/audit/index.js";
import { openSessionMemoryCandidateQueue } from "../modules/long-memory/index.js";
import { createSessionMemoryEnqueueWorker } from "../modules/long-memory/session-worker.js";
import { createSessionLifecycle } from "../modules/session/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  type EchoControlProvider
} from "../modules/voice/echo-control.js";
import {
  type AivisSpeechServiceConfig,
  checkAivisSpeechServiceHealth,
  createAivisSpeechTtsClient,
  createAppleSpeechSttClient,
  defineAivisSpeechService,
  defineAppleSpeechSidecar
} from "../modules/voice/index.js";
import { createDeferredToolCoordinator } from "./deferred-tool-coordinator.js";
import type { PiAgentTurnClientOptions } from "./pi-agent-turn.js";
import {
  createLoopbackHttpResidentActivationServer,
  createResidentActivationQueue
} from "./resident-activation.js";
import { createResidentPcmFrameSource, createResidentPlaybackSink } from "./resident-audio-io.js";
import {
  acquireResidentSingleInstanceLock,
  registerResidentSingleInstanceLockShutdownCleanup
} from "./resident-single-instance-lock.js";
import {
  createResidentVoiceAuditLog,
  type ResidentVoiceAuditLogStdoutMode
} from "./resident-voice-audit-log.js";
import { createResidentVoiceConsoleLog } from "./resident-voice-console-log.js";
import {
  createResidentVoiceCompositeConsoleSink,
  createResidentVoiceFileLogSink,
  type ResidentVoiceLogRunMode,
  requireResidentVoiceRunId
} from "./resident-voice-log-files.js";
import { warmResidentVoiceStartupProviders } from "./resident-voice-startup-warmup.js";
import {
  createEnergySpeechActivityGate,
  createTenWasmSpeechActivityGate
} from "./speech-activity-gate.js";
import {
  type PiAgentTurnClient,
  runVoiceResidentRuntime,
  type VoiceResidentActivation
} from "./voice-resident.js";

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

export async function runDirectResidentVoiceHarness(
  createPiAgent: (options: PiAgentTurnClientOptions) => PiAgentTurnClient
): Promise<void> {
  const config = loadPicoConfigFromEnvironment();
  requireResidentVoiceEnabled(config);
  const abortController = new AbortController();
  const lock = acquireResidentSingleInstanceLock(config.voice.resident.singleInstanceLockPath);
  const unregisterShutdownCleanup = registerResidentSingleInstanceLockShutdownCleanup(
    lock,
    abortController
  );

  try {
    await withShutdownGrace(
      runResidentVoiceWithProviders({
        config,
        signal: abortController.signal,
        createPiAgent
      }),
      abortController.signal,
      config.voice.resident.shutdownGraceMs
    );
  } finally {
    unregisterShutdownCleanup();
    lock.release();
  }
}

export async function runResidentVoiceWithProviders(input: {
  readonly config: PicoConfig;
  readonly signal: AbortSignal;
  readonly piAgent?: PiAgentTurnClient;
  readonly createPiAgent?: (options: PiAgentTurnClientOptions) => PiAgentTurnClient;
}): Promise<void> {
  const { config, signal } = input;
  requireResidentVoiceEnabled(config);
  await assertResidentVoiceStartupReadiness(config);
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

  const activation = await createConfiguredActivation(config, signal, writeProcessLine);

  try {
    const frames = createResidentPcmFrameSource(config, signal);
    const echoControl = createConfiguredEchoControl(config);
    const playback = createResidentPlaybackSink(config);
    const piAgent = resolveResidentPiAgent(input.piAgent, input.createPiAgent, {
      cwd: process.cwd(),
      sessionLifecycle,
      deferredTools: {
        coordinator: deferredTools
      },
      ...(audit === undefined ? {} : { voiceProbe: { audit } })
    });
    const speechActivity = await createConfiguredSpeechActivityGate(config);

    await runVoiceResidentRuntime({
      frames,
      triggerPhrases: [
        ...config.session.startTriggers.wakeNames,
        ...config.session.startTriggers.greetings
      ],
      sessionLifecycle,
      echoControl,
      speechActivity,
      stt,
      tts,
      playback,
      piAgent,
      memoryWorker,
      deferredTools,
      wakeAcknowledgement: {
        enabled: config.voice.resident.activation.mode === "wake_word"
      },
      farewell: {
        enabled: true
      },
      console: createResidentVoiceRuntimeConsoleSink(logRunMode, fileLog, stdoutProbeMode),
      minTriggerConfidence: config.voice.resident.minTriggerConfidence,
      activation: activation.runtime,
      utteranceWindow: config.voice.resident.utteranceWindow,
      ...(audit === undefined ? {} : { probe: { audit } }),
      signal
    });
  } finally {
    await activation.close();
  }
}

function resolveResidentPiAgent(
  piAgent: PiAgentTurnClient | undefined,
  createPiAgent: ((options: PiAgentTurnClientOptions) => PiAgentTurnClient) | undefined,
  options: PiAgentTurnClientOptions
): PiAgentTurnClient {
  const resolvedPiAgent = piAgent ?? createPiAgent?.(options);

  if (resolvedPiAgent === undefined) {
    throw new Error("pico resident voice requires a Pi Agent turn client");
  }

  return resolvedPiAgent;
}

export function requireResidentVoiceEnabled(config: PicoConfig): void {
  if (!config.voice.resident.enabled) {
    throw new Error("pico resident voice runtime requires voice.resident.enabled=true");
  }
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

async function createConfiguredActivation(
  config: PicoConfig,
  signal: AbortSignal,
  writeProcessLine: (line: string) => void
): Promise<{
  readonly runtime: VoiceResidentActivation;
  readonly close: () => Promise<void>;
}> {
  const activation = config.voice.resident.activation;

  if (activation.mode === "wake_word") {
    return {
      runtime: activation,
      close: () => Promise.resolve()
    };
  }

  const queue = createResidentActivationQueue({
    debounceMs: activation.debounceMs,
    activationWindowMs: activation.activationWindowMs
  });
  const server = await createLoopbackHttpResidentActivationServer({
    host: activation.host,
    port: activation.port,
    authTokenPath: activation.authTokenPath,
    queue,
    signal
  });

  try {
    writeProcessLine(`[pico] resident push-to-talk activation: ${server.url}\n`);

    return {
      runtime: {
        mode: "push_to_talk",
        source: queue
      },
      close: () => server.close()
    };
  } catch (error) {
    await server.close();
    throw error;
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
  const appleSpeech = config.voice.stt.appleSpeech;

  if (appleSpeech === undefined) {
    throw new Error("pico resident voice requires voice.stt.appleSpeech config");
  }

  return createAppleSpeechSttClient(
    defineAppleSpeechSidecar({
      id: appleSpeech.id ?? "local-apple-speech",
      provider: "apple-speech",
      localBaseUrl: appleSpeech.localBaseUrl,
      language: appleSpeech.language ?? "ja-JP",
      timeoutMs: appleSpeech.timeoutMs ?? 30_000,
      warmup: {
        audioSeconds: appleSpeech.warmupAudioSeconds ?? 0.25
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
