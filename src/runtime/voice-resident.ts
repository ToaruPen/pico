import type { SessionLifecycle, SessionRecord } from "../modules/session/index.js";
import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type { SttClient, TtsClient } from "../modules/voice/index.js";
import type { DeferredToolDeliverableResult } from "./deferred-tool-coordinator.js";
import type { ResidentAudioCapture, ResidentCaptureSession } from "./resident-audio-io.js";
import type { ResidentControlEvent, ResidentControlResult } from "./resident-control.js";
import {
  createResidentControlController,
  type ResidentControlController,
  type ResidentControlScheduler,
  type ResidentControlState,
  type ResidentTurnGeneration
} from "./resident-control-controller.js";
import type { ResidentVoiceValidationSink } from "./resident-voice-validation.js";
import type { SpeechActivityGate } from "./speech-activity-gate.js";
import { runTtsPlaybackPipeline, type TtsPlaybackPipelineResult } from "./tts-playback-pipeline.js";
import type { VoicePlaybackSink } from "./voice-playback.js";
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";

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
    };

export type VoiceResidentLogSink = {
  readonly record: (event: VoiceResidentLogEvent) => void;
};

export type VoiceResidentRuntimeOptions = {
  readonly audioCapture: ResidentAudioCapture;
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
  readonly scheduler?: ResidentControlScheduler;
  readonly farewell?: {
    readonly enabled: boolean;
  };
  readonly log?: VoiceResidentLogSink;
  readonly probe?: VoiceStageProbe;
  readonly validation?: ResidentVoiceValidationSink;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
};

export type VoiceResidentRuntimeResult = {
  readonly acceptedHolds: number;
  readonly completedTurns: number;
  readonly emptyHolds: number;
  readonly ignoredBusyTalkPresses: number;
  readonly cancelledTurns: number;
  readonly lateResultsSuppressed: number;
  readonly failedCaptures: number;
  readonly failedTurns: number;
};

export type VoiceResidentRuntime = {
  readonly handleControl: (event: ResidentControlEvent) => Promise<ResidentControlResult>;
  readonly state: () => ResidentControlState;
  readonly completion: Promise<VoiceResidentRuntimeResult>;
  readonly stop: () => Promise<void>;
};

type RuntimeCounters = {
  acceptedHolds: number;
  completedTurns: number;
  emptyHolds: number;
  ignoredBusyTalkPresses: number;
  cancelledTurns: number;
  lateResultsSuppressed: number;
  failedCaptures: number;
  failedTurns: number;
};

type ActiveTurn = {
  readonly generation: ResidentTurnGeneration;
  readonly capture: ResidentCaptureSession;
  readonly frames: VoicePcmFrame[];
  readonly frameCollection: Promise<void>;
  operation: Promise<void> | undefined;
  cancellation: Promise<void> | undefined;
  pttRelease: PttReleaseMeasurement | undefined;
};

type PttReleaseMeasurement = {
  readonly startedAt: string;
  readonly startedAtMs: number;
  settled: boolean;
};

type InteractionEndingControl = {
  readonly sessionId: string;
  readonly abortController: AbortController;
  readonly startedAt: string;
  readonly startedAtMs: number;
  cleanupOwner: "resident" | "pipeline";
  cancellation: Promise<void> | undefined;
};

class PlaybackInfrastructureError extends Error {}

const defaultNow = (): string => new Date().toISOString();
const defaultMonotonicNow = (): number => performance.now();
const farewellPrompt =
  "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic.";
const noSpeechTranscripts = new Set([
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "ご清聴ありがとうございました"
]);

export function createVoiceResidentRuntime(
  options: VoiceResidentRuntimeOptions
): VoiceResidentRuntime {
  const now = options.now ?? defaultNow;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const counters: RuntimeCounters = {
    acceptedHolds: 0,
    completedTurns: 0,
    emptyHolds: 0,
    ignoredBusyTalkPresses: 0,
    cancelledTurns: 0,
    lateResultsSuppressed: 0,
    failedCaptures: 0,
    failedTurns: 0
  };
  let activeTurn: ActiveTurn | undefined;
  let activeSessionId: string | undefined;
  let activeInteractionEnding: InteractionEndingControl | undefined;
  let interactionEnding: Promise<void> = Promise.resolve();
  const shutdownCancelledSessionIds = new Set<string>();
  let stopOperation: Promise<void> | undefined;
  let shutdownStarted = false;
  let runtimeFailure: Error | undefined;
  let runtimeSettled = false;
  let resolveCompletion: (result: VoiceResidentRuntimeResult) => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const completion = new Promise<VoiceResidentRuntimeResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  const failRuntime = (error: unknown, generationId?: number): void => {
    if (runtimeSettled || runtimeFailure !== undefined) {
      return;
    }

    runtimeFailure = asError(error);
    controller.fail(generationId);

    if (shutdownStarted) {
      return;
    }

    runtimeSettled = true;
    rejectCompletion(runtimeFailure);
  };
  const controller: ResidentControlController = createResidentControlController({
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    onListen(generation) {
      const capture = options.audioCapture.start(generation.signal);
      const frames: VoicePcmFrame[] = [];
      const frameCollection = collectCaptureFrames(capture.frames, frames, generation.signal);
      void frameCollection.catch((error: unknown) => {
        if (!generation.signal.aborted) {
          counters.failedCaptures += 1;
          failRuntime(error, generation.id);
        }
      });
      activeTurn = {
        generation,
        capture,
        frames,
        frameCollection,
        operation: undefined,
        cancellation: undefined,
        pttRelease: undefined
      };
      counters.acceptedHolds += 1;
    },
    onTailReady(generation) {
      const turn = currentTurn(activeTurn, generation.id);

      if (turn === undefined) {
        counters.lateResultsSuppressed += 1;
        return;
      }

      turn.operation = processCompletedHold(turn, controller, options, counters, {
        now,
        monotonicNow,
        getActiveSessionId: () => activeSessionId,
        getEndingSessionId: () => activeInteractionEnding?.sessionId,
        setActiveSessionId: (sessionId) => {
          activeSessionId = sessionId;
        }
      })
        .catch((error: unknown) => {
          if (error instanceof PlaybackInfrastructureError) {
            failRuntime(error, generation.id);
            return;
          }
          if (!generation.signal.aborted) {
            counters.failedCaptures += 1;
            failRuntime(error, generation.id);
          }
        })
        .finally(() => {
          if (activeTurn === turn) {
            activeTurn = undefined;
          }
        });
    },
    onCancel(generation, cancelledState) {
      const turn = currentTurn(activeTurn, generation.id);

      if (turn === undefined || turn.cancellation !== undefined) {
        return;
      }

      counters.cancelledTurns += 1;
      settlePttReleaseMeasurement(turn, options, "skipped", monotonicNow, "cancelled");
      turn.cancellation = convergeCancellation(
        turn,
        controller,
        options,
        cancelledState === "synthesizing" || cancelledState === "speaking"
      ).then(() => {
        if (activeTurn === turn) {
          activeTurn = undefined;
        }
      });
      turn.cancellation.catch((error: unknown) => failRuntime(error, generation.id));
    }
  });
  const cancelInteractionEnding = (): boolean => {
    const ending = activeInteractionEnding;

    if (ending === undefined || ending.abortController.signal.aborted) {
      return false;
    }

    ending.abortController.abort(new Error("pico resident interaction ending cancelled"));
    ending.cancellation ??= cancelInteractionEndingResources(ending, options);
    void ending.cancellation.catch(() => undefined);

    return true;
  };
  const queueInteractionEnding = (session: SessionRecord): void => {
    if (session.id !== activeSessionId || activeInteractionEnding?.sessionId === session.id) {
      return;
    }

    const ending: InteractionEndingControl = {
      sessionId: session.id,
      abortController: new AbortController(),
      startedAt: now(),
      startedAtMs: monotonicNow(),
      cleanupOwner: "resident",
      cancellation: undefined
    };
    activeInteractionEnding = ending;
    const turn = activeTurn;

    const operation = interactionEnding.then(async () => {
      let settlement: {
        readonly status: Parameters<typeof recordStage>[2];
        readonly errorCode?: string;
      } = { status: "ok" };

      try {
        await waitForTurnBoundary(turn);
        await finalizeEndedInteraction(
          ending,
          options,
          counters,
          now,
          shutdownCancelledSessionIds.has(session.id)
        );

        if (activeSessionId === session.id) {
          activeSessionId = undefined;
        }
        if (ending.abortController.signal.aborted) {
          settlement = { status: "skipped", errorCode: "cancelled" };
        }
      } catch (error) {
        settlement = { status: "error", errorCode: "interaction_end_failed" };
        throw error;
      } finally {
        recordStage(
          options,
          "interaction_end",
          settlement.status,
          ending.startedAt,
          Math.max(0, monotonicNow() - ending.startedAtMs),
          settlement.errorCode === undefined
            ? undefined
            : { "pico.voice.error_code": settlement.errorCode }
        );
        shutdownCancelledSessionIds.delete(session.id);

        if (activeInteractionEnding === ending) {
          activeInteractionEnding = undefined;
        }
      }
    });
    interactionEnding = operation;
    void operation.catch((error: unknown) => failRuntime(error));
  };
  const unsubscribeSessionEnding = options.sessionLifecycle.subscribeEnded(queueInteractionEnding);
  const stopFromSignal = (): void => {
    stop().catch((error: unknown) => failRuntime(error));
  };
  const stop = (): Promise<void> => {
    if (stopOperation !== undefined) {
      return stopOperation;
    }

    shutdownStarted = true;
    options.signal?.removeEventListener("abort", stopFromSignal);
    cancelInteractionEnding();
    const turn = activeTurn;

    if (turn !== undefined && isCancellableControlState(controller.state())) {
      controller.handle({ kind: "cancel_pressed", occurredAt: now() });
    }

    const shutdownFailure = endActiveInteractionForShutdown(
      activeSessionId,
      options,
      shutdownCancelledSessionIds
    );

    if (runtimeFailure === undefined && shutdownFailure !== undefined) {
      runtimeFailure = asError(shutdownFailure);
    }

    const endingAtShutdown = interactionEnding;
    unsubscribeSessionEnding();
    controller.stop();
    stopOperation = shutdownVoiceRuntime(
      turn,
      options,
      endingAtShutdown,
      () => runtimeFailure
    ).then(
      () => {
        activeTurn = undefined;

        if (!runtimeSettled) {
          runtimeSettled = true;
          resolveCompletion(Object.freeze({ ...counters }));
        }
      },
      (error: unknown) => {
        const failure = runtimeFailure ?? asError(error);
        runtimeFailure = failure;

        if (!runtimeSettled) {
          runtimeSettled = true;
          rejectCompletion(failure);
        }

        throw failure;
      }
    );

    return stopOperation;
  };

  options.signal?.addEventListener("abort", stopFromSignal, { once: true });

  if (options.signal?.aborted) {
    stopFromSignal();
  }

  const processControlEvent = (event: ResidentControlEvent): ResidentControlResult => {
    if (event.kind === "talk_pressed" && activeInteractionEnding !== undefined) {
      counters.ignoredBusyTalkPresses += 1;
      return "ignored_busy";
    }

    const result = controller.handle(event);
    recordAcceptedPttRelease(event, result, activeTurn, monotonicNow);

    if (acceptInteractionEndingCancel(event, cancelInteractionEnding)) {
      return "accepted";
    }

    if (event.kind === "talk_pressed" && result === "ignored_busy") {
      counters.ignoredBusyTalkPresses += 1;
    }

    return result;
  };
  const handleControlEvent = (event: ResidentControlEvent): ResidentControlResult => {
    try {
      return processControlEvent(event);
    } catch (error) {
      failRuntime(error, controller.generation()?.id);
      throw error;
    }
  };

  return {
    handleControl(event) {
      return Promise.resolve().then(() => handleControlEvent(event));
    },
    state: controller.state,
    completion,
    stop
  };
}

function recordAcceptedPttRelease(
  event: ResidentControlEvent,
  result: ResidentControlResult,
  activeTurn: ActiveTurn | undefined,
  monotonicNow: () => number
): void {
  if (event.kind !== "talk_released" || result !== "accepted" || activeTurn === undefined) {
    return;
  }

  activeTurn.pttRelease = {
    startedAt: event.occurredAt,
    startedAtMs: monotonicNow(),
    settled: false
  };
}

function acceptInteractionEndingCancel(
  event: ResidentControlEvent,
  cancel: () => boolean
): boolean {
  return event.kind === "cancel_pressed" && cancel();
}

async function collectCaptureFrames(
  source: AsyncIterable<VoicePcmFrame>,
  target: VoicePcmFrame[],
  signal: AbortSignal
): Promise<void> {
  for await (const frame of source) {
    signal.throwIfAborted();
    target.push(defineVoicePcmFrame(frame));
  }
}

async function processCompletedHold(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  state: {
    readonly now: () => string;
    readonly monotonicNow: () => number;
    readonly getActiveSessionId: () => string | undefined;
    readonly getEndingSessionId: () => string | undefined;
    readonly setActiveSessionId: (sessionId: string | undefined) => void;
  }
): Promise<void> {
  try {
    await processCompletedHoldWork(turn, controller, options, counters, state);
  } catch (error) {
    settlePttReleaseMeasurement(
      turn,
      options,
      turn.generation.signal.aborted ? "skipped" : "error",
      state.monotonicNow,
      turn.generation.signal.aborted ? "cancelled" : "turn_failed_before_playback"
    );
    throw error;
  } finally {
    settlePttReleaseMeasurement(
      turn,
      options,
      "skipped",
      state.monotonicNow,
      turn.generation.signal.aborted ? "cancelled" : "playback_not_started"
    );
  }
}

// Each guard rejects results that no longer belong to the active generation and stage.
// eslint-disable-next-line complexity
async function processCompletedHoldWork(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  state: {
    readonly now: () => string;
    readonly monotonicNow: () => number;
    readonly getActiveSessionId: () => string | undefined;
    readonly getEndingSessionId: () => string | undefined;
    readonly setActiveSessionId: (sessionId: string | undefined) => void;
  }
): Promise<void> {
  await turn.capture.stop();
  await turn.frameCollection;

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  const admitted = await admitCapturedSpeech(turn.frames, options, turn.generation.signal);

  if (!admitted.speech || admitted.audio.byteLength === 0) {
    counters.emptyHolds += 1;
    finishCurrentTurn(controller, turn.generation.id, "transcribing", counters);
    return;
  }

  const transcript = await transcribeHold(admitted, turn, options, state.now, state.monotonicNow);

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  if (transcript === undefined) {
    counters.failedTurns += 1;
    finishCurrentTurn(controller, turn.generation.id, "transcribing", counters);
    return;
  }

  if (isEmptyTranscript(transcript)) {
    counters.emptyHolds += 1;
    finishCurrentTurn(controller, turn.generation.id, "transcribing", counters);
    return;
  }

  if (!controller.advance(turn.generation.id, "transcribing", "processing")) {
    counters.lateResultsSuppressed += 1;
    return;
  }

  const sessionId = await ensureActiveSession(options, state);
  const deferredResults = collectDeferredResults(options, sessionId, state.now());
  options.validation?.record({
    kind: "staff_transcript",
    occurredAt: state.now(),
    sessionId,
    text: transcript
  });
  recordLog(options.log, {
    kind: "staff_input",
    occurredAt: state.now(),
    sessionId
  });
  const piStartedAt = state.now();
  const piStartedAtMs = state.monotonicNow();
  const response = await requestPiTurn(
    transcript,
    sessionId,
    deferredResults,
    turn,
    options,
    counters
  );
  const piDurationMs = Math.max(0, state.monotonicNow() - piStartedAtMs);

  recordPiTurnSettlement(response, turn.generation.signal, options, piStartedAt, piDurationMs);

  if (!isCurrentStage(controller, turn.generation.id, "processing", counters)) {
    return;
  }

  if (response === undefined) {
    finishCurrentTurn(controller, turn.generation.id, "processing", counters);
    return;
  }

  options.validation?.record({
    kind: "pi_response",
    occurredAt: state.now(),
    sessionId,
    text: response.text
  });

  recordLog(options.log, {
    kind: "pi_agent_response",
    occurredAt: state.now(),
    sessionId,
    durationMs: piDurationMs
  });

  if (!controller.advance(turn.generation.id, "processing", "synthesizing")) {
    counters.lateResultsSuppressed += 1;
    return;
  }

  const playback = await runTtsPlaybackPipeline({
    text: response.text,
    signal: turn.generation.signal,
    tts: options.tts,
    playback: options.playback,
    echoControl: options.echoControl,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    now: state.now,
    monotonicNow: state.monotonicNow,
    onFirstPlaybackStart: () => {
      if (
        controller.generation()?.id !== turn.generation.id ||
        controller.state() !== "synthesizing"
      ) {
        return false;
      }
      if (!controller.advance(turn.generation.id, "synthesizing", "speaking")) {
        return false;
      }
      settlePttReleaseMeasurement(turn, options, "ok", state.monotonicNow);
      return true;
    }
  });

  throwPlaybackInfrastructureError(playback);

  settleCompletedTurn(
    playback,
    turn.generation.id,
    controller,
    options,
    counters,
    sessionId,
    deferredResults
  );
}

function settleCompletedTurn(
  result: TtsPlaybackPipelineResult,
  generationId: number,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  sessionId: string,
  deferredResults: readonly DeferredToolDeliverableResult[]
): void {
  const state = currentPlaybackState(controller, generationId);
  if (state === undefined) {
    return;
  }

  switch (result.status) {
    case "completed":
      acknowledgeDeferredResults(options, deferredResults);
      refreshSession(options.sessionLifecycle, sessionId);
      counters.completedTurns += 1;
      break;
    case "failed":
      counters.failedTurns += 1;
      break;
    case "cancelled":
    case "empty":
      break;
  }

  controller.finish(generationId, state);
}

function currentPlaybackState(
  controller: ResidentControlController,
  generationId: number
): "synthesizing" | "speaking" | undefined {
  if (controller.generation()?.id !== generationId) {
    return undefined;
  }
  const state = controller.state();
  return state === "synthesizing" || state === "speaking" ? state : undefined;
}

// Frame admission keeps echo suppression, optional VAD, and audio retention in one pass.
// eslint-disable-next-line complexity
async function admitCapturedSpeech(
  frames: readonly VoicePcmFrame[],
  options: VoiceResidentRuntimeOptions,
  signal: AbortSignal
): Promise<{
  readonly audio: Uint8Array;
  readonly speech: boolean;
  readonly sampleRateHz: number;
  readonly channels: number;
}> {
  const admitted: Uint8Array[] = [];
  let speech = false;

  for (const frame of frames) {
    signal.throwIfAborted();
    const echo = await options.echoControl.processNearEnd(frame);
    signal.throwIfAborted();

    if (echo.action === "suppress") {
      continue;
    }

    admitted.push(echo.frame.audio);
    const activity = await options.speechActivity?.process(echo.frame);
    signal.throwIfAborted();
    speech ||= activity?.speech ?? echo.diagnostics.voiceActivity;
  }

  const first = frames[0];

  return {
    audio: concatenateAudio(admitted),
    speech,
    sampleRateHz: first?.sampleRateHz ?? 16_000,
    channels: first?.channels ?? 1
  };
}

async function transcribeHold(
  admitted: {
    readonly audio: Uint8Array;
    readonly sampleRateHz: number;
    readonly channels: number;
  },
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  now: () => string,
  monotonicNow: () => number
): Promise<string | undefined> {
  const startedAt = now();
  const startedAtMs = monotonicNow();
  const recordFailure = (cancelled: boolean, errorCode: string): void => {
    recordStage(
      options,
      "stt",
      cancelled ? "skipped" : "error",
      startedAt,
      Math.max(0, monotonicNow() - startedAtMs),
      { "pico.voice.error_code": errorCode }
    );
  };
  let result: Awaited<ReturnType<SttClient["transcribe"]>>;

  try {
    result = await options.stt.transcribe({
      audio: admitted.audio,
      encoding: "pcm16le",
      sampleRateHz: admitted.sampleRateHz,
      channels: admitted.channels,
      signal: turn.generation.signal
    });
  } catch {
    const cancelled = turn.generation.signal.aborted;
    recordFailure(cancelled, cancelled ? "cancelled" : "stt_request_failed");
    return undefined;
  }

  if (turn.generation.signal.aborted) {
    recordFailure(true, "cancelled");
    return undefined;
  }

  if (!result.ok) {
    recordFailure(result.reason === "aborted", result.reason);
    return undefined;
  }

  recordStage(options, "stt", "ok", startedAt, Math.max(0, monotonicNow() - startedAtMs), {
    "pico.voice.utterance_duration_ms": result.durationMs
  });
  return result.text.trim();
}

async function ensureActiveSession(
  options: VoiceResidentRuntimeOptions,
  state: {
    readonly getActiveSessionId: () => string | undefined;
    readonly getEndingSessionId: () => string | undefined;
    readonly setActiveSessionId: (sessionId: string | undefined) => void;
  }
): Promise<string> {
  const existingId = state.getActiveSessionId();
  const reusableId = reusableSessionId(
    existingId,
    state.getEndingSessionId(),
    options.sessionLifecycle
  );

  if (reusableId !== undefined) {
    return reusableId;
  }

  if (existingId !== undefined) {
    await options.piAgent.disposeSession?.(existingId);
    options.deferredTools?.cancelSession?.(existingId, "session_closed");
    options.sessionLifecycle.remove(existingId);
  }

  const session = options.sessionLifecycle.start({
    kind: "button_trigger",
    label: "hold_to_talk",
    source: "loopback_http"
  });
  state.setActiveSessionId(session.id);
  return session.id;
}

function reusableSessionId(
  activeSessionId: string | undefined,
  endingSessionId: string | undefined,
  lifecycle: SessionLifecycle
): string | undefined {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = lifecycle.read(activeSessionId);
  return session?.state === "active" || endingSessionId === activeSessionId
    ? activeSessionId
    : undefined;
}

async function requestPiTurn(
  transcript: string,
  sessionId: string,
  deferredResults: readonly DeferredToolDeliverableResult[],
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters
): Promise<{ readonly text: string } | undefined> {
  try {
    return await options.piAgent.prompt({
      sessionId,
      text: transcript,
      ...(deferredResults.length === 0 ? {} : { deferredToolResults: deferredResults }),
      signal: turn.generation.signal
    });
  } catch {
    if (!turn.generation.signal.aborted) {
      counters.failedTurns += 1;
    }

    return undefined;
  }
}

function isCancellableControlState(state: ResidentControlState): boolean {
  return state !== "idle" && state !== "cancelling" && state !== "error" && state !== "stopped";
}

async function waitForTurnBoundary(turn: ActiveTurn | undefined): Promise<void> {
  if (turn === undefined) {
    return;
  }

  await turn.frameCollection.catch(() => undefined);
  let operation: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;

  do {
    operation = turn.operation;
    cancellation = turn.cancellation;
    await Promise.allSettled([operation ?? Promise.resolve(), cancellation ?? Promise.resolve()]);
  } while (operation !== turn.operation || cancellation !== turn.cancellation);
}

async function finalizeEndedInteraction(
  ending: InteractionEndingControl,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  now: () => string,
  deferredAlreadyCancelled: boolean
): Promise<void> {
  const { sessionId } = ending;

  if (options.sessionLifecycle.read(sessionId)?.state !== "ended") {
    return;
  }

  const farewellResults = await Promise.allSettled([
    runInteractionFarewell(ending, options, counters, now)
  ]);
  const cancellationBeforeCleanup = ending.cancellation;
  const cancellationResults = await Promise.allSettled([
    cancellationBeforeCleanup ?? Promise.resolve()
  ]);
  const cleanupResults = await Promise.allSettled([
    cancelDeferredAfterInteraction(sessionId, options, deferredAlreadyCancelled),
    Promise.resolve().then(() => options.piAgent.disposeSession?.(sessionId))
  ]);
  const lateCancellationResults = await settleLateInteractionEndingCancellation(
    ending,
    cancellationBeforeCleanup
  );
  const cleanupRejected = findRejected(cleanupResults);

  removeEndedSessionAfterCleanup(sessionId, options, cleanupRejected);

  const rejected = findRejected([
    ...farewellResults,
    ...cleanupResults,
    ...cancellationResults,
    ...lateCancellationResults
  ]);

  if (rejected !== undefined) {
    throw asError(rejected.reason);
  }
}

function settleLateInteractionEndingCancellation(
  ending: InteractionEndingControl,
  previouslyAwaited: Promise<void> | undefined
): Promise<readonly PromiseSettledResult<void>[]> {
  const cancellation = ending.cancellation;
  return cancellation === undefined || cancellation === previouslyAwaited
    ? Promise.resolve([])
    : Promise.allSettled([cancellation]);
}

function removeEndedSessionAfterCleanup(
  sessionId: string,
  options: VoiceResidentRuntimeOptions,
  cleanupRejected: PromiseRejectedResult | undefined
): void {
  if (
    cleanupRejected === undefined &&
    options.sessionLifecycle.read(sessionId)?.state === "ended"
  ) {
    options.sessionLifecycle.remove(sessionId);
  }
}

function cancelDeferredAfterInteraction(
  sessionId: string,
  options: VoiceResidentRuntimeOptions,
  alreadyCancelled: boolean
): Promise<void> {
  if (alreadyCancelled) {
    return Promise.resolve();
  }

  return Promise.resolve().then(() => {
    options.deferredTools?.cancelSession?.(sessionId, "session_closed");
  });
}

async function runInteractionFarewell(
  ending: InteractionEndingControl,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  now: () => string
): Promise<void> {
  const { sessionId } = ending;
  const signal = ending.abortController.signal;
  if (options.farewell?.enabled !== true || isAbortRequested(signal)) {
    return;
  }

  const piStartedAt = now();
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const piStartedAtMs = monotonicNow();
  const response = await requestFarewellResponse(sessionId, signal, options, counters);
  const piDurationMs = Math.max(0, monotonicNow() - piStartedAtMs);

  recordPiTurnSettlement(response, signal, options, piStartedAt, piDurationMs);

  if (response === undefined || isAbortRequested(signal)) {
    return;
  }

  await runFarewellPlayback(response.text, ending, options, counters, now, monotonicNow);
}

async function runFarewellPlayback(
  text: string,
  ending: InteractionEndingControl,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  now: () => string,
  monotonicNow: () => number
): Promise<void> {
  const signal = ending.abortController.signal;
  let result: TtsPlaybackPipelineResult;
  try {
    result = await runTtsPlaybackPipeline({
      text,
      signal,
      tts: options.tts,
      playback: options.playback,
      echoControl: options.echoControl,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      now,
      monotonicNow,
      onFirstPlaybackStart: () => {
        if (signal.aborted) {
          return false;
        }
        ending.cleanupOwner = "pipeline";
        return true;
      }
    });
  } finally {
    ending.cleanupOwner = "resident";
  }

  if (result.status === "failed") {
    counters.failedTurns += 1;
    throwPlaybackInfrastructureError(result);
  }
}

function cancelInteractionEndingResources(
  ending: InteractionEndingControl,
  options: VoiceResidentRuntimeOptions
): Promise<void> {
  return ending.cleanupOwner === "pipeline"
    ? Promise.resolve()
    : Promise.resolve().then(async () => {
        await options.echoControl.flush();
      });
}

function throwPlaybackInfrastructureError(result: TtsPlaybackPipelineResult): void {
  if (
    result.status === "failed" &&
    (result.errorCode === "playback_stop_failed" || result.errorCode === "playback_stop_timeout")
  ) {
    throw new PlaybackInfrastructureError(
      `pico resident voice playback infrastructure failed during cancellation: ${result.errorCode}`
    );
  }
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function requestFarewellResponse(
  sessionId: string,
  signal: AbortSignal,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters
): Promise<{ readonly text: string } | undefined> {
  try {
    return await options.piAgent.prompt({ sessionId, text: farewellPrompt, signal });
  } catch {
    if (signal.aborted) {
      return undefined;
    }

    counters.failedTurns += 1;
    return undefined;
  }
}

function recordPiTurnSettlement(
  response: { readonly text: string } | undefined,
  signal: AbortSignal,
  options: VoiceResidentRuntimeOptions,
  startedAt: string,
  durationMs: number
): void {
  if (response !== undefined && !signal.aborted) {
    recordStage(options, "pi_turn", "ok", startedAt, durationMs);
    return;
  }

  const cancelled = signal.aborted;
  recordStage(options, "pi_turn", cancelled ? "skipped" : "error", startedAt, durationMs, {
    "pico.voice.error_code": cancelled ? "cancelled" : "pi_agent_prompt_failed"
  });
}

async function convergeCancellation(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  pipelineOwnsPlayback: boolean
): Promise<void> {
  const stops = await Promise.allSettled([
    turn.capture.stop(),
    ...(pipelineOwnsPlayback ? [] : [options.playback.stop()])
  ]);
  await turn.frameCollection.catch(() => undefined);
  await turn.operation?.catch(() => undefined);
  if (!pipelineOwnsPlayback) {
    await options.echoControl.flush();
  }
  const rejected = findRejected(stops);

  if (rejected !== undefined) {
    throw rejected.reason;
  }

  controller.completeCancellation(turn.generation.id);
}

// Await each independently owned async boundary before shared resources close.
// eslint-disable-next-line complexity
async function shutdownVoiceRuntime(
  turn: ActiveTurn | undefined,
  options: VoiceResidentRuntimeOptions,
  interactionEnding: Promise<void>,
  precedingFailure: () => Error | undefined
): Promise<void> {
  const turnResults = await Promise.allSettled(
    turn === undefined
      ? []
      : [
          turn.capture.stop(),
          turn.frameCollection,
          turn.operation ?? Promise.resolve(),
          turn.cancellation ?? Promise.resolve()
        ]
  );
  const endingResults = await Promise.allSettled([interactionEnding]);
  const ownerResults = await Promise.allSettled([
    options.playback.stop(),
    options.audioCapture.close(),
    options.echoControl.flush(),
    Promise.resolve(options.speechActivity?.close?.()),
    Promise.resolve(options.piAgent.disposeAll?.()),
    options.deferredTools?.waitForIdle?.() ?? Promise.resolve()
  ]);
  let closeFailure: unknown;

  try {
    await options.playback.close();
  } catch (error) {
    closeFailure = error;
  }

  const rejected = findRejected([...turnResults, ...endingResults, ...ownerResults]);
  const failure = precedingFailure();

  if (failure !== undefined) {
    throw failure;
  }

  if (rejected !== undefined) {
    throw asError(rejected.reason);
  }

  if (closeFailure !== undefined) {
    throw asError(closeFailure);
  }
}

function endActiveInteractionForShutdown(
  activeSessionId: string | undefined,
  options: VoiceResidentRuntimeOptions,
  shutdownCancelledSessionIds: Set<string>
): unknown {
  if (activeSessionId === undefined) {
    return undefined;
  }

  const session = options.sessionLifecycle.read(activeSessionId);

  if (session?.state !== "active") {
    return undefined;
  }

  const cancelFailure = cancelDeferredForShutdown(session.id, options, shutdownCancelledSessionIds);
  const endingFailure = endSessionForShutdown(session.id, options.sessionLifecycle);

  return cancelFailure ?? endingFailure;
}

function cancelDeferredForShutdown(
  sessionId: string,
  options: VoiceResidentRuntimeOptions,
  shutdownCancelledSessionIds: Set<string>
): unknown {
  try {
    options.deferredTools?.cancelSession?.(sessionId, "shutdown");
    shutdownCancelledSessionIds.add(sessionId);
    return undefined;
  } catch (error) {
    return error;
  }
}

function endSessionForShutdown(sessionId: string, lifecycle: SessionLifecycle): unknown {
  try {
    lifecycle.end(sessionId);
    return undefined;
  } catch (error) {
    return error;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function findRejected(
  results: readonly PromiseSettledResult<unknown>[]
): PromiseRejectedResult | undefined {
  return results.find((result): result is PromiseRejectedResult => result.status === "rejected");
}

function collectDeferredResults(
  options: VoiceResidentRuntimeOptions,
  sessionId: string,
  now: string
): readonly DeferredToolDeliverableResult[] {
  return (
    options.deferredTools?.collectDeliverableResults({
      sessionId,
      activeSessionId: sessionId,
      now
    }) ?? []
  );
}

function acknowledgeDeferredResults(
  options: VoiceResidentRuntimeOptions,
  results: readonly DeferredToolDeliverableResult[]
): void {
  try {
    options.deferredTools?.acknowledgeDelivered?.(results.map((result) => result.jobId));
  } catch {
    return;
  }
}

function refreshSession(lifecycle: SessionLifecycle, sessionId: string): void {
  if (lifecycle.read(sessionId)?.state === "active") {
    lifecycle.refreshActivity(sessionId);
  }
}

function currentTurn(turn: ActiveTurn | undefined, generationId: number): ActiveTurn | undefined {
  return turn?.generation.id === generationId ? turn : undefined;
}

function isCurrentStage(
  controller: ResidentControlController,
  generationId: number,
  expected: ResidentControlState,
  counters: RuntimeCounters
): boolean {
  const current = controller.generation()?.id === generationId && controller.state() === expected;

  if (!current && controller.state() !== "cancelling" && controller.state() !== "stopped") {
    counters.lateResultsSuppressed += 1;
  }

  return current;
}

function finishCurrentTurn(
  controller: ResidentControlController,
  generationId: number,
  expected: ResidentControlState,
  counters: RuntimeCounters
): void {
  if (!controller.finish(generationId, expected)) {
    counters.lateResultsSuppressed += 1;
  }
}

function isEmptyTranscript(text: string): boolean {
  const normalized = text.trim().replaceAll(/\s+/gu, "");
  return normalized === "" || noSpeechTranscripts.has(normalized);
}

function concatenateAudio(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function recordLog(sink: VoiceResidentLogSink | undefined, event: VoiceResidentLogEvent): void {
  try {
    sink?.record(event);
  } catch {
    return;
  }
}

function recordStage(
  options: VoiceResidentRuntimeOptions,
  stage: Parameters<typeof recordVoiceStageProbe>[1]["stage"],
  status: Parameters<typeof recordVoiceStageProbe>[1]["status"],
  startedAt: string,
  durationMs: number,
  attributes?: Parameters<typeof recordVoiceStageProbe>[1]["attributes"]
): void {
  recordVoiceStageProbe(options.probe ?? {}, {
    stage,
    status,
    startedAt,
    durationMs,
    ...(attributes === undefined ? {} : { attributes })
  });
}

function settlePttReleaseMeasurement(
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  status: Parameters<typeof recordStage>[2],
  monotonicNow: () => number,
  errorCode?: string
): void {
  const measurement = turn.pttRelease;
  if (measurement === undefined || measurement.settled) {
    return;
  }

  measurement.settled = true;
  recordStage(
    options,
    "ptt_release_to_playback_start",
    status,
    measurement.startedAt,
    Math.max(0, monotonicNow() - measurement.startedAtMs),
    errorCode === undefined ? undefined : { "pico.voice.error_code": errorCode }
  );
}
