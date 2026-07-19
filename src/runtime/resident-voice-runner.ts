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
  checkAivisSpeechServiceHealth,
  createAivisSpeechTtsClient,
  createAppleSpeechSttClient,
  defineAivisSpeechService,
  defineAppleSpeechSidecar
} from "../modules/voice/index.js";
import { createDeferredToolCoordinator } from "./deferred-tool-coordinator.js";
import { type MacOSControlBridge, startMacOSControlBridge } from "./macos-control-bridge.js";
import type { PiAgentTurnClientOptions } from "./pi-agent-turn.js";
import { createResidentAudioCapture } from "./resident-audio-io.js";
import {
  createResidentAudioOutputPlan,
  createResidentContinuousPlaybackSink
} from "./resident-audio-playback.js";
import {
  createLoopbackHttpResidentControlServer,
  type ResidentControlHandler,
  type ResidentControlServer
} from "./resident-control.js";
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
  type ResidentVoiceLogRunMode,
  requireResidentVoiceRunId
} from "./resident-voice-log-files.js";
import {
  createEnergySpeechActivityGate,
  createTenWasmSpeechActivityGate
} from "./speech-activity-gate.js";
import {
  createVoiceResidentRuntime,
  type PiAgentTurnClient,
  type VoiceResidentRuntime
} from "./voice-resident.js";
import { voiceRuntimeStagePolicy } from "./voice-stage-probe.js";

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
    const deferredTools = createDeferredToolCoordinator();
    const stt = createConfiguredStt(config);
    const tts = createConfiguredTts(config);
    const control = requireResidentControlConfig(config);
    const audioCapture = createResidentAudioCapture(config);
    const echoControl = createConfiguredEchoControl(config);
    const playback = createResidentContinuousPlaybackSink(createResidentAudioOutputPlan(config));
    const piAgent = resolveResidentPiAgent(input.piAgent, input.createPiAgent, {
      cwd: process.cwd(),
      deferredTools: {
        coordinator: deferredTools
      },
      ...(audit === undefined ? {} : { voiceProbe: { audit } })
    });
    const speechActivity = await createConfiguredSpeechActivityGate(config);

    await runResidentControlLifecycle({
      signal,
      startServer: async (handle) => {
        const server = await createLoopbackHttpResidentControlServer({
          host: control.host,
          port: control.port,
          authTokenPath: control.authTokenPath,
          shutdownTimeoutMs: config.voice.resident.shutdownGraceMs,
          handle,
          signal
        });
        writeProcessLine(`[pico] resident control: ${server.url}\n`);

        return server;
      },
      createRuntime: () =>
        createVoiceResidentRuntime({
          audioCapture,
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
          ...(audit === undefined ? {} : { probe: { audit } }),
          signal
        }),
      startBridge: () => startMacOSControlBridge({ control, signal })
    });
  } finally {
    await shutdownResidentVoiceTelemetry(telemetry, writeProcessLine);
  }
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
  readonly startServer: (handle: ResidentControlHandler) => Promise<ResidentControlServer>;
  readonly createRuntime: () => VoiceResidentRuntime;
  readonly startBridge: () => Promise<MacOSControlBridge>;
};

export async function runResidentControlLifecycle(
  options: ResidentControlLifecycleOptions
): Promise<void> {
  let runtime: VoiceResidentRuntime | undefined;
  let bridge: MacOSControlBridge | undefined;
  const server = await options.startServer((event) =>
    runtime === undefined ? "ignored_busy" : runtime.handleControl(event)
  );
  let lifecycleFailed = false;
  let lifecycleFailure: unknown;

  try {
    runtime = options.createRuntime();
    bridge = await options.startBridge();

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

  const cleanupFailure = await closeResidentControlOwners(runtime, bridge, server);

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
  bridge: MacOSControlBridge | undefined,
  server: ResidentControlServer
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
  await close(() => server.close());

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

export function requireResidentVoiceEnabled(config: PicoConfig): void {
  if (!config.voice.resident.enabled) {
    throw new Error("pico resident voice runtime requires voice.resident.enabled=true");
  }

  requireResidentControlConfig(config);
}

function requireResidentControlConfig(config: PicoConfig): PicoResidentControlConfig {
  const control = config.voice.resident.control;

  if (control === undefined) {
    throw new Error("pico resident voice runtime requires voice.resident.control config");
  }

  return control;
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

export function createConfiguredTts(config: PicoConfig) {
  return createAivisSpeechTtsClient(buildAivisSpeechService(config));
}

export async function assertResidentVoiceStartupReadiness(config: PicoConfig): Promise<void> {
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
