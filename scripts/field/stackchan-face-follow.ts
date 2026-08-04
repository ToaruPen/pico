#!/usr/bin/env jiti
import { lstat, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStackChanHeadTargetLaneFromConfig,
  STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
  type StackChanHeadTargetLane,
  type StackChanHeadTargetStatus
} from "../../src/modules/stackchan/head-target-lane.js";
import {
  createStackChanAdapterFromConfig,
  type StackChanAdapter,
  type StackChanHeadPose
} from "../../src/modules/stackchan/index.js";
import {
  type AttentionDetection,
  type AttentionDetectionModel,
  createPintoAttentionDetectionModel
} from "../../src/modules/vision/attention-detection.js";
import {
  createStackChanAttentionRuntime,
  type StackChanAttentionRuntime,
  type StackChanAttentionStatus
} from "../../src/runtime/stackchan-attention-runtime.js";
import {
  type AttentionMetricSample,
  type AttentionMetricsSummary,
  createAttentionMetricsAccumulator
} from "./stackchan-attention-metrics.js";
import { writePrivateJsonReport } from "./stackchan-field-report.js";
import {
  readContentionCameraStatus,
  type StackChanServoContentionCameraStatus
} from "./stackchan-servo-latency.js";

export type StackChanFaceFollowOptions = {
  readonly enableLiveRun: true;
  readonly durationMs: number;
  readonly maxFrames: number;
  readonly maxStepDeg?: number;
  readonly modelPath: string;
  readonly reportOutput: string;
};

export type StackChanAttentionCapacityCondition = "obs" | "ctrl";

export type StackChanAttentionCapacityOptions = {
  readonly enableLiveRun: true;
  readonly capacity: true;
  readonly intervals: readonly [250, 167, 125];
  readonly modelPath: string;
  readonly reportOutput: string;
};

type CapacityDistributionSummary = {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
};

type StackChanAttentionCapacityCameraStatus = {
  readonly running: boolean;
  readonly subscribers: number;
  readonly physicalRunning: boolean;
  readonly available: boolean;
};

type StackChanAttentionCapacityControlSummary = {
  readonly acceptedUpdates: number;
  readonly failedUpdates: number;
  readonly updatesPerSecond: number;
  readonly updateAcknowledgmentMs: DistributionSummary;
  readonly headTargetLane: {
    readonly accepted: number;
    readonly replaced: number;
    readonly dispatched: number;
    readonly applyReplies: number;
    readonly failed: number;
    readonly staleDiscarded: number;
    readonly noOpDiscarded: number;
    readonly maximumActiveCalls: number;
    readonly maximumPendingDepth: number;
    readonly postStopDispatches: number;
    readonly pendingAgeMs: StackChanHeadTargetStatus["pendingAgeMs"];
    readonly deviceDispatchLatencyMs: StackChanHeadTargetStatus["deviceDispatchLatencyMs"];
  };
  readonly observationsWhileMoveInFlight: number;
  readonly staleFramesDiscarded: number;
  readonly staleFrameDispatches: number;
  readonly maximumPendingMoveDepth: 0 | 1;
  readonly pendingMoveReplacements: number;
  readonly pendingMoveDispatches: number;
  readonly maximumConcurrentObservationTicks: number;
  readonly maximumConcurrentMoves: number;
  readonly observationOverlapAttempts: number;
  readonly moveOverlapAttempts: number;
  readonly preStopInFlightObservations: number;
  readonly preStopInFlightMoves: number;
  readonly postDrainInFlightObservations: number;
  readonly postDrainInFlightMoves: number;
  readonly stopAfterCommands: number;
};

type StackChanAttentionCapacityBlock = {
  readonly condition: StackChanAttentionCapacityCondition;
  readonly intervalMs: 250 | 167 | 125;
  readonly conditionBlock?: 1 | 2;
  readonly measuredDurationMs: number;
  readonly processedObservations: number;
  readonly observationRateHz: number;
  readonly theoreticalRateAchievement: number;
  readonly tickWallMs: CapacityDistributionSummary;
  readonly interObservationGapMs: CapacityDistributionSummary;
  readonly latestFrameLatencyMs: CapacityDistributionSummary;
  readonly frameAgeMs: CapacityDistributionSummary;
  readonly inferenceMs: CapacityDistributionSummary;
  readonly duplicateSequenceCount: number;
  readonly cameraInterruptions: number;
  readonly headCommands: number;
  readonly outOfBoundsCommands: number;
  readonly servoLimitCommands: number;
  readonly camera: StackChanAttentionCapacityCameraStatus;
  readonly sustainable?: boolean;
  readonly control?: StackChanAttentionCapacityControlSummary;
  readonly home?: {
    readonly returnedHome: boolean;
  };
};

type StackChanAttentionCapacityIntervalSummary = {
  readonly intervalMs: 250 | 167 | 125;
  readonly obs: {
    readonly blockCount: number;
    readonly processedObservations: number;
    readonly observationRateHz: number;
    readonly theoreticalRateAchievement: number;
    readonly worstGapP95Ms: number;
    readonly sustainable: boolean;
  };
  readonly ctrl: {
    readonly blockCount: number;
    readonly processedObservations: number;
    readonly observationRateHz: number;
    readonly versusObsRate: number;
    readonly acceptedUpdates: number;
    readonly updatesPerSecond: number;
    readonly worstUpdateAcknowledgmentP95Ms: number;
    readonly sustainable: boolean;
  };
};

export type StackChanAttentionCapacityReport = {
  readonly status: "passed" | "failed";
  readonly provider: "stackchan-cores3+pinto441-dist";
  readonly details: {
    readonly experiment: "active-load-cadence-capacity";
    readonly warmupMs: 2_000;
    readonly measuredMs: 8_000;
    readonly intervals: readonly [250, 167, 125];
    readonly blockOrder: readonly StackChanAttentionCapacityCondition[];
    readonly blocks: readonly StackChanAttentionCapacityBlock[];
    readonly capacityByInterval: readonly StackChanAttentionCapacityIntervalSummary[];
    readonly supportedBoundary:
      | "fixed-250ms-candidate"
      | "capacity-between-125ms-and-167ms"
      | "move-single-flight"
      | "host-observation"
      | "setup-drift"
      | "unresolved";
    readonly humanAcceptancePending: true;
  };
};

type DistributionSummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
};

type RequestedDeltaBins = {
  zero: number;
  one: number;
  two: number;
  three: number;
  four: number;
  fivePlus: number;
};

type StackChanFaceFollowControlSummary = {
  readonly maxStepDeg: number;
  readonly commandRequests: number;
  readonly successfulUpdates: number;
  readonly failedUpdates: number;
  readonly requestedDeltaBins: RequestedDeltaBins;
  readonly updateAcknowledgmentMs: DistributionSummary;
  readonly headTargetLane: {
    readonly accepted: number;
    readonly replaced: number;
    readonly dispatched: number;
    readonly applyReplies: number;
    readonly failed: number;
    readonly staleDiscarded: number;
    readonly noOpDiscarded: number;
    readonly maximumActiveCalls: number;
    readonly maximumPendingDepth: number;
    readonly postStopDispatches: number;
    readonly pendingDispatchLatencyMs: StackChanHeadTargetStatus["pendingAgeMs"];
    readonly deviceDispatchLatencyMs: StackChanHeadTargetStatus["deviceDispatchLatencyMs"];
    readonly successfulReplyLatencyMs: StackChanHeadTargetStatus["successfulReplyLatencyMs"];
    readonly firmwareMcpStageUs: StackChanHeadTargetStatus["firmwareMcpStageUs"];
  };
  readonly captureToCommandMs: DistributionSummary;
  readonly observationTickWallMs: DistributionSummary;
  readonly interObservationGapMs: {
    readonly allTicks: DistributionSummary;
    readonly moveTicks: DistributionSummary;
    readonly noMoveTicks: DistributionSummary;
  };
  readonly flow: {
    readonly observationsWhileMoveInFlight: number;
    readonly lastAcceptedFrameSequence?: number;
    readonly staleFramesDiscarded: number;
    readonly staleFrameDispatches: number;
    readonly pendingMoveDepth: 0 | 1;
    readonly maximumPendingMoveDepth: 0 | 1;
    readonly pendingMoveReplacements: number;
    readonly pendingMoveDispatches: number;
    readonly maximumConcurrentObservationTicks: number;
    readonly maximumConcurrentMoves: number;
    readonly observationOverlapAttempts: number;
    readonly moveOverlapAttempts: number;
    readonly preStopInFlightObservations: number;
    readonly preStopInFlightMoves: number;
    readonly postDrainInFlightObservations: number;
    readonly postDrainInFlightMoves: number;
  };
};

type StackChanFaceFollowAggregateDetails = {
  readonly sourceId: string;
  readonly durationMs: number;
  readonly maxFrames: number;
  readonly framesProcessed: number;
  readonly movesIssued: number;
  readonly errors: number;
  readonly stream: {
    readonly requestedFps: number;
    readonly observedDurationMs: number;
    readonly receivedFps: number;
    readonly frameAgeP50Ms: number;
    readonly frameAgeP95Ms: number;
    readonly frameAgeP99Ms: number;
    readonly sequenceGaps: number;
    readonly maxJpegBytes: number;
  };
  readonly inference: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  };
  readonly attention: {
    readonly targetFrames: number;
    readonly centeredFrames: number;
    readonly centeredRatio: number;
  };
  readonly diagnostics: StackChanFaceFollowDiagnostics;
  readonly control: StackChanFaceFollowControlSummary;
  readonly moveRateHz: number;
};

export type StackChanFaceFollowReport =
  | {
      readonly status: "passed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly details: StackChanFaceFollowAggregateDetails & {
        readonly finalPose: StackChanHeadPose;
        readonly returnedHome: boolean;
      };
    }
  | {
      readonly status: "failed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly reason: string;
      readonly details?: StackChanFaceFollowAggregateDetails & {
        readonly finalPose?: StackChanHeadPose;
        readonly returnedHome: boolean;
        readonly failureChecks: readonly string[];
      };
    };

export type StackChanFaceFollowDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createModel?: (input: {
    readonly modelPath: string;
    readonly inputWidth: number;
    readonly inputHeight: number;
    readonly headConfidenceThreshold: number;
    readonly faceConfidenceThreshold: number;
  }) => Promise<AttentionDetectionModel>;
  readonly createHeadTargetLane?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanHeadTargetLane;
  readonly createRuntime?: typeof createStackChanAttentionRuntime;
  readonly runRuntime?: (
    runtime: StackChanAttentionRuntime,
    options: Pick<StackChanFaceFollowOptions, "durationMs" | "maxFrames">,
    onStatus: (status: StackChanAttentionStatus) => void,
    onRunEnded: () => void,
    monotonicNowMs: () => number
  ) => Promise<StackChanAttentionStatus>;
  readonly onFrameStatus?: (status: StackChanAttentionStatus) => void;
  readonly settleHead?: () => Promise<void>;
  readonly writeReport?: (path: string, report: StackChanFaceFollowReport) => Promise<void>;
  readonly monotonicNowMs?: () => number;
  readonly controlNowMs?: () => number;
  readonly wallNowMs?: () => number;
};

type StackChanAttentionCapacityBlockInput = {
  readonly condition: StackChanAttentionCapacityCondition;
  readonly intervalMs: 250 | 167 | 125;
  readonly adapter: StackChanAdapter;
  readonly model: AttentionDetectionModel;
  readonly follow: Extract<
    NonNullable<NonNullable<PicoConfig["camera"]["stackchan"]>["follow"]>,
    { readonly enabled: true }
  >;
  readonly createRuntime: typeof createStackChanAttentionRuntime;
  readonly createHeadTargetLane: () => StackChanHeadTargetLane;
  readonly readCameraStatus: () => Promise<StackChanAttentionCapacityCameraStatus>;
  readonly monotonicNowMs: () => number;
  readonly wallNowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
};

export type StackChanAttentionCapacityDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createModel?: StackChanFaceFollowDependencies["createModel"];
  readonly createHeadTargetLane?: StackChanFaceFollowDependencies["createHeadTargetLane"];
  readonly createRuntime?: typeof createStackChanAttentionRuntime;
  readonly runBlock?: (
    input: StackChanAttentionCapacityBlockInput
  ) => Promise<StackChanAttentionCapacityBlock>;
  readonly readCameraStatus?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => Promise<StackChanAttentionCapacityCameraStatus>;
  readonly writeReport?: (path: string, report: StackChanAttentionCapacityReport) => Promise<void>;
  readonly monotonicNowMs?: () => number;
  readonly wallNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
};

const provider = "stackchan-cores3+pinto441-dist" as const;
const failedReason = "StackChan face follow field run failed or did not return home";
const capacityIntervals = [250, 167, 125] as const;
const capacityWarmupMs = 2_000;
const capacityMeasuredMs = 8_000;
const capacityTrajectoryStepDeg = 4;
const capacityPoseFeedbackToleranceDeg = 1;
const fieldStatusPollIntervalMs = 20;
const homeSettlePollIntervalMs = 100;
const homeSettleTimeoutMs = 5_000;
const homeSettleToleranceDeg = 1;
const capacityBlockMatrix = [
  { condition: "obs", intervalMs: 250 },
  { condition: "ctrl", intervalMs: 250 },
  { condition: "obs", intervalMs: 167 },
  { condition: "ctrl", intervalMs: 167 },
  { condition: "obs", intervalMs: 125 },
  { condition: "ctrl", intervalMs: 125 },
  { condition: "ctrl", intervalMs: 125 },
  { condition: "obs", intervalMs: 125 },
  { condition: "ctrl", intervalMs: 167 },
  { condition: "obs", intervalMs: 167 },
  { condition: "ctrl", intervalMs: 250 },
  { condition: "obs", intervalMs: 250 }
] as const;

type FieldMeasurements = {
  readonly sequences: number[];
  readonly frameAgesMs: number[];
  readonly jpegBytes: number[];
  readonly inferenceMs: number[];
  readonly pendingPoses: StackChanHeadPose[];
  readonly completedPoses: StackChanHeadPose[];
  readonly control: ControlMeasurements;
  commandedPose: StackChanHeadPose | undefined;
  invalidPoseQueue: boolean;
};

type FixedDistribution = {
  readonly buckets: Uint32Array;
  count: number;
  min: number;
  max: number;
};

type PendingObservation = {
  readonly captureCompletedAtMs: number;
  readonly interObservationGapMs: number | undefined;
};

type ControlMeasurements = {
  readonly updateAcknowledgmentMs: FixedDistribution;
  readonly captureToCommandMs: FixedDistribution;
  readonly observationTickWallMs: FixedDistribution;
  readonly allObservationGapMs: FixedDistribution;
  readonly moveObservationGapMs: FixedDistribution;
  readonly noMoveObservationGapMs: FixedDistribution;
  readonly requestedDeltaBins: RequestedDeltaBins;
  pendingTickStartedAtMs: number | undefined;
  pendingCaptureCompletedAtMs: number | undefined;
  pendingObservation: PendingObservation | undefined;
  previousObservationAtMs: number | undefined;
  successfulUpdates: number;
  failedUpdates: number;
  laneStatus: StackChanHeadTargetStatus | undefined;
};

const maximumDistributionMs = 10_000;

type FieldRunSnapshot = {
  readonly status: StackChanAttentionStatus | undefined;
  readonly runEndedWallMs: number;
  readonly runEndedMonotonicMs: number;
  readonly measurements: FieldMeasurements;
};

type StackChanFaceFollowDiagnostics = Omit<
  AttentionMetricsSummary,
  | "framesProcessed"
  | "targetFrames"
  | "faceFrames"
  | "headFrames"
  | "firstTargetMs"
  | "firstCenteredMs"
> & {
  readonly firstTargetMs?: number;
  readonly firstCenteredMs?: number;
};

export function parseStackChanAttentionCapacityArguments(
  arguments_: readonly string[]
): StackChanAttentionCapacityOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }
  if (!values.has("--capacity")) {
    throw new Error("--capacity is required");
  }
  const intervalsValue = requireStringArgument(values, "--capacity-intervals");
  if (intervalsValue !== capacityIntervals.join(",")) {
    throw new Error("--capacity-intervals must be 250,167,125");
  }
  return {
    enableLiveRun: true,
    capacity: true,
    intervals: capacityIntervals,
    modelPath: requireStringArgument(values, "--model-path"),
    reportOutput: requireStringArgument(values, "--report-output")
  };
}

// eslint-disable-next-line complexity
export async function runStackChanAttentionCapacityField(
  config: PicoConfig,
  options: StackChanAttentionCapacityOptions,
  dependencies: StackChanAttentionCapacityDependencies = {}
): Promise<StackChanAttentionCapacityReport> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  const attention = config.vision.attentionDetection;
  if (stackchan === undefined || follow?.enabled !== true || attention?.enabled !== true) {
    throw new Error("enabled camera.stackchan.follow and vision.attentionDetection are required");
  }
  await validateFaceFollowPaths(options.modelPath, options.reportOutput);

  const adapter = (dependencies.createAdapter ?? createStackChanAdapterFromConfig)(stackchan);
  const model = await (dependencies.createModel ?? createPintoAttentionDetectionModel)({
    modelPath: options.modelPath,
    inputWidth: attention.inputWidth,
    inputHeight: attention.inputHeight,
    headConfidenceThreshold: attention.headConfidenceThreshold,
    faceConfidenceThreshold: attention.faceConfidenceThreshold
  });
  const createRuntime = dependencies.createRuntime ?? createStackChanAttentionRuntime;
  const runBlock = dependencies.runBlock ?? runAttentionCapacityBlock;
  const readCameraStatus =
    dependencies.readCameraStatus ??
    ((currentConfig) =>
      readContentionCameraStatus(currentConfig).then(projectCapacityCameraStatus));
  const writeReport =
    dependencies.writeReport ??
    (async (path, report) => {
      try {
        await writePrivateJsonReport(path, report);
      } catch {
        throw new Error("StackChan attention capacity report write failed");
      }
    });
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const wallNowMs = dependencies.wallNowMs ?? Date.now;
  const waitMs = dependencies.waitMs ?? wait;
  const blocks: StackChanAttentionCapacityBlock[] = [];
  const blockCounts = new Map<string, number>();
  let failed = false;

  try {
    await adapter.connect();
    const initialCamera = await readCameraStatus(stackchan);
    if (!isRunningCapacityCamera(initialCamera)) {
      failed = true;
    }
    for (const entry of capacityBlockMatrix) {
      if (failed) {
        break;
      }
      const key = `${entry.condition}:${entry.intervalMs}`;
      const conditionBlock = ((blockCounts.get(key) ?? 0) + 1) as 1 | 2;
      blockCounts.set(key, conditionBlock);
      const block = await runBlock({
        ...entry,
        adapter,
        model,
        follow,
        createRuntime,
        createHeadTargetLane: () =>
          (dependencies.createHeadTargetLane ?? createStackChanHeadTargetLaneFromConfig)(stackchan),
        readCameraStatus: () => readCameraStatus(stackchan),
        monotonicNowMs,
        wallNowMs,
        waitMs
      });
      const numberedBlock = {
        ...block,
        conditionBlock
      };
      blocks.push(numberedBlock);
      failed ||= !capacityBlockPassed(numberedBlock);
    }
  } catch {
    failed = true;
  } finally {
    await adapter.close().catch(() => {
      failed = true;
    });
  }

  const capacityByInterval = capacityIntervals.map((intervalMs) =>
    summarizeCapacityInterval(intervalMs, blocks)
  );
  const complete = blocks.length === capacityBlockMatrix.length;
  const report: StackChanAttentionCapacityReport = {
    status: !failed && complete ? "passed" : "failed",
    provider,
    details: {
      experiment: "active-load-cadence-capacity",
      warmupMs: capacityWarmupMs,
      measuredMs: capacityMeasuredMs,
      intervals: capacityIntervals,
      blockOrder: capacityBlockMatrix.map((entry) => entry.condition),
      blocks,
      capacityByInterval,
      supportedBoundary: classifyCapacityBoundary(capacityByInterval),
      humanAcceptancePending: true
    }
  };
  await writeReport(options.reportOutput, report);
  return report;
}

type CapacityMeasurements = {
  readonly tickWallMs: FixedDistribution;
  readonly interObservationGapMs: FixedDistribution;
  readonly latestFrameLatencyMs: FixedDistribution;
  readonly frameAgeMs: FixedDistribution;
  readonly inferenceMs: FixedDistribution;
  readonly updateAcknowledgmentMs: FixedDistribution;
  measuring: boolean;
  stopping: boolean;
  measuredStartedAtMs: number;
  measuredEndedAtMs: number;
  pendingTickStartedAtMs: number | undefined;
  previousObservationAtMs: number | undefined;
  previousSequence: number | undefined;
  processedObservations: number;
  duplicateSequenceCount: number;
  headCommands: number;
  acceptedUpdates: number;
  failedUpdates: number;
  outOfBoundsCommands: number;
  servoLimitCommands: number;
  followCommandsAfterStop: number;
  readonly homePose: StackChanHeadPose;
  latestCommandedPose: StackChanHeadPose;
  laneStatus: StackChanHeadTargetStatus | undefined;
};

export function createCapacitySyntheticTarget(homePose: StackChanHeadPose): {
  readonly next: (pose: StackChanHeadPose) => readonly AttentionDetection[];
} {
  const yawTargets = [
    homePose.yaw + capacityTrajectoryStepDeg,
    homePose.yaw,
    homePose.yaw - capacityTrajectoryStepDeg,
    homePose.yaw
  ] as const;
  let targetIndex = 0;

  return {
    next: (pose) => {
      for (let attempts = 0; attempts < yawTargets.length; attempts += 1) {
        const currentTarget = yawTargets[targetIndex] ?? homePose.yaw;
        if (Math.abs(pose.yaw - currentTarget) > capacityPoseFeedbackToleranceDeg) {
          break;
        }
        targetIndex = (targetIndex + 1) % yawTargets.length;
      }
      const targetYaw = yawTargets[targetIndex] ?? homePose.yaw;
      const direction = Math.sign(targetYaw - pose.yaw);
      const centerX = 0.5 + direction * 0.25;
      return [
        {
          label: "face",
          confidence: 1,
          boundingBox: {
            xMin: centerX - 0.1,
            yMin: 0.4,
            xMax: centerX + 0.1,
            yMax: 0.6
          }
        }
      ];
    }
  };
}

async function runAttentionCapacityBlock(
  input: StackChanAttentionCapacityBlockInput
): Promise<StackChanAttentionCapacityBlock> {
  return input.condition === "obs"
    ? runAttentionCapacityObservationBlock(input)
    : runAttentionCapacityControlBlock(input);
}

async function runAttentionCapacityObservationBlock(
  input: StackChanAttentionCapacityBlockInput
): Promise<StackChanAttentionCapacityBlock> {
  const measurements = createCapacityMeasurements(input.follow);
  const adapter = instrumentCapacityAdapter(input.adapter, measurements, input);
  const model = instrumentCapacityModel(input.model, measurements, input);
  const cameraBefore = await input.readCameraStatus();

  await runCapacityObservationLoop(
    adapter,
    model,
    input.intervalMs,
    capacityWarmupMs,
    input.monotonicNowMs,
    input.waitMs
  );
  beginCapacityMeasurement(measurements, input.monotonicNowMs());
  await runCapacityObservationLoop(
    adapter,
    model,
    input.intervalMs,
    capacityMeasuredMs,
    input.monotonicNowMs,
    input.waitMs
  );
  endCapacityMeasurement(measurements, input.monotonicNowMs());

  const cameraAfter = await input.readCameraStatus();
  return capacityBlockFromMeasurements(
    input,
    measurements,
    cameraAfter,
    capacityCameraInterruptionCount(cameraBefore, cameraAfter)
  );
}

async function runAttentionCapacityControlBlock(
  input: StackChanAttentionCapacityBlockInput
): Promise<StackChanAttentionCapacityBlock> {
  const measurements = createCapacityMeasurements(input.follow);
  const adapter = instrumentCapacityAdapter(input.adapter, measurements, input);
  const lane = instrumentCapacityHeadTargetLane(
    input.createHeadTargetLane(),
    measurements,
    input.monotonicNowMs,
    input.follow.maxStepDeg
  );
  const target = createCapacitySyntheticTarget({
    yaw: input.follow.homeYaw,
    pitch: input.follow.homePitch
  });
  const model = instrumentCapacityModel(input.model, measurements, input, () =>
    target.next(measurements.latestCommandedPose)
  );
  const runtime = input.createRuntime({
    adapter: capacityRuntimeAdapter(adapter),
    headTargetLane: lane.client,
    model,
    config: {
      ...input.follow,
      frameIntervalMs: input.intervalMs
    }
  });
  const cameraBefore = await input.readCameraStatus();
  let warmupStatus: StackChanAttentionStatus | undefined;
  let preStopStatus: StackChanAttentionStatus | undefined;
  let postDrainStatus: StackChanAttentionStatus | undefined;
  let warmupLaneStatus: StackChanHeadTargetStatus | undefined;
  let preStopLaneStatus: StackChanHeadTargetStatus | undefined;

  await runtime.start();
  try {
    await input.waitMs(capacityWarmupMs);
    warmupLaneStatus = await lane.pollStatus();
    warmupStatus = runtime.status();
    beginCapacityMeasurement(measurements, input.monotonicNowMs());
    await input.waitMs(capacityMeasuredMs);
    preStopLaneStatus = await lane.pollStatus();
    preStopStatus = runtime.status();
    endCapacityMeasurement(measurements, input.monotonicNowMs());
    measurements.stopping = true;
  } finally {
    await runtime.stop();
    measurements.stopping = false;
    postDrainStatus = runtime.status();
  }

  const home = await verifyCapacityHome(input);
  const cameraAfter = await input.readCameraStatus();
  const block = capacityBlockFromMeasurements(
    input,
    measurements,
    cameraAfter,
    capacityCameraInterruptionCount(cameraBefore, cameraAfter)
  );
  return {
    ...block,
    control: summarizeCapacityControl(
      measurements,
      warmupStatus,
      preStopStatus,
      postDrainStatus,
      warmupLaneStatus,
      preStopLaneStatus
    ),
    home
  };
}

function createCapacityMeasurements(
  follow: StackChanAttentionCapacityBlockInput["follow"]
): CapacityMeasurements {
  return {
    tickWallMs: createFixedDistribution(),
    interObservationGapMs: createFixedDistribution(),
    latestFrameLatencyMs: createFixedDistribution(),
    frameAgeMs: createFixedDistribution(),
    inferenceMs: createFixedDistribution(),
    updateAcknowledgmentMs: createFixedDistribution(),
    measuring: false,
    stopping: false,
    measuredStartedAtMs: 0,
    measuredEndedAtMs: 0,
    pendingTickStartedAtMs: undefined,
    previousObservationAtMs: undefined,
    previousSequence: undefined,
    processedObservations: 0,
    duplicateSequenceCount: 0,
    headCommands: 0,
    acceptedUpdates: 0,
    failedUpdates: 0,
    outOfBoundsCommands: 0,
    servoLimitCommands: 0,
    followCommandsAfterStop: 0,
    homePose: {
      yaw: follow.homeYaw,
      pitch: follow.homePitch
    },
    latestCommandedPose: {
      yaw: follow.homeYaw,
      pitch: follow.homePitch
    },
    laneStatus: undefined
  };
}

function beginCapacityMeasurement(measurements: CapacityMeasurements, nowMs: number): void {
  resetCapacityMeasurements(measurements);
  measurements.measuredStartedAtMs = nowMs;
  measurements.measuredEndedAtMs = nowMs;
  measurements.measuring = true;
}

function endCapacityMeasurement(measurements: CapacityMeasurements, nowMs: number): void {
  measurements.measuring = false;
  measurements.measuredEndedAtMs = nowMs;
  measurements.pendingTickStartedAtMs = undefined;
}

function resetCapacityMeasurements(measurements: CapacityMeasurements): void {
  resetDistribution(measurements.tickWallMs);
  resetDistribution(measurements.interObservationGapMs);
  resetDistribution(measurements.latestFrameLatencyMs);
  resetDistribution(measurements.frameAgeMs);
  resetDistribution(measurements.inferenceMs);
  resetDistribution(measurements.updateAcknowledgmentMs);
  measurements.pendingTickStartedAtMs = undefined;
  measurements.previousObservationAtMs = undefined;
  measurements.previousSequence = undefined;
  measurements.processedObservations = 0;
  measurements.duplicateSequenceCount = 0;
  measurements.headCommands = 0;
  measurements.acceptedUpdates = 0;
  measurements.failedUpdates = 0;
  measurements.outOfBoundsCommands = 0;
  measurements.servoLimitCommands = 0;
  measurements.followCommandsAfterStop = 0;
}

function resetDistribution(distribution: FixedDistribution): void {
  distribution.buckets.fill(0);
  distribution.count = 0;
  distribution.min = Number.POSITIVE_INFINITY;
  distribution.max = 0;
}

function instrumentCapacityAdapter(
  adapter: StackChanAdapter,
  measurements: CapacityMeasurements,
  input: Pick<StackChanAttentionCapacityBlockInput, "monotonicNowMs" | "wallNowMs">
): StackChanAdapter {
  return {
    connect: () => Promise.resolve(),
    captureJpeg: async () => {
      const startedAtMs = input.monotonicNowMs();
      if (measurements.measuring) {
        measurements.pendingTickStartedAtMs = startedAtMs;
      }
      const frame = await adapter.captureJpeg();
      if (measurements.measuring) {
        recordDistribution(measurements.latestFrameLatencyMs, input.monotonicNowMs() - startedAtMs);
        if (frame.receivedAtMs !== undefined) {
          recordDistribution(measurements.frameAgeMs, input.wallNowMs() - frame.receivedAtMs);
        }
        if (
          frame.sequence !== undefined &&
          measurements.previousSequence !== undefined &&
          frame.sequence <= measurements.previousSequence
        ) {
          measurements.duplicateSequenceCount++;
        }
        measurements.previousSequence = frame.sequence;
      }
      return frame;
    },
    getHeadAngles: adapter.getHeadAngles,
    moveHead: async (pose, motion) => {
      await adapter.moveHead(pose, motion);
      measurements.latestCommandedPose = { ...pose };
    },
    close: () => Promise.resolve()
  };
}

function instrumentCapacityHeadTargetLane(
  lane: StackChanHeadTargetLane,
  measurements: CapacityMeasurements,
  monotonicNowMs: () => number,
  maxStepDeg: number
): {
  readonly client: StackChanHeadTargetLane;
  readonly pollStatus: () => Promise<StackChanHeadTargetStatus>;
} {
  let leaseId: string | undefined;
  const adoptStatus = (status: StackChanHeadTargetStatus): StackChanHeadTargetStatus => {
    measurements.laneStatus = status;
    if (status.confirmedPose !== undefined) {
      measurements.latestCommandedPose = { ...status.confirmedPose };
    }
    return status;
  };
  const client: StackChanHeadTargetLane = {
    connect: lane.connect,
    start: async (config) => {
      const lease = await lane.start(config);
      leaseId = lease.leaseId;
      measurements.latestCommandedPose = { ...lease.confirmedPose };
      adoptStatus(lease.status);
      return lease;
    },
    update: async (target) => {
      if (measurements.stopping) {
        measurements.followCommandsAfterStop++;
      }
      const measured = measurements.measuring;
      if (measured) {
        measurements.headCommands++;
        measurements.outOfBoundsCommands += Number(
          Math.abs(target.pose.yaw - measurements.latestCommandedPose.yaw) >
            maxStepDeg + capacityPoseFeedbackToleranceDeg ||
            Math.abs(target.pose.pitch - measurements.latestCommandedPose.pitch) >
              maxStepDeg + capacityPoseFeedbackToleranceDeg
        );
        measurements.servoLimitCommands += Number(isCapacityServoLimit(target.pose));
      }
      const startedAtMs = monotonicNowMs();
      try {
        const acknowledgment = await lane.update(target);
        if (measured) {
          measurements.acceptedUpdates++;
          recordDistribution(measurements.updateAcknowledgmentMs, monotonicNowMs() - startedAtMs);
        }
        measurements.laneStatus = mergeAcknowledgmentStatus(
          measurements.laneStatus,
          acknowledgment
        );
        return acknowledgment;
      } catch (error) {
        if (measured) {
          measurements.failedUpdates++;
          recordDistribution(measurements.updateAcknowledgmentMs, monotonicNowMs() - startedAtMs);
        }
        throw error;
      }
    },
    clear: async (currentLeaseId) => adoptStatus(await lane.clear(currentLeaseId)),
    status: async (currentLeaseId) => adoptStatus(await lane.status(currentLeaseId)),
    stop: async (currentLeaseId) => {
      const status = adoptStatus(await lane.stop(currentLeaseId));
      leaseId = undefined;
      return status;
    },
    close: lane.close
  };
  return {
    client,
    pollStatus: () => {
      if (leaseId === undefined) {
        return Promise.reject(new Error("StackChan capacity lane lease is unavailable"));
      }
      return client.status(leaseId);
    }
  };
}

function instrumentCapacityModel(
  model: AttentionDetectionModel,
  measurements: CapacityMeasurements,
  input: Pick<StackChanAttentionCapacityBlockInput, "monotonicNowMs">,
  syntheticDetections?: () => readonly AttentionDetection[]
): AttentionDetectionModel {
  return {
    detect: async (frame) => {
      const startedAtMs = input.monotonicNowMs();
      const detections = await model.detect(frame);
      const completedAtMs = input.monotonicNowMs();
      if (measurements.measuring) {
        recordDistribution(measurements.inferenceMs, completedAtMs - startedAtMs);
        const tickStartedAtMs = measurements.pendingTickStartedAtMs;
        measurements.pendingTickStartedAtMs = undefined;
        if (tickStartedAtMs !== undefined) {
          recordDistribution(measurements.tickWallMs, completedAtMs - tickStartedAtMs);
        }
        if (measurements.previousObservationAtMs !== undefined) {
          recordDistribution(
            measurements.interObservationGapMs,
            completedAtMs - measurements.previousObservationAtMs
          );
        }
        measurements.previousObservationAtMs = completedAtMs;
        measurements.processedObservations++;
      }
      return syntheticDetections?.() ?? detections;
    }
  };
}

async function runCapacityObservationLoop(
  adapter: StackChanAdapter,
  model: AttentionDetectionModel,
  intervalMs: number,
  durationMs: number,
  monotonicNowMs: () => number,
  waitMs: (durationMs: number) => Promise<void>
): Promise<void> {
  const startedAtMs = monotonicNowMs();
  const deadlineMs = startedAtMs + durationMs;
  let nextTickAtMs = startedAtMs;
  while (monotonicNowMs() < deadlineMs) {
    const frame = await adapter.captureJpeg();
    await model.detect(frame.bytes);
    nextTickAtMs += intervalMs;
    const remainingMs = deadlineMs - monotonicNowMs();
    if (remainingMs <= 0) {
      break;
    }
    await waitMs(Math.max(1, Math.min(remainingMs, nextTickAtMs - monotonicNowMs())));
  }
}

function capacityRuntimeAdapter(adapter: StackChanAdapter): StackChanAdapter {
  return {
    connect: () => Promise.resolve(),
    captureJpeg: adapter.captureJpeg,
    getHeadAngles: adapter.getHeadAngles,
    moveHead: adapter.moveHead,
    close: () => Promise.resolve()
  };
}

function capacityBlockFromMeasurements(
  input: StackChanAttentionCapacityBlockInput,
  measurements: CapacityMeasurements,
  camera: StackChanAttentionCapacityCameraStatus,
  cameraInterruptions: number
): StackChanAttentionCapacityBlock {
  const measuredDurationMs = Math.max(
    1,
    measurements.measuredEndedAtMs - measurements.measuredStartedAtMs
  );
  const observationRateHz = roundRate(measurements.processedObservations, measuredDurationMs);
  return {
    condition: input.condition,
    intervalMs: input.intervalMs,
    measuredDurationMs: roundHundredths(measuredDurationMs),
    processedObservations: measurements.processedObservations,
    observationRateHz,
    theoreticalRateAchievement: roundRatio(observationRateHz, 1_000 / input.intervalMs),
    tickWallMs: summarizeCapacityDistribution(measurements.tickWallMs),
    interObservationGapMs: summarizeCapacityDistribution(measurements.interObservationGapMs),
    latestFrameLatencyMs: summarizeCapacityDistribution(measurements.latestFrameLatencyMs),
    frameAgeMs: summarizeCapacityDistribution(measurements.frameAgeMs),
    inferenceMs: summarizeCapacityDistribution(measurements.inferenceMs),
    duplicateSequenceCount: measurements.duplicateSequenceCount,
    cameraInterruptions,
    headCommands: measurements.headCommands,
    outOfBoundsCommands: measurements.outOfBoundsCommands,
    servoLimitCommands: measurements.servoLimitCommands,
    camera: { ...camera }
  };
}

function summarizeCapacityControl(
  measurements: CapacityMeasurements,
  warmupStatus: StackChanAttentionStatus,
  preStopStatus: StackChanAttentionStatus,
  postDrainStatus: StackChanAttentionStatus,
  warmupLaneStatus: StackChanHeadTargetStatus,
  preStopLaneStatus: StackChanHeadTargetStatus
): StackChanAttentionCapacityControlSummary {
  const measuredDurationMs = Math.max(
    1,
    measurements.measuredEndedAtMs - measurements.measuredStartedAtMs
  );
  const postDrainLaneStatus = measurements.laneStatus ?? preStopLaneStatus;
  return {
    acceptedUpdates: measurements.acceptedUpdates,
    failedUpdates: measurements.failedUpdates,
    updatesPerSecond: roundRate(measurements.acceptedUpdates, measuredDurationMs),
    updateAcknowledgmentMs: summarizeDistribution(measurements.updateAcknowledgmentMs),
    headTargetLane: {
      accepted: capacityCounterDelta(warmupLaneStatus.accepted, preStopLaneStatus.accepted),
      replaced: capacityCounterDelta(warmupLaneStatus.replaced, preStopLaneStatus.replaced),
      dispatched: capacityCounterDelta(warmupLaneStatus.dispatched, preStopLaneStatus.dispatched),
      applyReplies: capacityCounterDelta(
        warmupLaneStatus.confirmedApplyReplies,
        preStopLaneStatus.confirmedApplyReplies
      ),
      failed: capacityCounterDelta(warmupLaneStatus.failed, preStopLaneStatus.failed),
      staleDiscarded: capacityCounterDelta(
        warmupLaneStatus.staleDiscarded,
        preStopLaneStatus.staleDiscarded
      ),
      noOpDiscarded: capacityCounterDelta(
        warmupLaneStatus.noOpDiscarded,
        preStopLaneStatus.noOpDiscarded
      ),
      maximumActiveCalls: postDrainLaneStatus.maximumActiveCalls,
      maximumPendingDepth: postDrainLaneStatus.maximumPendingDepth,
      postStopDispatches: postDrainLaneStatus.postStopDispatches,
      pendingAgeMs: preStopLaneStatus.pendingAgeMs,
      deviceDispatchLatencyMs: preStopLaneStatus.deviceDispatchLatencyMs
    },
    observationsWhileMoveInFlight: capacityCounterDelta(
      warmupStatus.flow.observationsWhileMoveInFlight,
      preStopStatus.flow.observationsWhileMoveInFlight
    ),
    staleFramesDiscarded: capacityCounterDelta(
      warmupStatus.flow.staleFramesDiscarded,
      preStopStatus.flow.staleFramesDiscarded
    ),
    staleFrameDispatches: capacityCounterDelta(
      warmupStatus.flow.staleFrameDispatches,
      preStopStatus.flow.staleFrameDispatches
    ),
    maximumPendingMoveDepth: preStopStatus.flow.maximumPendingMoveDepth,
    pendingMoveReplacements: capacityCounterDelta(
      warmupStatus.flow.pendingMoveReplacements,
      preStopStatus.flow.pendingMoveReplacements
    ),
    pendingMoveDispatches: capacityCounterDelta(
      warmupStatus.flow.pendingMoveDispatches,
      preStopStatus.flow.pendingMoveDispatches
    ),
    maximumConcurrentObservationTicks: preStopStatus.flow.maximumConcurrentObservationTicks,
    maximumConcurrentMoves: preStopStatus.flow.maximumConcurrentMoves,
    observationOverlapAttempts: capacityCounterDelta(
      warmupStatus.flow.observationOverlapAttempts,
      preStopStatus.flow.observationOverlapAttempts
    ),
    moveOverlapAttempts: capacityCounterDelta(
      warmupStatus.flow.moveOverlapAttempts,
      preStopStatus.flow.moveOverlapAttempts
    ),
    preStopInFlightObservations: preStopStatus.flow.activeObservationTicks,
    preStopInFlightMoves: preStopStatus.flow.activeMoves,
    postDrainInFlightObservations: postDrainStatus.flow.activeObservationTicks,
    postDrainInFlightMoves: postDrainStatus.flow.activeMoves,
    stopAfterCommands: measurements.followCommandsAfterStop
  };
}

async function verifyCapacityHome(
  input: StackChanAttentionCapacityBlockInput
): Promise<{ readonly returnedHome: boolean }> {
  const homePose = {
    yaw: input.follow.homeYaw,
    pitch: input.follow.homePitch
  };
  await input.waitMs(1_000);
  let pose = await input.adapter.getHeadAngles().catch(() => undefined);
  if (!capacityPoseIsHome(pose, homePose)) {
    await input.adapter.moveHead(
      {
        yaw: homePose.yaw,
        pitch: Math.min(85, homePose.pitch + 4)
      },
      { speedDps: input.follow.moveSpeedDps }
    );
    await input.waitMs(250);
    await input.adapter.moveHead(homePose, {
      speedDps: input.follow.moveSpeedDps
    });
    await input.waitMs(1_000);
    pose = await input.adapter.getHeadAngles().catch(() => undefined);
  }
  return {
    returnedHome: capacityPoseIsHome(pose, homePose)
  };
}

function capacityPoseIsHome(
  pose: StackChanHeadPose | undefined,
  homePose: StackChanHeadPose
): boolean {
  return (
    pose !== undefined &&
    Math.abs(pose.yaw - homePose.yaw) <= 1 &&
    Math.abs(pose.pitch - homePose.pitch) <= 1
  );
}

function capacityCameraInterruptionCount(
  before: StackChanAttentionCapacityCameraStatus,
  after: StackChanAttentionCapacityCameraStatus
): number {
  return Number(!isRunningCapacityCamera(before)) + Number(!isActiveCapacityCamera(after));
}

function isActiveCapacityCamera(status: StackChanAttentionCapacityCameraStatus): boolean {
  return isRunningCapacityCamera(status) && status.available;
}

function isRunningCapacityCamera(status: StackChanAttentionCapacityCameraStatus): boolean {
  return status.running && status.subscribers >= 1 && status.physicalRunning;
}

function projectCapacityCameraStatus(
  status: StackChanServoContentionCameraStatus
): StackChanAttentionCapacityCameraStatus {
  return {
    running: status.running,
    subscribers: status.subscribers,
    physicalRunning: status.physicalRunning,
    available: status.available
  };
}

function isCapacityServoLimit(pose: StackChanHeadPose): boolean {
  return (
    Math.abs(Math.abs(pose.yaw) - 90) <= 1 ||
    Math.abs(pose.pitch - 5) <= 1 ||
    Math.abs(pose.pitch - 85) <= 1
  );
}

function capacityCounterDelta(before: number, after: number): number {
  return Math.max(0, after - before);
}

function summarizeCapacityDistribution(
  distribution: FixedDistribution
): CapacityDistributionSummary {
  return {
    count: distribution.count,
    p50Ms: distributionPercentile(distribution, 0.5),
    p95Ms: distributionPercentile(distribution, 0.95),
    p99Ms: distributionPercentile(distribution, 0.99),
    maxMs: distribution.count === 0 ? 0 : roundHundredths(distribution.max)
  };
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1_000) / 1_000;
}

// eslint-disable-next-line complexity
function capacityBlockPassed(block: StackChanAttentionCapacityBlock): boolean {
  if (
    block.measuredDurationMs < capacityMeasuredMs * 0.9 ||
    block.processedObservations < 1 ||
    block.cameraInterruptions !== 0 ||
    !isActiveCapacityCamera(block.camera) ||
    block.outOfBoundsCommands !== 0 ||
    block.servoLimitCommands !== 0
  ) {
    return false;
  }
  if (block.condition === "obs") {
    return block.headCommands === 0 && block.control === undefined && block.home === undefined;
  }
  const control = block.control;
  return (
    block.headCommands > 0 &&
    control !== undefined &&
    block.home?.returnedHome === true &&
    control.failedUpdates === 0 &&
    control.headTargetLane.failed === 0 &&
    control.headTargetLane.staleDiscarded === 0 &&
    control.headTargetLane.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    control.headTargetLane.maximumPendingDepth <= 1 &&
    control.headTargetLane.postStopDispatches === 0 &&
    control.maximumConcurrentObservationTicks <= 1 &&
    control.maximumConcurrentMoves <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    control.moveOverlapAttempts === 0 &&
    control.postDrainInFlightObservations === 0 &&
    control.postDrainInFlightMoves === 0 &&
    control.stopAfterCommands === 0
  );
}

function summarizeCapacityInterval(
  intervalMs: 250 | 167 | 125,
  blocks: readonly StackChanAttentionCapacityBlock[]
): StackChanAttentionCapacityIntervalSummary {
  const obsBlocks = blocks.filter(
    (block) => block.intervalMs === intervalMs && block.condition === "obs"
  );
  const ctrlBlocks = blocks.filter(
    (block) => block.intervalMs === intervalMs && block.condition === "ctrl"
  );
  const obsDurationMs = sumCapacityBlockDuration(obsBlocks);
  const ctrlDurationMs = sumCapacityBlockDuration(ctrlBlocks);
  const obsProcessed = sumCapacityObservations(obsBlocks);
  const ctrlProcessed = sumCapacityObservations(ctrlBlocks);
  const obsRate = roundRate(obsProcessed, Math.max(1, obsDurationMs));
  const ctrlRate = roundRate(ctrlProcessed, Math.max(1, ctrlDurationMs));
  const acceptedUpdates = ctrlBlocks.reduce(
    (total, block) => total + (block.control?.acceptedUpdates ?? 0),
    0
  );
  return {
    intervalMs,
    obs: {
      blockCount: obsBlocks.length,
      processedObservations: obsProcessed,
      observationRateHz: obsRate,
      theoreticalRateAchievement: roundRatio(obsRate, 1_000 / intervalMs),
      worstGapP95Ms: maximumCapacityMetric(obsBlocks, "interObservationGapMs", "p95Ms"),
      sustainable:
        obsBlocks.length === 2 && obsBlocks.every((block) => capacityObservationSustainable(block))
    },
    ctrl: {
      blockCount: ctrlBlocks.length,
      processedObservations: ctrlProcessed,
      observationRateHz: ctrlRate,
      versusObsRate: roundRatio(ctrlRate, obsRate),
      acceptedUpdates,
      updatesPerSecond: roundRate(acceptedUpdates, Math.max(1, ctrlDurationMs)),
      worstUpdateAcknowledgmentP95Ms: Math.max(
        0,
        ...ctrlBlocks.map((block) => block.control?.updateAcknowledgmentMs.p95 ?? 0)
      ),
      sustainable:
        ctrlBlocks.length === 2 &&
        ctrlBlocks.every((block) => capacityControlSustainable(block, obsRate))
    }
  };
}

function capacityObservationSustainable(block: StackChanAttentionCapacityBlock): boolean {
  return (
    block.theoreticalRateAchievement >= 0.8 &&
    capacityObservationCadenceSustainable(block) &&
    block.tickWallMs.p95Ms < block.intervalMs &&
    capacityFrameFreshnessSustainable(block) &&
    block.cameraInterruptions === 0
  );
}

function capacityObservationCadenceSustainable(block: StackChanAttentionCapacityBlock): boolean {
  return (
    block.interObservationGapMs.p95Ms <= block.intervalMs * 1.5 &&
    (block.intervalMs !== 125 || block.interObservationGapMs.p99Ms <= 200)
  );
}

function capacityFrameFreshnessSustainable(block: StackChanAttentionCapacityBlock): boolean {
  return block.intervalMs === 125
    ? block.frameAgeMs.p95Ms <= 140 && block.frameAgeMs.p99Ms <= 180
    : block.frameAgeMs.p95Ms <= 150;
}

// eslint-disable-next-line complexity
function capacityControlSustainable(
  block: StackChanAttentionCapacityBlock,
  combinedObsRate: number
): boolean {
  const control = block.control;
  return (
    control !== undefined &&
    roundRatio(block.observationRateHz, combinedObsRate) >= 0.85 &&
    control.failedUpdates === 0 &&
    control.updateAcknowledgmentMs.p99 <= 50 &&
    control.headTargetLane.pendingAgeMs.p99 <= 180 &&
    control.headTargetLane.failed === 0 &&
    control.headTargetLane.staleDiscarded === 0 &&
    control.headTargetLane.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    control.headTargetLane.maximumPendingDepth <= 1 &&
    control.headTargetLane.postStopDispatches === 0 &&
    roundRatio(
      roundRate(control.headTargetLane.dispatched, block.measuredDurationMs),
      block.observationRateHz
    ) >= 0.95 &&
    control.staleFrameDispatches === 0 &&
    control.maximumPendingMoveDepth <= 1 &&
    control.moveOverlapAttempts === 0 &&
    block.servoLimitCommands === 0 &&
    control.maximumConcurrentObservationTicks <= 1 &&
    control.maximumConcurrentMoves <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    control.postDrainInFlightObservations === 0 &&
    control.postDrainInFlightMoves === 0
  );
}

function sumCapacityBlockDuration(blocks: readonly StackChanAttentionCapacityBlock[]): number {
  return blocks.reduce((total, block) => total + block.measuredDurationMs, 0);
}

function sumCapacityObservations(blocks: readonly StackChanAttentionCapacityBlock[]): number {
  return blocks.reduce((total, block) => total + block.processedObservations, 0);
}

function maximumCapacityMetric(
  blocks: readonly StackChanAttentionCapacityBlock[],
  distribution: "interObservationGapMs",
  metric: "p95Ms"
): number {
  return Math.max(0, ...blocks.map((block) => block[distribution][metric]));
}

// eslint-disable-next-line complexity
function classifyCapacityBoundary(
  summaries: readonly StackChanAttentionCapacityIntervalSummary[]
): StackChanAttentionCapacityReport["details"]["supportedBoundary"] {
  const byInterval = new Map(summaries.map((summary) => [summary.intervalMs, summary]));
  const baseline = byInterval.get(250);
  if (
    baseline === undefined ||
    baseline.obs.blockCount !== 2 ||
    baseline.obs.observationRateHz < 3.59 * 0.8 ||
    baseline.obs.observationRateHz > 3.91 * 1.2
  ) {
    return "setup-drift";
  }
  const at167 = byInterval.get(167);
  const at125 = byInterval.get(125);
  if (at167?.obs.sustainable === true && at167.ctrl.sustainable) {
    return at125?.obs.sustainable === true && at125.ctrl.sustainable
      ? "fixed-250ms-candidate"
      : "capacity-between-125ms-and-167ms";
  }
  if (at167?.obs.sustainable === true && !at167.ctrl.sustainable) {
    return "move-single-flight";
  }
  if (at167 !== undefined && !at167.obs.sustainable) {
    return "host-observation";
  }
  return "unresolved";
}

export function parseStackChanFaceFollowArguments(
  arguments_: readonly string[]
): StackChanFaceFollowOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }

  const maxStepDeg = optionalBoundedPositiveInteger(values, "--max-step-deg", 15);
  return {
    enableLiveRun: true,
    durationMs: requireBoundedPositiveInteger(values, "--duration-ms", 120_000),
    maxFrames: requireBoundedPositiveInteger(values, "--max-frames", 10_000),
    ...(maxStepDeg === undefined ? {} : { maxStepDeg }),
    modelPath: requireStringArgument(values, "--model-path"),
    reportOutput: requireStringArgument(values, "--report-output")
  };
}

// eslint-disable-next-line complexity
export async function runStackChanFaceFollowField(
  config: PicoConfig,
  options: StackChanFaceFollowOptions,
  dependencies: StackChanFaceFollowDependencies = {}
): Promise<StackChanFaceFollowReport> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  const attention = config.vision.attentionDetection;
  if (stackchan === undefined || follow?.enabled !== true || attention?.enabled !== true) {
    throw new Error("enabled camera.stackchan.follow and vision.attentionDetection are required");
  }
  await validateFaceFollowPaths(options.modelPath, options.reportOutput);

  const adapter = (dependencies.createAdapter ?? createStackChanAdapterFromConfig)(stackchan);
  const headTargetLane = (
    dependencies.createHeadTargetLane ?? createStackChanHeadTargetLaneFromConfig
  )(stackchan);
  const model = await (dependencies.createModel ?? createPintoAttentionDetectionModel)({
    modelPath: options.modelPath,
    inputWidth: attention.inputWidth,
    inputHeight: attention.inputHeight,
    headConfidenceThreshold: attention.headConfidenceThreshold,
    faceConfidenceThreshold: attention.faceConfidenceThreshold
  });
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const controlNowMs = dependencies.controlNowMs ?? (() => performance.now());
  const wallNowMs = dependencies.wallNowMs ?? (() => Date.now());
  const measurements: FieldMeasurements = {
    sequences: [],
    frameAgesMs: [],
    jpegBytes: [],
    inferenceMs: [],
    pendingPoses: [],
    completedPoses: [],
    control: createControlMeasurements(),
    commandedPose: undefined,
    invalidPoseQueue: false
  };
  const instrumentedAdapter = instrumentStackChanAdapter(
    adapter,
    measurements,
    controlNowMs,
    wallNowMs,
    options.maxFrames
  );
  const instrumentedModel = instrumentAttentionModel(
    model,
    measurements,
    controlNowMs,
    monotonicNowMs,
    options.maxFrames
  );
  const instrumentedHeadTargetLane = instrumentStackChanHeadTargetLane(
    headTargetLane,
    measurements,
    controlNowMs
  );
  const runtimeReference: { current: StackChanAttentionRuntime | undefined } = {
    current: undefined
  };
  const createRuntime = dependencies.createRuntime ?? createStackChanAttentionRuntime;
  const runtime = createRuntime({
    adapter: adapterWithoutClose(instrumentedAdapter),
    headTargetLane: instrumentedHeadTargetLane,
    model: instrumentedModel,
    scheduler: createFrameBoundedScheduler(options.maxFrames, () =>
      runtimeReference.current?.status()
    ),
    config: {
      ...follow,
      ...(options.maxStepDeg === undefined ? {} : { maxStepDeg: options.maxStepDeg })
    }
  });
  runtimeReference.current = runtime;
  const runRuntime = dependencies.runRuntime ?? runBoundedRuntime;
  const settleHead =
    dependencies.settleHead ??
    (() =>
      waitForHeadToSettle(adapter, {
        yaw: follow.homeYaw,
        pitch: follow.homePitch
      }).then(() => undefined));
  const writeReport = dependencies.writeReport ?? writeJsonReport;
  let status: StackChanAttentionStatus | undefined;
  let finalPose: StackChanHeadPose | undefined;
  let failure: unknown;
  const runStartedMs = monotonicNowMs();
  const metricsRunStartedAtMs = wallNowMs();
  const metrics = createAttentionMetricsAccumulator({
    runStartedAtMs: metricsRunStartedAtMs,
    deadZone: follow.deadZone
  });
  const recordedFrames = new Set<number>();
  const strictPoseAssociation =
    dependencies.createRuntime === undefined && dependencies.runRuntime === undefined;
  let latestStatus: StackChanAttentionStatus | undefined;
  let runSnapshot: FieldRunSnapshot | undefined;
  const validation = { diagnosticsInvalid: false };
  let greatestRecordedFrame = 0;
  const recordStatus = (
    currentStatus: StackChanAttentionStatus,
    lostObservedAtMs?: number
  ): void => {
    latestStatus = currentStatus;
    validation.diagnosticsInvalid ||= currentStatus.framesProcessed > options.maxFrames;
    if (runSnapshot !== undefined) {
      return;
    }
    if (!isNewProcessedFrame(currentStatus.framesProcessed, recordedFrames)) {
      return;
    }
    if (currentStatus.framesProcessed !== greatestRecordedFrame + 1) {
      validation.diagnosticsInvalid = true;
    }
    greatestRecordedFrame = Math.max(greatestRecordedFrame, currentStatus.framesProcessed);
    recordedFrames.add(currentStatus.framesProcessed);
    const completedPose = measurements.completedPoses[currentStatus.framesProcessed - 1];
    if (isMissingStrictPoseAssociation(strictPoseAssociation, completedPose)) {
      validation.diagnosticsInvalid = true;
    }
    metrics.record(
      metricSampleFromStatus(
        currentStatus,
        completedPose ?? {
          yaw: follow.homeYaw,
          pitch: follow.homePitch
        },
        () => lostObservedAtMs ?? wallNowMs()
      )
    );
    dependencies.onFrameStatus?.(currentStatus);
  };
  let diagnostics: StackChanFaceFollowDiagnostics | undefined;
  const recordRunEnded = (): void => {
    runSnapshot ??= createRunSnapshot(latestStatus, measurements, wallNowMs(), monotonicNowMs());
  };

  try {
    status = await runRuntime(runtime, options, recordStatus, recordRunEnded, monotonicNowMs);
    if (runSnapshot === undefined) {
      const runEndedWallMs = wallNowMs();
      const runEndedMonotonicMs = monotonicNowMs();
      recordStatus(status, runEndedWallMs);
      runSnapshot = createRunSnapshot(status, measurements, runEndedWallMs, runEndedMonotonicMs);
    }
    diagnostics = diagnosticsFromSummary(metrics.summarize(runSnapshot.runEndedWallMs));
    await settleHead();
    finalPose = await adapter.getHeadAngles();
  } catch (error) {
    recordRunEnded();
    failure = error;
    await runtime.stop().catch(() => undefined);
  } finally {
    await adapter.close().catch((error: unknown) => {
      failure ??= error;
    });
  }

  const returnedHome =
    finalPose !== undefined &&
    Math.abs(finalPose.yaw - follow.homeYaw) <= 1 &&
    Math.abs(finalPose.pitch - follow.homePitch) <= 1;
  const reportStatus = runSnapshot?.status ?? status;
  const reportMeasurements = runSnapshot?.measurements ?? measurements;
  const observedDurationMs = Math.max(
    1,
    (runSnapshot?.runEndedMonotonicMs ?? runStartedMs) - runStartedMs
  );
  const failureChecks = collectFaceFollowFailureChecks({
    failure,
    status,
    reportStatus,
    maxFrames: options.maxFrames,
    diagnosticsInvalid: validation.diagnosticsInvalid,
    measurements: reportMeasurements,
    finalPose,
    returnedHome
  });
  const aggregateDetails: StackChanFaceFollowAggregateDetails | undefined =
    status === undefined ||
    reportStatus === undefined ||
    !hasSerializableCounters(status) ||
    !hasSerializableCounters(reportStatus)
      ? undefined
      : {
          sourceId: stackchan.sourceId ?? "stackchan-core-s3",
          durationMs: options.durationMs,
          maxFrames: options.maxFrames,
          framesProcessed: reportStatus.framesProcessed,
          movesIssued: reportStatus.moveCount,
          errors: status.errors?.length ?? 0,
          stream: summarizeStreamMeasurements(
            reportMeasurements,
            stackchan.streamFps,
            observedDurationMs,
            reportStatus.framesProcessed
          ),
          inference: {
            p50Ms: percentile(reportMeasurements.inferenceMs, 0.5),
            p95Ms: percentile(reportMeasurements.inferenceMs, 0.95),
            p99Ms: percentile(reportMeasurements.inferenceMs, 0.99)
          },
          attention: {
            targetFrames: reportStatus.attention.targetFrames,
            centeredFrames: reportStatus.attention.centeredFrames,
            centeredRatio: centeredRatio(
              reportStatus.attention.centeredFrames,
              reportStatus.attention.targetFrames
            )
          },
          diagnostics:
            diagnostics ?? diagnosticsFromSummary(metrics.summarize(metricsRunStartedAtMs)),
          control: summarizeControlMeasurements(
            reportMeasurements.control,
            options.maxStepDeg ?? follow.maxStepDeg,
            reportStatus,
            status
          ),
          moveRateHz: roundRate(reportStatus.moveCount, observedDurationMs)
        };
  const report: StackChanFaceFollowReport =
    failureChecks.length === 0 && aggregateDetails !== undefined && finalPose !== undefined
      ? {
          status: "passed",
          provider,
          details: {
            ...aggregateDetails,
            finalPose,
            returnedHome
          }
        }
      : {
          status: "failed",
          provider,
          reason: failedReason,
          ...(aggregateDetails === undefined
            ? {}
            : {
                details: {
                  ...aggregateDetails,
                  ...(finalPose === undefined ? {} : { finalPose }),
                  returnedHome,
                  failureChecks
                }
              })
        };
  await writeReport(options.reportOutput, report);
  return report;
}

function isMissingStrictPoseAssociation(
  strictPoseAssociation: boolean,
  completedPose: StackChanHeadPose | undefined
): boolean {
  return strictPoseAssociation && completedPose === undefined;
}

function collectFaceFollowFailureChecks(input: {
  readonly failure: unknown;
  readonly status: StackChanAttentionStatus | undefined;
  readonly reportStatus: StackChanAttentionStatus | undefined;
  readonly maxFrames: number;
  readonly diagnosticsInvalid: boolean;
  readonly measurements: FieldMeasurements;
  readonly finalPose: StackChanHeadPose | undefined;
  readonly returnedHome: boolean;
}): readonly string[] {
  return [
    ...namedFailures([[input.failure !== undefined, "runtime_failure"]]),
    ...reportStatusFailureChecks(input.reportStatus, input.maxFrames),
    ...postDrainFailureChecks(input.status, input.maxFrames, input.measurements.control),
    ...measurementFailureChecks(input),
    ...namedFailures([
      [input.finalPose === undefined, "final_pose_missing"],
      [!input.returnedHome, "home_not_reached"]
    ])
  ];
}

function reportStatusFailureChecks(
  status: StackChanAttentionStatus | undefined,
  maxFrames: number
): readonly string[] {
  if (status === undefined) return ["report_status_missing"];
  return namedFailures([
    [!hasValidPassedCounters(status), "report_counters_invalid"],
    [status.framesProcessed > maxFrames, "report_frame_limit"],
    [status.lastError !== undefined, "report_runtime_error"],
    [status.flow.maximumConcurrentObservationTicks > 1, "observation_concurrency"],
    [
      status.flow.maximumConcurrentMoves > STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
      "move_concurrency"
    ],
    [status.flow.moveOverlapAttempts !== 0, "move_overlap"],
    [status.flow.staleFrameDispatches !== 0, "stale_frame_dispatch"],
    [status.flow.maximumPendingMoveDepth > 1, "pending_move_depth"]
  ]);
}

function postDrainFailureChecks(
  status: StackChanAttentionStatus | undefined,
  maxFrames: number,
  control: ControlMeasurements
): readonly string[] {
  if (status === undefined) return ["post_drain_status_missing"];
  return namedFailures([
    [!hasValidPassedCounters(status), "post_drain_counters_invalid"],
    [status.framesProcessed > maxFrames, "post_drain_frame_limit"],
    [status.lastError !== undefined, "post_drain_runtime_error"],
    [status.flow.activeObservationTicks !== 0, "active_observation_tick"],
    [status.flow.activeMoves !== 0, "active_move"],
    [!faceFollowLanePassed(control, status), "head_target_lane_gate"]
  ]);
}

function measurementFailureChecks(input: {
  readonly diagnosticsInvalid: boolean;
  readonly measurements: FieldMeasurements;
}): readonly string[] {
  return namedFailures([
    [input.diagnosticsInvalid, "diagnostics_invalid"],
    [input.measurements.invalidPoseQueue, "pose_queue_invalid"],
    [
      distributionPercentile(input.measurements.control.allObservationGapMs, 0.95) > 150,
      "observation_gap_p95"
    ],
    [
      distributionPercentile(input.measurements.control.allObservationGapMs, 0.99) > 200,
      "observation_gap_p99"
    ],
    [percentile(input.measurements.frameAgesMs, 0.95) > 140, "frame_age_p95"],
    [percentile(input.measurements.frameAgesMs, 0.99) > 180, "frame_age_p99"]
  ]);
}

function namedFailures(entries: ReadonlyArray<readonly [boolean, string]>): readonly string[] {
  return entries.filter(([failed]) => failed).map(([, code]) => code);
}

function isNewProcessedFrame(frame: number, recordedFrames: ReadonlySet<number>): boolean {
  return frame >= 1 && !recordedFrames.has(frame);
}

function hasValidPassedCounters(status: StackChanAttentionStatus): boolean {
  return hasSerializableCounters(status) && status.framesProcessed > 0;
}

function hasSerializableCounters(status: StackChanAttentionStatus): boolean {
  const counters = [
    status.framesProcessed,
    status.attention.targetFrames,
    status.attention.centeredFrames,
    status.moveCount,
    ...Object.values(status.flow)
  ];
  return (
    counters.every((counter) => Number.isSafeInteger(counter) && counter >= 0) &&
    status.attention.centeredFrames <= status.attention.targetFrames &&
    status.attention.targetFrames <= status.framesProcessed &&
    status.moveCount <= status.framesProcessed &&
    hasValidFlowCounters(status)
  );
}

function hasValidFlowCounters(status: StackChanAttentionStatus): boolean {
  return (
    status.flow.observationTicksCompleted <= status.flow.observationTicksStarted &&
    status.flow.activeObservationTicks <= 1 &&
    status.flow.activeMoves <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    status.flow.pendingMoveDepth <= 1 &&
    status.flow.maximumPendingMoveDepth <= 1 &&
    status.flow.maximumConcurrentObservationTicks <= 1 &&
    status.flow.maximumConcurrentMoves <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS
  );
}

function faceFollowLanePassed(
  measurements: ControlMeasurements,
  postDrainStatus: StackChanAttentionStatus
): boolean {
  const acknowledgment = summarizeDistribution(measurements.updateAcknowledgmentMs);
  const lane = postDrainStatus.headTargetLane ?? projectMeasuredLaneStatus(measurements);
  return faceAcknowledgmentPassed(acknowledgment) && faceLaneStatusPassed(lane);
}

function faceAcknowledgmentPassed(acknowledgment: DistributionSummary): boolean {
  return acknowledgment.count === 0 || (acknowledgment.p95 <= 25 && acknowledgment.p99 <= 50);
}

function faceLaneStatusPassed(
  lane: NonNullable<StackChanAttentionStatus["headTargetLane"]>
): boolean {
  return [
    lane.failed === 0,
    lane.staleDiscarded === 0,
    lane.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
    lane.maximumPendingDepth <= 1,
    lane.postStopDispatches === 0,
    lane.pendingAgeMs.p99 <= 180
  ].every(Boolean);
}

function metricSampleFromStatus(
  status: StackChanAttentionStatus,
  pose: StackChanHeadPose,
  lostObservedAtMs: () => number
): AttentionMetricSample {
  const lastTarget = status.attention.targetVisible ? status.attention.lastTarget : undefined;
  return {
    sequence: status.framesProcessed,
    observedAtMs: lastTarget?.observedAtMs ?? lostObservedAtMs(),
    pose,
    ...(lastTarget === undefined
      ? {}
      : {
          target: {
            label: lastTarget.label,
            horizontalError: lastTarget.horizontalError,
            verticalError: lastTarget.verticalError,
            centered: lastTarget.centered
          }
        })
  };
}

function instrumentStackChanAdapter(
  adapter: StackChanAdapter,
  measurements: FieldMeasurements,
  controlNowMs: () => number,
  wallNowMs: () => number,
  maximumFrames: number
): StackChanAdapter {
  return {
    ...adapter,
    getHeadAngles: async () => {
      const pose = await adapter.getHeadAngles();
      measurements.commandedPose = { ...pose };
      return pose;
    },
    moveHead: async (pose, motion) => {
      await adapter.moveHead(pose, motion);
      measurements.commandedPose = { ...pose };
    },
    captureJpeg: async () => {
      finalizePendingObservationAsNoMove(measurements.control);
      measurements.control.pendingTickStartedAtMs = controlNowMs();
      const capturePose =
        measurements.commandedPose === undefined ? undefined : { ...measurements.commandedPose };
      let frame: Awaited<ReturnType<StackChanAdapter["captureJpeg"]>>;
      try {
        frame = await adapter.captureJpeg();
      } catch (error) {
        measurements.control.pendingTickStartedAtMs = undefined;
        throw error;
      }
      measurements.control.pendingCaptureCompletedAtMs = controlNowMs();
      if (capturePose === undefined) {
        measurements.invalidPoseQueue = true;
      } else {
        pushBoundedPose(measurements.pendingPoses, capturePose, maximumFrames, measurements);
      }
      measurements.jpegBytes.push(frame.bytes.byteLength);
      if (frame.sequence !== undefined) {
        measurements.sequences.push(frame.sequence);
      }
      if (frame.receivedAtMs !== undefined) {
        measurements.frameAgesMs.push(Math.max(0, wallNowMs() - frame.receivedAtMs));
      }
      return frame;
    }
  };
}

function instrumentStackChanHeadTargetLane(
  lane: StackChanHeadTargetLane,
  measurements: FieldMeasurements,
  controlNowMs: () => number
): StackChanHeadTargetLane {
  const adoptStatus = (status: StackChanHeadTargetStatus): StackChanHeadTargetStatus => {
    measurements.control.laneStatus = status;
    return status;
  };
  return {
    connect: lane.connect,
    start: async (config) => {
      const lease = await lane.start(config);
      measurements.commandedPose = { ...lease.confirmedPose };
      adoptStatus(lease.status);
      return lease;
    },
    update: async (target) => {
      const observation = measurements.control.pendingObservation;
      const startedAtMs = controlNowMs();
      if (observation !== undefined) {
        measurements.control.pendingObservation = undefined;
        recordOptionalDistribution(
          measurements.control.moveObservationGapMs,
          observation.interObservationGapMs
        );
        recordDistribution(
          measurements.control.captureToCommandMs,
          startedAtMs - observation.captureCompletedAtMs
        );
        recordRequestedDelta(
          measurements.control.requestedDeltaBins,
          measurements.commandedPose,
          target.pose
        );
      }
      try {
        const acknowledgment = await lane.update(target);
        if (observation !== undefined) {
          measurements.control.successfulUpdates++;
          recordDistribution(
            measurements.control.updateAcknowledgmentMs,
            controlNowMs() - startedAtMs
          );
        }
        measurements.commandedPose = { ...target.pose };
        measurements.control.laneStatus = mergeAcknowledgmentStatus(
          measurements.control.laneStatus,
          acknowledgment
        );
        return acknowledgment;
      } catch (error) {
        if (observation !== undefined) {
          measurements.control.failedUpdates++;
          recordDistribution(
            measurements.control.updateAcknowledgmentMs,
            controlNowMs() - startedAtMs
          );
        }
        throw error;
      }
    },
    clear: async (leaseId) => adoptStatus(await lane.clear(leaseId)),
    status: async (leaseId) => adoptStatus(await lane.status(leaseId)),
    stop: async (leaseId) => adoptStatus(await lane.stop(leaseId)),
    close: lane.close
  };
}

function mergeAcknowledgmentStatus(
  status: StackChanHeadTargetStatus | undefined,
  acknowledgment: Awaited<ReturnType<StackChanHeadTargetLane["update"]>>
): StackChanHeadTargetStatus {
  const base = status ?? emptyMeasuredLaneStatus();
  return {
    ...base,
    phase: "running",
    accepted: acknowledgment.acceptedCount,
    replaced: acknowledgment.replacedCount,
    pendingDepth: acknowledgment.pendingDepth,
    maximumPendingDepth: Math.max(base.maximumPendingDepth, acknowledgment.pendingDepth)
  };
}

function emptyMeasuredLaneStatus(): StackChanHeadTargetStatus {
  const distribution = {
    count: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0
  };
  return {
    phase: "running",
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmed: 0,
    confirmedApplyReplies: 0,
    failed: 0,
    staleDiscarded: 0,
    noOpDiscarded: 0,
    activeCalls: 0,
    pendingDepth: 0,
    maximumActiveCalls: 0,
    maximumPendingDepth: 0,
    postStopDispatches: 0,
    updateAcknowledgmentMs: distribution,
    pendingAgeMs: distribution,
    deviceDispatchLatencyMs: distribution,
    successfulReplyLatencyMs: distribution,
    firmwareMcpStageUs: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    }
  };
}

function projectMeasuredLaneStatus(
  measurements: ControlMeasurements
): NonNullable<StackChanAttentionStatus["headTargetLane"]> {
  const status = measurements.laneStatus ?? emptyMeasuredLaneStatus();
  return {
    phase: status.phase,
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    confirmedApplyReplies: status.confirmedApplyReplies,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    noOpDiscarded: status.noOpDiscarded,
    activeCalls: status.activeCalls,
    pendingDepth: status.pendingDepth,
    maximumActiveCalls: status.maximumActiveCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    postStopDispatches: status.postStopDispatches,
    updateAcknowledgmentMs: status.updateAcknowledgmentMs,
    pendingAgeMs: status.pendingAgeMs,
    deviceDispatchLatencyMs: status.deviceDispatchLatencyMs
  };
}

function instrumentAttentionModel(
  model: AttentionDetectionModel,
  measurements: FieldMeasurements,
  controlNowMs: () => number,
  monotonicNowMs: () => number,
  maximumFrames: number
): AttentionDetectionModel {
  return {
    detect: async (frame) => {
      const startedAt = monotonicNowMs();
      try {
        const detections = await model.detect(frame);
        recordCompletedObservation(measurements.control, controlNowMs());
        const pose = measurements.pendingPoses.shift();
        if (pose === undefined) {
          measurements.invalidPoseQueue = true;
        } else {
          pushBoundedPose(measurements.completedPoses, pose, maximumFrames, measurements);
        }
        return detections;
      } catch (error) {
        measurements.control.pendingTickStartedAtMs = undefined;
        measurements.control.pendingCaptureCompletedAtMs = undefined;
        measurements.pendingPoses.shift();
        throw error;
      } finally {
        measurements.inferenceMs.push(Math.max(0, monotonicNowMs() - startedAt));
      }
    }
  };
}

function pushBoundedPose(
  poses: StackChanHeadPose[],
  pose: StackChanHeadPose,
  maximumFrames: number,
  measurements: FieldMeasurements
): void {
  if (poses.length >= maximumFrames) {
    measurements.invalidPoseQueue = true;
    return;
  }
  poses.push({ ...pose });
}

function createRunSnapshot(
  status: StackChanAttentionStatus | undefined,
  measurements: FieldMeasurements,
  runEndedWallMs: number,
  runEndedMonotonicMs: number
): FieldRunSnapshot {
  const frameCount = status?.framesProcessed ?? 0;
  return {
    status,
    runEndedWallMs,
    runEndedMonotonicMs,
    measurements: {
      sequences: measurements.sequences.slice(0, frameCount),
      frameAgesMs: measurements.frameAgesMs.slice(0, frameCount),
      jpegBytes: measurements.jpegBytes.slice(0, frameCount),
      inferenceMs: measurements.inferenceMs.slice(0, frameCount),
      pendingPoses: [],
      completedPoses: measurements.completedPoses.slice(0, frameCount),
      control: snapshotControlMeasurements(measurements.control),
      commandedPose:
        measurements.commandedPose === undefined ? undefined : { ...measurements.commandedPose },
      invalidPoseQueue: measurements.invalidPoseQueue
    }
  };
}

function createControlMeasurements(): ControlMeasurements {
  return {
    updateAcknowledgmentMs: createFixedDistribution(),
    captureToCommandMs: createFixedDistribution(),
    observationTickWallMs: createFixedDistribution(),
    allObservationGapMs: createFixedDistribution(),
    moveObservationGapMs: createFixedDistribution(),
    noMoveObservationGapMs: createFixedDistribution(),
    requestedDeltaBins: {
      zero: 0,
      one: 0,
      two: 0,
      three: 0,
      four: 0,
      fivePlus: 0
    },
    pendingTickStartedAtMs: undefined,
    pendingCaptureCompletedAtMs: undefined,
    pendingObservation: undefined,
    previousObservationAtMs: undefined,
    successfulUpdates: 0,
    failedUpdates: 0,
    laneStatus: undefined
  };
}

function createFixedDistribution(): FixedDistribution {
  return {
    buckets: new Uint32Array(maximumDistributionMs + 2),
    count: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0
  };
}

function recordDistribution(distribution: FixedDistribution, rawValue: number): void {
  const value = Math.max(0, rawValue);
  const bucket = Math.min(maximumDistributionMs + 1, Math.round(value));
  distribution.buckets[bucket] = (distribution.buckets[bucket] ?? 0) + 1;
  distribution.count++;
  distribution.min = Math.min(distribution.min, value);
  distribution.max = Math.max(distribution.max, value);
}

function recordOptionalDistribution(
  distribution: FixedDistribution,
  value: number | undefined
): void {
  if (value !== undefined) {
    recordDistribution(distribution, value);
  }
}

function recordCompletedObservation(control: ControlMeasurements, observedAtMs: number): void {
  const tickStartedAtMs = control.pendingTickStartedAtMs;
  control.pendingTickStartedAtMs = undefined;
  if (tickStartedAtMs !== undefined) {
    recordDistribution(control.observationTickWallMs, observedAtMs - tickStartedAtMs);
  }
  const captureCompletedAtMs = control.pendingCaptureCompletedAtMs;
  control.pendingCaptureCompletedAtMs = undefined;
  if (captureCompletedAtMs === undefined) {
    return;
  }
  const interObservationGapMs =
    control.previousObservationAtMs === undefined
      ? undefined
      : Math.max(0, observedAtMs - control.previousObservationAtMs);
  control.previousObservationAtMs = observedAtMs;
  recordOptionalDistribution(control.allObservationGapMs, interObservationGapMs);
  control.pendingObservation = {
    captureCompletedAtMs,
    interObservationGapMs
  };
}

function finalizePendingObservationAsNoMove(control: ControlMeasurements): void {
  const observation = control.pendingObservation;
  if (observation === undefined) {
    return;
  }
  recordOptionalDistribution(control.noMoveObservationGapMs, observation.interObservationGapMs);
  control.pendingObservation = undefined;
}

function recordRequestedDelta(
  bins: RequestedDeltaBins,
  currentPose: StackChanHeadPose | undefined,
  nextPose: StackChanHeadPose
): void {
  if (currentPose === undefined) {
    return;
  }
  const delta = Math.max(
    Math.abs(nextPose.yaw - currentPose.yaw),
    Math.abs(nextPose.pitch - currentPose.pitch)
  );
  if (delta <= 0) {
    bins.zero++;
  } else if (delta <= 1) {
    bins.one++;
  } else if (delta <= 2) {
    bins.two++;
  } else if (delta <= 3) {
    bins.three++;
  } else if (delta <= 4) {
    bins.four++;
  } else {
    bins.fivePlus++;
  }
}

function snapshotControlMeasurements(source: ControlMeasurements): ControlMeasurements {
  const snapshot: ControlMeasurements = {
    updateAcknowledgmentMs: cloneDistribution(source.updateAcknowledgmentMs),
    captureToCommandMs: cloneDistribution(source.captureToCommandMs),
    observationTickWallMs: cloneDistribution(source.observationTickWallMs),
    allObservationGapMs: cloneDistribution(source.allObservationGapMs),
    moveObservationGapMs: cloneDistribution(source.moveObservationGapMs),
    noMoveObservationGapMs: cloneDistribution(source.noMoveObservationGapMs),
    requestedDeltaBins: { ...source.requestedDeltaBins },
    pendingTickStartedAtMs: source.pendingTickStartedAtMs,
    pendingCaptureCompletedAtMs: source.pendingCaptureCompletedAtMs,
    pendingObservation:
      source.pendingObservation === undefined ? undefined : { ...source.pendingObservation },
    previousObservationAtMs: source.previousObservationAtMs,
    successfulUpdates: source.successfulUpdates,
    failedUpdates: source.failedUpdates,
    laneStatus: source.laneStatus === undefined ? undefined : { ...source.laneStatus }
  };
  finalizePendingObservationAsNoMove(snapshot);
  return snapshot;
}

function cloneDistribution(source: FixedDistribution): FixedDistribution {
  return {
    buckets: source.buckets.slice(),
    count: source.count,
    min: source.min,
    max: source.max
  };
}

function summarizeControlMeasurements(
  source: ControlMeasurements,
  maxStepDeg: number,
  preStopStatus: StackChanAttentionStatus,
  postDrainStatus: StackChanAttentionStatus
): StackChanFaceFollowControlSummary {
  const measurements = snapshotControlMeasurements(source);
  const commandRequests = countRequestedDeltas(measurements.requestedDeltaBins);
  const lane = postDrainStatus.headTargetLane ?? projectMeasuredLaneStatus(measurements);
  const detailedLane = measurements.laneStatus ?? emptyMeasuredLaneStatus();
  return {
    maxStepDeg,
    commandRequests,
    successfulUpdates: measurements.successfulUpdates,
    failedUpdates: measurements.failedUpdates,
    requestedDeltaBins: { ...measurements.requestedDeltaBins },
    updateAcknowledgmentMs: summarizeDistribution(measurements.updateAcknowledgmentMs),
    headTargetLane: {
      accepted: lane.accepted,
      replaced: lane.replaced,
      dispatched: lane.dispatched,
      applyReplies: lane.confirmedApplyReplies,
      failed: lane.failed,
      staleDiscarded: lane.staleDiscarded,
      noOpDiscarded: lane.noOpDiscarded,
      maximumActiveCalls: lane.maximumActiveCalls,
      maximumPendingDepth: lane.maximumPendingDepth,
      postStopDispatches: lane.postStopDispatches,
      pendingDispatchLatencyMs: detailedLane.pendingAgeMs,
      deviceDispatchLatencyMs: detailedLane.deviceDispatchLatencyMs,
      successfulReplyLatencyMs: detailedLane.successfulReplyLatencyMs,
      firmwareMcpStageUs: detailedLane.firmwareMcpStageUs
    },
    captureToCommandMs: summarizeDistribution(measurements.captureToCommandMs),
    observationTickWallMs: summarizeDistribution(measurements.observationTickWallMs),
    interObservationGapMs: {
      allTicks: summarizeDistribution(measurements.allObservationGapMs),
      moveTicks: summarizeDistribution(measurements.moveObservationGapMs),
      noMoveTicks: summarizeDistribution(measurements.noMoveObservationGapMs)
    },
    flow: {
      observationsWhileMoveInFlight: preStopStatus.flow.observationsWhileMoveInFlight,
      ...(preStopStatus.flow.lastAcceptedFrameSequence === undefined
        ? {}
        : { lastAcceptedFrameSequence: preStopStatus.flow.lastAcceptedFrameSequence }),
      staleFramesDiscarded: preStopStatus.flow.staleFramesDiscarded,
      staleFrameDispatches: preStopStatus.flow.staleFrameDispatches,
      pendingMoveDepth: preStopStatus.flow.pendingMoveDepth,
      maximumPendingMoveDepth: preStopStatus.flow.maximumPendingMoveDepth,
      pendingMoveReplacements: preStopStatus.flow.pendingMoveReplacements,
      pendingMoveDispatches: preStopStatus.flow.pendingMoveDispatches,
      maximumConcurrentObservationTicks: preStopStatus.flow.maximumConcurrentObservationTicks,
      maximumConcurrentMoves: preStopStatus.flow.maximumConcurrentMoves,
      observationOverlapAttempts: preStopStatus.flow.observationOverlapAttempts,
      moveOverlapAttempts: preStopStatus.flow.moveOverlapAttempts,
      preStopInFlightObservations: preStopStatus.flow.activeObservationTicks,
      preStopInFlightMoves: preStopStatus.flow.activeMoves,
      postDrainInFlightObservations: postDrainStatus.flow.activeObservationTicks,
      postDrainInFlightMoves: postDrainStatus.flow.activeMoves
    }
  };
}

function countRequestedDeltas(bins: RequestedDeltaBins): number {
  return bins.zero + bins.one + bins.two + bins.three + bins.four + bins.fivePlus;
}

function summarizeDistribution(distribution: FixedDistribution): DistributionSummary {
  return {
    count: distribution.count,
    p50: distributionPercentile(distribution, 0.5),
    p95: distributionPercentile(distribution, 0.95),
    p99: distributionPercentile(distribution, 0.99),
    min: distribution.count === 0 ? 0 : roundHundredths(distribution.min),
    max: distribution.count === 0 ? 0 : roundHundredths(distribution.max)
  };
}

function distributionPercentile(distribution: FixedDistribution, quantile: number): number {
  if (distribution.count === 0) {
    return 0;
  }
  const requiredCount = Math.ceil(distribution.count * quantile);
  let accumulated = 0;
  for (let index = 0; index < distribution.buckets.length; index += 1) {
    accumulated += distribution.buckets[index] ?? 0;
    if (accumulated >= requiredCount) {
      return index > maximumDistributionMs ? roundHundredths(distribution.max) : index;
    }
  }
  return roundHundredths(distribution.max);
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeStreamMeasurements(
  measurements: FieldMeasurements,
  requestedFps: number,
  observedDurationMs: number,
  framesProcessed: number
): Extract<StackChanFaceFollowReport, { readonly status: "passed" }>["details"]["stream"] {
  return {
    requestedFps,
    observedDurationMs: Math.round(observedDurationMs),
    receivedFps: roundRate(framesProcessed, observedDurationMs),
    frameAgeP50Ms: percentile(measurements.frameAgesMs, 0.5),
    frameAgeP95Ms: percentile(measurements.frameAgesMs, 0.95),
    frameAgeP99Ms: percentile(measurements.frameAgesMs, 0.99),
    sequenceGaps: countSequenceGaps(measurements.sequences),
    maxJpegBytes: Math.max(0, ...measurements.jpegBytes)
  };
}

function countSequenceGaps(sequences: readonly number[]): number {
  let gaps = 0;
  for (let index = 1; index < sequences.length; index += 1) {
    const previous = sequences[index - 1];
    const current = sequences[index];
    if (previous !== undefined && current !== undefined) {
      gaps += Math.max(0, current - previous - 1);
    }
  }
  return gaps;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  const value = sorted[index];
  return value === undefined ? 0 : Math.round(value * 100) / 100;
}

function roundRate(count: number, durationMs: number): number {
  return Math.round(((count * 1000) / durationMs) * 100) / 100;
}

function centeredRatio(centeredFrames: number, targetFrames: number): number {
  if (targetFrames === 0) {
    return 0;
  }
  return Math.round((centeredFrames / targetFrames) * 1000) / 1000;
}

export async function runBoundedRuntime(
  runtime: StackChanAttentionRuntime,
  options: Pick<StackChanFaceFollowOptions, "durationMs" | "maxFrames">,
  onStatus: (status: StackChanAttentionStatus) => void,
  onRunEnded: () => void,
  monotonicNowMs: () => number
): Promise<StackChanAttentionStatus> {
  await runtime.start();
  const deadline = monotonicNowMs() + options.durationMs;
  try {
    while (monotonicNowMs() < deadline) {
      await wait(Math.min(fieldStatusPollIntervalMs, Math.max(1, deadline - monotonicNowMs())));
      const status = runtime.status();
      onStatus(status);
      if (status.framesProcessed >= options.maxFrames) {
        break;
      }
    }
  } finally {
    try {
      onStatus(runtime.status());
    } finally {
      onRunEnded();
      await runtime.stop();
    }
  }
  const status = runtime.status();
  onStatus(status);
  return status;
}

function createFrameBoundedScheduler(
  maximumFrames: number,
  status: () => StackChanAttentionStatus | undefined
) {
  return (task: () => Promise<void>, intervalMs: number) => {
    const timer = setInterval(() => {
      if ((status()?.framesProcessed ?? 0) >= maximumFrames) {
        return;
      }
      task().catch(() => undefined);
    }, intervalMs);

    return {
      cancel() {
        clearInterval(timer);
      }
    };
  };
}

function diagnosticsFromSummary(summary: AttentionMetricsSummary): StackChanFaceFollowDiagnostics {
  return {
    ...(summary.firstTargetMs === undefined ? {} : { firstTargetMs: summary.firstTargetMs }),
    ...(summary.firstCenteredMs === undefined ? {} : { firstCenteredMs: summary.firstCenteredMs }),
    maximumLostGapMs: summary.maximumLostGapMs,
    evaluationWindow: summary.evaluationWindow,
    horizontal: summary.horizontal,
    vertical: summary.vertical,
    servoLimitFrames: summary.servoLimitFrames
  };
}

function adapterWithoutClose(adapter: StackChanAdapter): StackChanAdapter {
  return {
    connect: adapter.connect,
    captureJpeg: adapter.captureJpeg,
    getHeadAngles: adapter.getHeadAngles,
    moveHead: adapter.moveHead,
    close: () => Promise.resolve()
  };
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

type HeadSettleOptions = {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly toleranceDeg?: number;
  readonly monotonicNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
};

type RequiredHeadSettleOptions = Required<HeadSettleOptions>;

export function waitForHeadToSettle(
  adapter: Pick<StackChanAdapter, "getHeadAngles">,
  homePose: StackChanHeadPose,
  options: HeadSettleOptions = {}
): Promise<StackChanHeadPose> {
  return pollHeadUntilSettled(adapter, homePose, requiredHeadSettleOptions(options));
}

async function pollHeadUntilSettled(
  adapter: Pick<StackChanAdapter, "getHeadAngles">,
  homePose: StackChanHeadPose,
  options: RequiredHeadSettleOptions
): Promise<StackChanHeadPose> {
  const { intervalMs, timeoutMs, toleranceDeg, monotonicNowMs, waitMs } = options;
  const deadline = monotonicNowMs() + timeoutMs;
  let pose = await adapter.getHeadAngles();

  while (!isPoseWithinTolerance(pose, homePose, toleranceDeg) && monotonicNowMs() < deadline) {
    await waitMs(Math.min(intervalMs, Math.max(1, deadline - monotonicNowMs())));
    pose = await adapter.getHeadAngles();
  }
  return pose;
}

function requiredHeadSettleOptions(options: HeadSettleOptions): RequiredHeadSettleOptions {
  return {
    intervalMs: options.intervalMs ?? homeSettlePollIntervalMs,
    timeoutMs: options.timeoutMs ?? homeSettleTimeoutMs,
    toleranceDeg: options.toleranceDeg ?? homeSettleToleranceDeg,
    monotonicNowMs: options.monotonicNowMs ?? (() => performance.now()),
    waitMs: options.waitMs ?? wait
  };
}

function isPoseWithinTolerance(
  pose: StackChanHeadPose,
  target: StackChanHeadPose,
  toleranceDeg: number
): boolean {
  return (
    Math.abs(pose.yaw - target.yaw) <= toleranceDeg &&
    Math.abs(pose.pitch - target.pitch) <= toleranceDeg
  );
}

async function writeJsonReport(path: string, report: StackChanFaceFollowReport): Promise<void> {
  try {
    await writePrivateJsonReport(path, report);
  } catch {
    throw new Error("StackChan face follow report write failed");
  }
}

async function validateFaceFollowPaths(modelPath: string, reportOutput: string): Promise<void> {
  const resolvedModelPath = resolve(modelPath);
  const resolvedReportOutput = resolve(reportOutput);
  if (resolvedModelPath === resolvedReportOutput) {
    throw new Error("face follow model and report paths must be distinct");
  }
  const reportLinkStatus = await optionalFileStatus(resolvedReportOutput, lstat);
  if (reportLinkStatus?.isSymbolicLink() === true) {
    throw new Error("face follow report output must not be a symbolic link");
  }
  const [modelStatus, reportStatus] = await Promise.all([
    optionalFileStatus(resolvedModelPath, stat),
    optionalFileStatus(resolvedReportOutput, stat)
  ]);
  if (
    modelStatus !== undefined &&
    reportStatus !== undefined &&
    modelStatus.dev === reportStatus.dev &&
    modelStatus.ino === reportStatus.ino
  ) {
    throw new Error("face follow model and report paths must be distinct");
  }
}

async function optionalFileStatus(
  path: string,
  readStatus: typeof stat
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await readStatus(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
  }
  throw new Error("face follow path validation failed");
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error("field arguments must use named --options");
    }
    if (name === "--enable-live-run" || name === "--capacity") {
      values.set(name, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  return values;
}

function requireStringArgument(values: ReadonlyMap<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireBoundedPositiveInteger(
  values: ReadonlyMap<string, string | true>,
  name: string,
  maximum: number
): number {
  const value = Number(requireStringArgument(values, name));
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer up to ${maximum}`);
  }
  return value;
}

function optionalBoundedPositiveInteger(
  values: ReadonlyMap<string, string | true>,
  name: string,
  maximum: number
): number | undefined {
  if (!values.has(name)) {
    return undefined;
  }
  return requireBoundedPositiveInteger(values, name, maximum);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const arguments_ = process.argv.slice(2);
    const config = loadPicoConfigFromEnvironment();
    const report = arguments_.includes("--capacity")
      ? await runStackChanAttentionCapacityField(
          config,
          parseStackChanAttentionCapacityArguments(arguments_)
        )
      : await runStackChanFaceFollowField(config, parseStackChanFaceFollowArguments(arguments_));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("StackChan face follow command failed\n");
    process.exitCode = 2;
  }
}
