import { defineVoicePcmFrame, type EchoControlProvider } from "../modules/voice/echo-control.js";
import type { TtsAudioChunk, TtsClient, TtsSynthesisEvent } from "../modules/voice/index.js";
import type { VoicePlaybackSession, VoicePlaybackSink } from "./voice-playback.js";
import {
  recordVoiceStageProbe,
  type VoiceStageProbe,
  type VoiceStageStatus
} from "./voice-stage-probe.js";

export type TtsPlaybackPipelineOptions = {
  readonly text: string;
  readonly signal: AbortSignal;
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly echoControl: EchoControlProvider;
  readonly probe?: VoiceStageProbe;
  readonly now: () => string;
  readonly monotonicNow: () => number;
  readonly onFirstPlaybackStart?: () => boolean;
};

export type TtsPlaybackPipelineResult =
  | { readonly status: "completed"; readonly playedChunkCount: number; readonly durationMs: number }
  | { readonly status: "empty"; readonly playedChunkCount: 0 }
  | { readonly status: "cancelled"; readonly playedChunkCount: number }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly playedChunkCount: number;
      readonly sentenceIndex?: number;
    };

type PipelineState = {
  readonly options: TtsPlaybackPipelineOptions;
  readonly producerController: AbortController;
  readonly requestStartedAt: string;
  readonly requestStartedAtMs: number;
  iterator?: AsyncIterator<TtsSynthesisEvent>;
  session?: VoicePlaybackSession;
  playedChunkCount: number;
  playedDurationMs: number;
  firstChunkSettled: boolean;
  requestSettled: boolean;
  playbackStartedAt?: string;
  playbackStartedAtMs?: number;
  playbackSettled: boolean;
  stopSettlement?: Promise<Settlement<void>>;
  deferredRequest?: { readonly status: VoiceStageStatus; readonly errorCode: string };
  pendingPull: Promise<Settlement<TimedPull>> | undefined;
  iteratorCleanup?: Promise<void>;
  activeEchoFlush?: Promise<Settlement<void>>;
  echoCleanup?: Promise<void>;
};

type TimedPull = {
  readonly result: IteratorResult<TtsSynthesisEvent>;
  readonly settledAtMs: number;
};

type Settlement<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type AbortableSettlement<T> = Settlement<T> | { readonly ok: false; readonly aborted: true };

const echoMutationFences = new WeakMap<EchoControlProvider, Promise<void>>();

export async function runTtsPlaybackPipeline(
  options: TtsPlaybackPipelineOptions
): Promise<TtsPlaybackPipelineResult> {
  if (options.signal.aborted) {
    return { status: "cancelled", playedChunkCount: 0 };
  }

  const producerController = new AbortController();
  const forwardAbort = (): void => producerController.abort(options.signal.reason);
  options.signal.addEventListener("abort", forwardAbort, { once: true });
  const state: PipelineState = {
    options,
    producerController,
    requestStartedAt: options.now(),
    requestStartedAtMs: options.monotonicNow(),
    playedChunkCount: 0,
    playedDurationMs: 0,
    firstChunkSettled: false,
    requestSettled: false,
    playbackSettled: false,
    pendingPull: undefined
  };
  const execution = await settle(executePipeline(state));
  if (!execution.ok) {
    abortProducer(state);
    settleFirstChunk(state, "error", "tts_pipeline_failed");
    deferRequest(state, "error", "tts_pipeline_failed");
  }

  const result = execution.ok ? execution.value : failedResult(state, "tts_pipeline_failed");
  await cleanUpIterator(state, result.status === "completed" || result.status === "empty");
  options.signal.removeEventListener("abort", forwardAbort);
  return result;
}

async function executePipeline(state: PipelineState): Promise<TtsPlaybackPipelineResult> {
  const iteratorSettlement = await settle(
    Promise.resolve().then(() => {
      const events = state.options.tts.synthesize({
        text: state.options.text,
        signal: state.producerController.signal
      });
      return events[Symbol.asyncIterator]();
    })
  );

  if (!iteratorSettlement.ok) {
    settleFirstChunk(state, "error", "tts_request_failed");
    settleRequest(state, "error", "tts_request_failed");
    return failedResult(state, "tts_request_failed");
  }

  state.iterator = iteratorSettlement.value;
  const firstPullPromise = pullNext(iteratorSettlement.value, state.options.monotonicNow);
  state.pendingPull = settle(firstPullPromise);
  const firstPull = await awaitWithAbort(firstPullPromise, state.producerController.signal);

  if (isAborted(firstPull)) {
    return convergeCancellation(state);
  }

  if (!firstPull.ok) {
    settleFirstChunk(state, "error", "tts_request_failed");
    settleRequest(state, "error", "tts_request_failed");
    return failedResult(state, "tts_request_failed");
  }

  state.pendingPull = undefined;
  return processPull(state, iteratorSettlement.value, firstPull.value);
}

async function processPull(
  state: PipelineState,
  iterator: AsyncIterator<TtsSynthesisEvent>,
  firstPull: TimedPull
): Promise<TtsPlaybackPipelineResult> {
  let pull = firstPull;

  for (;;) {
    if (state.producerController.signal.aborted) {
      return convergeCancellation(state);
    }

    if (pull.result.done) {
      return convergeProducerFailure(state, "tts_request_failed", pull.settledAtMs);
    }

    const event = pull.result.value;
    if (event.kind !== "chunk") {
      return convergeTerminalEvent(state, event, pull.settledAtMs);
    }

    settleFirstChunk(state, "ok", undefined, event.chunk.sentenceIndex, pull.settledAtMs);
    const nextPull = pullNext(iterator, state.options.monotonicNow);
    state.pendingPull = settle(nextPull);
    const submission = await submitChunk(state, event.chunk);
    if (submission !== undefined) {
      return submission;
    }

    const nextSettlement = await awaitWithAbort(nextPull, state.producerController.signal);
    if (isAborted(nextSettlement)) {
      return convergeCancellation(state);
    }
    if (!nextSettlement.ok) {
      return convergeProducerFailure(state, "tts_request_failed", state.options.monotonicNow());
    }
    state.pendingPull = undefined;
    pull = nextSettlement.value;
  }
}

async function submitChunk(
  state: PipelineState,
  chunk: TtsAudioChunk
): Promise<TtsPlaybackPipelineResult | undefined> {
  if (state.session === undefined) {
    const opened = await openPlayback(state, chunk);
    if (opened !== undefined) {
      return opened;
    }
  }

  const echoRegistration = registerEchoReference(state, chunk);
  const ownedEchoRegistration = settle(echoRegistration);
  const echoSettlement = await awaitWithAbort(echoRegistration, state.producerController.signal);
  if (isAborted(echoSettlement)) {
    return convergeCancellationDuringEcho(state, ownedEchoRegistration);
  }
  if (!echoSettlement.ok) {
    return convergePlaybackFailure(state, "echo_control_failed");
  }

  const session = state.session;
  if (session === undefined) {
    return convergePlaybackFailure(state, "playback_open_failed");
  }
  const writeSettlement = await awaitWithAbort(
    Promise.resolve().then(() => session.write(chunk)),
    state.producerController.signal
  );
  if (isAborted(writeSettlement)) {
    return convergeCancellation(state);
  }
  if (!writeSettlement.ok) {
    return convergePlaybackFailure(state, "playback_write_failed");
  }

  state.playedChunkCount += 1;
  state.playedDurationMs += chunk.durationMs;
  return undefined;
}

async function openPlayback(
  state: PipelineState,
  firstChunk: TtsAudioChunk
): Promise<TtsPlaybackPipelineResult | undefined> {
  const accepted = await settle(
    Promise.resolve().then(() => state.options.onFirstPlaybackStart?.() ?? true)
  );
  if (!accepted.ok) {
    abortProducer(state);
    deferRequest(state, "error", "playback_start_failed");
    return failedResult(state, "playback_start_failed");
  }
  if (!accepted.value) {
    abortProducer(state);
    deferRequest(state, "skipped", "cancelled");
    return { status: "cancelled", playedChunkCount: state.playedChunkCount };
  }

  state.playbackStartedAt = state.options.now();
  state.playbackStartedAtMs = state.options.monotonicNow();
  const openSettlement = await settle(
    Promise.resolve().then(() =>
      state.options.playback.open(firstChunk, state.producerController.signal)
    )
  );
  if (!openSettlement.ok) {
    return convergePlaybackFailure(state, "playback_open_failed");
  }
  state.session = openSettlement.value;
  return undefined;
}

async function convergeTerminalEvent(
  state: PipelineState,
  event: Exclude<TtsSynthesisEvent, { readonly kind: "chunk" }>,
  settledAtMs: number
): Promise<TtsPlaybackPipelineResult> {
  if (event.kind === "completed") {
    settleFirstChunk(state, "skipped", "empty", undefined, settledAtMs);
    settleRequest(state, "ok", undefined, undefined, settledAtMs, event.chunkCount);
    if (state.session === undefined) {
      return { status: "empty", playedChunkCount: 0 };
    }
    return finishCompletedPlayback(state);
  }

  settleFirstChunk(state, "error", event.failure.reason, event.failure.sentenceIndex, settledAtMs);
  settleRequest(state, "error", event.failure.reason, event.failure.sentenceIndex, settledAtMs);
  if (state.session !== undefined) {
    const drained = await finishPlayback(state, state.session);
    if (isAborted(drained)) {
      return convergeCancellation(state);
    }
    if (!drained.ok) {
      return convergePlaybackFailure(state, "playback_finish_failed");
    }
    settlePlayback(state, "ok");
  }
  return failedResult(state, event.failure.reason, event.failure.sentenceIndex);
}

async function finishCompletedPlayback(state: PipelineState): Promise<TtsPlaybackPipelineResult> {
  const session = state.session;
  if (session === undefined) {
    return convergePlaybackFailure(state, "playback_finish_failed");
  }
  const finished = await finishPlayback(state, session);
  if (isAborted(finished)) {
    return convergeCancellation(state);
  }
  if (!finished.ok) {
    return convergePlaybackFailure(state, "playback_finish_failed");
  }

  settlePlayback(state, "ok");
  return {
    status: "completed",
    playedChunkCount: state.playedChunkCount,
    durationMs: state.playedDurationMs
  };
}

function finishPlayback(
  state: PipelineState,
  session: VoicePlaybackSession
): Promise<AbortableSettlement<void>> {
  return awaitWithAbort(
    Promise.resolve().then(() => session.finish()),
    state.producerController.signal
  );
}

async function convergeProducerFailure(
  state: PipelineState,
  errorCode: string,
  settledAtMs: number
): Promise<TtsPlaybackPipelineResult> {
  settleFirstChunk(state, "error", errorCode, undefined, settledAtMs);
  settleRequest(state, "error", errorCode, undefined, settledAtMs);
  if (state.session !== undefined) {
    const drained = await finishPlayback(state, state.session);
    if (isAborted(drained)) {
      return convergeCancellation(state);
    }
    if (!drained.ok) {
      return convergePlaybackFailure(state, "playback_finish_failed");
    }
    settlePlayback(state, "ok");
  }
  return failedResult(state, errorCode);
}

async function convergeCancellation(state: PipelineState): Promise<TtsPlaybackPipelineResult> {
  abortProducer(state);
  settleFirstChunk(state, "skipped", "cancelled");
  deferRequest(state, "skipped", "cancelled");
  if (state.playbackStartedAt !== undefined) {
    await stopAndFlush(state);
    settlePlayback(state, "skipped", "cancelled");
  }
  return { status: "cancelled", playedChunkCount: state.playedChunkCount };
}

async function convergePlaybackFailure(
  state: PipelineState,
  errorCode: string
): Promise<TtsPlaybackPipelineResult> {
  abortProducer(state);
  deferRequest(state, "error", errorCode);
  await stopAndFlush(state);
  settlePlayback(state, "error", errorCode);
  return failedResult(state, errorCode);
}

async function stopAndFlush(state: PipelineState): Promise<void> {
  state.stopSettlement ??= settle(Promise.resolve().then(() => state.options.playback.stop()));
  const echoFlush = settle(Promise.resolve().then(() => state.options.echoControl.flush()));
  state.activeEchoFlush = echoFlush;
  await Promise.all([state.stopSettlement, echoFlush]);
}

async function convergeCancellationDuringEcho(
  state: PipelineState,
  echoRegistration: Promise<Settlement<void>>
): Promise<TtsPlaybackPipelineResult> {
  const cancellation = convergeCancellation(state);
  const echoFlush = state.activeEchoFlush;
  if (echoFlush === undefined) {
    return cancellation;
  }

  const firstSettlement = await Promise.race([
    echoRegistration.then((registration) => ({ owner: "echo" as const, registration })),
    echoFlush.then(() => ({ owner: "flush" as const }))
  ]);
  const result = await cancellation;
  if (firstSettlement.owner === "flush") {
    scheduleCompensatingEchoFlush(state, echoRegistration);
  }
  return result;
}

function scheduleCompensatingEchoFlush(
  state: PipelineState,
  echoRegistration: Promise<Settlement<void>>
): void {
  const echoControl = state.options.echoControl;
  const previousFence = echoMutationFences.get(echoControl) ?? Promise.resolve();
  const cleanup = previousFence.then(async () => {
    const registration = await echoRegistration;
    if (registration.ok) {
      await settle(Promise.resolve().then(() => echoControl.flush()));
    }
  });
  const fence = settle(cleanup).then(() => undefined);
  echoMutationFences.set(echoControl, fence);
  const release = fence.then(() => {
    if (echoMutationFences.get(echoControl) === fence) {
      echoMutationFences.delete(echoControl);
    }
  });
  state.echoCleanup = settle(release).then(() => undefined);
}

function abortProducer(state: PipelineState): void {
  if (!state.producerController.signal.aborted) {
    state.producerController.abort();
  }
}

function settleFirstChunk(
  state: PipelineState,
  status: VoiceStageStatus,
  errorCode?: string,
  sentenceIndex?: number,
  settledAtMs: number = state.options.monotonicNow()
): void {
  if (state.firstChunkSettled) {
    return;
  }
  state.firstChunkSettled = true;
  recordStage(state, "tts_time_to_first_chunk", status, state.requestStartedAt, settledAtMs, {
    ...(sentenceIndex === undefined ? {} : { "pico.voice.sentence_index": sentenceIndex }),
    ...(errorCode === undefined ? {} : { "pico.voice.error_code": errorCode })
  });
}

function settleRequest(
  state: PipelineState,
  status: VoiceStageStatus,
  errorCode?: string,
  sentenceIndex?: number,
  settledAtMs: number = state.options.monotonicNow(),
  chunkCount?: number
): void {
  if (state.requestSettled) {
    return;
  }
  state.requestSettled = true;
  recordStage(state, "tts_request_wall", status, state.requestStartedAt, settledAtMs, {
    ...(chunkCount === undefined ? {} : { "pico.voice.chunk_count": chunkCount }),
    "pico.voice.played_chunk_count": state.playedChunkCount,
    ...(sentenceIndex === undefined ? {} : { "pico.voice.sentence_index": sentenceIndex }),
    ...(errorCode === undefined ? {} : { "pico.voice.error_code": errorCode })
  });
}

function deferRequest(state: PipelineState, status: VoiceStageStatus, errorCode: string): void {
  if (!state.requestSettled) {
    state.deferredRequest = { status, errorCode };
  }
}

function settleDeferredRequest(
  state: PipelineState,
  settledAtMs: number = state.options.monotonicNow()
): void {
  const deferred = state.deferredRequest;
  if (deferred !== undefined) {
    settleRequest(state, deferred.status, deferred.errorCode, undefined, settledAtMs);
  }
}

function settlePlayback(state: PipelineState, status: VoiceStageStatus, errorCode?: string): void {
  if (
    state.playbackSettled ||
    state.playbackStartedAt === undefined ||
    state.playbackStartedAtMs === undefined
  ) {
    return;
  }
  state.playbackSettled = true;
  recordStage(
    state,
    "tts_playback",
    status,
    state.playbackStartedAt,
    state.options.monotonicNow(),
    {
      "pico.voice.played_chunk_count": state.playedChunkCount,
      "pico.voice.utterance_duration_ms": state.playedDurationMs,
      ...(errorCode === undefined ? {} : { "pico.voice.error_code": errorCode })
    },
    state.playbackStartedAtMs
  );
}

function recordStage(
  state: PipelineState,
  stage: Parameters<typeof recordVoiceStageProbe>[1]["stage"],
  status: VoiceStageStatus,
  startedAt: string,
  settledAtMs: number,
  attributes: NonNullable<Parameters<typeof recordVoiceStageProbe>[1]["attributes"]>,
  startedAtMs: number = state.requestStartedAtMs
): void {
  recordVoiceStageProbe(state.options.probe ?? {}, {
    stage,
    status,
    startedAt,
    durationMs: Math.max(0, settledAtMs - startedAtMs),
    attributes
  });
}

function failedResult(
  state: PipelineState,
  errorCode: string,
  sentenceIndex?: number
): TtsPlaybackPipelineResult {
  return {
    status: "failed",
    errorCode,
    playedChunkCount: state.playedChunkCount,
    ...(sentenceIndex === undefined ? {} : { sentenceIndex })
  };
}

function pullNext(
  iterator: AsyncIterator<TtsSynthesisEvent>,
  monotonicNow: () => number
): Promise<TimedPull> {
  return new Promise<IteratorResult<TtsSynthesisEvent>>((resolve) => resolve(iterator.next())).then(
    (result) => ({ result, settledAtMs: monotonicNow() })
  );
}

async function registerEchoReference(state: PipelineState, chunk: TtsAudioChunk): Promise<void> {
  const playbackStartedAt = state.playbackStartedAt;
  if (playbackStartedAt === undefined) {
    return Promise.reject(new Error("pico TTS playback session has not started"));
  }
  const echoMutationFence = echoMutationFences.get(state.options.echoControl);
  if (echoMutationFence !== undefined) {
    await echoMutationFence;
  }
  await state.options.echoControl.acceptFarEndReference(
    defineVoicePcmFrame({
      id: `tts-${String(chunk.sentenceIndex)}`,
      direction: "far_end",
      audio: chunk.audio,
      encoding: chunk.encoding,
      sampleRateHz: chunk.sampleRateHz,
      channels: chunk.channels,
      capturedAt: addMilliseconds(playbackStartedAt, state.playedDurationMs),
      durationMs: chunk.durationMs
    })
  );
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<AbortableSettlement<T>> {
  if (signal.aborted) {
    return { ok: false, aborted: true };
  }

  let resolveAbort = (): void => undefined;
  const aborted = new Promise<AbortableSettlement<T>>((resolve) => {
    resolveAbort = () => resolve({ ok: false, aborted: true });
  });
  signal.addEventListener("abort", resolveAbort, { once: true });
  const result = await Promise.race([settle(promise), aborted]);
  signal.removeEventListener("abort", resolveAbort);
  return result;
}

function isAborted<T>(
  value: AbortableSettlement<T>
): value is { readonly ok: false; readonly aborted: true } {
  return !value.ok && "aborted" in value;
}

function settle<T>(promise: Promise<T>): Promise<Settlement<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

async function cleanUpIterator(state: PipelineState, waitForCleanup: boolean): Promise<void> {
  if (state.pendingPull === undefined) {
    const cleanup = closeIterator(state.iterator).then(() => settleDeferredRequest(state));
    if (waitForCleanup) {
      await cleanup;
    } else {
      state.iteratorCleanup = settle(cleanup).then(() => undefined);
    }
    return;
  }

  const cleanup = state.pendingPull.then(async (pull) => {
    const terminalAtMs = terminalPullTime(pull, state.options.monotonicNow);
    await closeIterator(state.iterator);
    settleDeferredRequest(state, terminalAtMs ?? state.options.monotonicNow());
  });
  state.iteratorCleanup = settle(cleanup).then(() => undefined);
}

function terminalPullTime(
  pull: Settlement<TimedPull>,
  monotonicNow: () => number
): number | undefined {
  if (!pull.ok) {
    return monotonicNow();
  }

  const { result, settledAtMs } = pull.value;
  return result.done || result.value.kind !== "chunk" ? settledAtMs : undefined;
}

async function closeIterator(
  iterator: AsyncIterator<TtsSynthesisEvent> | undefined
): Promise<void> {
  if (iterator?.return !== undefined) {
    await settle(Promise.resolve().then(() => iterator.return?.()));
  }
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}
