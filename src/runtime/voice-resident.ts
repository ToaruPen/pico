import type { SessionLifecycle, SessionRecord } from "../modules/session/index.js";
import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type {
  ResidentStreamingSttClient,
  ResidentStreamingSttSession,
  TtsClient
} from "../modules/voice/index.js";
import type { VoiceDesignSpeechPlan } from "../modules/voice-design/index.js";
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
import {
  type ResidentVoiceOperatorSink,
  type ResidentVoiceOperatorStageSink,
  type ResidentVoiceTurnPhase,
  recordResidentVoiceOperatorEvent,
  recordResidentVoiceOperatorStageEvent,
  scopeResidentVoiceOperatorStagesToCurrentTurn
} from "./resident-voice-operator.js";
import type { ResidentVoiceValidationSink } from "./resident-voice-validation.js";
import type { SpeechActivityGate } from "./speech-activity-gate.js";
import { runTtsPlaybackPipeline, type TtsPlaybackPipelineResult } from "./tts-playback-pipeline.js";
import type { VoicePlaybackSink } from "./voice-playback.js";
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";

export type PiAgentTurnResponse = {
  readonly text: string;
  readonly speechPlan?: VoiceDesignSpeechPlan;
  readonly settled: Promise<void>;
};

export type PiAgentTurnClient = {
  readonly prompt: (input: {
    readonly sessionId: string;
    readonly text: string;
    readonly deferredToolResults?: readonly DeferredToolDeliverableResult[];
    readonly signal?: AbortSignal;
  }) => Promise<PiAgentTurnResponse>;
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
  readonly captureBoundary?: {
    readonly suppress: () => Promise<void>;
    readonly resume: () => Promise<void>;
  };
  readonly sessionLifecycle: SessionLifecycle;
  readonly echoControl: EchoControlProvider;
  readonly speechActivity?: SpeechActivityGate;
  readonly stt: ResidentStreamingSttClient;
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
  readonly operator?: ResidentVoiceOperatorSink;
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
  readonly generationId: () => number | undefined;
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
  readonly sttSession: Promise<ResidentStreamingSttSession>;
  readonly frameCollection: Promise<StreamingCaptureAdmission>;
  readonly operatorStages: ResidentVoiceOperatorStageSink | undefined;
  playbackOperation: Promise<TtsPlaybackPipelineResult> | undefined;
  operation: Promise<void> | undefined;
  cancellation: Promise<void> | undefined;
  pipelineOwnsPlayback: boolean;
  pttRelease: PttReleaseMeasurement | undefined;
  operatorIdleRecorded: boolean;
};

type PttReleaseMeasurement = {
  readonly startedAt: string;
  readonly startedAtMs: number;
  settled: boolean;
};

type CancellationMeasurement = {
  readonly startedAt: string;
  readonly startedAtMs: number;
  outputStoppedSettled: boolean;
  idleSettled: boolean;
};

type PiTurnSettlement = "ok" | "failed";

type PiAdmissionBarrier = {
  pending: boolean;
  readonly completion: Promise<void>;
};

type InteractionEndingControl = {
  readonly sessionId: string;
  readonly abortController: AbortController;
  readonly startedAt: string;
  readonly startedAtMs: number;
  acceptingCancellation: boolean;
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
  const ownedTurnOperations = new Set<Promise<void>>();
  let piAdmissionBarrier: PiAdmissionBarrier = {
    pending: false,
    completion: Promise.resolve()
  };
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
    if (controller.fail(generationId)) {
      recordTurnIdle(activeTurn, options);
    }

    if (shutdownStarted) {
      return;
    }

    runtimeSettled = true;
    rejectCompletion(runtimeFailure);
  };
  const controller: ResidentControlController = createResidentControlController({
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    onError: (error) => failRuntime(error, controller.generation()?.id),
    onListen(generation) {
      if (activeSessionId !== undefined) {
        refreshSession(options.sessionLifecycle, activeSessionId);
      }
      const capture = options.audioCapture.start(generation.signal, generation.id);
      const sttSession = options.stt.open(generation.signal);
      const frameCollection = streamCaptureFrames(
        capture.frames,
        sttSession,
        options,
        generation.signal
      );
      void frameCollection.catch((error: unknown) => {
        if (!generation.signal.aborted) {
          counters.failedCaptures += 1;
          failRuntime(error, generation.id);
        }
      });
      recordResidentVoiceOperatorEvent(options.operator, {
        kind: "turn_started"
      });
      activeTurn = {
        generation,
        capture,
        sttSession,
        frameCollection,
        operatorStages: scopeResidentVoiceOperatorStagesToCurrentTurn(options.operator),
        playbackOperation: undefined,
        operation: undefined,
        cancellation: undefined,
        pipelineOwnsPlayback: false,
        pttRelease: undefined,
        operatorIdleRecorded: false
      };
      recordTurnPhase(options.operator, "listening");
      counters.acceptedHolds += 1;
    },
    onTailReady(generation) {
      const turn = currentTurn(activeTurn, generation.id);

      if (turn === undefined) {
        counters.lateResultsSuppressed += 1;
        return;
      }

      recordTurnPhase(options.operator, "transcribing");

      const operation = processCompletedHold(turn, controller, options, counters, {
        now,
        monotonicNow,
        getActiveSessionId: () => activeSessionId,
        getEndingSessionId: () => activeInteractionEnding?.sessionId,
        setActiveSessionId: (sessionId) => {
          activeSessionId = sessionId;
        },
        waitForPiAdmission: async (signal) => {
          if (piAdmissionBarrier.pending) {
            recordTurnPhase(options.operator, "waiting_for_previous_turn");
          }
          return waitForPiAdmission(piAdmissionBarrier, signal);
        },
        ownPiSettlement: (settlement) => {
          const barrier: PiAdmissionBarrier = {
            pending: true,
            completion: settlement
          };
          piAdmissionBarrier = barrier;
          const clearPending = (): void => {
            barrier.pending = false;
          };
          void settlement.then(clearPending, clearPending);
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
      turn.operation = operation;
      ownTurnOperation(ownedTurnOperations, operation);
    },
    onCancel(generation) {
      const turn = currentTurn(activeTurn, generation.id);

      if (turn === undefined || turn.cancellation !== undefined) {
        return;
      }

      counters.cancelledTurns += 1;
      recordResidentVoiceOperatorEvent(options.operator, { kind: "turn_cancelled" });
      recordTurnPhase(options.operator, "cancelling");
      settlePttReleaseToFirstPcmWrite(turn, options, "skipped", monotonicNow, "cancelled");
      turn.cancellation = convergeCancellation(
        turn,
        controller,
        options,
        turn.pipelineOwnsPlayback,
        {
          startedAt: now(),
          startedAtMs: monotonicNow(),
          outputStoppedSettled: false,
          idleSettled: false
        },
        monotonicNow
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

    if (
      ending === undefined ||
      !ending.acceptingCancellation ||
      ending.cancellation !== undefined
    ) {
      return false;
    }

    ending.abortController.abort(new Error("pico resident interaction ending cancelled"));
    ending.cancellation = cancelInteractionEndingResources(ending, options);
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
      acceptingCancellation: true,
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
        await waitForOwnedTurnOperations(ownedTurnOperations);
        recordResidentVoiceOperatorEvent(options.operator, {
          kind: "interaction_ending_started"
        });
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
        recordResidentVoiceOperatorEvent(options.operator, {
          kind: "interaction_ending_finished"
        });
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
    recordTurnIdle(turn, options);
    stopOperation = shutdownVoiceRuntime(
      turn,
      options,
      endingAtShutdown,
      ownedTurnOperations,
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
      recordTalkControlDecision(event, "ignored_busy", "interaction_ending", counters, options);
      return "ignored_busy";
    }

    const result = controller.handle(event);
    recordAcceptedPttRelease(event, result, activeTurn, monotonicNow);

    if (acceptInteractionEndingCancel(event, cancelInteractionEnding)) {
      return "accepted";
    }

    recordTalkControlDecision(event, result, controller.state(), counters, options);

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
    generationId: () => controller.generation()?.id,
    completion,
    stop
  };
}

function recordTalkControlDecision(
  event: ResidentControlEvent,
  result: ResidentControlResult,
  state: ResidentControlState | "interaction_ending",
  counters: RuntimeCounters,
  options: Pick<VoiceResidentRuntimeOptions, "operator">
): void {
  if (event.kind !== "talk_pressed") return;
  if (result === "ignored_busy") {
    counters.ignoredBusyTalkPresses += 1;
  }
  if (result === "accepted" || state === "error" || state === "stopped") return;
  recordResidentVoiceOperatorEvent(options.operator, {
    kind: "control_decision",
    control: "talk",
    result,
    state
  });
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

type StreamingCaptureAdmission = {
  readonly speech: boolean;
  readonly writtenBytes: number;
  readonly sttFailed: boolean;
};

type StreamingCaptureState = {
  readonly stream: ResidentStreamingSttSession | undefined;
  speech: boolean;
  writtenBytes: number;
  sttFailed: boolean;
};

async function streamCaptureFrames(
  source: AsyncIterable<VoicePcmFrame>,
  sttSession: Promise<ResidentStreamingSttSession>,
  options: Pick<VoiceResidentRuntimeOptions, "echoControl" | "speechActivity">,
  signal: AbortSignal
): Promise<StreamingCaptureAdmission> {
  const stream = await openStreamingSession(sttSession, signal);
  const state: StreamingCaptureState = {
    stream,
    speech: false,
    writtenBytes: 0,
    sttFailed: stream === undefined
  };

  try {
    for await (const input of source) {
      await processStreamingCaptureFrame(input, state, options, signal);
    }
    return {
      speech: state.speech,
      writtenBytes: state.writtenBytes,
      sttFailed: state.sttFailed
    };
  } catch (error) {
    await state.stream?.cancel();
    throw error;
  }
}

async function openStreamingSession(
  sttSession: Promise<ResidentStreamingSttSession>,
  signal: AbortSignal
): Promise<ResidentStreamingSttSession | undefined> {
  try {
    return await sttSession;
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

async function processStreamingCaptureFrame(
  input: VoicePcmFrame,
  state: StreamingCaptureState,
  options: Pick<VoiceResidentRuntimeOptions, "echoControl" | "speechActivity">,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const frame = defineVoicePcmFrame(input);
  const stream = writableStreamingSession(state);
  if (stream === undefined) return;
  const echo = await options.echoControl.processNearEnd(frame);
  signal.throwIfAborted();
  if (echo.action === "suppress") return;

  const activity = await options.speechActivity?.process(echo.frame);
  signal.throwIfAborted();
  state.speech ||= activity?.speech ?? echo.diagnostics.voiceActivity;
  try {
    await stream.write(echo.frame.audio);
    state.writtenBytes += echo.frame.audio.byteLength;
  } catch {
    state.sttFailed = true;
    await stream.cancel().catch(() => undefined);
  }
}

function writableStreamingSession(
  state: StreamingCaptureState
): ResidentStreamingSttSession | undefined {
  if (state.sttFailed) return undefined;
  return state.stream;
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
    readonly waitForPiAdmission: (signal: AbortSignal) => Promise<boolean>;
    readonly ownPiSettlement: (settlement: Promise<void>) => void;
  }
): Promise<void> {
  try {
    await processCompletedHoldWork(turn, controller, options, counters, state);
  } catch (error) {
    settlePttReleaseToFirstPcmWrite(
      turn,
      options,
      turn.generation.signal.aborted ? "skipped" : "error",
      state.monotonicNow,
      turn.generation.signal.aborted ? "cancelled" : "turn_failed_before_playback"
    );
    throw error;
  } finally {
    settlePttReleaseToFirstPcmWrite(
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
    readonly waitForPiAdmission: (signal: AbortSignal) => Promise<boolean>;
    readonly ownPiSettlement: (settlement: Promise<void>) => void;
  }
): Promise<void> {
  await turn.capture.stop();
  const admitted = await turn.frameCollection;

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  if (admitted.sttFailed) {
    counters.failedTurns += 1;
    finishCurrentTurn(controller, turn, "transcribing", counters, options);
    return;
  }

  if (!admitted.speech || admitted.writtenBytes === 0) {
    await cancelStreamingStt(turn);
    counters.emptyHolds += 1;
    finishCurrentTurn(controller, turn, "transcribing", counters, options);
    return;
  }

  const transcript = await transcribeHold(turn, options, state.now, state.monotonicNow);

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  if (transcript === undefined) {
    counters.failedTurns += 1;
    finishCurrentTurn(controller, turn, "transcribing", counters, options);
    return;
  }

  if (isEmptyTranscript(transcript)) {
    counters.emptyHolds += 1;
    finishCurrentTurn(controller, turn, "transcribing", counters, options);
    return;
  }

  if (!controller.advance(turn.generation.id, "transcribing", "processing")) {
    counters.lateResultsSuppressed += 1;
    return;
  }
  recordTurnPhase(options.operator, "processing");

  const sessionId = await ensureActiveSession(options, state);
  const deferredResults = collectDeferredResults(options, sessionId, state.now());
  const transcriptOccurredAt = state.now();
  options.validation?.record({
    kind: "staff_transcript",
    occurredAt: transcriptOccurredAt,
    sessionId,
    text: transcript
  });
  recordResidentVoiceOperatorEvent(options.operator, {
    kind: "staff_transcript",
    text: transcript
  });
  recordLog(options.log, {
    kind: "staff_input",
    occurredAt: transcriptOccurredAt,
    sessionId
  });
  const waitedForPiAdmission = await state.waitForPiAdmission(turn.generation.signal);
  if (!isCurrentStage(controller, turn.generation.id, "processing", counters)) {
    return;
  }
  if (waitedForPiAdmission) {
    recordTurnPhase(options.operator, "processing");
  }
  const piStartedAt = state.now();
  const piStartedAtMs = state.monotonicNow();
  const responseOperation = requestPiTurn(
    transcript,
    sessionId,
    deferredResults,
    turn,
    options,
    counters
  );
  const piSettlementOperation = responseOperation.then((response) =>
    response === undefined
      ? "failed"
      : settlePiResponse(
          response,
          options,
          turn.operatorStages,
          piStartedAt,
          piStartedAtMs,
          state.monotonicNow
        )
  );
  state.ownPiSettlement(piSettlementOperation.then(() => undefined));
  const response = await responseOperation;
  const responseReadyDurationMs = Math.max(0, state.monotonicNow() - piStartedAtMs);

  if (response === undefined) {
    recordUnavailablePiTurn(
      turn.generation.signal,
      options,
      turn.operatorStages,
      piStartedAt,
      responseReadyDurationMs
    );
    if (isCurrentStage(controller, turn.generation.id, "processing", counters)) {
      finishCurrentTurn(controller, turn, "processing", counters, options);
    }
    return;
  }

  if (!isCurrentStage(controller, turn.generation.id, "processing", counters)) {
    await piSettlementOperation;
    return;
  }

  const responseOccurredAt = state.now();
  options.validation?.record({
    kind: "pi_response",
    occurredAt: responseOccurredAt,
    sessionId,
    text: response.text
  });
  recordResidentVoiceOperatorEvent(options.operator, {
    kind: "pi_response",
    text: response.text
  });

  recordLog(options.log, {
    kind: "pi_agent_response",
    occurredAt: responseOccurredAt,
    sessionId,
    durationMs: responseReadyDurationMs
  });

  if (!controller.advance(turn.generation.id, "processing", "synthesizing")) {
    counters.lateResultsSuppressed += 1;
    return;
  }
  recordTurnPhase(options.operator, "synthesizing");

  const captureBoundary = createCaptureBoundaryLease(options.captureBoundary);
  const playbackOperation = runTurnPlayback(
    response.text,
    response.speechPlan,
    turn,
    controller,
    options,
    state.now,
    state.monotonicNow,
    captureBoundary
  );
  turn.playbackOperation = playbackOperation;
  const [playback, piSettlement] = await settleConcurrentOperations(
    playbackOperation,
    piSettlementOperation
  );

  if (playback.status === "failed") {
    settlePttReleaseToFirstPcmWrite(turn, options, "error", state.monotonicNow, playback.errorCode);
  }
  throwPlaybackInfrastructureError(playback);

  settleCompletedTurn(
    playback,
    piSettlement,
    turn,
    controller,
    options,
    counters,
    sessionId,
    deferredResults
  );
}

async function runTurnPlayback(
  text: string,
  speechPlan: VoiceDesignSpeechPlan | undefined,
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  now: () => string,
  monotonicNow: () => number,
  captureBoundary: CaptureBoundaryLease
): Promise<TtsPlaybackPipelineResult> {
  turn.pipelineOwnsPlayback = true;
  try {
    return await runTtsPlaybackPipeline({
      text,
      ...(speechPlan === undefined ? {} : { speechPlan }),
      signal: turn.generation.signal,
      tts: options.tts,
      playback: options.playback,
      echoControl: options.echoControl,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      now,
      monotonicNow,
      onFirstPlaybackStart: () => admitTurnPlayback(controller, turn, options, captureBoundary),
      onFirstPlaybackWriteAccepted: () =>
        settlePttReleaseToFirstPcmWrite(turn, options, "ok", monotonicNow)
    });
  } finally {
    turn.pipelineOwnsPlayback = false;
    await captureBoundary.resume();
  }
}

type CaptureBoundaryLease = {
  readonly suppress: () => Promise<void>;
  readonly resume: () => Promise<void>;
};

function createCaptureBoundaryLease(
  boundary: VoiceResidentRuntimeOptions["captureBoundary"]
): CaptureBoundaryLease {
  let suppressed = false;

  return {
    async suppress() {
      if (boundary === undefined) return;
      suppressed = true;
      await boundary.suppress();
    },
    async resume() {
      if (!suppressed || boundary === undefined) return;
      suppressed = false;
      await boundary.resume();
    }
  };
}

async function admitTurnPlayback(
  controller: ResidentControlController,
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  captureBoundary: CaptureBoundaryLease
): Promise<boolean> {
  if (controller.generation()?.id !== turn.generation.id || controller.state() !== "synthesizing") {
    return false;
  }
  await captureBoundary.suppress();
  if (controller.generation()?.id !== turn.generation.id || controller.state() !== "synthesizing") {
    return false;
  }
  if (!controller.advance(turn.generation.id, "synthesizing", "speaking")) {
    return false;
  }
  recordTurnPhase(options.operator, "speaking");
  return true;
}

function settleCompletedTurn(
  result: TtsPlaybackPipelineResult,
  piSettlement: PiTurnSettlement,
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  sessionId: string,
  deferredResults: readonly DeferredToolDeliverableResult[]
): void {
  const state = currentPlaybackState(controller, turn.generation.id);
  if (state === undefined) {
    return;
  }

  if (piSettlement === "failed") {
    counters.failedTurns += 1;
  } else {
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
  }

  if (controller.finish(turn.generation.id, state)) {
    recordTurnIdle(turn, options);
  }
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

async function transcribeHold(
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
  let result: Awaited<ReturnType<ResidentStreamingSttSession["finish"]>>;

  try {
    result = await (await turn.sttSession).finish();
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
    refreshSession(options.sessionLifecycle, reusableId);
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
    source: "macos_resident_io"
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
): Promise<PiAgentTurnResponse | undefined> {
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

function ownTurnOperation(operations: Set<Promise<void>>, operation: Promise<void>): void {
  operations.add(operation);
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation)
  );
}

async function waitForOwnedTurnOperations(operations: Set<Promise<void>>): Promise<void> {
  while (operations.size > 0) {
    await Promise.allSettled([...operations]);
  }
}

function waitForPiAdmission(barrier: PiAdmissionBarrier, signal: AbortSignal): Promise<boolean> {
  if (!barrier.pending) {
    signal.throwIfAborted();
    return Promise.resolve(false);
  }

  return waitForCompletionOrAbort(barrier.completion, signal).then(() => true);
}

function waitForCompletionOrAbort(completion: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = (): void => signal.removeEventListener("abort", abort);
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      operation();
    };
    const abort = (): void => {
      settle(() => reject(asError(signal.reason ?? "pico resident Pi admission cancelled")));
    };

    completion.then(
      () => settle(resolve),
      (error: unknown) => settle(() => reject(asError(error)))
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
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
  const cancellationAfterCleanup = closeInteractionEndingCancellationAdmission(ending);
  const lateCancellationResults = await settleFinalInteractionEndingCancellation(
    cancellationAfterCleanup,
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

function closeInteractionEndingCancellationAdmission(
  ending: InteractionEndingControl
): Promise<void> | undefined {
  ending.acceptingCancellation = false;
  return ending.cancellation;
}

function settleFinalInteractionEndingCancellation(
  cancellation: Promise<void> | undefined,
  previouslyAwaited: Promise<void> | undefined
): Promise<readonly PromiseSettledResult<void>[]> {
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

// Farewell keeps prompt, playback, cancellation, and settlement in one lifecycle boundary.
// eslint-disable-next-line complexity
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
  const operatorStages = scopeResidentVoiceOperatorStagesToCurrentTurn(options.operator);
  const response = await requestFarewellResponse(sessionId, signal, options, counters);
  if (response === undefined) {
    recordUnavailablePiTurn(
      signal,
      options,
      operatorStages,
      piStartedAt,
      Math.max(0, monotonicNow() - piStartedAtMs)
    );
    return;
  }

  const [playback, piSettlement] = await settleConcurrentOperations(
    isAbortRequested(signal)
      ? Promise.resolve(undefined)
      : runFarewellPlayback(response.text, response.speechPlan, ending, options, now, monotonicNow),
    settlePiResponse(response, options, operatorStages, piStartedAt, piStartedAtMs, monotonicNow)
  );
  if (playback?.status === "failed" || (piSettlement === "failed" && !isAbortRequested(signal))) {
    counters.failedTurns += 1;
  }
  if (playback !== undefined) {
    throwPlaybackInfrastructureError(playback);
  }
}

async function settleConcurrentOperations<First, Second>(
  first: Promise<First>,
  second: Promise<Second>
): Promise<readonly [First, Second]> {
  const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);
  if (firstOutcome.status === "rejected") {
    throw firstOutcome.reason;
  }
  if (secondOutcome.status === "rejected") {
    throw secondOutcome.reason;
  }
  return [firstOutcome.value, secondOutcome.value];
}

async function runFarewellPlayback(
  text: string,
  speechPlan: VoiceDesignSpeechPlan | undefined,
  ending: InteractionEndingControl,
  options: VoiceResidentRuntimeOptions,
  now: () => string,
  monotonicNow: () => number
): Promise<TtsPlaybackPipelineResult> {
  const signal = ending.abortController.signal;
  let result: TtsPlaybackPipelineResult;
  const captureBoundary = createCaptureBoundaryLease(options.captureBoundary);
  try {
    result = await runTtsPlaybackPipeline({
      text,
      ...(speechPlan === undefined ? {} : { speechPlan }),
      signal,
      tts: options.tts,
      playback: options.playback,
      echoControl: options.echoControl,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      now,
      monotonicNow,
      onFirstPlaybackStart: async () => {
        if (isAbortRequested(signal)) {
          return false;
        }
        await captureBoundary.suppress();
        if (isAbortRequested(signal)) {
          return false;
        }
        ending.cleanupOwner = "pipeline";
        return true;
      }
    });
  } finally {
    ending.cleanupOwner = "resident";
    await captureBoundary.resume();
  }

  return result;
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
    (result.errorCode === "playback_start_failed" ||
      result.errorCode === "playback_stop_failed" ||
      result.errorCode === "playback_stop_timeout")
  ) {
    const phase =
      result.errorCode === "playback_start_failed" ? "during startup" : "during cancellation";
    throw new PlaybackInfrastructureError(
      `pico resident voice playback infrastructure failed ${phase}: ${result.errorCode}`
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
): Promise<PiAgentTurnResponse | undefined> {
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

function recordUnavailablePiTurn(
  signal: AbortSignal,
  options: VoiceResidentRuntimeOptions,
  operatorStages: ResidentVoiceOperatorStageSink | undefined,
  startedAt: string,
  durationMs: number
): void {
  const cancelled = signal.aborted;
  recordPiTurnStage(
    options,
    operatorStages,
    cancelled ? "skipped" : "error",
    startedAt,
    durationMs,
    { "pico.voice.error_code": cancelled ? "cancelled" : "pi_agent_prompt_failed" }
  );
}

async function settlePiResponse(
  response: PiAgentTurnResponse,
  options: VoiceResidentRuntimeOptions,
  operatorStages: ResidentVoiceOperatorStageSink | undefined,
  startedAt: string,
  startedAtMs: number,
  monotonicNow: () => number
): Promise<PiTurnSettlement> {
  try {
    await response.settled;
    recordPiTurnStage(
      options,
      operatorStages,
      "ok",
      startedAt,
      Math.max(0, monotonicNow() - startedAtMs)
    );
    return "ok";
  } catch {
    recordPiTurnStage(
      options,
      operatorStages,
      "error",
      startedAt,
      Math.max(0, monotonicNow() - startedAtMs),
      { "pico.voice.error_code": "pi_agent_settlement_failed" }
    );
    return "failed";
  }
}

function recordPiTurnStage(
  options: VoiceResidentRuntimeOptions,
  operatorStages: ResidentVoiceOperatorStageSink | undefined,
  status: Parameters<typeof recordStage>[2],
  startedAt: string,
  durationMs: number,
  attributes?: Parameters<typeof recordStage>[5]
): void {
  recordStage(options, "pi_turn", status, startedAt, durationMs, attributes);
  recordResidentVoiceOperatorStageEvent(operatorStages, {
    kind: "stage",
    stage: "pi_turn",
    status,
    durationMs,
    attributes: attributes ?? {}
  });
}

async function cancelStreamingStt(turn: ActiveTurn): Promise<void> {
  try {
    const session = await turn.sttSession;
    await session.cancel();
  } catch (error) {
    if (!turn.generation.signal.aborted) throw error;
  }
}

async function convergeCancellation(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  pipelineOwnsPlayback: boolean,
  measurement: CancellationMeasurement,
  monotonicNow: () => number
): Promise<void> {
  try {
    await settleCancellationOutput(turn, options, pipelineOwnsPlayback);
    settleCancellationMeasurement(measurement, "output_stopped", options, "ok", monotonicNow);
    await flushCancellationEcho(options.echoControl, pipelineOwnsPlayback);

    const completed = controller.completeCancellation(turn.generation.id);
    settleCancellationMeasurement(
      measurement,
      "idle",
      options,
      completed ? "ok" : "skipped",
      monotonicNow,
      completed ? undefined : "shutdown"
    );
    if (completed) {
      recordTurnIdle(turn, options);
    }
  } catch (error) {
    settleCancellationMeasurement(
      measurement,
      "output_stopped",
      options,
      "error",
      monotonicNow,
      "cancellation_failed"
    );
    settleCancellationMeasurement(
      measurement,
      "idle",
      options,
      "error",
      monotonicNow,
      "cancellation_failed"
    );
    throw error;
  }
}

async function settleCancellationOutput(
  turn: ActiveTurn,
  options: Pick<VoiceResidentRuntimeOptions, "playback">,
  pipelineOwnsPlayback: boolean
): Promise<void> {
  const stops = await Promise.allSettled([
    turn.capture.stop(),
    cancelStreamingStt(turn),
    ...(pipelineOwnsPlayback ? [] : [options.playback.stop()])
  ]);
  await turn.frameCollection.catch(() => undefined);
  const [playbackSettlement] = await Promise.allSettled([
    turn.playbackOperation ?? Promise.resolve(undefined)
  ]);
  const outputFailure = findRejected([...stops, playbackSettlement]);

  if (outputFailure !== undefined) {
    throw outputFailure.reason;
  }
  if (playbackSettlement.status === "fulfilled" && playbackSettlement.value !== undefined) {
    throwPlaybackInfrastructureError(playbackSettlement.value);
  }
}

async function flushCancellationEcho(
  echoControl: EchoControlProvider,
  pipelineOwnsPlayback: boolean
): Promise<void> {
  if (!pipelineOwnsPlayback) {
    await echoControl.flush();
  }
}

function settleCancellationMeasurement(
  measurement: CancellationMeasurement,
  boundary: "output_stopped" | "idle",
  options: VoiceResidentRuntimeOptions,
  status: Parameters<typeof recordStage>[2],
  monotonicNow: () => number,
  errorCode?: string
): void {
  const settledKey = boundary === "output_stopped" ? "outputStoppedSettled" : "idleSettled";

  if (measurement[settledKey]) {
    return;
  }
  measurement[settledKey] = true;
  recordStage(
    options,
    boundary === "output_stopped"
      ? "resident_cancel_admission_to_output_stopped"
      : "resident_cancel_admission_to_idle",
    status,
    measurement.startedAt,
    Math.max(0, monotonicNow() - measurement.startedAtMs),
    errorCode === undefined ? undefined : { "pico.voice.error_code": errorCode }
  );
}

// Await each independently owned async boundary before shared resources close.
// eslint-disable-next-line complexity
async function shutdownVoiceRuntime(
  turn: ActiveTurn | undefined,
  options: VoiceResidentRuntimeOptions,
  interactionEnding: Promise<void>,
  ownedTurnOperations: Set<Promise<void>>,
  precedingFailure: () => Error | undefined
): Promise<void> {
  const turnResults = await Promise.allSettled(
    turn === undefined
      ? []
      : [
          turn.capture.stop(),
          cancelStreamingStt(turn),
          turn.frameCollection,
          turn.operation ?? Promise.resolve(),
          turn.cancellation ?? Promise.resolve()
        ]
  );
  await waitForOwnedTurnOperations(ownedTurnOperations);
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
  turn: ActiveTurn,
  expected: ResidentControlState,
  counters: RuntimeCounters,
  options: VoiceResidentRuntimeOptions
): void {
  if (!controller.finish(turn.generation.id, expected)) {
    counters.lateResultsSuppressed += 1;
    return;
  }
  recordTurnIdle(turn, options);
}

function recordTurnPhase(
  operator: ResidentVoiceOperatorSink | undefined,
  phase: ResidentVoiceTurnPhase
): void {
  recordResidentVoiceOperatorEvent(operator, { kind: "turn_phase", phase });
}

function recordTurnIdle(turn: ActiveTurn | undefined, options: VoiceResidentRuntimeOptions): void {
  if (turn === undefined || turn.operatorIdleRecorded) return;
  turn.operatorIdleRecorded = true;
  recordTurnPhase(options.operator, "idle");
}

function isEmptyTranscript(text: string): boolean {
  const normalized = text.trim().replaceAll(/\s+/gu, "");
  return normalized === "" || noSpeechTranscripts.has(normalized);
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

function settlePttReleaseToFirstPcmWrite(
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
    "ptt_release_to_first_pcm_write",
    status,
    measurement.startedAt,
    Math.max(0, monotonicNow() - measurement.startedAtMs),
    errorCode === undefined ? undefined : { "pico.voice.error_code": errorCode }
  );
}
