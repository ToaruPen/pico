import type { SessionMemoryWorker } from "../modules/long-memory/session-worker.js";
import type {
  SessionLifecycle,
  SessionRecord,
  SessionStartTrigger
} from "../modules/session/index.js";
import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type EchoControlResult,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type {
  SttClient,
  TtsAudioChunk,
  TtsClient,
  TtsSynthesisSuccess
} from "../modules/voice/index.js";
import type { DeferredToolDeliverableResult } from "./deferred-tool-coordinator.js";
import type { SpeechActivityGate, SpeechActivityGateResult } from "./speech-activity-gate.js";
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";
import {
  createVoiceUtteranceAssembler,
  type TranscribedUtterance,
  type VoiceUtteranceAssembler,
  type VoiceUtteranceWindowConfig
} from "./voice-utterance-window.js";

export type VoiceFrameSource = AsyncIterable<VoicePcmFrame> | Iterable<VoicePcmFrame>;

export type VoicePlaybackSink = {
  readonly play: (chunk: TtsAudioChunk, startedAt: string) => Promise<void>;
};

export type PiAgentTurnClient = {
  readonly prompt: (input: {
    readonly sessionId: string;
    readonly text: string;
    readonly deferredToolResults?: readonly DeferredToolDeliverableResult[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly text: string }>;
  readonly disposeSession?: (sessionId: string) => void | Promise<void>;
  readonly disposeAll?: () => void | Promise<void>;
};

export type VoiceResidentMemoryWorker = Pick<SessionMemoryWorker, "enqueueCutoff"> & {
  readonly close?: () => void;
};

export type VoiceResidentConsoleEvent =
  | {
      readonly kind: "staff_transcript";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly text: string;
    }
  | {
      readonly kind: "pi_agent_response";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly durationMs: number;
      readonly text: string;
    }
  | {
      readonly kind: "wake_ack_input";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly trigger: string;
      readonly text: string;
    }
  | {
      readonly kind: "wake_ack_response";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly durationMs: number;
      readonly text: string;
    };

export type VoiceResidentConsoleSink = {
  readonly record: (event: VoiceResidentConsoleEvent) => void;
};

export type VoiceResidentRuntimeOptions = {
  readonly now?: () => string;
  readonly frames: VoiceFrameSource;
  readonly triggerPhrases: readonly string[];
  readonly sessionLifecycle: SessionLifecycle;
  readonly echoControl: EchoControlProvider;
  readonly speechActivity?: SpeechActivityGate;
  readonly stt: SttClient;
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly piAgent: PiAgentTurnClient;
  readonly memoryWorker?: VoiceResidentMemoryWorker;
  readonly deferredTools?: {
    readonly collectDeliverableResults: (input: {
      readonly sessionId: string;
      readonly activeSessionId: string | undefined;
      readonly now: string;
    }) => readonly DeferredToolDeliverableResult[];
    readonly acknowledgeDelivered?: (jobIds: readonly string[]) => void;
    readonly cancelSession?: (sessionId: string, reason: "session_closed" | "shutdown") => void;
  };
  readonly console?: VoiceResidentConsoleSink;
  readonly wakeAcknowledgement?: {
    readonly enabled: boolean;
  };
  readonly farewell?: {
    readonly enabled: boolean;
  };
  readonly probe?: VoiceStageProbe;
  readonly signal?: AbortSignal;
  readonly endedSessionIds?: readonly string[];
  readonly minTriggerConfidence?: number;
  readonly utteranceWindow: VoiceUtteranceWindowConfig;
  readonly monotonicNow?: () => number;
};

export type VoiceResidentRuntimeResult = {
  readonly processedFrames: number;
  readonly startedSessions: number;
  readonly completedTurns: number;
  readonly enqueuedCutoffs: number;
  readonly failedCutoffs: number;
  readonly failedFrames: number;
  readonly failedTurns: number;
  readonly suppressedFrames: number;
};

type VoiceResidentCounters = {
  processedFrames: number;
  startedSessions: number;
  completedTurns: number;
  enqueuedCutoffs: number;
  failedCutoffs: number;
  failedFrames: number;
  failedTurns: number;
  suppressedFrames: number;
};

type ActiveSessionState = {
  readonly getActiveSessionId: () => string | undefined;
  readonly setActiveSessionId: (id: string | undefined) => void;
};

type PendingSessionState = {
  readonly activeSession: ActiveSessionState;
  readonly pendingCutoffSessionIds: Set<string>;
  readonly farewelledSessionIds: Set<string>;
};

type ActiveVoiceSessionResult =
  | {
      readonly kind: "active";
      readonly sessionId: string;
    }
  | {
      readonly kind: "started";
      readonly sessionId: string;
      readonly trigger: string;
    };

const defaultNow = (): string => new Date().toISOString();
const defaultMonotonicNow = (): number => performance.now();
const farewellPrompt =
  "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic.";

export async function runVoiceResidentRuntime(
  options: VoiceResidentRuntimeOptions
): Promise<VoiceResidentRuntimeResult> {
  const now = options.now ?? defaultNow;
  const counters: VoiceResidentCounters = {
    processedFrames: 0,
    startedSessions: 0,
    completedTurns: 0,
    enqueuedCutoffs: 0,
    failedCutoffs: 0,
    failedFrames: 0,
    failedTurns: 0,
    suppressedFrames: 0
  };
  const pendingCutoffSessionIds = new Set(options.endedSessionIds ?? []);
  const farewelledSessionIds = new Set<string>();
  let activeSessionId: string | undefined;
  const utteranceAssembler = createVoiceUtteranceAssembler(options.utteranceWindow);
  const activeSession = {
    getActiveSessionId: () => activeSessionId,
    setActiveSessionId: (id: string | undefined) => {
      activeSessionId = id;
    }
  };

  try {
    const health = await options.echoControl.checkHealth();

    if (!health.ok) {
      throw new Error(`pico resident voice echo-control provider is unhealthy: ${health.message}`);
    }

    await enqueueEndedSessions(
      options,
      pendingCutoffSessionIds,
      counters,
      now,
      farewelledSessionIds
    );

    for await (const rawFrame of toAsyncIterable(options.frames)) {
      throwIfAborted(options.signal);
      activeSessionId = await processResidentFrameIteration(rawFrame, options, counters, now, {
        activeSession,
        pendingCutoffSessionIds,
        farewelledSessionIds,
        utteranceAssembler,
        currentActiveSessionId: activeSessionId
      });
      counters.processedFrames += 1;
    }

    await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
      activeSession,
      pendingCutoffSessionIds,
      farewelledSessionIds
    });

    activeSessionId = collectEndedActiveSession(options.sessionLifecycle, activeSessionId, {
      pendingCutoffSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    });
    await enqueueEndedSessions(
      options,
      pendingCutoffSessionIds,
      counters,
      now,
      farewelledSessionIds
    );
  } finally {
    try {
      await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
        activeSession,
        pendingCutoffSessionIds,
        farewelledSessionIds
      });
    } finally {
      activeSessionId = await runShutdownCleanup(
        options,
        activeSessionId,
        pendingCutoffSessionIds,
        farewelledSessionIds,
        counters,
        now
      );
    }
  }

  return Object.freeze({ ...counters });
}

async function runShutdownCleanup(
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string | undefined,
  pendingCutoffSessionIds: Set<string>,
  farewelledSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<string | undefined> {
  const nextActiveSessionId = await cleanupActiveSessionForShutdown(
    options,
    activeSessionId,
    pendingCutoffSessionIds,
    farewelledSessionIds,
    counters,
    now
  );
  const firstError = await collectFirstShutdownCleanupError(options);

  if (firstError !== undefined) {
    throw firstError;
  }

  return nextActiveSessionId;
}

async function collectFirstShutdownCleanupError(
  options: VoiceResidentRuntimeOptions
): Promise<Error | undefined> {
  const errors: Error[] = [];

  await recordCleanupError(errors, () => options.piAgent.disposeAll?.());
  await recordCleanupError(errors, () => {
    options.memoryWorker?.close?.();
  });
  await recordCleanupError(errors, () => options.echoControl.flush());
  await recordCleanupError(errors, () => options.speechActivity?.close?.());

  return errors[0];
}

async function recordCleanupError(
  errors: Error[],
  cleanup: () => void | Promise<void>
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
}

async function processResidentFrameIteration(
  rawFrame: VoicePcmFrame,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState & {
    readonly utteranceAssembler: VoiceUtteranceAssembler;
    readonly currentActiveSessionId: string | undefined;
  }
): Promise<string | undefined> {
  const activeSessionId = collectEndedActiveSession(
    options.sessionLifecycle,
    state.currentActiveSessionId,
    {
      pendingCutoffSessionIds: state.pendingCutoffSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    }
  );
  state.activeSession.setActiveSessionId(activeSessionId);
  await enqueueEndedSessions(
    options,
    state.pendingCutoffSessionIds,
    counters,
    now,
    state.farewelledSessionIds
  );
  await processNearEndFrame(rawFrame, options, counters, now, state);

  return state.activeSession.getActiveSessionId();
}

async function flushPendingUtteranceWindow(
  utteranceAssembler: VoiceUtteranceAssembler,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState
): Promise<void> {
  await processTranscribedUtterances(utteranceAssembler.flush(), options, counters, now, state);
}

async function cleanupActiveSessionForShutdown(
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string | undefined,
  pendingCutoffSessionIds: Set<string>,
  farewelledSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<string | undefined> {
  if (options.memoryWorker === undefined) {
    if (activeSessionId !== undefined) {
      cancelDeferredToolSession(options.deferredTools, activeSessionId, "shutdown");
    }

    return activeSessionId;
  }

  const nextActiveSessionId = endActiveSessionForShutdown(
    options.sessionLifecycle,
    activeSessionId,
    {
      pendingCutoffSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    }
  );
  await enqueueEndedSessions(options, pendingCutoffSessionIds, counters, now, farewelledSessionIds);

  return nextActiveSessionId;
}

async function processNearEndFrame(
  rawFrame: VoicePcmFrame,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState & {
    readonly utteranceAssembler: VoiceUtteranceAssembler;
  }
): Promise<void> {
  const echoResult = await processEchoControlledFrame(rawFrame, options, now);

  if (echoResult.action === "suppress") {
    counters.suppressedFrames += 1;
    return;
  }

  const speechResult = await processSpeechActivityFrame(echoResult, options, now);

  await processTranscribedUtterances(
    state.utteranceAssembler.accept(echoResult.frame, speechResult.speech),
    options,
    counters,
    now,
    state
  );
}

async function processTranscribedUtterances(
  utterances: readonly TranscribedUtterance[],
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState
): Promise<void> {
  for (const utterance of utterances) {
    await processTranscribedUtterance(utterance, options, counters, now, state);
  }
}

async function processTranscribedUtterance(
  utterance: TranscribedUtterance,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState
): Promise<void> {
  recordUtteranceWindowProbe(utterance, options);
  const transcript = await transcribePassedFrame(utterance, options, counters, now);

  if (
    transcript === undefined ||
    transcript.text === "" ||
    isLikelyNoSpeechHallucination(transcript.text)
  ) {
    return;
  }

  const activeSession = ensureActiveVoiceSession(
    transcript,
    options,
    counters,
    now,
    state.activeSession
  );

  if (activeSession === undefined) {
    return;
  }

  if (activeSession.kind === "started") {
    await runOptionalWakeAcknowledgement(activeSession, options, counters, now);
    return;
  }

  if (activeSession.sessionId !== state.activeSession.getActiveSessionId()) {
    return;
  }

  await runActiveVoiceTurn(transcript.text, options, counters, now, activeSession.sessionId);
  state.activeSession.setActiveSessionId(
    collectEndedActiveSession(options.sessionLifecycle, activeSession.sessionId, {
      pendingCutoffSessionIds: state.pendingCutoffSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    })
  );
  await enqueueEndedSessions(
    options,
    state.pendingCutoffSessionIds,
    counters,
    now,
    state.farewelledSessionIds
  );
}

function isLikelyNoSpeechHallucination(text: string): boolean {
  const normalized = text.trim().replaceAll(/\s+/gu, "");

  return noSpeechHallucinationTranscripts.has(normalized);
}

const noSpeechHallucinationTranscripts = new Set([
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "ご清聴ありがとうございました"
]);

function recordUtteranceWindowProbe(
  utterance: TranscribedUtterance,
  options: VoiceResidentRuntimeOptions
): void {
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "utterance_window",
    status: "ok",
    startedAt: utterance.frame.capturedAt,
    durationMs: 0,
    attributes: {
      "pico.voice.frame_count": utterance.frameCount,
      "pico.voice.utterance_duration_ms": utterance.frame.durationMs,
      "pico.voice.sample_rate_hz": utterance.frame.sampleRateHz,
      "pico.voice.channels": utterance.frame.channels
    }
  });
}

async function runOptionalWakeAcknowledgement(
  activeSession: Extract<ActiveVoiceSessionResult, { readonly kind: "started" }>,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<void> {
  if (options.wakeAcknowledgement?.enabled !== true) {
    return;
  }

  await runWakeAcknowledgement(
    activeSession.sessionId,
    activeSession.trigger,
    options,
    counters,
    now
  );
}

async function processEchoControlledFrame(
  rawFrame: VoicePcmFrame,
  options: VoiceResidentRuntimeOptions,
  now: () => string
): Promise<EchoControlResult> {
  const echoStageStartedAt = now();
  const frame = defineVoicePcmFrame(rawFrame);
  const echoResult = await options.echoControl.processNearEnd(frame);

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "echo_control",
    status: echoResult.action === "suppress" ? "suppressed" : "ok",
    startedAt: echoStageStartedAt,
    durationMs: 0,
    attributes: {
      "pico.voice.frame_count": 1,
      "pico.voice.sample_rate_hz": frame.sampleRateHz,
      "pico.voice.channels": frame.channels
    }
  });

  return echoResult;
}

async function processSpeechActivityFrame(
  echoResult: Extract<EchoControlResult, { readonly action: "pass" }>,
  options: VoiceResidentRuntimeOptions,
  now: () => string
): Promise<SpeechActivityGateResult> {
  if (options.speechActivity === undefined) {
    return {
      speech: echoResult.diagnostics.voiceActivity,
      provider: "energy",
      rmsDb: Number.NaN
    };
  }

  const stageStartedAt = now();
  const result = await options.speechActivity.process(echoResult.frame);

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "speech_gate",
    status: result.speech ? "ok" : "suppressed",
    startedAt: stageStartedAt,
    durationMs: 0,
    attributes: {
      "pico.voice.frame_count": 1,
      "pico.voice.sample_rate_hz": echoResult.frame.sampleRateHz,
      "pico.voice.channels": echoResult.frame.channels,
      "pico.voice.speech_detected": result.speech,
      "pico.voice.rms_db": result.rmsDb,
      ...(result.probability === undefined
        ? {}
        : { "pico.voice.speech_probability": result.probability })
    }
  });

  return result;
}

async function transcribePassedFrame(
  utterance: TranscribedUtterance,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<{ readonly text: string; readonly confidence: number } | undefined> {
  const sttStageStartedAt = now();
  const { frame } = utterance;
  const sttResult = await options.stt.transcribe({
    audio: frame.audio,
    encoding: frame.encoding,
    sampleRateHz: frame.sampleRateHz,
    channels: frame.channels
  });

  if (!sttResult.ok) {
    counters.failedFrames += 1;
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "stt",
      status: "error",
      startedAt: sttStageStartedAt,
      durationMs: 0,
      attributes: {
        "pico.voice.frame_count": utterance.frameCount,
        "pico.voice.error_code": sttResult.reason
      }
    });

    return undefined;
  }

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "stt",
    status: "ok",
    startedAt: sttStageStartedAt,
    durationMs: sttResult.durationMs,
    attributes: {
      "pico.voice.frame_count": utterance.frameCount,
      "pico.voice.sample_rate_hz": frame.sampleRateHz,
      "pico.voice.channels": frame.channels
    }
  });

  return {
    text: sttResult.text.trim(),
    confidence: sttResult.confidence
  };
}

function ensureActiveVoiceSession(
  transcript: { readonly text: string; readonly confidence: number },
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  activeSession: ActiveSessionState
): ActiveVoiceSessionResult | undefined {
  const currentSessionId = activeSession.getActiveSessionId();

  if (currentSessionId !== undefined) {
    return {
      kind: "active",
      sessionId: currentSessionId
    };
  }

  const trigger =
    transcript.confidence >= (options.minTriggerConfidence ?? 0.5)
      ? findTrigger(transcript.text, options.triggerPhrases)
      : undefined;
  recordTriggerProbe(trigger, options, now);

  if (trigger === undefined) {
    return undefined;
  }

  const started = options.sessionLifecycle.start(buildVoiceTrigger(trigger));
  activeSession.setActiveSessionId(started.id);
  counters.startedSessions += 1;
  recordSessionStartProbe(started.id, options, now);

  return {
    kind: "started",
    sessionId: started.id,
    trigger
  };
}

function recordTriggerProbe(
  trigger: string | undefined,
  options: VoiceResidentRuntimeOptions,
  now: () => string
): void {
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "trigger_match",
    status: trigger === undefined ? "skipped" : "ok",
    startedAt: now(),
    durationMs: 0,
    attributes: {
      "pico.voice.triggered": trigger !== undefined
    }
  });
}

function recordSessionStartProbe(
  _sessionId: string,
  options: VoiceResidentRuntimeOptions,
  now: () => string
): void {
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "session_start",
    status: "ok",
    startedAt: now(),
    durationMs: 0,
    attributes: {}
  });
}

async function runWakeAcknowledgement(
  sessionId: string,
  trigger: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<void> {
  const prompt = buildWakeAcknowledgementPrompt(trigger);
  const piStageStartedAt = now();
  const piStageStartedMs = (options.monotonicNow ?? defaultMonotonicNow)();
  recordResidentConsoleEvent(options.console, {
    kind: "wake_ack_input",
    occurredAt: piStageStartedAt,
    sessionId,
    trigger,
    text: prompt
  });
  const response = await requestPiAgentResponse(
    sessionId,
    prompt,
    [],
    options,
    counters,
    piStageStartedAt,
    piStageStartedMs
  );

  if (response === undefined) {
    return;
  }

  recordResidentConsoleEvent(options.console, {
    kind: "wake_ack_response",
    occurredAt: response.completedAt,
    sessionId,
    durationMs: response.durationMs,
    text: response.text
  });
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "pi_turn",
    status: "ok",
    startedAt: piStageStartedAt,
    durationMs: response.durationMs,
    attributes: {}
  });

  const ttsStageStartedAt = now();
  const ttsResult = await synthesizeTurnResponse(
    response.text,
    options,
    counters,
    ttsStageStartedAt
  );

  if (ttsResult === undefined) {
    return;
  }

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "tts_synthesize",
    status: "ok",
    startedAt: ttsStageStartedAt,
    durationMs: ttsResult.totalDurationMs,
    attributes: {
      "pico.voice.chunk_count": ttsResult.chunks.length
    }
  });
  await playTtsChunks(ttsResult.chunks, options, now);
  refreshSessionActivityQuietly(options.sessionLifecycle, sessionId);
  counters.completedTurns += 1;
}

function buildWakeAcknowledgementPrompt(trigger: string): string {
  return `The user just woke you up by saying: ${JSON.stringify(
    trigger
  )}. Respond briefly in spoken Japanese to show you are listening. Do not answer a separate task yet.`;
}

async function runActiveVoiceTurn(
  transcript: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  activeSessionId: string
): Promise<void> {
  if (!appendStaffEntryIfSessionActive(options.sessionLifecycle, activeSessionId, transcript)) {
    return;
  }

  const piStageStartedAt = now();
  const piStageStartedMs = (options.monotonicNow ?? defaultMonotonicNow)();
  const turnRequest = createActiveVoiceTurnRequest(transcript, options, activeSessionId, now);
  recordResidentConsoleEvent(options.console, {
    kind: "staff_transcript",
    occurredAt: piStageStartedAt,
    sessionId: activeSessionId,
    text: transcript
  });
  const response = await requestPiAgentResponse(
    activeSessionId,
    turnRequest.prompt,
    turnRequest.deferredResults,
    options,
    counters,
    piStageStartedAt,
    piStageStartedMs
  );

  if (response === undefined) {
    return;
  }

  appendAssistantEntryIfSessionActive(options.sessionLifecycle, activeSessionId, response.text);
  recordResidentConsoleEvent(options.console, {
    kind: "pi_agent_response",
    occurredAt: response.completedAt,
    sessionId: activeSessionId,
    durationMs: response.durationMs,
    text: response.text
  });
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "pi_turn",
    status: "ok",
    startedAt: piStageStartedAt,
    durationMs: response.durationMs,
    attributes: {}
  });

  const ttsStageStartedAt = now();
  const ttsResult = await synthesizeTurnResponse(
    response.text,
    options,
    counters,
    ttsStageStartedAt
  );

  if (ttsResult === undefined) {
    return;
  }

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "tts_synthesize",
    status: "ok",
    startedAt: ttsStageStartedAt,
    durationMs: ttsResult.totalDurationMs,
    attributes: {
      "pico.voice.chunk_count": ttsResult.chunks.length
    }
  });
  await playTtsChunks(ttsResult.chunks, options, now);
  acknowledgeDeferredToolDelivery(options, turnRequest.deferredResults);
  refreshSessionActivityQuietly(options.sessionLifecycle, activeSessionId);
  counters.completedTurns += 1;
}

function createActiveVoiceTurnRequest(
  transcript: string,
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string,
  now: () => string
): {
  readonly prompt: string;
  readonly deferredResults: readonly DeferredToolDeliverableResult[];
} {
  const deferredResults = collectDeferredResultsForActiveTurn(options, activeSessionId, now);

  return {
    prompt: transcript,
    deferredResults
  };
}

function acknowledgeDeferredToolDelivery(
  options: VoiceResidentRuntimeOptions,
  results: readonly DeferredToolDeliverableResult[]
): void {
  try {
    options.deferredTools?.acknowledgeDelivered?.(results.map((result) => result.jobId));
  } catch {
    return;
  }
}

function collectDeferredResultsForActiveTurn(
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string,
  now: () => string
): readonly DeferredToolDeliverableResult[] {
  return (
    options.deferredTools?.collectDeliverableResults({
      sessionId: activeSessionId,
      activeSessionId,
      now: now()
    }) ?? []
  );
}

async function requestPiAgentResponse(
  sessionId: string,
  transcript: string,
  deferredToolResults: readonly DeferredToolDeliverableResult[],
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  startedAt: string,
  startedAtMs: number
): Promise<
  | {
      readonly text: string;
      readonly completedAt: string;
      readonly durationMs: number;
    }
  | undefined
> {
  try {
    const response = await options.piAgent.prompt({
      sessionId,
      text: transcript,
      ...(deferredToolResults.length === 0 ? {} : { deferredToolResults }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    const completedAt = (options.now ?? defaultNow)();
    const completedAtMs = (options.monotonicNow ?? defaultMonotonicNow)();

    return {
      text: response.text,
      completedAt,
      durationMs: Math.max(0, completedAtMs - startedAtMs)
    };
  } catch {
    counters.failedTurns += 1;
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "pi_turn",
      status: "error",
      startedAt,
      durationMs: 0,
      attributes: {
        "pico.voice.error_code": "pi_agent_prompt_failed"
      }
    });

    return undefined;
  }
}

async function synthesizeTurnResponse(
  text: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  startedAt: string
): Promise<TtsSynthesisSuccess | undefined> {
  const startedAtMs = (options.monotonicNow ?? defaultMonotonicNow)();
  const ttsResult = await options.tts.synthesize({
    text,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const completedAtMs = (options.monotonicNow ?? defaultMonotonicNow)();
  const wallDurationMs = Math.max(0, completedAtMs - startedAtMs);

  if (ttsResult.ok) {
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "tts_request_wall",
      status: "ok",
      startedAt,
      durationMs: wallDurationMs,
      attributes: {
        "pico.voice.chunk_count": ttsResult.chunks.length
      }
    });
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "tts_audio_duration",
      status: "ok",
      startedAt,
      durationMs: ttsResult.totalDurationMs,
      attributes: {
        "pico.voice.chunk_count": ttsResult.chunks.length
      }
    });

    return ttsResult;
  }

  counters.failedTurns += 1;
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "tts_request_wall",
    status: "error",
    startedAt,
    durationMs: wallDurationMs,
    attributes: {
      "pico.voice.error_code": ttsResult.reason
    }
  });

  return undefined;
}

function recordResidentConsoleEvent(
  sink: VoiceResidentConsoleSink | undefined,
  event: VoiceResidentConsoleEvent
): void {
  try {
    sink?.record(event);
  } catch {
    // Console and file logging must not break resident voice operation.
  }
}

function appendStaffEntryIfSessionActive(
  lifecycle: SessionLifecycle,
  sessionId: string,
  text: string
): boolean {
  if (lifecycle.read(sessionId)?.state !== "active") {
    return false;
  }

  lifecycle.appendEntry(sessionId, {
    role: "staff",
    content: text
  });

  return true;
}

function appendAssistantEntryIfSessionActive(
  lifecycle: SessionLifecycle,
  sessionId: string,
  text: string
): void {
  if (lifecycle.read(sessionId)?.state !== "active") {
    return;
  }

  lifecycle.appendEntry(sessionId, {
    role: "assistant",
    content: text
  });
}

async function playTtsChunks(
  chunks: readonly TtsAudioChunk[],
  options: VoiceResidentRuntimeOptions,
  now: () => string
): Promise<void> {
  const playbackStartedAt = now();
  let playbackOffsetMs = 0;

  for (const chunk of chunks) {
    const chunkStartedAt = addMilliseconds(playbackStartedAt, playbackOffsetMs);

    await options.echoControl.acceptFarEndReference(
      defineVoicePcmFrame({
        id: `tts-${chunk.sentenceIndex}`,
        direction: "far_end",
        audio: chunk.audio,
        encoding: chunk.encoding,
        sampleRateHz: chunk.sampleRateHz,
        channels: chunk.channels,
        capturedAt: chunkStartedAt,
        durationMs: chunk.durationMs
      })
    );
    await options.playback.play(chunk, chunkStartedAt);
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "tts_playback",
      status: "ok",
      startedAt: chunkStartedAt,
      durationMs: chunk.durationMs,
      attributes: {
        "pico.voice.chunk_count": 1,
        "pico.voice.sample_rate_hz": chunk.sampleRateHz,
        "pico.voice.channels": chunk.channels
      }
    });
    playbackOffsetMs += chunk.durationMs;
  }
}

function collectEndedActiveSession(
  lifecycle: SessionLifecycle,
  activeSessionId: string | undefined,
  options: {
    readonly pendingCutoffSessionIds: Set<string>;
    readonly piAgent: PiAgentTurnClient;
    readonly deferredTools?: VoiceResidentRuntimeOptions["deferredTools"];
  }
): string | undefined {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = lifecycle.read(activeSessionId);

  if (session === undefined) {
    cancelDeferredToolSession(options.deferredTools, activeSessionId, "session_closed");
    disposeSessionQuietly(options.piAgent, activeSessionId);
    return undefined;
  }

  if (session.state !== "ended") {
    return activeSessionId;
  }

  cancelDeferredToolSession(options.deferredTools, activeSessionId, "session_closed");
  options.pendingCutoffSessionIds.add(activeSessionId);

  return undefined;
}

function endActiveSessionForShutdown(
  lifecycle: SessionLifecycle,
  activeSessionId: string | undefined,
  options: {
    readonly pendingCutoffSessionIds: Set<string>;
    readonly piAgent: PiAgentTurnClient;
    readonly deferredTools?: VoiceResidentRuntimeOptions["deferredTools"];
  }
): string | undefined {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = lifecycle.read(activeSessionId);

  if (session === undefined) {
    cancelDeferredToolSession(options.deferredTools, activeSessionId, "shutdown");
    disposeSessionQuietly(options.piAgent, activeSessionId);
    return undefined;
  }

  if (session.state === "active") {
    lifecycle.end(activeSessionId);
  }

  cancelDeferredToolSession(options.deferredTools, activeSessionId, "shutdown");
  options.pendingCutoffSessionIds.add(activeSessionId);

  return undefined;
}

function cancelDeferredToolSession(
  deferredTools: VoiceResidentRuntimeOptions["deferredTools"] | undefined,
  sessionId: string,
  reason: "session_closed" | "shutdown"
): void {
  try {
    deferredTools?.cancelSession?.(sessionId, reason);
  } catch {
    return;
  }
}

async function enqueueEndedSessions(
  options: VoiceResidentRuntimeOptions,
  pendingCutoffSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string,
  farewelledSessionIds: Set<string>
): Promise<void> {
  for (const sessionId of [...pendingCutoffSessionIds]) {
    const session = options.sessionLifecycle.read(sessionId);

    if (session?.state !== "ended") {
      pendingCutoffSessionIds.delete(sessionId);
      continue;
    }

    await runOptionalFarewell(session, options, counters, now, farewelledSessionIds);

    if (options.memoryWorker === undefined) {
      counters.failedCutoffs += 1;
      recordCutoffEnqueueError(options, now(), "missing_memory_worker");
      continue;
    }

    const startedAt = now();
    const cutoff = options.sessionLifecycle.cutoff(sessionId);

    try {
      options.memoryWorker.enqueueCutoff(cutoff);
    } catch {
      counters.failedCutoffs += 1;
      recordCutoffEnqueueError(options, startedAt, "enqueue_failed");
      continue;
    }

    options.sessionLifecycle.acknowledgeCutoff(sessionId);
    pendingCutoffSessionIds.delete(sessionId);
    counters.enqueuedCutoffs += 1;
    recordVoiceStageProbe(options.probe ?? {}, {
      stage: "session_cutoff_enqueue",
      status: "ok",
      startedAt,
      durationMs: 0,
      attributes: {
        "pico.voice.entry_count": cutoff.entries.length
      }
    });
    disposeSessionQuietly(options.piAgent, sessionId);
  }
}

async function runOptionalFarewell(
  session: SessionRecord,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  farewelledSessionIds: Set<string>
): Promise<void> {
  if (!claimFarewell(session.id, options, farewelledSessionIds)) {
    return;
  }

  try {
    await runFarewellTurn(session.id, options, counters, now);
  } catch {
    counters.failedTurns += 1;
  }
}

function claimFarewell(
  sessionId: string,
  options: VoiceResidentRuntimeOptions,
  farewelledSessionIds: Set<string>
): boolean {
  if (options.farewell?.enabled !== true || farewelledSessionIds.has(sessionId)) {
    return false;
  }

  farewelledSessionIds.add(sessionId);

  return true;
}

async function runFarewellTurn(
  sessionId: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<void> {
  const piStageStartedAt = now();
  const piStageStartedMs = (options.monotonicNow ?? defaultMonotonicNow)();
  const response = await requestPiAgentResponse(
    sessionId,
    farewellPrompt,
    [],
    options,
    counters,
    piStageStartedAt,
    piStageStartedMs
  );

  if (response === undefined) {
    return;
  }

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "pi_turn",
    status: "ok",
    startedAt: piStageStartedAt,
    durationMs: response.durationMs,
    attributes: {}
  });

  await synthesizeAndPlayFarewell(response.text, options, counters, now);
}

async function synthesizeAndPlayFarewell(
  text: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<void> {
  const ttsStageStartedAt = now();
  const ttsResult = await synthesizeTurnResponse(text, options, counters, ttsStageStartedAt);

  if (ttsResult === undefined) {
    return;
  }

  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "tts_synthesize",
    status: "ok",
    startedAt: ttsStageStartedAt,
    durationMs: ttsResult.totalDurationMs,
    attributes: {
      "pico.voice.chunk_count": ttsResult.chunks.length
    }
  });
  await playTtsChunks(ttsResult.chunks, options, now);
}

function refreshSessionActivityQuietly(lifecycle: SessionLifecycle, sessionId: string): void {
  try {
    lifecycle.refreshActivity(sessionId);
  } catch {
    // Activity refresh must not break an otherwise completed voice turn.
  }
}

function disposeSessionQuietly(piAgent: PiAgentTurnClient, sessionId: string): void {
  void Promise.resolve(piAgent.disposeSession?.(sessionId)).catch(() => undefined);
}

function recordCutoffEnqueueError(
  options: VoiceResidentRuntimeOptions,
  startedAt: string,
  errorCode: string
): void {
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "session_cutoff_enqueue",
    status: "error",
    startedAt,
    durationMs: 0,
    attributes: {
      "pico.voice.error_code": errorCode
    }
  });
}

async function* toAsyncIterable(frames: VoiceFrameSource): AsyncIterable<VoicePcmFrame> {
  yield* frames;
}

function findTrigger(transcript: string, triggerPhrases: readonly string[]): string | undefined {
  const normalizedTranscript = transcript.toLowerCase();

  return triggerPhrases.find((phrase) => {
    const normalizedPhrase = phrase.trim().toLowerCase();

    return normalizedPhrase !== "" && normalizedTranscript.includes(normalizedPhrase);
  });
}

function buildVoiceTrigger(label: string): SessionStartTrigger {
  return {
    kind: "wake_name",
    label,
    source: "voice"
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("pico resident voice runtime aborted");
  }
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
