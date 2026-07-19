#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { AuthStorage, type ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import type { AuditEvent } from "../../src/modules/audit/index.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import type { PicoTelemetry, TelemetryHealthSnapshot } from "../../src/modules/telemetry/index.js";
import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";
import type { ResidentAudioCapture } from "../../src/runtime/resident-audio-io.js";
import {
  createResidentAudioOutputPlan,
  createResidentContinuousPlaybackSink
} from "../../src/runtime/resident-audio-playback.js";
import { createResidentVoiceAuditLog } from "../../src/runtime/resident-voice-audit-log.js";
import {
  assertResidentVoiceStartupReadiness,
  createConfiguredEchoControl,
  createConfiguredOpenTelemetry,
  createConfiguredSpeechActivityGate,
  createConfiguredStt,
  createConfiguredTts,
  requireResidentVoiceEnabled
} from "../../src/runtime/resident-voice-runner.js";
import {
  createPrivateResidentVoiceValidationSink,
  type PrivateResidentVoiceValidationSink,
  type ResidentVoiceValidationSink
} from "../../src/runtime/resident-voice-validation.js";
import {
  createVoiceResidentRuntime,
  type VoiceResidentRuntime,
  type VoiceResidentRuntimeResult
} from "../../src/runtime/voice-resident.js";
import {
  createInProcessTelemetryCapture,
  type InProcessTelemetryCapture
} from "./in-process-telemetry.js";
import { createResidentAudioFixtureCapture } from "./resident-audio-fixture.js";

export type ResidentVoicePseudoAudioArguments = {
  readonly audioFixturePath: string;
  readonly validationOutputPath: string;
  readonly requiredToolName?: string;
  readonly timeoutMs: number;
  readonly help: boolean;
};

export type ResidentVoicePseudoAudioReport = {
  readonly status: "passed" | "failed";
  readonly audioFixturePath: string;
  readonly validationOutputPath: string;
  readonly validationEventCount: number;
  readonly requiredToolName?: string;
  readonly toolExecutions: readonly {
    readonly toolName: string;
    readonly isError: boolean;
    readonly durationMs: number;
  }[];
  readonly agent: {
    readonly provider: string;
    readonly id: string;
    readonly thinkingLevel: ResidentVoicePseudoAudioAgentSettings["thinkingLevel"];
  };
  readonly runtime: VoiceResidentRuntimeResult;
  readonly telemetry: {
    readonly mode: "configured_collector" | "in_process";
    readonly health: TelemetryHealthSnapshot;
    readonly logRecordCount?: number;
    readonly metricDataPointCount?: number;
  };
  readonly stages: readonly {
    readonly stage: string;
    readonly status: string;
    readonly durationMs: number;
    readonly errorCode?: string;
  }[];
};

type ResidentVoicePseudoAudioAgentSettings = {
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly thinkingLevel: NonNullable<PicoConfig["pico"]["model"]>["thinkingLevel"];
};

type ResidentVoicePseudoAudioModelFinder = (
  provider: string,
  id: string
) => NonNullable<ExtensionContext["model"]> | undefined;

const defaultTimeoutMs = 120_000;
const maximumTimeoutMs = 300_000;

type MutablePseudoAudioArguments = {
  audioFixturePath?: string;
  validationOutputPath?: string;
  requiredToolName?: string;
  timeoutMs: number;
};

const pseudoAudioArgumentReaders: Readonly<
  Record<string, (state: MutablePseudoAudioArguments, value: string) => void>
> = {
  "--audio-fixture": (state, value) => {
    state.audioFixturePath = value;
  },
  "--validation-output": (state, value) => {
    state.validationOutputPath = value;
  },
  "--required-tool-name": (state, value) => {
    state.requiredToolName = value;
  },
  "--timeout-ms": (state, value) => {
    state.timeoutMs = readPseudoAudioTimeout(value);
  }
};

export function readResidentVoicePseudoAudioArguments(
  arguments_: readonly string[]
): ResidentVoicePseudoAudioArguments {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return {
      audioFixturePath: "",
      validationOutputPath: "",
      timeoutMs: defaultTimeoutMs,
      help: true
    };
  }

  return readResidentVoicePseudoAudioArgumentPairs(arguments_);
}

function readResidentVoicePseudoAudioArgumentPairs(
  arguments_: readonly string[]
): ResidentVoicePseudoAudioArguments {
  const parsed: MutablePseudoAudioArguments = { timeoutMs: defaultTimeoutMs };

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    const read = flag === undefined ? undefined : pseudoAudioArgumentReaders[flag];
    if (read === undefined || value === undefined || value.trim() === "") {
      throw invalidArguments("each flag requires a non-empty value");
    }
    read(parsed, value);
  }

  return finalizePseudoAudioArguments(parsed);
}

function finalizePseudoAudioArguments(
  parsed: MutablePseudoAudioArguments
): ResidentVoicePseudoAudioArguments {
  if (parsed.audioFixturePath === undefined) {
    throw invalidArguments("--audio-fixture is required");
  }
  if (parsed.validationOutputPath === undefined) {
    throw invalidArguments("--validation-output is required");
  }
  if (parsed.audioFixturePath === parsed.validationOutputPath) {
    throw invalidArguments("--validation-output must differ from --audio-fixture");
  }

  return {
    audioFixturePath: parsed.audioFixturePath,
    validationOutputPath: parsed.validationOutputPath,
    ...(parsed.requiredToolName === undefined ? {} : { requiredToolName: parsed.requiredToolName }),
    timeoutMs: parsed.timeoutMs,
    help: false
  };
}

function readPseudoAudioTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > maximumTimeoutMs) {
    throw invalidArguments("--timeout-ms must be an integer from 10000 to 300000");
  }
  return parsed;
}

export function formatResidentVoicePseudoAudioHelp(): string {
  return [
    "Usage: npm run field:resident-voice-pseudo-audio -- --audio-fixture path.wav|path.pcm --validation-output path.jsonl [--required-tool-name name] [--timeout-ms 120000]",
    "",
    "Runs one explicit full resident voice turn with finite injected audio.",
    "The validation output is a mode-0600 contentful JSONL artifact containing recognized text, Pi response text, and tool arguments/results.",
    "Normal resident logs and OTel remain metadata-only. Delete the validation artifact when it is no longer needed."
  ].join("\n");
}

export function resolveResidentVoicePseudoAudioAgentSettings(
  config: PicoConfig,
  findModel: ResidentVoicePseudoAudioModelFinder = findConfiguredPiModel
): ResidentVoicePseudoAudioAgentSettings {
  const modelConfig = config.pico.model;
  if (modelConfig === undefined) {
    throw new Error("pico pseudo-audio validation requires pico.model config");
  }

  const model = findModel(modelConfig.provider, modelConfig.id);
  if (model === undefined) {
    throw new Error("pico pseudo-audio configured Pico model is unavailable");
  }

  return Object.freeze({ model, thinkingLevel: modelConfig.thinkingLevel });
}

function findConfiguredPiModel(
  provider: string,
  id: string
): NonNullable<ExtensionContext["model"]> | undefined {
  const authStorage = AuthStorage.create();
  return ModelRegistry.create(authStorage).find(provider, id);
}

export async function withResidentVoicePseudoAudioOwners<T>(input: {
  readonly telemetry: PicoTelemetry;
  readonly createValidation: () => PrivateResidentVoiceValidationSink;
  readonly run: (validation: PrivateResidentVoiceValidationSink) => Promise<T>;
}): Promise<T> {
  let validation: PrivateResidentVoiceValidationSink | undefined;
  let outcome: PromiseSettledResult<T>;

  try {
    validation = input.createValidation();
    outcome = { status: "fulfilled", value: await input.run(validation) };
  } catch (error) {
    outcome = { status: "rejected", reason: error };
  }

  const cleanupErrors: unknown[] = [];
  try {
    validation?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await input.telemetry.shutdown();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (outcome.status === "rejected") {
    throw asPseudoAudioError(outcome.reason);
  }
  if (cleanupErrors[0] !== undefined) {
    throw asPseudoAudioError(cleanupErrors[0]);
  }
  return outcome.value;
}

function asPseudoAudioError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// This orchestration is field-only; production resident startup never constructs these sinks.
export async function runResidentVoicePseudoAudio(
  arguments_: ResidentVoicePseudoAudioArguments
): Promise<ResidentVoicePseudoAudioReport> {
  const config = loadPicoConfigFromEnvironment();
  requireResidentVoiceEnabled(config);
  await assertResidentVoiceStartupReadiness(config);
  const audioCapture = createResidentAudioFixtureCapture({
    path: arguments_.audioFixturePath,
    expectedSampleRateHz: config.voice.echoControl.sampleRateHz,
    expectedChannels: config.voice.echoControl.channels,
    frameMs: config.voice.echoControl.frameMs
  });
  const agentSettings = resolveResidentVoicePseudoAudioAgentSettings(config);
  const inProcessCapture = config.telemetry.otel.enabled
    ? undefined
    : createInProcessTelemetryCapture();
  const telemetry =
    inProcessCapture?.telemetry ?? createConfiguredOpenTelemetry(config.telemetry.otel);
  if (telemetry === undefined) {
    throw new Error("pico pseudo-audio validation could not create telemetry");
  }

  return withResidentVoicePseudoAudioOwners({
    telemetry,
    createValidation: () =>
      createPrivateResidentVoiceValidationSink({ path: arguments_.validationOutputPath }),
    run: (privateValidation) =>
      executeResidentVoicePseudoAudio({
        arguments_,
        config,
        telemetry,
        inProcessCapture,
        audioCapture,
        agentSettings,
        privateValidation
      })
  });
}

// This field-only graph intentionally mirrors the real providers while exposing no production hook.
// eslint-disable-next-line complexity
async function executeResidentVoicePseudoAudio(input: {
  readonly arguments_: ResidentVoicePseudoAudioArguments;
  readonly config: PicoConfig;
  readonly telemetry: PicoTelemetry;
  readonly inProcessCapture: InProcessTelemetryCapture | undefined;
  readonly audioCapture: ResidentAudioCapture;
  readonly agentSettings: ResidentVoicePseudoAudioAgentSettings;
  readonly privateValidation: PrivateResidentVoiceValidationSink;
}): Promise<ResidentVoicePseudoAudioReport> {
  const { arguments_, config, telemetry, inProcessCapture, audioCapture, agentSettings } = input;
  const auditEvents: AuditEvent[] = [];
  const toolExecutions: Array<{ toolName: string; isError: boolean; durationMs: number }> = [];
  let validationEventCount = 0;
  const validation: ResidentVoiceValidationSink = {
    record(event) {
      input.privateValidation.record(event);
      validationEventCount += 1;
      if (event.kind === "tool_execution_end") {
        toolExecutions.push({
          toolName: event.toolName,
          isError: event.isError,
          durationMs: event.durationMs
        });
      }
    }
  };
  const audit = createResidentVoiceAuditLog({
    stdoutEnabled: false,
    writeEvent(event) {
      auditEvents.push(event);
      telemetry.record(event);
    }
  });
  const piAgent = createPiAgentTurnClient({
    cwd: process.cwd(),
    voiceProbe: { audit },
    validation,
    model: agentSettings.model,
    thinkingLevel: agentSettings.thinkingLevel
  });
  let runtime: VoiceResidentRuntime | undefined;

  try {
    runtime = createVoiceResidentRuntime({
      audioCapture,
      sessionLifecycle: createSessionLifecycle({ ending: config.session.ending, audit }),
      echoControl: createConfiguredEchoControl(config),
      speechActivity: await createConfiguredSpeechActivityGate(config),
      stt: createConfiguredStt(config),
      tts: createConfiguredTts(config),
      playback: createResidentContinuousPlaybackSink(createResidentAudioOutputPlan(config)),
      piAgent,
      farewell: { enabled: false },
      probe: { audit },
      validation
    });
    const occurredAt = new Date().toISOString();
    requireAccepted(await runtime.handleControl({ kind: "talk_pressed", occurredAt }), "press");
    requireAccepted(await runtime.handleControl({ kind: "talk_released", occurredAt }), "release");
    await waitForIdle(runtime, arguments_.timeoutMs);
    await withDeadline(runtime.stop(), arguments_.timeoutMs, "runtime_stop_timeout");
    const runtimeResult = await runtime.completion;
    await telemetry.forceFlush();
    const inspection = inProcessCapture?.inspection();
    const health = telemetry.health();
    const requiredToolSucceeded =
      arguments_.requiredToolName === undefined ||
      toolExecutions.some(
        (execution) => execution.toolName === arguments_.requiredToolName && !execution.isError
      );
    const passed =
      runtimeResult.completedTurns === 1 &&
      validationEventCount >= 2 &&
      requiredToolSucceeded &&
      health.logs.consecutiveFailures === 0 &&
      health.metrics.consecutiveFailures === 0;

    return {
      status: passed ? "passed" : "failed",
      audioFixturePath: arguments_.audioFixturePath,
      validationOutputPath: arguments_.validationOutputPath,
      validationEventCount,
      ...(arguments_.requiredToolName === undefined
        ? {}
        : { requiredToolName: arguments_.requiredToolName }),
      toolExecutions,
      agent: {
        provider: agentSettings.model.provider,
        id: agentSettings.model.id,
        thinkingLevel: agentSettings.thinkingLevel
      },
      runtime: runtimeResult,
      telemetry: {
        mode: inProcessCapture === undefined ? "configured_collector" : "in_process",
        health,
        ...(inspection === undefined ? {} : inspection)
      },
      stages: summarizeStages(auditEvents)
    };
  } finally {
    await runtime?.stop().catch(() => undefined);
  }
}

function summarizeStages(events: readonly AuditEvent[]): ResidentVoicePseudoAudioReport["stages"] {
  return events.flatMap((event) => {
    if (event.name !== "voice.runtime.stage") {
      return [];
    }

    const stage = event.attributes["pico.voice.stage"];
    const status = event.attributes["pico.voice.stage_status"];
    const durationMs = event.attributes["pico.voice.stage_duration_ms"];
    const errorCode = event.attributes["pico.voice.error_code"];
    if (typeof stage !== "string" || typeof status !== "string" || typeof durationMs !== "number") {
      return [];
    }

    return [
      {
        stage,
        status,
        durationMs,
        ...(typeof errorCode === "string" ? { errorCode } : {})
      }
    ];
  });
}

async function waitForIdle(runtime: VoiceResidentRuntime, timeoutMs: number): Promise<void> {
  const startedAt = performance.now();

  while (runtime.state() !== "idle") {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`pico pseudo-audio validation timed out in ${runtime.state()}`);
    }
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
      runtime.completion.then(() => undefined)
    ]);
  }
}

function requireAccepted(result: string, phase: string): void {
  if (result !== "accepted") {
    throw new Error(`pico pseudo-audio ${phase} was ${result}`);
  }
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(code)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function invalidArguments(reason: string): Error {
  return new Error(
    `usage: field:resident-voice-pseudo-audio --audio-fixture path.wav|path.pcm --validation-output path.jsonl [--required-tool-name name] [--timeout-ms 10000..300000]: ${reason}`
  );
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const arguments_ = readResidentVoicePseudoAudioArguments(process.argv.slice(2));
  if (arguments_.help) {
    process.stdout.write(`${formatResidentVoicePseudoAudioHelp()}\n`);
  } else {
    const report = await runResidentVoicePseudoAudio(arguments_);
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
}
