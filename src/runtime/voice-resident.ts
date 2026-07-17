import type { SessionLifecycle } from "../modules/session/index.js";
import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type { SttClient, TtsAudioChunk, TtsClient } from "../modules/voice/index.js";
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
import type { SpeechActivityGate } from "./speech-activity-gate.js";
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";

export type VoicePlaybackSink = {
  readonly play: (chunk: TtsAudioChunk, startedAt: string, signal?: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
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
  readonly log?: VoiceResidentLogSink;
  readonly probe?: VoiceStageProbe;
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
};

const defaultNow = (): string => new Date().toISOString();
const defaultMonotonicNow = (): number => performance.now();
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
  let stopOperation: Promise<void> | undefined;
  let runtimeSettled = false;
  let resolveCompletion: (result: VoiceResidentRuntimeResult) => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const completion = new Promise<VoiceResidentRuntimeResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const failRuntime = (error: unknown, generationId?: number): void => {
    if (runtimeSettled) {
      return;
    }

    runtimeSettled = true;
    controller.fail(generationId);
    rejectCompletion(error instanceof Error ? error : new Error(String(error)));
  };
  const controller: ResidentControlController = createResidentControlController({
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    onListen(generation) {
      const capture = options.audioCapture.start(generation.signal);
      const frames: VoicePcmFrame[] = [];
      const frameCollection = collectCaptureFrames(capture.frames, frames);
      activeTurn = {
        generation,
        capture,
        frames,
        frameCollection,
        operation: undefined,
        cancellation: undefined
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
        setActiveSessionId: (sessionId) => {
          activeSessionId = sessionId;
        }
      })
        .catch((error: unknown) => {
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
    onCancel(generation) {
      const turn = currentTurn(activeTurn, generation.id);

      if (turn === undefined || turn.cancellation !== undefined) {
        return;
      }

      counters.cancelledTurns += 1;
      turn.cancellation = convergeCancellation(turn, controller, options).then(() => {
        if (activeTurn === turn) {
          activeTurn = undefined;
        }
      });
      turn.cancellation.catch((error: unknown) => failRuntime(error, generation.id));
    }
  });
  const stopFromSignal = (): void => {
    stop().catch((error: unknown) => failRuntime(error));
  };
  const stop = (): Promise<void> => {
    if (stopOperation !== undefined) {
      return stopOperation;
    }

    options.signal?.removeEventListener("abort", stopFromSignal);
    const turn = activeTurn;
    controller.stop();
    stopOperation = shutdownVoiceRuntime(turn, options, activeSessionId).then(() => {
      activeTurn = undefined;

      if (!runtimeSettled) {
        runtimeSettled = true;
        resolveCompletion(Object.freeze({ ...counters }));
      }
    });

    return stopOperation;
  };

  options.signal?.addEventListener("abort", stopFromSignal, { once: true });

  if (options.signal?.aborted) {
    stopFromSignal();
  }

  return {
    handleControl(event) {
      return Promise.resolve().then(() => {
        try {
          const result = controller.handle(event);

          if (event.kind === "talk_pressed" && result === "ignored_busy") {
            counters.ignoredBusyTalkPresses += 1;
          }

          return result;
        } catch (error) {
          failRuntime(error, controller.generation()?.id);
          throw error;
        }
      });
    },
    state: controller.state,
    completion,
    stop
  };
}

async function collectCaptureFrames(
  source: AsyncIterable<VoicePcmFrame>,
  target: VoicePcmFrame[]
): Promise<void> {
  for await (const frame of source) {
    target.push(defineVoicePcmFrame(frame));
  }
}

// The linear guards mirror the externally reviewed state machine one stage at a time.
// eslint-disable-next-line complexity
async function processCompletedHold(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  state: {
    readonly now: () => string;
    readonly monotonicNow: () => number;
    readonly getActiveSessionId: () => string | undefined;
    readonly setActiveSessionId: (sessionId: string | undefined) => void;
  }
): Promise<void> {
  await turn.capture.stop();
  await turn.frameCollection;

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  const admitted = await admitCapturedSpeech(turn.frames, options);

  if (!admitted.speech || admitted.audio.byteLength === 0) {
    counters.emptyHolds += 1;
    finishCurrentTurn(controller, turn.generation.id, "transcribing", counters);
    return;
  }

  const transcript = await transcribeHold(admitted, turn, options, state.now);

  if (!isCurrentStage(controller, turn.generation.id, "transcribing", counters)) {
    return;
  }

  if (transcript === undefined || isEmptyTranscript(transcript)) {
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

  if (!isCurrentStage(controller, turn.generation.id, "processing", counters)) {
    return;
  }

  if (response === undefined) {
    finishCurrentTurn(controller, turn.generation.id, "processing", counters);
    return;
  }

  const piDurationMs = Math.max(0, state.monotonicNow() - piStartedAtMs);
  recordLog(options.log, {
    kind: "pi_agent_response",
    occurredAt: state.now(),
    sessionId,
    durationMs: piDurationMs
  });
  recordStage(options, "pi_turn", "ok", piStartedAt, piDurationMs);

  if (!controller.advance(turn.generation.id, "processing", "synthesizing")) {
    counters.lateResultsSuppressed += 1;
    return;
  }

  const synthesis = await requestTts(response.text, turn, options, counters, state.now);

  if (!isCurrentStage(controller, turn.generation.id, "synthesizing", counters)) {
    return;
  }

  if (synthesis === undefined || synthesis.length === 0) {
    finishCurrentTurn(controller, turn.generation.id, "synthesizing", counters);
    return;
  }

  if (!controller.advance(turn.generation.id, "synthesizing", "speaking")) {
    counters.lateResultsSuppressed += 1;
    return;
  }

  const played = await playTurnChunks(synthesis, turn, options, state.now);

  if (!isCurrentStage(controller, turn.generation.id, "speaking", counters)) {
    return;
  }

  if (!played) {
    counters.failedTurns += 1;
    finishCurrentTurn(controller, turn.generation.id, "speaking", counters);
    return;
  }

  acknowledgeDeferredResults(options, deferredResults);
  refreshSession(options.sessionLifecycle, sessionId);
  counters.completedTurns += 1;
  finishCurrentTurn(controller, turn.generation.id, "speaking", counters);
}

// Frame admission keeps echo suppression, optional VAD, and audio retention in one pass.
// eslint-disable-next-line complexity
async function admitCapturedSpeech(
  frames: readonly VoicePcmFrame[],
  options: VoiceResidentRuntimeOptions
): Promise<{
  readonly audio: Uint8Array;
  readonly speech: boolean;
  readonly sampleRateHz: number;
  readonly channels: number;
}> {
  const admitted: Uint8Array[] = [];
  let speech = false;

  for (const frame of frames) {
    const echo = await options.echoControl.processNearEnd(frame);

    if (echo.action === "suppress") {
      continue;
    }

    admitted.push(echo.frame.audio);
    const activity = await options.speechActivity?.process(echo.frame);
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
  now: () => string
): Promise<string | undefined> {
  const startedAt = now();
  const result = await options.stt.transcribe({
    audio: admitted.audio,
    encoding: "pcm16le",
    sampleRateHz: admitted.sampleRateHz,
    channels: admitted.channels,
    signal: turn.generation.signal
  });

  if (!result.ok) {
    recordStage(options, "stt", result.reason === "aborted" ? "skipped" : "error", startedAt, 0, {
      "pico.voice.error_code": result.reason
    });
    return undefined;
  }

  recordStage(options, "stt", "ok", startedAt, result.durationMs);
  return result.text.trim();
}

async function ensureActiveSession(
  options: VoiceResidentRuntimeOptions,
  state: {
    readonly getActiveSessionId: () => string | undefined;
    readonly setActiveSessionId: (sessionId: string | undefined) => void;
  }
): Promise<string> {
  const existingId = state.getActiveSessionId();

  if (existingId !== undefined && options.sessionLifecycle.read(existingId)?.state === "active") {
    return existingId;
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

async function requestTts(
  text: string,
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  counters: RuntimeCounters,
  now: () => string
): Promise<readonly TtsAudioChunk[] | undefined> {
  const startedAt = now();

  try {
    const result = await options.tts.synthesize({ text, signal: turn.generation.signal });

    if (!result.ok) {
      if (result.reason !== "cancelled") {
        counters.failedTurns += 1;
      }

      recordStage(options, "tts_synthesize", "error", startedAt, 0, {
        "pico.voice.error_code": result.reason
      });
      return undefined;
    }

    recordStage(options, "tts_synthesize", "ok", startedAt, result.totalDurationMs, {
      "pico.voice.chunk_count": result.chunks.length
    });
    return result.chunks;
  } catch {
    if (!turn.generation.signal.aborted) {
      counters.failedTurns += 1;
    }

    return undefined;
  }
}

async function playTurnChunks(
  chunks: readonly TtsAudioChunk[],
  turn: ActiveTurn,
  options: VoiceResidentRuntimeOptions,
  now: () => string
): Promise<boolean> {
  let offsetMs = 0;
  const playbackStartedAt = now();

  try {
    for (const chunk of chunks) {
      const chunkStartedAt = addMilliseconds(playbackStartedAt, offsetMs);
      await options.echoControl.acceptFarEndReference(
        defineVoicePcmFrame({
          id: `tts-${String(chunk.sentenceIndex)}`,
          direction: "far_end",
          audio: chunk.audio,
          encoding: chunk.encoding,
          sampleRateHz: chunk.sampleRateHz,
          channels: chunk.channels,
          capturedAt: chunkStartedAt,
          durationMs: chunk.durationMs
        })
      );
      await options.playback.play(chunk, chunkStartedAt, turn.generation.signal);
      offsetMs += chunk.durationMs;
    }

    return true;
  } catch {
    return false;
  }
}

async function convergeCancellation(
  turn: ActiveTurn,
  controller: ResidentControlController,
  options: VoiceResidentRuntimeOptions
): Promise<void> {
  const stops = await Promise.allSettled([turn.capture.stop(), options.playback.stop()]);
  await turn.frameCollection.catch(() => undefined);
  await turn.operation?.catch(() => undefined);
  await options.echoControl.flush();
  const rejected = stops.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (rejected !== undefined) {
    throw rejected.reason;
  }

  controller.completeCancellation(turn.generation.id);
}

// Shutdown deliberately inventories every independently owned asynchronous boundary.
// eslint-disable-next-line complexity
async function shutdownVoiceRuntime(
  turn: ActiveTurn | undefined,
  options: VoiceResidentRuntimeOptions,
  activeSessionId: string | undefined
): Promise<void> {
  const operations: Array<Promise<unknown>> = [
    options.playback.stop(),
    options.audioCapture.close(),
    options.echoControl.flush(),
    Promise.resolve(options.speechActivity?.close?.()),
    Promise.resolve(options.piAgent.disposeAll?.()),
    options.deferredTools?.waitForIdle?.() ?? Promise.resolve()
  ];

  if (turn !== undefined) {
    operations.unshift(
      turn.capture.stop(),
      turn.frameCollection,
      turn.operation ?? Promise.resolve()
    );
  }

  if (activeSessionId !== undefined) {
    options.deferredTools?.cancelSession?.(activeSessionId, "shutdown");
  }

  const results = await Promise.allSettled(operations);
  await options.playback.close();
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );

  if (rejected !== undefined) {
    throw rejected.reason;
  }
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

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
