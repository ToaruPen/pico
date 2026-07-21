import { homedir } from "node:os";

import {
  loadPicoConfigFromEnvironment,
  type PicoConfig,
  type PicoResidentControlConfig,
  type PicoTelemetryOtelConfig
} from "../config/index.js";
import type { AuditEvent } from "../modules/audit/index.js";
import { createSessionLifecycle } from "../modules/session/index.js";
import {
  createOpenTelemetryProvider,
  type OpenTelemetryProviderOptions,
  type PicoTelemetry
} from "../modules/telemetry/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  type EchoControlProvider
} from "../modules/voice/echo-control.js";
import {
  type AivisSpeechServiceConfig,
  type AivisSpeechTtsClientOptions,
  checkAivisSpeechServiceHealth,
  createAivisSpeechTtsClient,
  createAppleSpeechStreamingSttClient,
  defineAivisSpeechService,
  defineAppleSpeechSidecar,
  defineTtsProviderStageObservation
} from "../modules/voice/index.js";
import { createDeferredToolCoordinator } from "./deferred-tool-coordinator.js";
import {
  type MacOSResidentIoBridge,
  type MacOSResidentIoControlEvent,
  type MacOSResidentIoControlOutcome,
  startMacOSResidentIoBridge
} from "./macos-resident-io-bridge.js";
import type { PiAgentTurnClientOptions } from "./pi-agent-turn.js";
import {
  assertResidentPlaybackReadiness,
  createResidentAudioOutputPlan,
  createResidentContinuousPlaybackSink,
  type ResidentAudioOutputPlan,
  residentPlaybackFinalSilenceMs
} from "./resident-audio-playback.js";
import { createResidentHealthPublicationGate } from "./resident-health-publication.js";
import type { ResidentIoMessage, ResidentIoTimingStage } from "./resident-io-protocol.js";
import {
  acquireResidentSingleInstanceLock,
  registerResidentSingleInstanceLockShutdownCleanup
} from "./resident-single-instance-lock.js";
import {
  createAuditEventFanout,
  createResidentVoiceAuditLog,
  type ResidentVoiceAuditLogStdoutMode
} from "./resident-voice-audit-log.js";
import { createResidentVoiceConsoleLog } from "./resident-voice-console-log.js";
import {
  createResidentVoiceCompositeLogSink,
  createResidentVoiceFileLogSink,
  type ResidentVoiceFileLogSink,
  type ResidentVoiceLogRunMode,
  requireResidentVoiceRunId
} from "./resident-voice-log-files.js";
import {
  type ResidentVoiceOperatorSink,
  recordResidentVoiceOperatorEvent
} from "./resident-voice-operator.js";
import {
  createEnergySpeechActivityGate,
  createTenWasmSpeechActivityGate
} from "./speech-activity-gate.js";
import {
  createVoiceResidentRuntime,
  type PiAgentTurnClient,
  type VoiceResidentRuntime
} from "./voice-resident.js";
import {
  recordVoiceStageProbe,
  type VoiceStageProbe,
  voiceRuntimeStagePolicy
} from "./voice-stage-probe.js";

export type ResidentVoiceStartupReadinessDependencies = {
  readonly platform?: NodeJS.Platform;
  readonly checkAivisHealth?: typeof checkAivisSpeechServiceHealth;
  readonly assertPlaybackReadiness?: (plan: ResidentAudioOutputPlan) => Promise<void>;
};

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
  const runtime = runResidentVoiceWithProviders({
    config,
    signal: abortController.signal,
    createPiAgent
  });

  await waitForDirectResidentVoiceRuntime({
    runtime,
    signal: abortController.signal,
    shutdownGraceMs: config.voice.resident.shutdownGraceMs,
    releaseLock: () => lock.release(),
    unregisterShutdownCleanup
  });
}

export async function waitForDirectResidentVoiceRuntime(input: {
  readonly runtime: Promise<void>;
  readonly signal: AbortSignal;
  readonly shutdownGraceMs: number;
  readonly releaseLock: () => void;
  readonly unregisterShutdownCleanup: () => void;
}): Promise<void> {
  const runtimeWithRelease = input.runtime.finally(input.releaseLock);
  // A shutdown timeout can settle first, so observe any later runtime or release failure.
  void runtimeWithRelease.catch(() => undefined);

  try {
    await withShutdownGrace(runtimeWithRelease, input.signal, input.shutdownGraceMs);
  } finally {
    input.unregisterShutdownCleanup();
  }
}

export async function runResidentVoiceWithProviders(input: {
  readonly config: PicoConfig;
  readonly signal: AbortSignal;
  readonly piAgent?: PiAgentTurnClient;
  readonly createPiAgent?: (options: PiAgentTurnClientOptions) => PiAgentTurnClient;
  readonly createTelemetry?: (options: OpenTelemetryProviderOptions) => PicoTelemetry;
  readonly startupReadiness?: (config: PicoConfig) => Promise<void>;
  readonly operator?: ResidentVoiceOperatorSink;
}): Promise<void> {
  const { config, signal } = input;
  requireResidentVoiceEnabled(config);
  await resolveStartupReadiness(input.startupReadiness)(config);
  const stdoutProbeMode = readVoiceProbeStdoutMode(process.env.PICO_VOICE_PROBE_STDOUT);
  const logRunMode = readResidentVoiceLogRunMode(process.env.PICO_RESIDENT_VOICE_LOG_MODE);
  const runId = readResidentVoiceRunId(process.env.PICO_RESIDENT_VOICE_RUN_ID);
  const fileLog = createResidentVoiceFileLogSink({
    homeDirectory: homedir(),
    runMode: logRunMode,
    onDiagnostic: (diagnostic) => {
      process.stderr.write(
        `[pico] resident voice log ${diagnostic.code} dropped=${String(diagnostic.droppedRecordCount)}\n`
      );
    },
    ...(runId === undefined ? {} : { runId })
  });
  await runWithResidentVoiceFileLog(fileLog, async () => {
    const writeProcessLine = (line: string): void => {
      fileLog.writeProcessLine(line);

      if (stdoutProbeMode !== undefined) {
        process.stdout.write(line);
      }
    };
    const telemetry = createConfiguredOpenTelemetry(
      config.telemetry.otel,
      input.createTelemetry ?? createOpenTelemetryProvider,
      writeProcessLine
    );

    try {
      const audit = config.voice.probes.enabled
        ? createResidentVoiceAuditLog({
            stdoutEnabled: true,
            writeStdout: writeProcessLine,
            writeEvent: createAuditEventFanout([
              (event) => {
                writeResidentVoiceMetricEvent(fileLog.writeAuditEvent, event);
              },
              ...(telemetry === undefined
                ? []
                : [
                    (event: AuditEvent) => {
                      if (shouldExportResidentVoiceAuditEvent(event)) {
                        telemetry.record(event);
                      }
                    }
                  ])
            ]),
            ...(stdoutProbeMode === undefined ? {} : { stdoutMode: stdoutProbeMode })
          })
        : undefined;
      const sessionLifecycle = createSessionLifecycle({
        ending: config.session.ending,
        ...(audit === undefined ? {} : { audit })
      });
      const stageProbe = createResidentVoiceStageProbe(audit, input.operator);
      const deferredTools = createDeferredToolCoordinator();
      const stt = createConfiguredStt(config);
      const tts = createConfiguredTts(config, stageProbe);
      const control = requireResidentControlConfig(config);
      const audioInput = requireMacOSResidentAudioInput(config);
      const echoControl = createConfiguredEchoControl(config);
      const playback = createResidentContinuousPlaybackSink(
        createResidentAudioOutputPlan(config),
        undefined,
        { finalSilenceMs: residentPlaybackFinalSilenceMs }
      );
      const piAgent = resolveResidentPiAgent(input.piAgent, input.createPiAgent, {
        cwd: process.cwd(),
        deferredTools: {
          coordinator: deferredTools
        },
        voiceProbe: stageProbe,
        ...(input.operator === undefined ? {} : { operator: input.operator })
      });
      const speechActivity = await createConfiguredSpeechActivityGate(config);
      const healthPublication = createResidentHealthPublicationGate();

      await runResidentControlLifecycle({
        signal,
        startBridge: (handleControl, handleTailComplete, handleCaptureUnavailable) =>
          startMacOSResidentIoBridge({
            input: {
              deviceUid: audioInput.deviceUid,
              sampleRateHz: config.voice.echoControl.sampleRateHz,
              channels: config.voice.echoControl.channels,
              frameMs: config.voice.echoControl.frameMs,
              releaseTailMs: 250,
              talkKey: control.keyboard.talkKey,
              cancelKey: control.keyboard.cancelKey
            },
            handleControl,
            handleTailComplete,
            handleCaptureInvalidated: handleCaptureUnavailable,
            observeHealth: async (event) => {
              if (healthPublication.accept(event, performance.now())) {
                writeProcessLine(formatResidentIoHealthLine(event));
                audit?.record({
                  category: "transport_event",
                  name: "voice.resident_io.health",
                  severity: event.state === "running" ? "info" : "warn",
                  occurredAt: new Date().toISOString(),
                  summary: "Pico macOS resident I/O health changed.",
                  attributes: {
                    "pico.voice.resident_io.state": event.state,
                    "pico.voice.resident_io.code": event.code,
                    "pico.voice.resident_io.restart_count": event.restartCount,
                    "pico.voice.resident_io.dropped_frame_count": event.droppedFrameCount,
                    "pico.voice.resident_io.buffer_cadence_ms": event.bufferCadenceMs,
                    "pico.voice.resident_io.outside_ptt_dropped_frame_count":
                      event.outsidePttDroppedFrameCount,
                    "pico.voice.resident_io.suppressed_dropped_frame_count":
                      event.suppressedDroppedFrameCount
                  }
                });
              }
              if (event.state !== "running") {
                await handleCaptureUnavailable();
              }
            },
            observeTiming: (event) => recordResidentIoTimingEvent(stageProbe, event),
            signal
          }),
        createRuntime: (bridge) => {
          writeProcessLine("[pico] macOS resident I/O: ready\n");
          return createVoiceResidentRuntime({
            audioCapture: bridge.audioCapture,
            captureBoundary: {
              suppress: bridge.suppressCapture,
              resume: bridge.resumeCapture
            },
            sessionLifecycle,
            echoControl,
            speechActivity,
            stt,
            tts,
            playback,
            piAgent,
            deferredTools,
            farewell: { enabled: true },
            log: createResidentVoiceRuntimeLogSink(logRunMode, fileLog, stdoutProbeMode),
            probe: stageProbe,
            ...(input.operator === undefined ? {} : { operator: input.operator }),
            signal
          });
        }
      });
    } finally {
      await shutdownResidentVoiceTelemetry(telemetry, writeProcessLine);
    }
  });
}

export async function runWithResidentVoiceFileLog(
  fileLog: ResidentVoiceFileLogSink,
  operation: () => Promise<void>
): Promise<void> {
  let operationFailure: unknown;
  let operationFailed = false;
  try {
    await fileLog.ready;
    await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  let closeFailure: unknown;
  let closeFailed = false;
  try {
    await fileLog.close();
  } catch (error) {
    closeFailed = true;
    closeFailure = error;
  }

  if (operationFailed) throw operationFailure;
  if (closeFailed) throw closeFailure;
}

function residentIoVoiceStage(stage: ResidentIoTimingStage) {
  return `resident_${stage}` as const;
}

export function recordResidentIoTimingEvent(
  stageProbe: VoiceStageProbe,
  event: Extract<ResidentIoMessage, { kind: "timing_event" }>,
  occurredAtMs = Date.now()
): void {
  recordVoiceStageProbe(stageProbe, {
    stage: residentIoVoiceStage(event.stage),
    status: "ok",
    startedAt: new Date(Math.max(0, occurredAtMs - event.durationMs)).toISOString(),
    durationMs: event.durationMs,
    ...(event.controlResult === undefined
      ? {}
      : {
          attributes: {
            "pico.voice.control_result": event.controlResult
          }
        })
  });
}

export function formatResidentIoHealthLine(
  event: Extract<ResidentIoMessage, { kind: "health_event" }>
): string {
  const expectedDiscardedSampleFrames =
    event.outsidePttDroppedFrameCount + event.suppressedDroppedFrameCount;
  const abnormalDroppedSampleFrames = Math.max(
    0,
    event.droppedFrameCount - expectedDiscardedSampleFrames
  );
  const abnormalLoss =
    event.state !== "running" || abnormalDroppedSampleFrames > 0
      ? ` abnormal_dropped_sample_frames=${String(abnormalDroppedSampleFrames)}`
      : "";

  return `[pico] macOS resident I/O health: ${event.state}/${event.code} restarts=${String(event.restartCount)} outside_ptt_discarded_sample_frames=${String(event.outsidePttDroppedFrameCount)} suppressed_discarded_sample_frames=${String(event.suppressedDroppedFrameCount)}${abnormalLoss}\n`;
}

function resolveStartupReadiness(
  startupReadiness: ((config: PicoConfig) => Promise<void>) | undefined
): (config: PicoConfig) => Promise<void> {
  return startupReadiness ?? assertResidentVoiceStartupReadiness;
}

export function createResidentVoiceStageProbe(
  audit: VoiceStageProbe["audit"],
  operator: ResidentVoiceOperatorSink | undefined
): VoiceStageProbe {
  return {
    ...(audit === undefined ? {} : { audit }),
    ...(operator === undefined
      ? {}
      : {
          observe: (observation) => {
            if (
              observation.stage === "pi_turn" &&
              operator.scopeStagesToCurrentTurn !== undefined
            ) {
              return;
            }
            recordResidentVoiceOperatorEvent(operator, {
              kind: "stage",
              stage: observation.stage,
              status: observation.status,
              durationMs: observation.durationMs,
              attributes: observation.attributes
            });
          }
        })
  };
}

export function createConfiguredOpenTelemetry(
  config: PicoTelemetryOtelConfig,
  createTelemetry: (
    options: OpenTelemetryProviderOptions
  ) => PicoTelemetry = createOpenTelemetryProvider,
  writeProcessLine?: (line: string) => void
): PicoTelemetry | undefined {
  if (!config.enabled) {
    return undefined;
  }

  return createTelemetry({
    baseUrl: requireTelemetryConfigValue(config.baseUrl, "baseUrl"),
    serviceName: requireTelemetryConfigValue(config.serviceName, "serviceName"),
    timeoutMs: requireTelemetryConfigValue(config.timeoutMs, "timeoutMs"),
    metricExportIntervalMs: requireTelemetryConfigValue(
      config.metricExportIntervalMs,
      "metricExportIntervalMs"
    ),
    shutdownTimeoutMs: requireTelemetryConfigValue(config.shutdownTimeoutMs, "shutdownTimeoutMs"),
    ...(writeProcessLine === undefined
      ? {}
      : {
          onDiagnostic: (diagnostic) => {
            writeProcessLine(`[pico] telemetry ${diagnostic.phase} failed\n`);
          }
        })
  });
}

export async function shutdownResidentVoiceTelemetry(
  telemetry: PicoTelemetry | undefined,
  writeProcessLine: (line: string) => void
): Promise<void> {
  if (telemetry === undefined) {
    return;
  }

  try {
    await telemetry.shutdown();
  } catch {
    writeProcessLine("[pico] telemetry shutdown failed\n");
  }
}

function requireTelemetryConfigValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`pico telemetry OTel ${name} is required when enabled`);
  }

  return value;
}

export type ResidentControlLifecycleOptions = {
  readonly signal: AbortSignal;
  readonly createRuntime: (bridge: MacOSResidentIoBridge) => VoiceResidentRuntime;
  readonly startBridge: (
    handleControl: (
      event: MacOSResidentIoControlEvent
    ) => MacOSResidentIoControlOutcome | Promise<MacOSResidentIoControlOutcome>,
    handleTailComplete: (generation: number) => void | Promise<void>,
    handleCaptureUnavailable: (generation?: number) => void | Promise<void>
  ) => Promise<MacOSResidentIoBridge>;
  readonly now?: () => string;
};

export async function runResidentControlLifecycle(
  options: ResidentControlLifecycleOptions
): Promise<void> {
  let runtime: VoiceResidentRuntime | undefined;
  let bridge: MacOSResidentIoBridge | undefined;
  const now = options.now ?? (() => new Date().toISOString());
  let lifecycleFailed = false;
  let lifecycleFailure: unknown;

  try {
    bridge = await options.startBridge(
      async (event) => {
        if (runtime === undefined) {
          return { result: "ignored_busy" };
        }
        const result = await runtime.handleControl({ kind: event.kind, occurredAt: now() });
        const generation =
          event.kind === "talk_pressed" && result === "accepted"
            ? runtime.generationId()
            : undefined;
        return { result, ...(generation === undefined ? {} : { generation }) };
      },
      async (generation) => {
        await runtime?.handleControl({
          kind: "tail_complete",
          generationId: generation,
          occurredAt: now()
        });
      },
      async (generation) => {
        if (
          runtime === undefined ||
          (generation !== undefined && runtime.generationId() !== generation) ||
          runtime.state() === "idle" ||
          runtime.state() === "error" ||
          runtime.state() === "stopped"
        ) {
          return;
        }
        await runtime.handleControl({ kind: "cancel_pressed", occurredAt: now() });
      }
    );
    runtime = options.createRuntime(bridge);

    await Promise.race([
      waitForAbort(options.signal),
      rejectUnexpectedCompletion(
        runtime.completion,
        options.signal,
        "pico resident voice runtime exited unexpectedly"
      ),
      rejectUnexpectedCompletion(
        bridge.completion,
        options.signal,
        "pico macOS control bridge exited unexpectedly"
      )
    ]);
  } catch (error) {
    lifecycleFailed = true;
    lifecycleFailure = error;
  }

  const cleanupFailure = await closeResidentControlOwners(runtime, bridge);

  if (lifecycleFailed) {
    throw lifecycleFailure;
  }

  if (cleanupFailure.failed) {
    throw cleanupFailure.error;
  }
}

type ResidentControlCleanupResult =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

async function closeResidentControlOwners(
  runtime: VoiceResidentRuntime | undefined,
  bridge: MacOSResidentIoBridge | undefined
): Promise<ResidentControlCleanupResult> {
  let result: ResidentControlCleanupResult = { failed: false };
  const close = async (operation: (() => Promise<void>) | undefined): Promise<void> => {
    if (operation === undefined) {
      return;
    }

    try {
      await operation();
    } catch (error) {
      if (!result.failed) {
        result = { failed: true, error };
      }
    }
  };

  await close(runtime === undefined ? undefined : () => runtime.stop());
  await close(bridge === undefined ? undefined : () => bridge.close());

  return result;
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

export function requireResidentVoiceEnabled(config: PicoConfig): PicoResidentControlConfig {
  if (!config.voice.resident.enabled) {
    throw new Error("pico resident voice runtime requires voice.resident.enabled=true");
  }

  return requireResidentControlConfig(config);
}

function requireResidentControlConfig(config: PicoConfig): PicoResidentControlConfig {
  const control = config.voice.resident.control;

  if (control === undefined) {
    throw new Error("pico resident voice runtime requires voice.resident.control config");
  }

  return control;
}

function requireMacOSResidentAudioInput(
  config: PicoConfig
): Extract<
  NonNullable<PicoConfig["voice"]["resident"]["audioInput"]>,
  { provider: "avaudioengine" }
> {
  const audioInput = config.voice.resident.audioInput;

  if (audioInput?.provider !== "avaudioengine") {
    throw new Error(
      "pico macOS resident I/O requires voice.resident.audioInput.provider=avaudioengine"
    );
  }

  return audioInput;
}

function createResidentVoiceRuntimeLogSink(
  logRunMode: ResidentVoiceLogRunMode,
  fileLog: ReturnType<typeof createResidentVoiceFileLogSink>,
  stdoutProbeMode: ResidentVoiceAuditLogStdoutMode | undefined
) {
  if (stdoutProbeMode !== undefined && logRunMode === "development") {
    return createResidentVoiceCompositeLogSink([createResidentVoiceConsoleLog(), fileLog]);
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

  if (event.name === "voice.runtime.stage" && voiceRuntimeStagePolicy(stage)?.persisted === true) {
    writeAuditEvent(event);
  }
}

function shouldExportResidentVoiceAuditEvent(event: AuditEvent): boolean {
  if (event.name !== "voice.runtime.stage") {
    return true;
  }

  return voiceRuntimeStagePolicy(event.attributes["pico.voice.stage"])?.persisted === true;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function rejectUnexpectedCompletion<T>(
  completion: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<void> {
  await completion;

  if (!signal.aborted) {
    throw new Error(message);
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

export function createConfiguredEchoControl(config: PicoConfig): EchoControlProvider {
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

export async function createConfiguredSpeechActivityGate(config: PicoConfig) {
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

export function createConfiguredStt(config: PicoConfig) {
  const appleSpeech = config.voice.stt.appleSpeech;

  if (appleSpeech === undefined) {
    throw new Error("pico resident voice requires voice.stt.appleSpeech config");
  }

  return createAppleSpeechStreamingSttClient(
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

export function createConfiguredTts(
  config: PicoConfig,
  probe: VoiceStageProbe = {},
  options: AivisSpeechTtsClientOptions = {}
) {
  const callerObserver = options.observeStage;
  const probeObserver: NonNullable<AivisSpeechTtsClientOptions["observeStage"]> = (observation) => {
    recordVoiceStageProbe(probe, {
      stage: observation.stage === "audio_query" ? "tts_audio_query" : "tts_synthesize",
      status: observation.status,
      startedAt: observation.startedAt,
      durationMs: observation.durationMs,
      attributes: {
        "pico.voice.sentence_index": observation.sentenceIndex,
        ...(observation.errorCode === undefined
          ? {}
          : { "pico.voice.error_code": observation.errorCode })
      }
    });
  };

  return createAivisSpeechTtsClient(buildAivisSpeechService(config), {
    ...options,
    observeStage: (observation) => {
      const trustedObservation = defineTtsProviderStageObservation(observation);
      const callerObservation = defineTtsProviderStageObservation(observation);
      notifyTtsStageObserver(probeObserver, trustedObservation);
      notifyTtsStageObserver(callerObserver, callerObservation);
    }
  });
}

function notifyTtsStageObserver(
  observer: AivisSpeechTtsClientOptions["observeStage"],
  observation: Parameters<NonNullable<AivisSpeechTtsClientOptions["observeStage"]>>[0]
): void {
  try {
    observer?.(observation);
  } catch {
    // Each telemetry consumer is isolated from the provider and from its peers.
  }
}

export async function assertResidentVoiceStartupReadiness(
  config: PicoConfig,
  dependencies: ResidentVoiceStartupReadinessDependencies = {}
): Promise<void> {
  const healthCheck = dependencies.checkAivisHealth ?? checkAivisSpeechServiceHealth;
  const playbackCheck = dependencies.assertPlaybackReadiness ?? assertResidentPlaybackReadiness;
  const service = buildAivisSpeechService(config);
  const plan = createResidentAudioOutputPlan(config, dependencies.platform);
  const [healthResult, playbackResult] = await Promise.allSettled([
    healthCheck(service),
    playbackCheck(plan)
  ]);

  if (healthResult.status === "rejected") {
    throw healthResult.reason;
  }

  const health = healthResult.value;

  if (!health.ok) {
    throw new Error(`pico resident voice TTS provider is unhealthy: ${health.message}`);
  }

  if (playbackResult.status === "rejected") {
    throw playbackResult.reason;
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
