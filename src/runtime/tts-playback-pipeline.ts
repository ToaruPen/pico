import { types as nodeUtilityTypes } from "node:util";

import {
  defineVoicePcmFrame,
  ECHO_CONTROL_REGISTRATION_TIMEOUT_MS,
  type EchoControlProvider,
  type EchoControlRegistrationResult,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
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
  trailingSilenceMs: number | undefined;
  firstChunkSettled: boolean;
  requestSettled: boolean;
  playbackStartedAt?: string;
  playbackStartedAtMs?: number;
  playbackSettled: boolean;
  stopSettlement?: Promise<Settlement<void>>;
  deferredRequest?: {
    readonly status: VoiceStageStatus;
    readonly errorCode: string;
    readonly settledAtMs: number;
  };
  pendingPull: Promise<Settlement<TimedPull>> | undefined;
  pendingPullResolvedChunk: boolean;
  submissionPending: boolean;
  pendingTerminalRequest?: PendingTerminalRequest;
  echoReferenceApplied: boolean;
  echoReset?: Promise<"reset" | "unsafe">;
};

type PendingTerminalRequest = {
  readonly status: VoiceStageStatus;
  readonly settledAtMs: number;
  readonly errorCode?: string;
  readonly sentenceIndex?: number;
  readonly chunkCount?: number;
};

type TimedPull = {
  readonly result: IteratorResult<TtsSynthesisEvent>;
  readonly settledAtMs: number;
};

type ClassifiedPull =
  | { readonly chunk: TtsAudioChunk }
  | { readonly result: TtsPlaybackPipelineResult | Promise<TtsPlaybackPipelineResult> };

type PreparedChunkSubmission =
  | { readonly frame: VoicePcmFrame }
  | { readonly result: TtsPlaybackPipelineResult };

type Settlement<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type AbortableSettlement<T> = Settlement<T> | { readonly ok: false; readonly aborted: true };

type EchoProviderSafetyState = {
  unsafe: boolean;
  unsafeRevision: number;
  pending: Promise<"safe" | "unsafe"> | undefined;
};

type EchoRegistrationOutcome =
  | { readonly status: "registered" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "unsafe" };

const ECHO_PROVIDER_SAFETY_BOUND_MS = ECHO_CONTROL_REGISTRATION_TIMEOUT_MS + 100;
// The resident sink owns sequential 1,000 ms SIGTERM and SIGKILL windows.
const PLAYBACK_STOP_SAFETY_BOUND_MS = 2_100;
const ITERATOR_CLEANUP_SAFETY_BOUND_MS = 100;
const trailingSilenceAmplitudeThreshold = 16;
const echoProviderSafetyStates = new WeakMap<EchoControlProvider, EchoProviderSafetyState>();

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
    trailingSilenceMs: undefined,
    firstChunkSettled: false,
    requestSettled: false,
    playbackSettled: false,
    pendingPull: undefined,
    pendingPullResolvedChunk: false,
    submissionPending: false,
    echoReferenceApplied: false
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
  state.pendingPullResolvedChunk = false;
  observePendingPullTelemetry(state, state.pendingPull);
  const firstPull = await awaitWithAbort(firstPullPromise, state.producerController.signal);

  if (isAborted(firstPull)) {
    return convergeCancellation(state);
  }

  if (!firstPull.ok) {
    settleFirstChunk(state, "error", "tts_request_failed");
    deferTerminalRequest(state, {
      status: "error",
      settledAtMs: state.options.monotonicNow(),
      errorCode: "tts_request_failed"
    });
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

    const classified = classifyPull(state, pull);
    if ("result" in classified) {
      return classified.result;
    }
    const { chunk } = classified;

    settleFirstChunk(state, "ok", undefined, chunk.sentenceIndex, pull.settledAtMs);
    const nextPull = pullNext(iterator, state.options.monotonicNow);
    state.pendingPull = settle(nextPull);
    state.pendingPullResolvedChunk = false;
    state.submissionPending = true;
    observePendingPullTelemetry(state, state.pendingPull);
    const submission = await submitPendingChunk(state, chunk);
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
    state.pendingPullResolvedChunk = false;
    pull = nextSettlement.value;
  }
}

async function submitPendingChunk(
  state: PipelineState,
  chunk: TtsAudioChunk
): Promise<TtsPlaybackPipelineResult | undefined> {
  try {
    return await submitChunk(state, chunk);
  } finally {
    settlePendingSubmission(state);
  }
}

function classifyPull(state: PipelineState, pull: TimedPull): ClassifiedPull {
  if (pull.result.done) {
    return { result: convergeProducerFailure(state, "tts_request_failed", pull.settledAtMs) };
  }
  const event = pull.result.value;
  if (event.kind !== "chunk") {
    return { result: convergeTerminalEvent(state, event, pull.settledAtMs) };
  }
  if (!isValidTtsChunk(state, event.chunk)) {
    return { result: convergeInvalidTtsChunk(state, pull.settledAtMs) };
  }
  return { chunk: event.chunk };
}

async function submitChunk(
  state: PipelineState,
  chunk: TtsAudioChunk
): Promise<TtsPlaybackPipelineResult | undefined> {
  const prepared = await prepareChunkSubmission(state, chunk);
  if ("result" in prepared) {
    return prepared.result;
  }
  const echoRegistration = registerEchoReference(state, prepared.frame);
  const echoSettlement = await awaitWithAbort(echoRegistration, state.producerController.signal);
  if (isAborted(echoSettlement)) {
    return convergeCancellation(state);
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
  state.trailingSilenceMs = tryMeasureTrailingPcm16SilenceMs(
    chunk.audio,
    chunk.sampleRateHz,
    chunk.channels
  );
  return undefined;
}

async function prepareChunkSubmission(
  state: PipelineState,
  chunk: TtsAudioChunk
): Promise<PreparedChunkSubmission> {
  if (state.session === undefined) {
    const opened = await openPlayback(state, chunk);
    if (opened !== undefined) {
      return { result: opened };
    }
  }

  const frame = createEchoReferenceFrame(state, chunk);
  if (frame === undefined) {
    return { result: await convergePlaybackFailure(state, "tts_invalid_chunk") };
  }
  return { frame };
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
    settleTerminalRequest(state, event, settledAtMs);
    if (state.session === undefined) {
      return { status: "empty", playedChunkCount: 0 };
    }
    return finishCompletedPlayback(state);
  }

  settleFirstChunk(state, "error", event.failure.reason, event.failure.sentenceIndex, settledAtMs);
  settleTerminalRequest(state, event, settledAtMs);
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

async function convergeInvalidTtsChunk(
  state: PipelineState,
  settledAtMs: number
): Promise<TtsPlaybackPipelineResult> {
  abortProducer(state);
  settleFirstChunk(state, "error", "tts_invalid_chunk", undefined, settledAtMs);
  settleRequest(state, "error", "tts_invalid_chunk", undefined, settledAtMs);
  if (state.session !== undefined) {
    const stopFailure = await stopAndFlush(state);
    const terminalErrorCode = stopFailure ?? "tts_invalid_chunk";
    settlePlayback(state, "error", terminalErrorCode);
    return failedResult(state, terminalErrorCode);
  }
  return failedResult(state, "tts_invalid_chunk");
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
  deferTerminalRequest(state, { status: "error", settledAtMs, errorCode });
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
  settlePendingSubmission(state);
  abortProducer(state);
  settleFirstChunk(state, "skipped", "cancelled");
  deferRequest(state, "skipped", "cancelled");
  if (state.playbackStartedAt !== undefined) {
    const stopFailure = await stopAndFlush(state);
    if (stopFailure !== undefined) {
      settlePlayback(state, "error", stopFailure);
      return failedResult(state, stopFailure);
    }
    settlePlayback(state, "skipped", "cancelled");
  }
  return { status: "cancelled", playedChunkCount: state.playedChunkCount };
}

async function convergePlaybackFailure(
  state: PipelineState,
  errorCode: string
): Promise<TtsPlaybackPipelineResult> {
  settlePendingSubmission(state);
  abortProducer(state);
  deferRequest(state, "error", errorCode);
  const stopFailure = await stopAndFlush(state);
  const terminalErrorCode = stopFailure ?? errorCode;
  settlePlayback(state, "error", terminalErrorCode);
  return failedResult(state, terminalErrorCode);
}

async function stopAndFlush(
  state: PipelineState
): Promise<"playback_stop_failed" | "playback_stop_timeout" | undefined> {
  state.stopSettlement ??= settle(Promise.resolve().then(() => state.options.playback.stop()));
  const echoCleanup =
    state.echoReset ??
    (state.echoReferenceApplied
      ? resetPendingEchoReference(state)
      : settleWithinSafetyBound(
          settle(Promise.resolve().then(() => state.options.echoControl.flush())),
          ECHO_PROVIDER_SAFETY_BOUND_MS
        ).then(() => undefined));
  const [stopSettlement] = await Promise.all([
    settleWithinSafetyBound(state.stopSettlement, PLAYBACK_STOP_SAFETY_BOUND_MS),
    echoCleanup
  ]);
  if (stopSettlement === undefined) {
    return "playback_stop_timeout";
  }
  return stopSettlement.ok ? undefined : "playback_stop_failed";
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
    state.deferredRequest = { status, errorCode, settledAtMs: state.options.monotonicNow() };
    if (state.pendingPullResolvedChunk) {
      settleDeferredRequest(state);
    }
  }
}

function settleDeferredRequest(state: PipelineState, settledAtMs?: number): void {
  const deferred = state.deferredRequest;
  if (deferred !== undefined) {
    settleRequest(
      state,
      deferred.status,
      deferred.errorCode,
      undefined,
      settledAtMs ?? deferred.settledAtMs
    );
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
      ...(state.trailingSilenceMs === undefined
        ? {}
        : { "pico.voice.trailing_silence_ms": state.trailingSilenceMs }),
      ...(errorCode === undefined ? {} : { "pico.voice.error_code": errorCode })
    },
    state.playbackStartedAtMs
  );
}

export function measureTrailingPcm16SilenceMs(
  audio: Uint8Array,
  sampleRateHz: number,
  channels: number,
  amplitudeThreshold: number = trailingSilenceAmplitudeThreshold
): number {
  const bytesPerFrame = channels * 2;
  if (!isValidPcm16Measurement(audio, sampleRateHz, channels, amplitudeThreshold)) {
    throw new Error("pico trailing silence received invalid PCM16 audio");
  }

  const samples = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let silentFrames = 0;

  for (
    let frameOffset = audio.byteLength - bytesPerFrame;
    frameOffset >= 0;
    frameOffset -= bytesPerFrame
  ) {
    let silent = true;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = samples.getInt16(frameOffset + channel * 2, true);
      if (Math.abs(sample) > amplitudeThreshold) {
        silent = false;
        break;
      }
    }
    if (!silent) {
      break;
    }
    silentFrames += 1;
  }

  return (silentFrames * 1_000) / sampleRateHz;
}

function tryMeasureTrailingPcm16SilenceMs(
  audio: Uint8Array,
  sampleRateHz: number,
  channels: number
): number | undefined {
  try {
    return measureTrailingPcm16SilenceMs(audio, sampleRateHz, channels);
  } catch {
    return undefined;
  }
}

function isValidPcm16Measurement(
  audio: Uint8Array,
  sampleRateHz: number,
  channels: number,
  amplitudeThreshold: number
): boolean {
  if (audio.byteLength === 0) return false;
  if (!isPositiveInteger(sampleRateHz)) return false;
  if (!isPositiveInteger(channels)) return false;
  if (audio.byteLength % (channels * 2) !== 0) return false;
  if (!Number.isInteger(amplitudeThreshold)) return false;
  return amplitudeThreshold >= 0 && amplitudeThreshold <= 32_767;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
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

function isValidTtsChunk(state: PipelineState, chunk: TtsAudioChunk): boolean {
  return createVoicePcmFrame(state, chunk, state.requestStartedAt) !== undefined;
}

function createEchoReferenceFrame(
  state: PipelineState,
  chunk: TtsAudioChunk
): VoicePcmFrame | undefined {
  const playbackStartedAt = state.playbackStartedAt;
  if (playbackStartedAt === undefined) {
    return undefined;
  }
  return createVoicePcmFrame(state, chunk, playbackStartedAt);
}

function createVoicePcmFrame(
  state: PipelineState,
  chunk: TtsAudioChunk,
  playbackStartedAt: string
): VoicePcmFrame | undefined {
  try {
    return defineVoicePcmFrame({
      id: `tts-${String(chunk.sentenceIndex)}`,
      direction: "far_end",
      audio: chunk.audio,
      encoding: chunk.encoding,
      sampleRateHz: chunk.sampleRateHz,
      channels: chunk.channels,
      capturedAt: addMilliseconds(playbackStartedAt, state.playedDurationMs),
      durationMs: chunk.durationMs
    });
  } catch {
    return undefined;
  }
}

async function registerEchoReference(state: PipelineState, frame: VoicePcmFrame): Promise<void> {
  const echoControl = state.options.echoControl;
  const providerState = getEchoProviderSafetyState(echoControl);
  const previousRegistration = providerState.pending;
  if (previousRegistration !== undefined) {
    await previousRegistration;
  }
  state.producerController.signal.throwIfAborted();
  if (providerState.unsafe) {
    throw new Error("pico echo-control provider state is unsafe after registration timeout");
  }

  const registration = settle(
    Promise.resolve().then(() =>
      echoControl.acceptFarEndReference(frame, state.producerController.signal)
    )
  );
  const outcome = monitorEchoRegistration(state, providerState, registration);
  const safety = outcome.then((result) => (result.status === "unsafe" ? "unsafe" : "safe"));
  providerState.pending = safety;
  void safety.then(
    () => {
      if (providerState.pending === safety) {
        providerState.pending = undefined;
      }
    },
    () => undefined
  );

  const result = await outcome;
  if (result.status === "failed") {
    throw result.error;
  }
  if (result.status === "unsafe") {
    throw new Error("pico echo-control provider registration exceeded its safety bound");
  }
}

function observePendingPullTelemetry(
  state: PipelineState,
  pendingPull: Promise<Settlement<TimedPull>>
): void {
  pendingPull
    .then((pull) => settleRequestFromPull(state, pendingPull, pull))
    .catch(() => undefined);
}

function settleRequestFromPull(
  state: PipelineState,
  pendingPull: Promise<Settlement<TimedPull>>,
  pull: Settlement<TimedPull>
): void {
  if (!pull.ok) {
    deferTerminalRequest(state, {
      status: "error",
      settledAtMs: state.options.monotonicNow(),
      errorCode: "tts_request_failed"
    });
    return;
  }

  const { result, settledAtMs } = pull.value;
  if (result.done) {
    deferTerminalRequest(state, {
      status: "error",
      settledAtMs,
      errorCode: "tts_request_failed"
    });
    return;
  }
  if (result.value.kind === "chunk") {
    if (state.pendingPull === pendingPull) {
      state.pendingPullResolvedChunk = true;
    }
    settleDeferredRequest(state);
    return;
  }
  settleTerminalRequest(state, result.value, settledAtMs);
}

function settleTerminalRequest(
  state: PipelineState,
  event: Exclude<TtsSynthesisEvent, { readonly kind: "chunk" }>,
  settledAtMs: number
): void {
  if (state.requestSettled) {
    return;
  }
  if (event.kind === "completed") {
    deferTerminalRequest(state, {
      status: "ok",
      settledAtMs,
      chunkCount: event.chunkCount
    });
  } else {
    deferTerminalRequest(state, {
      status: event.failure.reason === "cancelled" ? "skipped" : "error",
      settledAtMs,
      errorCode: event.failure.reason,
      sentenceIndex: event.failure.sentenceIndex
    });
  }
}

function deferTerminalRequest(state: PipelineState, terminal: PendingTerminalRequest): void {
  if (state.requestSettled) {
    return;
  }
  state.pendingTerminalRequest = terminal;
  settlePendingTerminalRequest(state);
}

function settlePendingSubmission(state: PipelineState): void {
  if (!state.submissionPending) {
    return;
  }
  state.submissionPending = false;
  settlePendingTerminalRequest(state);
}

function settlePendingTerminalRequest(state: PipelineState): void {
  const pending = state.pendingTerminalRequest;
  if (pending === undefined || state.submissionPending || state.requestSettled) {
    return;
  }
  delete state.pendingTerminalRequest;
  settleRequest(
    state,
    pending.status,
    pending.errorCode,
    pending.sentenceIndex,
    pending.settledAtMs,
    pending.chunkCount
  );
}

function getEchoProviderSafetyState(provider: EchoControlProvider): EchoProviderSafetyState {
  const current = echoProviderSafetyStates.get(provider);
  if (current !== undefined) {
    return current;
  }

  const created = { unsafe: false, unsafeRevision: 0, pending: undefined };
  echoProviderSafetyStates.set(provider, created);
  return created;
}

function monitorEchoRegistration(
  state: PipelineState,
  providerState: EchoProviderSafetyState,
  registration: Promise<Settlement<EchoControlRegistrationResult>>
): Promise<EchoRegistrationOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completion = registration.then((settlement) =>
    resolveEchoRegistration(state, providerState, settlement)
  );
  const expired = new Promise<EchoRegistrationOutcome>((resolve) => {
    timeout = setTimeout(() => {
      poisonEchoProviderState(providerState);
      resolve({ status: "unsafe" });
    }, ECHO_PROVIDER_SAFETY_BOUND_MS);
  });

  return settle(Promise.race([completion, expired])).then((settlement) => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (!settlement.ok) {
      poisonEchoProviderState(providerState);
      return { status: "unsafe" };
    }
    const outcome = settlement.value;
    if (outcome.status === "unsafe") {
      poisonEchoProviderState(providerState);
    }
    return outcome;
  });
}

async function resolveEchoRegistration(
  state: PipelineState,
  providerState: EchoProviderSafetyState,
  settlement: Settlement<EchoControlRegistrationResult>
): Promise<EchoRegistrationOutcome> {
  if (!settlement.ok) {
    poisonEchoProviderState(providerState);
    return { status: "unsafe" };
  }
  const registrationResult = validateEchoRegistrationResult(settlement.value);
  if (registrationResult === undefined) {
    poisonEchoProviderState(providerState);
    return { status: "unsafe" };
  }

  switch (registrationResult.status) {
    case "indeterminate":
      poisonEchoProviderState(providerState);
      return { status: "unsafe" };
    case "definitely_not_applied":
      return { status: "failed", error: registrationResult.error };
    case "applied":
      return resolveAppliedEchoRegistration(state);
  }
}

async function resolveAppliedEchoRegistration(
  state: PipelineState
): Promise<EchoRegistrationOutcome> {
  state.echoReferenceApplied = true;
  const signal = state.producerController.signal;
  if (!signal.aborted) {
    return { status: "registered" };
  }

  const reset = await resetPendingEchoReference(state);
  if (reset === "reset") {
    return { status: "failed", error: signal.reason };
  }
  return { status: "unsafe" };
}

function resetPendingEchoReference(state: PipelineState): Promise<"reset" | "unsafe"> {
  if (state.echoReset !== undefined) {
    return state.echoReset;
  }

  const providerState = getEchoProviderSafetyState(state.options.echoControl);
  const unsafeRevision = poisonEchoProviderState(providerState);
  const reset = settleWithinSafetyBound(
    settle(Promise.resolve().then(() => state.options.echoControl.flush())),
    ECHO_PROVIDER_SAFETY_BOUND_MS
  ).then((settlement): "reset" | "unsafe" => {
    if (
      settlement?.ok &&
      isPlainResetResult(settlement.value) &&
      providerState.unsafeRevision === unsafeRevision
    ) {
      providerState.unsafe = false;
      state.echoReferenceApplied = false;
      return "reset";
    }
    return "unsafe";
  });
  state.echoReset = reset;
  return reset;
}

function isPlainResetResult(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    if (nodeUtilityTypes.isProxy(value)) {
      return false;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }
    const status = Object.getOwnPropertyDescriptor(value, "status");
    return status !== undefined && "value" in status && status.value === "reset";
  } catch {
    return false;
  }
}

function validateEchoRegistrationResult(value: unknown): EchoControlRegistrationResult | undefined {
  const record = echoRegistrationRecord(value);
  if (record === undefined) {
    return undefined;
  }

  switch (record.status) {
    case "applied":
      return { status: "applied" };
    case "definitely_not_applied":
      return validateEchoRegistrationFailure("definitely_not_applied", record);
    case "indeterminate":
      return validateEchoRegistrationFailure("indeterminate", record);
    default:
      return undefined;
  }
}

function echoRegistrationRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && "status" in value ? value : undefined;
}

function validateEchoRegistrationFailure(
  status: "definitely_not_applied" | "indeterminate",
  value: Record<string, unknown>
): EchoControlRegistrationResult | undefined {
  return value.error instanceof Error ? { status, error: value.error } : undefined;
}

function poisonEchoProviderState(state: EchoProviderSafetyState): number {
  state.unsafe = true;
  state.unsafeRevision += 1;
  return state.unsafeRevision;
}

async function settleWithinSafetyBound<T>(
  settlement: Promise<Settlement<T>>,
  timeoutMs: number
): Promise<Settlement<T> | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const result = await Promise.race([settlement, expired]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
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
    if (waitForCleanup) {
      const cleanup = settle(closeIterator(state.iterator));
      await settleWithinSafetyBound(cleanup, ITERATOR_CLEANUP_SAFETY_BOUND_MS);
      return;
    }
    const cleanup = closeIterator(state.iterator).then(() => settleDeferredRequest(state));
    cleanup.catch(() => undefined);
    return;
  }

  const cleanup = state.pendingPull.then(async (pull) => {
    const terminalAtMs = terminalPullTime(pull, state.options.monotonicNow);
    await closeIterator(state.iterator);
    settleDeferredRequest(state, terminalAtMs);
  });
  cleanup.catch(() => undefined);
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
