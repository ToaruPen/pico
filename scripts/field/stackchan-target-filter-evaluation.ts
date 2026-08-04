#!/usr/bin/env jiti
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PicoStackChanTargetFilterConfig } from "../../src/config/index.js";
import {
  advanceAttentionState,
  initialAttentionState,
  type StackChanAttentionControllerConfig
} from "../../src/modules/stackchan/attention-controller.js";
import type { StackChanHeadPose } from "../../src/modules/stackchan/index.js";
import type { AttentionDetection } from "../../src/modules/vision/attention-detection.js";

const EVALUATION_SEED = 20_260_801;
const SAMPLE_INTERVAL_MS = 125;
const STATIONARY_SAMPLE_COUNT = 96;
const REVERSAL_SEGMENT_SAMPLE_COUNT = 16;
const HORIZONTAL_NOISE_MAGNITUDE = 0.06;
const VERTICAL_NOISE_MAGNITUDE = 0.015;

export type StackChanTargetFilterSafetyMetrics = {
  readonly errorCount: number;
  readonly staleCount: number;
  readonly postStopCount: number;
  readonly overlapCount: number;
  readonly servoLimitFrames: number;
  readonly homeError: number;
};

export type StackChanTargetFilterTraceMetrics = {
  readonly filteredCenterTotalVariation: number;
  readonly targetAbsoluteErrorP50: number;
  readonly targetAbsoluteErrorP95: number;
  readonly moveRequestCount: number;
  readonly commandPathTotalVariation: number;
  readonly maximumIntegerStep: number;
  readonly commandNormalizedRoughness: number;
  readonly commandVelocityTotalVariation: number;
  readonly firstCorrectReversalLatencyMs: number;
  readonly extraDirectionReversals: number;
  readonly safety: StackChanTargetFilterSafetyMetrics;
};

export type StackChanTargetFilterAcceptanceCheck = {
  readonly id:
    | "stationary-command-path-total-variation"
    | "stationary-maximum-integer-step"
    | "reversal-response-delay"
    | "reversal-direction-stability"
    | "absolute-safety-nonregression";
  readonly passed: boolean;
  readonly actual: number;
  readonly maximum: number;
};

export type StackChanTargetFilterAcceptance = {
  readonly passed: boolean;
  readonly checks: readonly StackChanTargetFilterAcceptanceCheck[];
};

export type StackChanTargetFilterCandidateResult = {
  readonly config: PicoStackChanTargetFilterConfig;
  readonly stationary: StackChanTargetFilterTraceMetrics;
  readonly reversal: StackChanTargetFilterTraceMetrics;
  readonly acceptance: StackChanTargetFilterAcceptance;
};

export type StackChanTargetFilterEvaluationThresholds = {
  readonly stationaryCommandPathTotalVariationRatioMaximum: number;
  readonly stationaryMaximumIntegerStepRatioMaximum: number;
  readonly reversalResponseDelayMaximumMs: number;
};

export type StackChanTargetFilterEvaluation = {
  readonly seed: number;
  readonly sampleIntervalMs: number;
  readonly thresholds: StackChanTargetFilterEvaluationThresholds;
  readonly raw: StackChanTargetFilterCandidateResult;
  readonly candidates: readonly StackChanTargetFilterCandidateResult[];
  readonly selected?: StackChanTargetFilterCandidateResult;
};

type TraceSample = {
  readonly observedAtMs: number;
  readonly trueCenterX: number;
  readonly observedCenterX: number;
  readonly observedCenterY: number;
};

type SimulatedSample = {
  readonly sample: TraceSample;
  readonly filteredCenterX: number;
  readonly stepYaw: number;
  readonly pose: StackChanHeadPose;
};

const DEFAULT_THRESHOLDS: StackChanTargetFilterEvaluationThresholds = {
  stationaryCommandPathTotalVariationRatioMaximum: 0.7,
  stationaryMaximumIntegerStepRatioMaximum: 1,
  reversalResponseDelayMaximumMs: 250
};

export function evaluateStackChanTargetFilterCandidates(
  thresholdOverrides: Partial<StackChanTargetFilterEvaluationThresholds> = {}
): StackChanTargetFilterEvaluation {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...thresholdOverrides };
  const traces = createEvaluationTraces();
  const raw = simulateCandidate({ enabled: false }, traces.stationary, traces.reversal);
  const candidates = [0.5, 1, 1.5, 2].flatMap((minimumCutoffHz) =>
    [0.5, 1, 2, 4].map((speedCoefficient) => {
      const result = simulateCandidate(
        {
          enabled: true,
          minimumCutoffHz,
          speedCoefficient,
          derivativeCutoffHz: 1
        },
        traces.stationary,
        traces.reversal
      );
      return {
        ...result,
        acceptance: evaluateAcceptance(raw, result, thresholds)
      };
    })
  );
  const accepted = candidates.filter(({ acceptance }) => acceptance.passed);
  const selected = [...accepted].sort((left, right) => compareCandidateRank(raw, left, right))[0];

  return {
    seed: EVALUATION_SEED,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    thresholds,
    raw,
    candidates,
    ...(selected === undefined ? {} : { selected })
  };
}

function createEvaluationTraces(): {
  readonly stationary: readonly TraceSample[];
  readonly reversal: readonly TraceSample[];
} {
  const stationaryRandom = createLinearCongruentialGenerator(EVALUATION_SEED);
  const reversalRandom = createLinearCongruentialGenerator(EVALUATION_SEED);
  const stationary = Array.from({ length: STATIONARY_SAMPLE_COUNT }, (_, index) =>
    traceSample(index, 0.595, stationaryRandom)
  );
  const reversalCenters = [0.38, 0.62, 0.38];
  const reversal = reversalCenters.flatMap((trueCenterX, segmentIndex) =>
    Array.from({ length: REVERSAL_SEGMENT_SAMPLE_COUNT }, (_, index) =>
      traceSample(segmentIndex * REVERSAL_SEGMENT_SAMPLE_COUNT + index, trueCenterX, reversalRandom)
    )
  );
  return { stationary, reversal };
}

function traceSample(index: number, trueCenterX: number, random: () => number): TraceSample {
  return {
    observedAtMs: index * SAMPLE_INTERVAL_MS,
    trueCenterX,
    observedCenterX: trueCenterX + symmetricNoise(random, HORIZONTAL_NOISE_MAGNITUDE),
    observedCenterY: 0.5 + symmetricNoise(random, VERTICAL_NOISE_MAGNITUDE)
  };
}

function symmetricNoise(random: () => number, magnitude: number): number {
  return (random() * 2 - 1) * magnitude;
}

function createLinearCongruentialGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function simulateCandidate(
  targetFilter: PicoStackChanTargetFilterConfig,
  stationaryTrace: readonly TraceSample[],
  reversalTrace: readonly TraceSample[]
): StackChanTargetFilterCandidateResult {
  const stationarySamples = simulateTrace(stationaryTrace, targetFilter);
  const reversalSamples = simulateTrace(reversalTrace, targetFilter);
  return {
    config: targetFilter,
    stationary: summarizeTrace(stationarySamples, undefined),
    reversal: summarizeTrace(
      reversalSamples,
      REVERSAL_SEGMENT_SAMPLE_COUNT * 2 * SAMPLE_INTERVAL_MS
    ),
    acceptance: { passed: true, checks: baselineChecks() }
  };
}

function simulateTrace(
  trace: readonly TraceSample[],
  targetFilter: PicoStackChanTargetFilterConfig
): readonly SimulatedSample[] {
  const config = controllerConfig(targetFilter);
  let state = initialAttentionState();
  let pose: StackChanHeadPose = { yaw: 0, pitch: 35 };
  const samples: SimulatedSample[] = [];

  for (const sample of trace) {
    const transition = advanceAttentionState(
      state,
      {
        nowMs: sample.observedAtMs,
        observedAtMs: sample.observedAtMs,
        currentPose: pose,
        detections: [detection(sample.observedCenterX, sample.observedCenterY)]
      },
      config
    );
    const nextPose = transition.effect.kind === "move" ? transition.effect.pose : pose;
    samples.push({
      sample,
      filteredCenterX: transition.target?.centerX ?? sample.observedCenterX,
      stepYaw: nextPose.yaw - pose.yaw,
      pose: nextPose
    });
    state = transition.state;
    pose = nextPose;
  }

  return samples;
}

function controllerConfig(
  targetFilter: PicoStackChanTargetFilterConfig
): StackChanAttentionControllerConfig {
  return {
    deadZone: 0.1,
    deadZoneRelease: 0.14,
    stepQuantization: "error-feedback",
    targetFilter,
    yawGainDeg: 44,
    pitchGainDeg: 30,
    flipYaw: 1,
    flipPitch: -1,
    maxStepDeg: 4,
    trackingPitchMin: 25,
    lostHoldMs: 1000,
    scanDwellMs: 900,
    scanYaw: [-35, 0, 35],
    scanPitch: [35, 25]
  };
}

function detection(centerX: number, centerY: number): AttentionDetection {
  return {
    label: "face",
    confidence: 0.9,
    boundingBox: {
      xMin: centerX - 0.1,
      yMin: centerY - 0.1,
      xMax: centerX + 0.1,
      yMax: centerY + 0.1
    }
  };
}

function summarizeTrace(
  samples: readonly SimulatedSample[],
  reversalAtMs: number | undefined
): StackChanTargetFilterTraceMetrics {
  const centers = samples.map(({ filteredCenterX }) => filteredCenterX);
  const targetErrors = samples.map(({ filteredCenterX, sample }) =>
    Math.abs(filteredCenterX - sample.trueCenterX)
  );
  const velocities = samples.map(({ stepYaw }) => stepYaw);
  const commandPathTotalVariation = sum(velocities.map(Math.abs));
  const commandVelocityTotalVariation = totalVariation([0, ...velocities]);
  const finalPose = samples.at(-1)?.pose ?? { yaw: 0, pitch: 35 };
  const firstCorrectReversalLatencyMs =
    reversalAtMs === undefined ? 0 : firstCorrectReversalLatency(samples, reversalAtMs);

  return {
    filteredCenterTotalVariation: round(totalVariation(centers)),
    targetAbsoluteErrorP50: round(nearestRank(targetErrors, 0.5)),
    targetAbsoluteErrorP95: round(nearestRank(targetErrors, 0.95)),
    moveRequestCount: velocities.filter((velocity) => velocity !== 0).length,
    commandPathTotalVariation,
    maximumIntegerStep: Math.max(0, ...velocities.map((velocity) => Math.abs(velocity))),
    commandNormalizedRoughness: round(
      commandVelocityTotalVariation / Math.max(1, commandPathTotalVariation)
    ),
    commandVelocityTotalVariation,
    firstCorrectReversalLatencyMs,
    extraDirectionReversals:
      reversalAtMs === undefined ? 0 : countExtraDirectionReversals(samples, reversalAtMs),
    safety: {
      errorCount: 0,
      staleCount: 0,
      postStopCount: 0,
      overlapCount: 0,
      servoLimitFrames: samples.filter(({ pose }) => isServoLimitPose(pose)).length,
      homeError: Math.abs(finalPose.yaw) + Math.abs(finalPose.pitch - 35)
    }
  };
}

function firstCorrectReversalLatency(
  samples: readonly SimulatedSample[],
  reversalAtMs: number
): number {
  const response = samples.find(
    ({ sample, stepYaw }) => sample.observedAtMs >= reversalAtMs && stepYaw < 0
  );
  return response === undefined
    ? samples.length * SAMPLE_INTERVAL_MS
    : response.sample.observedAtMs - reversalAtMs;
}

function countExtraDirectionReversals(
  samples: readonly SimulatedSample[],
  reversalAtMs: number
): number {
  const directions = samples
    .filter(({ sample, stepYaw }) => sample.observedAtMs >= reversalAtMs && stepYaw !== 0)
    .map(({ stepYaw }) => Math.sign(stepYaw));
  const firstCorrectIndex = directions.findIndex((direction) => direction < 0);
  if (firstCorrectIndex < 0) {
    return directions.length;
  }
  return directions
    .slice(firstCorrectIndex + 1)
    .reduce(
      (count, direction, index, remaining) =>
        count + Number(direction !== (index === 0 ? -1 : remaining[index - 1])),
      0
    );
}

function evaluateAcceptance(
  raw: StackChanTargetFilterCandidateResult,
  candidate: StackChanTargetFilterCandidateResult,
  thresholds: StackChanTargetFilterEvaluationThresholds
): StackChanTargetFilterAcceptance {
  const commandPathMaximum =
    raw.stationary.commandPathTotalVariation *
    thresholds.stationaryCommandPathTotalVariationRatioMaximum;
  const maximumStepMaximum =
    raw.stationary.maximumIntegerStep * thresholds.stationaryMaximumIntegerStepRatioMaximum;
  const reversalLatencyMaximum =
    raw.reversal.firstCorrectReversalLatencyMs + thresholds.reversalResponseDelayMaximumMs;
  const safetyRegression = countSafetyRegressions(raw, candidate);
  const checks: readonly StackChanTargetFilterAcceptanceCheck[] = [
    check(
      "stationary-command-path-total-variation",
      candidate.stationary.commandPathTotalVariation,
      commandPathMaximum
    ),
    check(
      "stationary-maximum-integer-step",
      candidate.stationary.maximumIntegerStep,
      maximumStepMaximum
    ),
    check(
      "reversal-response-delay",
      candidate.reversal.firstCorrectReversalLatencyMs,
      reversalLatencyMaximum
    ),
    check(
      "reversal-direction-stability",
      candidate.reversal.extraDirectionReversals,
      raw.reversal.extraDirectionReversals
    ),
    check("absolute-safety-nonregression", safetyRegression, 0)
  ];
  return {
    passed: checks.every(({ passed }) => passed),
    checks
  };
}

function check(
  id: StackChanTargetFilterAcceptanceCheck["id"],
  actual: number,
  maximum: number
): StackChanTargetFilterAcceptanceCheck {
  return { id, passed: actual <= maximum, actual, maximum };
}

function countSafetyRegressions(
  raw: StackChanTargetFilterCandidateResult,
  candidate: StackChanTargetFilterCandidateResult
): number {
  return (["stationary", "reversal"] as const).reduce((total, trace) => {
    const baseline = raw[trace].safety;
    const current = candidate[trace].safety;
    return (
      total +
      Number(current.errorCount > baseline.errorCount) +
      Number(current.staleCount > baseline.staleCount) +
      Number(current.postStopCount > baseline.postStopCount) +
      Number(current.overlapCount > baseline.overlapCount) +
      Number(current.servoLimitFrames > baseline.servoLimitFrames) +
      Number(current.homeError > baseline.homeError)
    );
  }, 0);
}

function baselineChecks(): readonly StackChanTargetFilterAcceptanceCheck[] {
  return [
    check("stationary-command-path-total-variation", 0, 0),
    check("stationary-maximum-integer-step", 0, 0),
    check("reversal-response-delay", 0, 0),
    check("reversal-direction-stability", 0, 0),
    check("absolute-safety-nonregression", 0, 0)
  ];
}

function compareCandidateRank(
  raw: StackChanTargetFilterCandidateResult,
  left: StackChanTargetFilterCandidateResult,
  right: StackChanTargetFilterCandidateResult
): number {
  const leftRank = candidateRank(raw, left);
  const rightRank = candidateRank(raw, right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = (leftRank[index] ?? 0) - (rightRank[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function candidateRank(
  raw: StackChanTargetFilterCandidateResult,
  candidate: StackChanTargetFilterCandidateResult
): readonly number[] {
  if (!candidate.config.enabled) {
    throw new Error("target-filter rank requires an enabled candidate");
  }
  return [
    candidate.stationary.commandPathTotalVariation,
    candidate.reversal.firstCorrectReversalLatencyMs - raw.reversal.firstCorrectReversalLatencyMs,
    candidate.reversal.targetAbsoluteErrorP95,
    candidate.config.minimumCutoffHz,
    candidate.config.speedCoefficient
  ];
}

function totalVariation(values: readonly number[]): number {
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
  }
  return total;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nearestRank(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isServoLimitPose(pose: StackChanHeadPose): boolean {
  return pose.yaw <= -90 || pose.yaw >= 90 || pose.pitch <= 5 || pose.pitch >= 85;
}

type StackChanTargetFilterEvaluationReport = {
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly generatedAt: string;
  readonly evaluation: StackChanTargetFilterEvaluation;
};

async function executeStackChanTargetFilterEvaluationCli(
  arguments_: readonly string[]
): Promise<number> {
  try {
    const reportOutput = parseReportOutput(arguments_);
    const evaluation = evaluateStackChanTargetFilterCandidates();
    if (evaluation.selected === undefined || !evaluation.selected.acceptance.passed) {
      throw new Error("target-filter evaluation did not select an accepted candidate");
    }
    const report: StackChanTargetFilterEvaluationReport = {
      schemaVersion: 1,
      status: "passed",
      generatedAt: new Date().toISOString(),
      evaluation
    };
    await writeAtomicJsonReport(reportOutput, report);
    process.stdout.write(`${reportOutput}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseReportOutput(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--report-output" ||
    arguments_[1] === undefined ||
    arguments_[1].trim() === ""
  ) {
    throw new Error("expected only --report-output <absolute path>");
  }
  if (!isAbsolute(arguments_[1])) {
    throw new Error("--report-output must be an absolute path");
  }
  return resolve(arguments_[1]);
}

async function writeAtomicJsonReport(
  outputPath: string,
  report: StackChanTargetFilterEvaluationReport
): Promise<void> {
  await rejectSymbolicPathComponents(outputPath);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(report, undefined, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rejectSymbolicPathComponents(outputPath);
    await rename(temporaryPath, outputPath);
    replaced = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!replaced) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function rejectSymbolicPathComponents(path: string): Promise<void> {
  const root = parse(path).root;
  const components = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) {
        throw new Error(`report path must not contain a symbolic link: ${current}`);
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isDirectExecution(): boolean {
  const moduleName = basename(fileURLToPath(import.meta.url));
  return (
    (moduleName === "stackchan-target-filter-evaluation.ts" ||
      moduleName === "stackchan-target-filter-evaluation.js") &&
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isDirectExecution()) {
  process.exitCode = await executeStackChanTargetFilterEvaluationCli(process.argv.slice(2));
}
