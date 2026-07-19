#!/usr/bin/env jiti
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { AuthStorage, type ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import type { AuditEvent, StructuredAuditLog } from "../../src/modules/audit/index.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import type { PicoTelemetry, TelemetryHealthSnapshot } from "../../src/modules/telemetry/index.js";
import type { AivisSpeechTtsClientOptions, TtsClient } from "../../src/modules/voice/index.js";
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
  createPrivateResidentVoiceArtifact,
  createPrivateResidentVoiceValidationSink,
  type PrivateResidentVoiceArtifact,
  type PrivateResidentVoiceValidationSink,
  type ResidentVoiceValidationEvent,
  type ResidentVoiceValidationSink
} from "../../src/runtime/resident-voice-validation.js";
import type { VoicePlaybackSink } from "../../src/runtime/voice-playback.js";
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
  readonly reportOutputPath?: string;
  readonly requiredToolName?: string;
  readonly expectedTranscriptSha256?: string;
  readonly timeoutMs: number;
  readonly help: boolean;
};

export type ResidentVoicePseudoAudioReport = {
  readonly status: "passed" | "failed";
  readonly audioFixturePath: string;
  readonly validationOutputPath: string;
  readonly validationEventCount: number;
  readonly validation: {
    readonly staffTranscriptPresent: boolean;
    readonly finalPiResponsePresent: boolean;
  };
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
  readonly playback: { readonly sinkOpenCount: number };
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
    readonly sentenceIndex?: number;
    readonly chunkCount?: number;
    readonly playedChunkCount?: number;
  }[];
};

export type ResidentVoicePseudoAudioEvidence = {
  readonly passed: boolean;
  readonly validationEventCount: number;
  readonly validation: {
    readonly staffTranscriptPresent: boolean;
    readonly finalPiResponsePresent: boolean;
  };
  readonly toolExecutions: ResidentVoicePseudoAudioReport["toolExecutions"];
  readonly playback: { readonly sinkOpenCount: number };
  readonly stages: ResidentVoicePseudoAudioReport["stages"];
};

export type ResidentVoicePseudoAudioPlaybackMeasurement = {
  readonly playback: VoicePlaybackSink;
  readonly openCount: () => number;
};

// Exported only as a field-harness test seam around the real playback sink.
export function createResidentVoicePseudoAudioPlaybackMeasurement(
  delegate: VoicePlaybackSink
): ResidentVoicePseudoAudioPlaybackMeasurement {
  let openCount = 0;

  return {
    playback: {
      open(firstChunk, signal) {
        openCount += 1;
        return delegate.open(firstChunk, signal);
      },
      stop: () => delegate.stop(),
      close: () => delegate.close()
    },
    openCount: () => openCount
  };
}

const singletonMeasuredStages = new Set([
  "tts_time_to_first_chunk",
  "tts_request_wall",
  "ptt_release_to_playback_start",
  "tts_playback"
]);
const repeatedMeasuredStages = new Set(["tts_audio_query", "tts_synthesize"]);
const lowercaseSha256Pattern = /^[\da-f]{64}$/u;

// Exported only as a field-harness test seam. It never returns validation content.
export function evaluateResidentVoicePseudoAudioEvidence(input: {
  readonly validationEvents: readonly ResidentVoiceValidationEvent[];
  readonly auditEvents: readonly AuditEvent[];
  readonly requiredToolName?: string;
  readonly expectedTranscriptSha256?: string;
  readonly playbackSinkOpenCount: number;
}): ResidentVoicePseudoAudioEvidence {
  const validationEvents = input.validationEvents.filter(isResidentVoiceValidationEvent);
  const validationEventsWellFormed = validationEvents.length === input.validationEvents.length;
  const validation = summarizeValidationContent(validationEvents, input.expectedTranscriptSha256);
  const toolExecutions = summarizePairedToolExecutions(validationEvents);
  const stages = summarizeStages(input.auditEvents);
  const requiredToolSucceeded = didRequiredToolSucceed(validationEvents, input.requiredToolName);
  const requiredStagesSucceeded = measuredStagesSucceeded(stages);
  const oneSession = new Set(validationEvents.map(({ sessionId }) => sessionId)).size === 1;
  const passed =
    validationEventsWellFormed &&
    oneSession &&
    validation.staffTranscriptPresent &&
    validation.finalPiResponsePresent &&
    requiredToolSucceeded &&
    requiredStagesSucceeded &&
    input.playbackSinkOpenCount === 1;

  return {
    passed,
    validationEventCount: input.validationEvents.length,
    validation,
    toolExecutions,
    playback: { sinkOpenCount: input.playbackSinkOpenCount },
    stages
  };
}

function summarizeValidationContent(
  events: readonly ResidentVoiceValidationEvent[],
  expectedTranscriptSha256: string | undefined
): ResidentVoicePseudoAudioEvidence["validation"] {
  const staffTranscripts = events.filter((event) => event.kind === "staff_transcript");
  const piResponses = events.filter((event) => event.kind === "pi_response");

  return {
    staffTranscriptPresent: isExpectedStaffTranscript(staffTranscripts, expectedTranscriptSha256),
    finalPiResponsePresent: isSingleNonEmptyPiResponse(piResponses)
  };
}

function isExpectedStaffTranscript(
  events: readonly ResidentVoiceValidationEvent[],
  expectedTranscriptSha256: string | undefined
): boolean {
  if (events.length !== 1) {
    return false;
  }
  const event = events[0];
  if (event?.kind !== "staff_transcript" || event.text.trim().length === 0) {
    return false;
  }

  return transcriptMatchesExpectedHash(event.text, expectedTranscriptSha256);
}

function isSingleNonEmptyPiResponse(events: readonly ResidentVoiceValidationEvent[]): boolean {
  if (events.length !== 1) {
    return false;
  }
  const event = events[0];
  return event?.kind === "pi_response" && event.text.trim().length > 0;
}

function transcriptMatchesExpectedHash(text: string, expected: string | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  if (!lowercaseSha256Pattern.test(expected)) {
    return false;
  }

  return createHash("sha256").update(text, "utf8").digest("hex") === expected;
}

function measuredStagesSucceeded(stages: ResidentVoicePseudoAudioReport["stages"]): boolean {
  const singletonStagesSucceeded = [...singletonMeasuredStages].every((requiredStage) => {
    const matching = stages.filter(({ stage }) => stage === requiredStage);
    return matching.length === 1 && matching[0]?.status === "ok";
  });
  const repeatedStagesSucceeded = [...repeatedMeasuredStages].every((requiredStage) => {
    const matching = stages.filter(({ stage }) => stage === requiredStage);
    return matching.length > 0 && matching.every(({ status }) => status === "ok");
  });

  return singletonStagesSucceeded && repeatedStagesSucceeded;
}

function isResidentVoiceValidationEvent(value: unknown): value is ResidentVoiceValidationEvent {
  if (!isValidationEventRecord(value)) {
    return false;
  }
  if (!hasValidValidationEventIdentity(value)) {
    return false;
  }

  return hasValidValidationEventPayload(value);
}

function hasValidValidationEventPayload(value: Record<string, unknown>): boolean {
  if (value.kind === "staff_transcript" || value.kind === "pi_response") {
    return typeof value.text === "string";
  }
  if (value.kind === "tool_execution_start") {
    return hasValidToolIdentity(value) && Object.hasOwn(value, "args");
  }
  if (value.kind === "tool_execution_end") {
    return hasValidToolIdentity(value) && hasValidToolEndDetails(value);
  }

  return false;
}

function isValidationEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidValidationEventIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.occurredAt === "string" &&
    !Number.isNaN(Date.parse(value.occurredAt)) &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim().length > 0
  );
}

function hasValidToolIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.toolCallId === "string" &&
    value.toolCallId.trim().length > 0 &&
    typeof value.toolName === "string" &&
    value.toolName.trim().length > 0
  );
}

function hasValidToolEndDetails(value: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(value, "result") &&
    typeof value.isError === "boolean" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

function summarizePairedToolExecutions(
  events: readonly ResidentVoiceValidationEvent[]
): ResidentVoicePseudoAudioReport["toolExecutions"] {
  const starts = events.filter(
    (event): event is Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_start" }> =>
      event.kind === "tool_execution_start"
  );
  const ends = events.filter(
    (event): event is Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_end" }> =>
      event.kind === "tool_execution_end"
  );

  return ends.flatMap((end) => {
    const matchingStarts = starts.filter(({ toolCallId }) => toolCallId === end.toolCallId);
    const matchingEnds = ends.filter(({ toolCallId }) => toolCallId === end.toolCallId);
    const start = matchingStarts[0];
    if (
      matchingStarts.length !== 1 ||
      matchingEnds.length !== 1 ||
      start === undefined ||
      start.toolName !== end.toolName
    ) {
      return [];
    }

    return [{ toolName: end.toolName, isError: end.isError, durationMs: end.durationMs }];
  });
}

function didRequiredToolSucceed(
  events: readonly ResidentVoiceValidationEvent[],
  requiredToolName: string | undefined
): boolean {
  const starts = events.filter(
    (event): event is Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_start" }> =>
      event.kind === "tool_execution_start"
  );
  const ends = events.filter(
    (event): event is Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_end" }> =>
      event.kind === "tool_execution_end"
  );
  if (requiredToolName === undefined) {
    const paired = summarizePairedToolExecutions(events);
    return (
      paired.length * 2 === starts.length + ends.length && paired.every(({ isError }) => !isError)
    );
  }
  return requiredToolSucceeded(starts, ends, requiredToolName);
}

function requiredToolSucceeded(
  starts: readonly Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_start" }>[],
  ends: readonly Extract<ResidentVoiceValidationEvent, { kind: "tool_execution_end" }>[],
  requiredToolName: string
): boolean {
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1) {
    return false;
  }
  if (start === undefined || end === undefined) {
    return false;
  }

  return (
    start.toolName === requiredToolName &&
    end.toolName === requiredToolName &&
    start.toolCallId === end.toolCallId &&
    !end.isError
  );
}

export function createResidentVoicePseudoAudioTts(
  config: PicoConfig,
  audit: StructuredAuditLog,
  options: AivisSpeechTtsClientOptions = {}
): TtsClient {
  return createConfiguredTts(config, { audit }, options);
}

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
  reportOutputPath?: string;
  requiredToolName?: string;
  expectedTranscriptSha256?: string;
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
  "--report-output": (state, value) => {
    state.reportOutputPath = value;
  },
  "--required-tool-name": (state, value) => {
    state.requiredToolName = value;
  },
  "--expected-transcript-sha256": (state, value) => {
    state.expectedTranscriptSha256 = readExpectedTranscriptSha256(value);
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
  const audioFixturePath = requirePseudoAudioPath(parsed.audioFixturePath, "--audio-fixture");
  const validationOutputPath = requirePseudoAudioPath(
    parsed.validationOutputPath,
    "--validation-output"
  );
  requireDistinctPseudoAudioPaths(audioFixturePath, validationOutputPath, parsed.reportOutputPath);

  return {
    audioFixturePath,
    validationOutputPath,
    ...optionalPseudoAudioArguments(parsed),
    timeoutMs: parsed.timeoutMs,
    help: false
  };
}

function requirePseudoAudioPath(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw invalidArguments(`${flag} is required`);
  }
  return value;
}

function requireDistinctPseudoAudioPaths(
  audioFixturePath: string,
  validationOutputPath: string,
  reportOutputPath: string | undefined
): void {
  if (audioFixturePath === validationOutputPath) {
    throw invalidArguments("--validation-output must differ from --audio-fixture");
  }
  if (
    reportOutputPath !== undefined &&
    (reportOutputPath === audioFixturePath || reportOutputPath === validationOutputPath)
  ) {
    throw invalidArguments(
      "--report-output must differ from --audio-fixture and --validation-output"
    );
  }
}

function optionalPseudoAudioArguments(
  parsed: MutablePseudoAudioArguments
): Pick<
  ResidentVoicePseudoAudioArguments,
  "reportOutputPath" | "requiredToolName" | "expectedTranscriptSha256"
> {
  return {
    ...(parsed.reportOutputPath === undefined ? {} : { reportOutputPath: parsed.reportOutputPath }),
    ...(parsed.requiredToolName === undefined ? {} : { requiredToolName: parsed.requiredToolName }),
    ...(parsed.expectedTranscriptSha256 === undefined
      ? {}
      : { expectedTranscriptSha256: parsed.expectedTranscriptSha256 })
  };
}

function readExpectedTranscriptSha256(value: string): string {
  if (!lowercaseSha256Pattern.test(value)) {
    throw invalidArguments("--expected-transcript-sha256 must be a lowercase SHA-256 hex digest");
  }
  return value;
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
    "Usage: npm run field:resident-voice-pseudo-audio -- --audio-fixture path.wav|path.pcm --validation-output path.jsonl [--report-output path.json] [--required-tool-name name] [--expected-transcript-sha256 digest] [--timeout-ms 120000]",
    "",
    "Runs one explicit full resident voice turn with finite injected audio.",
    "The validation output is a mode-0600 contentful JSONL artifact containing recognized text, Pi response text, and tool arguments/results.",
    "When --report-output is set, the metadata-only report is written directly to a separate mode-0600 file instead of shared stdout.",
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
  const validationEvents: ResidentVoiceValidationEvent[] = [];
  const validation: ResidentVoiceValidationSink = {
    record(event) {
      input.privateValidation.record(event);
      validationEvents.push(event);
    }
  };
  const audit = createResidentVoiceAuditLog({
    stdoutEnabled: false,
    writeEvent(event) {
      auditEvents.push(event);
      telemetry.record(event);
    }
  });
  const playbackMeasurement = createResidentVoicePseudoAudioPlaybackMeasurement(
    createResidentContinuousPlaybackSink(createResidentAudioOutputPlan(config))
  );
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
      tts: createResidentVoicePseudoAudioTts(config, audit),
      playback: playbackMeasurement.playback,
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
    const evidence = evaluateResidentVoicePseudoAudioEvidence({
      validationEvents,
      auditEvents,
      ...(arguments_.requiredToolName === undefined
        ? {}
        : { requiredToolName: arguments_.requiredToolName }),
      ...(arguments_.expectedTranscriptSha256 === undefined
        ? {}
        : { expectedTranscriptSha256: arguments_.expectedTranscriptSha256 }),
      playbackSinkOpenCount: playbackMeasurement.openCount()
    });
    const passed =
      runtimeResult.completedTurns === 1 &&
      evidence.passed &&
      health.logs.consecutiveFailures === 0 &&
      health.metrics.consecutiveFailures === 0;

    return {
      status: passed ? "passed" : "failed",
      audioFixturePath: arguments_.audioFixturePath,
      validationOutputPath: arguments_.validationOutputPath,
      validationEventCount: evidence.validationEventCount,
      validation: evidence.validation,
      ...(arguments_.requiredToolName === undefined
        ? {}
        : { requiredToolName: arguments_.requiredToolName }),
      toolExecutions: evidence.toolExecutions,
      agent: {
        provider: agentSettings.model.provider,
        id: agentSettings.model.id,
        thinkingLevel: agentSettings.thinkingLevel
      },
      runtime: runtimeResult,
      playback: evidence.playback,
      telemetry: {
        mode: inProcessCapture === undefined ? "configured_collector" : "in_process",
        health,
        ...(inspection === undefined ? {} : inspection)
      },
      stages: evidence.stages
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
    const sentenceIndex = event.attributes["pico.voice.sentence_index"];
    const chunkCount = event.attributes["pico.voice.chunk_count"];
    const playedChunkCount = event.attributes["pico.voice.played_chunk_count"];
    if (typeof stage !== "string" || typeof status !== "string" || typeof durationMs !== "number") {
      return [];
    }

    return [
      {
        stage,
        status,
        durationMs,
        ...summarizeStageMetadata({ errorCode, sentenceIndex, chunkCount, playedChunkCount })
      }
    ];
  });
}

function summarizeStageMetadata(input: {
  readonly errorCode: unknown;
  readonly sentenceIndex: unknown;
  readonly chunkCount: unknown;
  readonly playedChunkCount: unknown;
}): Pick<
  ResidentVoicePseudoAudioReport["stages"][number],
  "errorCode" | "sentenceIndex" | "chunkCount" | "playedChunkCount"
> {
  return {
    ...(typeof input.errorCode === "string" ? { errorCode: input.errorCode } : {}),
    ...(typeof input.sentenceIndex === "number" ? { sentenceIndex: input.sentenceIndex } : {}),
    ...(typeof input.chunkCount === "number" ? { chunkCount: input.chunkCount } : {}),
    ...(typeof input.playedChunkCount === "number"
      ? { playedChunkCount: input.playedChunkCount }
      : {})
  };
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
    `usage: field:resident-voice-pseudo-audio --audio-fixture path.wav|path.pcm --validation-output path.jsonl [--report-output path.json] [--required-tool-name name] [--expected-transcript-sha256 digest] [--timeout-ms 10000..300000]: ${reason}`
  );
}

export async function runResidentVoicePseudoAudioCommand(
  arguments_: ResidentVoicePseudoAudioArguments,
  dependencies: {
    readonly run?: typeof runResidentVoicePseudoAudio;
    readonly writeStdout?: (value: string) => void;
    readonly writeStderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  let reportOutput: ResidentVoicePseudoAudioReportOutput | undefined;

  try {
    reportOutput = openResidentVoicePseudoAudioReport(arguments_.reportOutputPath);
    const report = await (dependencies.run ?? runResidentVoicePseudoAudio)(arguments_);
    writeResidentVoicePseudoAudioReport(report, reportOutput, writeStdout);
    return residentVoicePseudoAudioReportExitCode(report.status);
  } catch (error) {
    writeStderr(`pico pseudo-audio validation failed: ${boundedErrorMessage(error)}\n`);
    return 2;
  } finally {
    reportOutput?.artifact.close();
  }
}

type ResidentVoicePseudoAudioReportOutput = {
  readonly path: string;
  readonly artifact: PrivateResidentVoiceArtifact;
};

function openResidentVoicePseudoAudioReport(
  path: string | undefined
): ResidentVoicePseudoAudioReportOutput | undefined {
  if (path === undefined) {
    return undefined;
  }
  return { path, artifact: createPrivateResidentVoiceArtifact({ path }) };
}

function writeResidentVoicePseudoAudioReport(
  report: ResidentVoicePseudoAudioReport,
  output: ResidentVoicePseudoAudioReportOutput | undefined,
  writeStdout: (value: string) => void
): void {
  const serialized = `${JSON.stringify(report, undefined, 2)}\n`;
  if (output === undefined) {
    writeStdout(serialized);
    return;
  }
  output.artifact.write(serialized);
  writeStdout(`pico pseudo-audio ${report.status}; metadata report written to ${output.path}\n`);
}

function residentVoicePseudoAudioReportExitCode(
  status: ResidentVoicePseudoAudioReport["status"]
): number {
  return status === "passed" ? 0 : 1;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message, "utf8").subarray(0, 1_024).toString("utf8");
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const arguments_ = readResidentVoicePseudoAudioArguments(process.argv.slice(2));
    if (arguments_.help) {
      process.stdout.write(`${formatResidentVoicePseudoAudioHelp()}\n`);
    } else {
      process.exitCode = await runResidentVoicePseudoAudioCommand(arguments_);
    }
  } catch (error) {
    process.stderr.write(`pico pseudo-audio validation failed: ${boundedErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
