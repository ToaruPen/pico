import type { SessionMemoryWorker } from "../modules/long-memory/session-worker.js";
import type { SessionLifecycle, SessionStartTrigger } from "../modules/session/index.js";
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
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly text: string }>;
  readonly disposeSession?: (sessionId: string) => void | Promise<void>;
  readonly disposeAll?: () => void | Promise<void>;
};

export type VoiceResidentMemoryWorker = Pick<SessionMemoryWorker, "enqueueCutoff"> & {
  readonly close?: () => void;
};

export type VoiceResidentRuntimeOptions = {
  readonly now?: () => string;
  readonly frames: VoiceFrameSource;
  readonly triggerPhrases: readonly string[];
  readonly sessionLifecycle: SessionLifecycle;
  readonly echoControl: EchoControlProvider;
  readonly stt: SttClient;
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly piAgent: PiAgentTurnClient;
  readonly memoryWorker?: VoiceResidentMemoryWorker;
  readonly probe?: VoiceStageProbe;
  readonly signal?: AbortSignal;
  readonly endedSessionIds?: readonly string[];
  readonly minTriggerConfidence?: number;
  readonly utteranceWindow: VoiceUtteranceWindowConfig;
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
};

const defaultNow = (): string => new Date().toISOString();

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

    enqueueEndedSessions(options, pendingCutoffSessionIds, counters, now);

    for await (const rawFrame of toAsyncIterable(options.frames)) {
      throwIfAborted(options.signal);
      activeSessionId = await processResidentFrameIteration(rawFrame, options, counters, now, {
        activeSession,
        pendingCutoffSessionIds,
        utteranceAssembler,
        currentActiveSessionId: activeSessionId
      });
      counters.processedFrames += 1;
    }

    await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
      activeSession,
      pendingCutoffSessionIds
    });

    activeSessionId = collectEndedActiveSession(options.sessionLifecycle, activeSessionId, {
      pendingCutoffSessionIds,
      piAgent: options.piAgent
    });
    enqueueEndedSessions(options, pendingCutoffSessionIds, counters, now);
  } finally {
    try {
      await flushPendingUtteranceWindow(utteranceAssembler, options, counters, now, {
        activeSession,
        pendingCutoffSessionIds
      });
    } finally {
      activeSessionId = await runShutdownCleanup(
        options,
        activeSessionId,
        pendingCutoffSessionIds,
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
  counters: VoiceResidentCounters,
  now: () => string
): Promise<string | undefined> {
  const nextActiveSessionId = cleanupActiveSessionForShutdown(
    options,
    activeSessionId,
    pendingCutoffSessionIds,
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
      piAgent: options.piAgent
    }
  );
  state.activeSession.setActiveSessionId(activeSessionId);
  enqueueEndedSessions(options, state.pendingCutoffSessionIds, counters, now);
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

function cleanupActiveSessionForShutdown(
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string | undefined,
  pendingCutoffSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): string | undefined {
  if (options.memoryWorker === undefined) {
    return activeSessionId;
  }

  const nextActiveSessionId = endActiveSessionForShutdown(
    options.sessionLifecycle,
    activeSessionId,
    {
      pendingCutoffSessionIds,
      piAgent: options.piAgent
    }
  );
  enqueueEndedSessions(options, pendingCutoffSessionIds, counters, now);

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

  await processTranscribedUtterances(
    state.utteranceAssembler.accept(echoResult.frame, echoResult.diagnostics.voiceActivity),
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

    const transcript = await transcribePassedFrame(utterance, options, counters, now);

    if (transcript === undefined || transcript.text === "") {
      continue;
    }

    const activeSessionId = ensureActiveVoiceSession(
      transcript,
      options,
      counters,
      now,
      state.activeSession
    );

    if (activeSessionId === undefined) {
      continue;
    }

    if (activeSessionId !== state.activeSession.getActiveSessionId()) {
      continue;
    }

    await runActiveVoiceTurn(transcript.text, options, counters, now, activeSessionId);
    state.activeSession.setActiveSessionId(
      collectEndedActiveSession(options.sessionLifecycle, activeSessionId, {
        pendingCutoffSessionIds: state.pendingCutoffSessionIds,
        piAgent: options.piAgent
      })
    );
    enqueueEndedSessions(options, state.pendingCutoffSessionIds, counters, now);
  }
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
  activeSession: {
    readonly getActiveSessionId: () => string | undefined;
    readonly setActiveSessionId: (id: string | undefined) => void;
  }
): string | undefined {
  const currentSessionId = activeSession.getActiveSessionId();

  if (currentSessionId !== undefined) {
    return currentSessionId;
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

  return undefined;
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

async function runActiveVoiceTurn(
  transcript: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  now: () => string,
  activeSessionId: string | undefined
): Promise<void> {
  if (activeSessionId === undefined) {
    throw new Error("pico resident voice active session is missing");
  }

  if (!appendStaffEntryIfSessionActive(options.sessionLifecycle, activeSessionId, transcript)) {
    return;
  }

  const piStageStartedAt = now();
  const response = await requestPiAgentResponse(
    activeSessionId,
    transcript,
    options,
    counters,
    piStageStartedAt
  );

  if (response === undefined) {
    return;
  }

  appendAssistantEntryIfSessionActive(options.sessionLifecycle, activeSessionId, response.text);
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "pi_turn",
    status: "ok",
    startedAt: piStageStartedAt,
    durationMs: 0,
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
  counters.completedTurns += 1;
}

async function requestPiAgentResponse(
  sessionId: string,
  transcript: string,
  options: VoiceResidentRuntimeOptions,
  counters: VoiceResidentCounters,
  startedAt: string
): Promise<{ readonly text: string } | undefined> {
  try {
    return await options.piAgent.prompt({
      sessionId,
      text: transcript,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
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
  const ttsResult = await options.tts.synthesize({
    text,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });

  if (ttsResult.ok) {
    return ttsResult;
  }

  counters.failedTurns += 1;
  recordVoiceStageProbe(options.probe ?? {}, {
    stage: "tts_synthesize",
    status: "error",
    startedAt,
    durationMs: 0,
    attributes: {
      "pico.voice.error_code": ttsResult.reason
    }
  });

  return undefined;
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
  }
): string | undefined {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = lifecycle.read(activeSessionId);

  if (session === undefined) {
    disposeSessionQuietly(options.piAgent, activeSessionId);
    return undefined;
  }

  if (session.state !== "ended") {
    return activeSessionId;
  }

  options.pendingCutoffSessionIds.add(activeSessionId);

  return undefined;
}

function endActiveSessionForShutdown(
  lifecycle: SessionLifecycle,
  activeSessionId: string | undefined,
  options: {
    readonly pendingCutoffSessionIds: Set<string>;
    readonly piAgent: PiAgentTurnClient;
  }
): string | undefined {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = lifecycle.read(activeSessionId);

  if (session === undefined) {
    disposeSessionQuietly(options.piAgent, activeSessionId);
    return undefined;
  }

  if (session.state === "active") {
    lifecycle.end(activeSessionId);
  }

  options.pendingCutoffSessionIds.add(activeSessionId);

  return undefined;
}

function enqueueEndedSessions(
  options: VoiceResidentRuntimeOptions,
  pendingCutoffSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string
): void {
  for (const sessionId of [...pendingCutoffSessionIds]) {
    const session = options.sessionLifecycle.read(sessionId);

    if (session?.state !== "ended") {
      pendingCutoffSessionIds.delete(sessionId);
      continue;
    }

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
