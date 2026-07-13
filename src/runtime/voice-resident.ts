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
import type { ResidentActivationEvent } from "./resident-activation.js";
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

export type VoiceResidentActivationSource = {
  readonly peek: (input: { readonly now: string }) => ResidentActivationEvent | undefined;
  readonly acknowledge: (activationId: string) => void;
};

export type VoiceResidentActivation =
  | {
      readonly mode: "wake_word";
    }
  | {
      readonly mode: "push_to_talk";
      readonly source: VoiceResidentActivationSource;
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

export type VoiceResidentLogEvent =
  | {
      readonly kind: "staff_input";
      readonly occurredAt: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "pi_agent_response";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "wake_ack_input";
      readonly occurredAt: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "wake_ack_response";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly durationMs: number;
    };

export type VoiceResidentLogSink = {
  readonly record: (event: VoiceResidentLogEvent) => void;
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
  readonly deferredTools?: {
    readonly collectDeliverableResults: (input: {
      readonly sessionId: string;
      readonly activeSessionId: string | undefined;
      readonly now: string;
    }) => readonly DeferredToolDeliverableResult[];
    readonly acknowledgeDelivered?: (jobIds: readonly string[]) => void;
    readonly cancelSession?: (sessionId: string, reason: "session_closed" | "shutdown") => void;
    readonly waitForIdle?: () => Promise<void>;
  };
  readonly log?: VoiceResidentLogSink;
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
  readonly activation?: VoiceResidentActivation;
  readonly utteranceWindow: VoiceUtteranceWindowConfig;
  readonly monotonicNow?: () => number;
};

export type VoiceResidentRuntimeResult = {
  readonly processedFrames: number;
  readonly startedSessions: number;
  readonly completedTurns: number;
  readonly failedFrames: number;
  readonly failedTurns: number;
  readonly suppressedFrames: number;
};

type VoiceResidentCounters = {
  processedFrames: number;
  startedSessions: number;
  completedTurns: number;
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
  readonly pendingEndedSessionIds: Set<string>;
  readonly farewelledSessionIds: Set<string>;
  readonly pushToTalk: PushToTalkActivationState;
};

type PushToTalkActivationState = {
  pendingActivation: ResidentActivationEvent | undefined;
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
    failedFrames: 0,
    failedTurns: 0,
    suppressedFrames: 0
  };
  const pendingEndedSessionIds = new Set(options.endedSessionIds ?? []);
  const farewelledSessionIds = new Set<string>();
  const pushToTalk: PushToTalkActivationState = {
    pendingActivation: undefined
  };
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

    await finalizeEndedInteractions(
      options,
      pendingEndedSessionIds,
      counters,
      now,
      farewelledSessionIds
    );

    for await (const rawFrame of toAsyncIterable(options.frames)) {
      throwIfAborted(options.signal);
      activeSessionId = await processResidentFrameIteration(rawFrame, options, counters, now, {
        activeSession,
        pendingEndedSessionIds,
        farewelledSessionIds,
        pushToTalk,
        utteranceAssembler,
        currentActiveSessionId: activeSessionId
      });
      counters.processedFrames += 1;
    }

    await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
      activeSession,
      pendingEndedSessionIds,
      farewelledSessionIds,
      pushToTalk
    });

    activeSessionId = collectEndedActiveSession(options.sessionLifecycle, activeSessionId, {
      pendingEndedSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    });
    await finalizeEndedInteractions(
      options,
      pendingEndedSessionIds,
      counters,
      now,
      farewelledSessionIds
    );
  } finally {
    try {
      await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
        activeSession,
        pendingEndedSessionIds,
        farewelledSessionIds,
        pushToTalk
      });
    } finally {
      activeSessionId = await runShutdownCleanup(
        options,
        activeSessionId,
        pendingEndedSessionIds,
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
  pendingEndedSessionIds: Set<string>,
  farewelledSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<string | undefined> {
  const errors: Error[] = [];
  let nextActiveSessionId = activeSessionId;

  await recordCleanupError(errors, async () => {
    nextActiveSessionId = await cleanupActiveSessionForShutdown(
      options,
      activeSessionId,
      pendingEndedSessionIds,
      farewelledSessionIds,
      counters,
      now
    );
  });

  await collectShutdownCleanupErrors(options, errors);
  const firstError = errors[0];

  if (firstError === undefined) {
    return nextActiveSessionId;
  }

  if (errors.length === 1) {
    throw firstError;
  }

  throw new AggregateError(errors, firstError.message);
}

async function collectShutdownCleanupErrors(
  options: VoiceResidentRuntimeOptions,
  errors: Error[]
): Promise<void> {
  await recordCleanupError(errors, () => options.piAgent.disposeAll?.());
  await recordCleanupError(errors, () => options.deferredTools?.waitForIdle?.());
  await recordCleanupError(errors, () => options.echoControl.flush());
  await recordCleanupError(errors, () => options.speechActivity?.close?.());
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
      pendingEndedSessionIds: state.pendingEndedSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    }
  );
  state.activeSession.setActiveSessionId(activeSessionId);
  await finalizeEndedInteractions(
    options,
    state.pendingEndedSessionIds,
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
  pendingEndedSessionIds: Set<string>,
  farewelledSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): Promise<string | undefined> {
  const nextActiveSessionId = endActiveSessionForShutdown(
    options.sessionLifecycle,
    activeSessionId,
    {
      pendingEndedSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    }
  );
  await finalizeEndedInteractions(
    options,
    pendingEndedSessionIds,
    counters,
    now,
    farewelledSessionIds
  );

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
  armPushToTalkActivation(rawFrame, options, now, state);
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

function armPushToTalkActivation(
  rawFrame: VoicePcmFrame,
  options: VoiceResidentRuntimeOptions,
  now: () => string,
  state: PendingSessionState & {
    readonly utteranceAssembler: VoiceUtteranceAssembler;
  }
): void {
  if (options.activation?.mode !== "push_to_talk") {
    return;
  }

  const pendingActivation = state.pushToTalk.pendingActivation;
  const nowTimestamp = now();

  if (pendingActivation !== undefined) {
    if (Date.parse(nowTimestamp) <= Date.parse(pendingActivation.expiresAt)) {
      return;
    }

    options.activation.source.acknowledge(pendingActivation.id);
    state.pushToTalk.pendingActivation = undefined;
  }

  const activation = options.activation.source.peek({ now: nowTimestamp });

  if (activation === undefined) {
    return;
  }

  state.utteranceAssembler.reset();
  state.pushToTalk.pendingActivation = activation;
  recordTriggerProbe(activation.trigger.label, options, () => rawFrame.capturedAt);
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

  const activeSession = ensureActiveVoiceSession(transcript, options, counters, now, state);

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
      pendingEndedSessionIds: state.pendingEndedSessionIds,
      piAgent: options.piAgent,
      deferredTools: options.deferredTools
    })
  );
  await finalizeEndedInteractions(
    options,
    state.pendingEndedSessionIds,
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
  state: PendingSessionState
): ActiveVoiceSessionResult | undefined {
  if (options.activation?.mode === "push_to_talk") {
    return ensurePushToTalkVoiceSession(options, counters, now, state);
  }

  const currentSessionId = state.activeSession.getActiveSessionId();

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
  state.activeSession.setActiveSessionId(started.id);
  counters.startedSessions += 1;
  recordSessionStartProbe(started.id, options, now);

  return {
    kind: "started",
    sessionId: started.id,
    trigger
  };
}

function ensurePushToTalkVoiceSession(
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  state: PendingSessionState
): ActiveVoiceSessionResult | undefined {
  if (options.activation?.mode !== "push_to_talk") {
    return undefined;
  }

  const activation = state.pushToTalk.pendingActivation;

  if (activation === undefined) {
    return undefined;
  }

  state.pushToTalk.pendingActivation = undefined;

  if (Date.parse(now()) > Date.parse(activation.expiresAt)) {
    options.activation.source.acknowledge(activation.id);
    return undefined;
  }

  options.activation.source.acknowledge(activation.id);
  const currentSessionId = state.activeSession.getActiveSessionId();

  if (currentSessionId !== undefined) {
    return {
      kind: "active",
      sessionId: currentSessionId
    };
  }

  const started = options.sessionLifecycle.start(activation.trigger);
  state.activeSession.setActiveSessionId(started.id);
  counters.startedSessions += 1;
  recordSessionStartProbe(started.id, options, now);

  return {
    kind: "active",
    sessionId: started.id
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
  recordResidentLogEvent(options.log, {
    kind: "wake_ack_input",
    occurredAt: piStageStartedAt,
    sessionId
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

  recordResidentLogEvent(options.log, {
    kind: "wake_ack_response",
    occurredAt: response.completedAt,
    sessionId,
    durationMs: response.durationMs
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
  if (!refreshActiveInteraction(options.sessionLifecycle, activeSessionId)) {
    return;
  }

  const piStageStartedAt = now();
  const piStageStartedMs = (options.monotonicNow ?? defaultMonotonicNow)();
  const turnRequest = createActiveVoiceTurnRequest(transcript, options, activeSessionId, now);
  recordResidentLogEvent(options.log, {
    kind: "staff_input",
    occurredAt: piStageStartedAt,
    sessionId: activeSessionId
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

  recordResidentLogEvent(options.log, {
    kind: "pi_agent_response",
    occurredAt: response.completedAt,
    sessionId: activeSessionId,
    durationMs: response.durationMs
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

function recordResidentLogEvent(
  sink: VoiceResidentLogSink | undefined,
  event: VoiceResidentLogEvent
): void {
  try {
    sink?.record(event);
  } catch {
    // Logging must not break resident voice operation.
  }
}

function refreshActiveInteraction(lifecycle: SessionLifecycle, sessionId: string): boolean {
  if (lifecycle.read(sessionId)?.state !== "active") {
    return false;
  }

  lifecycle.refreshActivity(sessionId);

  return true;
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
    readonly pendingEndedSessionIds: Set<string>;
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
    disposeSessionQuietly(options.piAgent, activeSessionId).catch(() => undefined);
    return undefined;
  }

  if (session.state !== "ended") {
    return activeSessionId;
  }

  options.pendingEndedSessionIds.add(activeSessionId);

  return undefined;
}

function endActiveSessionForShutdown(
  lifecycle: SessionLifecycle,
  activeSessionId: string | undefined,
  options: {
    readonly pendingEndedSessionIds: Set<string>;
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
    disposeSessionQuietly(options.piAgent, activeSessionId).catch(() => undefined);
    return undefined;
  }

  if (session.state === "active") {
    lifecycle.end(activeSessionId);
  }

  options.pendingEndedSessionIds.add(activeSessionId);

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

async function finalizeEndedInteractions(
  options: VoiceResidentRuntimeOptions,
  pendingEndedSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string,
  farewelledSessionIds: Set<string>
): Promise<void> {
  for (const sessionId of [...pendingEndedSessionIds]) {
    const session = options.sessionLifecycle.read(sessionId);

    if (session?.state !== "ended") {
      pendingEndedSessionIds.delete(sessionId);
      continue;
    }

    await runOptionalFarewell(session, options, counters, now, farewelledSessionIds);
    cancelDeferredToolSession(options.deferredTools, sessionId, "session_closed");
    await disposeSessionQuietly(options.piAgent, sessionId);
    options.sessionLifecycle.remove(sessionId);
    pendingEndedSessionIds.delete(sessionId);
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

async function disposeSessionQuietly(piAgent: PiAgentTurnClient, sessionId: string): Promise<void> {
  try {
    await piAgent.disposeSession?.(sessionId);
  } catch {
    return;
  }
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
