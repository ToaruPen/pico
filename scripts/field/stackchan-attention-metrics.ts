/* eslint-disable unicorn/no-null -- Replay JSON distributions use explicit null for empty percentiles. */
import type { StackChanHeadPose } from "../../src/modules/stackchan/index.js";

export type AttentionMetricSample = {
  sequence: number;
  observedAtMs: number;
  pose: StackChanHeadPose;
  target?: {
    label: "face" | "head";
    horizontalError: number;
    verticalError: number;
    centered: boolean;
  };
};

type AttentionAxisMetrics = {
  readonly signedP50: number;
  readonly absoluteP50: number;
  readonly absoluteP95: number;
  readonly signFlips: number;
  readonly eligibleSignComparisons: number;
  readonly positiveOutsideFrames: number;
  readonly negativeOutsideFrames: number;
};

export type AttentionMetricsSummary = {
  readonly framesProcessed: number;
  readonly targetFrames: number;
  readonly faceFrames: number;
  readonly headFrames: number;
  readonly firstTargetMs: number | undefined;
  readonly firstCenteredMs: number | undefined;
  readonly maximumLostGapMs: number;
  readonly evaluationWindow: {
    readonly targetFrames: number;
    readonly centeredFrames: number;
    readonly centeredRatio: number;
  };
  readonly horizontal: AttentionAxisMetrics;
  readonly vertical: AttentionAxisMetrics;
  readonly servoLimitFrames: number;
};

export type CreateAttentionMetricsAccumulatorOptions = {
  readonly runStartedAtMs: number;
  readonly deadZone: number;
};

export type AttentionMetricsAccumulator = {
  readonly record: (sample: AttentionMetricSample) => boolean;
  readonly summarize: (runEndedAtMs: number) => AttentionMetricsSummary;
};

export type AttentionQuantizationEffectOutcome =
  | "dispatched"
  | "replaced"
  | "noop"
  | "stale"
  | "none";

export type AttentionQuantizationResidualAction =
  | "round-disabled"
  | "reset-centered"
  | "reset-zero-correction"
  | "reset-direct-step"
  | "reset-direction-reversal"
  | "residual-accumulate"
  | "residual-release";

export type AttentionQuantizationAxisSample = {
  readonly timestampMs: number;
  readonly boundary: string;
  readonly active: boolean;
  readonly centered: boolean;
  readonly rawCorrectionDeg: number;
  readonly clampedCorrectionDeg: number;
  readonly legacyRoundedStepDeg: number;
  readonly quantizedStepDeg: number;
  readonly residualAction: AttentionQuantizationResidualAction;
  readonly effectOutcome: AttentionQuantizationEffectOutcome;
  readonly ticksWithoutConfirmedUpdate: number;
};

export type AttentionQuantizationDistribution = {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly max: number | null;
};

export type AttentionQuantizationAxisSummary = {
  readonly zeroRuns: {
    readonly completedCount: number;
    readonly censoredCount: number;
    readonly durationMs: AttentionQuantizationDistribution;
    readonly lengthTicks: AttentionQuantizationDistribution;
    readonly releaseStepAbsDeg: AttentionQuantizationDistribution;
  };
  readonly residualReleaseCount: number;
  readonly residualReleaseOutcomes: Record<AttentionQuantizationEffectOutcome, number>;
  readonly residualReleaseTicksWithoutConfirmedUpdate: AttentionQuantizationDistribution;
  readonly unDispatchedResidualReleaseCount: number;
  readonly directionReversalResetCount: number;
  readonly exactHalfStepHitCount: number;
  readonly negativeZeroCount: number;
};

type ActiveZeroRun = {
  readonly boundary: string;
  readonly startedAtMs: number;
  lastAtMs: number;
  lengthTicks: number;
};

type QuantizationSummaryState = {
  readonly durations: number[];
  readonly lengths: number[];
  readonly releaseSteps: number[];
  readonly releaseOutcomes: Record<AttentionQuantizationEffectOutcome, number>;
  readonly releaseTicks: number[];
  activeRun: ActiveZeroRun | undefined;
  completedCount: number;
  censoredCount: number;
  directionReversalResetCount: number;
  exactHalfStepHitCount: number;
  negativeZeroCount: number;
};

export function summarizeAttentionQuantizationAxis(
  samples: readonly AttentionQuantizationAxisSample[]
): AttentionQuantizationAxisSummary {
  const state = initialQuantizationSummaryState();

  for (const sample of samples) {
    updateZeroRun(state, sample);
    updateQuantizationCounters(state, sample);
  }
  if (state.activeRun !== undefined) {
    closeZeroRun(state, state.activeRun.lastAtMs);
  }
  const residualReleaseCount = Object.values(state.releaseOutcomes).reduce(
    (sum, count) => sum + count,
    0
  );
  return {
    zeroRuns: {
      completedCount: state.completedCount,
      censoredCount: state.censoredCount,
      durationMs: quantizationDistribution(state.durations),
      lengthTicks: quantizationDistribution(state.lengths),
      releaseStepAbsDeg: quantizationDistribution(state.releaseSteps)
    },
    residualReleaseCount,
    residualReleaseOutcomes: state.releaseOutcomes,
    residualReleaseTicksWithoutConfirmedUpdate: quantizationDistribution(state.releaseTicks),
    unDispatchedResidualReleaseCount: residualReleaseCount - state.releaseOutcomes.dispatched,
    directionReversalResetCount: state.directionReversalResetCount,
    exactHalfStepHitCount: state.exactHalfStepHitCount,
    negativeZeroCount: state.negativeZeroCount
  };
}

function initialQuantizationSummaryState(): QuantizationSummaryState {
  return {
    durations: [],
    lengths: [],
    releaseSteps: [],
    releaseOutcomes: { dispatched: 0, replaced: 0, noop: 0, stale: 0, none: 0 },
    releaseTicks: [],
    activeRun: undefined,
    completedCount: 0,
    censoredCount: 0,
    directionReversalResetCount: 0,
    exactHalfStepHitCount: 0,
    negativeZeroCount: 0
  };
}

function updateZeroRun(
  state: QuantizationSummaryState,
  sample: AttentionQuantizationAxisSample
): void {
  if (state.activeRun !== undefined && state.activeRun.boundary !== sample.boundary) {
    closeZeroRun(state, sample.timestampMs);
  }
  if (state.activeRun !== undefined && isQuantizedCorrection(sample, false)) {
    closeZeroRun(state, sample.timestampMs, sample.quantizedStepDeg);
    return;
  }
  if (isQuantizedCorrection(sample, true)) {
    extendZeroRun(state, sample);
    return;
  }
  closeZeroRun(state, sample.timestampMs);
}

function isQuantizedCorrection(
  sample: AttentionQuantizationAxisSample,
  expectZero: boolean
): boolean {
  return (
    sample.active &&
    !sample.centered &&
    sample.rawCorrectionDeg !== 0 &&
    (sample.quantizedStepDeg === 0) === expectZero
  );
}

function extendZeroRun(
  state: QuantizationSummaryState,
  sample: AttentionQuantizationAxisSample
): void {
  if (state.activeRun === undefined) {
    state.activeRun = {
      boundary: sample.boundary,
      startedAtMs: sample.timestampMs,
      lastAtMs: sample.timestampMs,
      lengthTicks: 1
    };
    return;
  }
  state.activeRun.lastAtMs = sample.timestampMs;
  state.activeRun.lengthTicks += 1;
}

function closeZeroRun(
  state: QuantizationSummaryState,
  endedAtMs: number,
  releaseStepDeg?: number
): void {
  const activeRun = state.activeRun;
  if (activeRun === undefined) {
    return;
  }
  state.durations.push(Math.max(0, endedAtMs - activeRun.startedAtMs));
  state.lengths.push(activeRun.lengthTicks);
  if (releaseStepDeg === undefined) {
    state.censoredCount += 1;
  } else {
    state.completedCount += 1;
    state.releaseSteps.push(Math.abs(releaseStepDeg));
  }
  state.activeRun = undefined;
}

function updateQuantizationCounters(
  state: QuantizationSummaryState,
  sample: AttentionQuantizationAxisSample
): void {
  if (sample.residualAction === "residual-release") {
    state.releaseOutcomes[sample.effectOutcome] += 1;
    state.releaseTicks.push(sample.ticksWithoutConfirmedUpdate);
  }
  state.directionReversalResetCount += Number(sample.residualAction === "reset-direction-reversal");
  state.exactHalfStepHitCount += Number(isExactHalfStep(sample.clampedCorrectionDeg));
  state.negativeZeroCount += Number(Object.is(sample.legacyRoundedStepDeg, -0));
  state.negativeZeroCount += Number(Object.is(sample.quantizedStepDeg, -0));
}

function quantizationDistribution(values: readonly number[]): AttentionQuantizationDistribution {
  if (values.length === 0) {
    return { count: 0, p50: null, p90: null, p95: null, max: null };
  }
  const sorted = values.map(round).sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: quantizationPercentile(sorted, 0.5),
    p90: quantizationPercentile(sorted, 0.9),
    p95: quantizationPercentile(sorted, 0.95),
    max: sorted.at(-1) ?? null
  };
}

function quantizationPercentile(sorted: readonly number[], quantile: number): number | null {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

function isExactHalfStep(value: number): boolean {
  const magnitude = Math.abs(value);
  return Math.abs(magnitude - Math.floor(magnitude) - 0.5) <= Number.EPSILON * 8;
}

type AxisTracking = {
  readonly errors: number[];
  previousSign: -1 | 1 | undefined;
  signFlips: number;
  eligibleSignComparisons: number;
  positiveOutsideFrames: number;
  negativeOutsideFrames: number;
};

type AttentionMetricsState = {
  readonly sequences: Set<number>;
  readonly horizontal: AxisTracking;
  readonly vertical: AxisTracking;
  framesProcessed: number;
  targetFrames: number;
  faceFrames: number;
  headFrames: number;
  firstTargetMs: number | undefined;
  firstCenteredMs: number | undefined;
  lastTargetAtMs: number | undefined;
  maximumLostGapMs: number;
  lostGapStartedAtMs: number | undefined;
  windowTargetFrames: number;
  windowCenteredFrames: number;
  servoLimitFrames: number;
};

export function createAttentionMetricsAccumulator(
  options: CreateAttentionMetricsAccumulatorOptions
): AttentionMetricsAccumulator {
  const state = createMetricsState(options.runStartedAtMs);

  return {
    record: (sample) => recordSample(state, sample, options),
    summarize: (runEndedAtMs) => summarizeMetrics(state, runEndedAtMs, options.runStartedAtMs)
  };
}

function createMetricsState(runStartedAtMs: number): AttentionMetricsState {
  return {
    sequences: new Set<number>(),
    horizontal: createAxisTracking(),
    vertical: createAxisTracking(),
    framesProcessed: 0,
    targetFrames: 0,
    faceFrames: 0,
    headFrames: 0,
    firstTargetMs: undefined,
    firstCenteredMs: undefined,
    lastTargetAtMs: undefined,
    maximumLostGapMs: 0,
    lostGapStartedAtMs: runStartedAtMs,
    windowTargetFrames: 0,
    windowCenteredFrames: 0,
    servoLimitFrames: 0
  };
}

function createAxisTracking(): AxisTracking {
  return {
    errors: [],
    previousSign: undefined,
    signFlips: 0,
    eligibleSignComparisons: 0,
    positiveOutsideFrames: 0,
    negativeOutsideFrames: 0
  };
}

function recordSample(
  state: AttentionMetricsState,
  sample: AttentionMetricSample,
  options: CreateAttentionMetricsAccumulatorOptions
): boolean {
  if (state.sequences.has(sample.sequence)) {
    return false;
  }
  state.sequences.add(sample.sequence);
  state.framesProcessed++;
  if (sample.target === undefined) {
    recordLostSample(state, sample.observedAtMs);
  } else {
    recordTargetSample(state, sample, options);
  }
  return true;
}

function recordLostSample(state: AttentionMetricsState, observedAtMs: number): void {
  state.lostGapStartedAtMs ??= observedAtMs;
  state.horizontal.previousSign = undefined;
  state.vertical.previousSign = undefined;
}

function recordTargetSample(
  state: AttentionMetricsState,
  sample: AttentionMetricSample,
  options: CreateAttentionMetricsAccumulatorOptions
): void {
  const target = sample.target;
  if (target === undefined) {
    return;
  }
  const elapsedMs = Math.max(0, sample.observedAtMs - options.runStartedAtMs);
  state.targetFrames++;
  state.faceFrames += Number(target.label === "face");
  state.headFrames += Number(target.label === "head");
  state.firstTargetMs ??= elapsedMs;
  if (target.centered) {
    state.firstCenteredMs ??= elapsedMs;
  }
  closeLostGap(state, sample.observedAtMs);
  state.lastTargetAtMs = sample.observedAtMs;
  state.horizontal.errors.push(target.horizontalError);
  state.vertical.errors.push(target.verticalError);
  recordEvaluationWindow(state, elapsedMs, target.centered);
  state.servoLimitFrames += Number(isServoLimitPose(sample.pose));
  recordAxisError(state.horizontal, target.horizontalError, options.deadZone);
  recordAxisError(state.vertical, target.verticalError, options.deadZone);
}

function closeLostGap(state: AttentionMetricsState, observedAtMs: number): void {
  const lostGapStartedAtMs = state.lostGapStartedAtMs;
  if (lostGapStartedAtMs === undefined) {
    return;
  }
  state.maximumLostGapMs = Math.max(
    state.maximumLostGapMs,
    Math.max(0, observedAtMs - lostGapStartedAtMs)
  );
  state.lostGapStartedAtMs = undefined;
}

function recordEvaluationWindow(
  state: AttentionMetricsState,
  elapsedMs: number,
  centered: boolean
): void {
  if (elapsedMs < 5_000 || elapsedMs >= 25_000) {
    return;
  }
  state.windowTargetFrames++;
  state.windowCenteredFrames += Number(centered);
}

function recordAxisError(axis: AxisTracking, error: number, deadZone: number): void {
  const sign = signOutsideDeadZone(error, deadZone);
  if (sign === 0) {
    axis.previousSign = undefined;
    return;
  }
  axis.positiveOutsideFrames += Number(sign === 1);
  axis.negativeOutsideFrames += Number(sign === -1);
  if (axis.previousSign !== undefined) {
    axis.eligibleSignComparisons++;
    axis.signFlips += Number(axis.previousSign !== sign);
  }
  axis.previousSign = sign;
}

function summarizeMetrics(
  state: AttentionMetricsState,
  runEndedAtMs: number,
  runStartedAtMs: number
): AttentionMetricsSummary {
  const finalLostGapStartedAtMs =
    state.lostGapStartedAtMs ?? state.lastTargetAtMs ?? runStartedAtMs;
  const finalLostGapMs = Math.max(0, runEndedAtMs - finalLostGapStartedAtMs);
  const centeredRatio =
    state.windowTargetFrames === 0
      ? 0
      : round(state.windowCenteredFrames / state.windowTargetFrames);

  return {
    framesProcessed: state.framesProcessed,
    targetFrames: state.targetFrames,
    faceFrames: state.faceFrames,
    headFrames: state.headFrames,
    firstTargetMs: state.firstTargetMs,
    firstCenteredMs: state.firstCenteredMs,
    maximumLostGapMs: Math.max(state.maximumLostGapMs, finalLostGapMs),
    evaluationWindow: {
      targetFrames: state.windowTargetFrames,
      centeredFrames: state.windowCenteredFrames,
      centeredRatio
    },
    horizontal: summarizeAxis(state.horizontal),
    vertical: summarizeAxis(state.vertical),
    servoLimitFrames: state.servoLimitFrames
  };
}

function summarizeAxis(axis: AxisTracking): AttentionAxisMetrics {
  return {
    signedP50: percentile(axis.errors, 0.5),
    absoluteP50: percentile(axis.errors.map(Math.abs), 0.5),
    absoluteP95: percentile(axis.errors.map(Math.abs), 0.95),
    signFlips: axis.signFlips,
    eligibleSignComparisons: axis.eligibleSignComparisons,
    positiveOutsideFrames: axis.positiveOutsideFrames,
    negativeOutsideFrames: axis.negativeOutsideFrames
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(sorted.length * quantile);
  return round(sorted[rank - 1] ?? 0);
}

function signOutsideDeadZone(error: number, deadZone: number): -1 | 0 | 1 {
  if (error > deadZone) {
    return 1;
  }
  if (error < -deadZone) {
    return -1;
  }
  return 0;
}

function isServoLimitPose(pose: StackChanHeadPose): boolean {
  return (
    Math.abs(Math.abs(pose.yaw) - 90) <= 1 ||
    Math.abs(pose.pitch - 5) <= 1 ||
    Math.abs(pose.pitch - 85) <= 1
  );
}

function round(value: number): number {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
