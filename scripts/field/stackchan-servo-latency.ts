#!/usr/bin/env jiti
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  loadPicoConfigFromEnvironment,
  type PicoAttentionDetectionConfig,
  type PicoConfig
} from "../../src/config/index.js";
import {
  createStackChanHeadTargetLaneFromConfig,
  STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
  type StackChanHeadTargetLane,
  type StackChanHeadTargetStatus
} from "../../src/modules/stackchan/head-target-lane.js";
import {
  closeStackChanMcpSession,
  createStackChanAdapter,
  createStackChanAdapterFromConfig,
  type StackChanAdapter,
  type StackChanHeadPose,
  type StackChanMcpClient
} from "../../src/modules/stackchan/index.js";
import {
  type AttentionDetectionModel,
  createPintoAttentionDetectionModel
} from "../../src/modules/vision/attention-detection.js";
import { writePrivateJsonReport } from "./stackchan-field-report.js";

export type StackChanServoLatencyOptions = {
  readonly enableLiveRun: true;
  readonly samplesPerBin: number;
};

type LatencySummary = {
  readonly successCount: number;
  readonly failureCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
};

export type StackChanServoLatencyReport = {
  readonly status: "passed" | "failed";
  readonly provider: "stackchan-cores3";
  readonly details: {
    readonly samplesPerBin: number;
    readonly measurementOrderDeg: readonly [0, 1, 2, 4];
    readonly homePose: StackChanHeadPose;
    readonly moveSpeedDps: number;
    readonly bins: {
      readonly zero: LatencySummary;
      readonly one: LatencySummary;
      readonly two: LatencySummary;
      readonly four: LatencySummary;
    };
    readonly finalPose?: StackChanHeadPose;
    readonly returnedHome: boolean;
  };
};

export type StackChanServoLatencyDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly monotonicNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
};

export type StackChanServoContentionCondition = "off" | "stream" | "load";

export type StackChanServoContentionOptions = {
  readonly enableLiveRun: true;
  readonly durationMs: number;
  readonly consecutiveLoadRuns: number;
  readonly singleCondition?: "stream" | "load";
  readonly reportOutput: string;
};

type DistributionSummary = {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
};

type ContentionLatencySummary = LatencySummary & {
  readonly over250MsCount: number;
};

type NativeWriteSummary = {
  readonly attemptedWrites: number;
  readonly ackFailures: number;
  readonly overflowCount: number;
};

type StackChanStabilityDiagnostics = {
  readonly beginNativeTelemetry: () => Promise<void>;
  readonly finishNativeTelemetry: () => Promise<NativeWriteSummary>;
  readonly readGatewaySessionId: () => Promise<string>;
  readonly readAutoSleepEnabled: () => Promise<boolean>;
  readonly close: () => Promise<void>;
};

export type StackChanServoContentionCameraStatus = {
  readonly running: boolean;
  readonly subscribers: number;
  readonly physicalRunning: boolean;
  readonly available: boolean;
  readonly receivedFrames: number;
  readonly maxJpegBytes: number;
  readonly creditSendCount: number;
  readonly creditSendFailures: number;
  readonly creditSendMaxUs: number;
};

type StackChanServoContentionCameraSummary = {
  readonly active: {
    readonly running: boolean;
    readonly subscribers: number;
    readonly physicalRunning: boolean;
    readonly available: boolean;
  };
  readonly cleanup: {
    readonly running: boolean;
    readonly subscribers: number;
    readonly physicalRunning: boolean;
    readonly available: boolean;
  };
  readonly receivedFrames: number;
  readonly receivedFps: number;
  readonly streamInterruptions: number;
  readonly maxJpegBytes: number;
  readonly creditSend: {
    readonly count: number;
    readonly failures: number;
    readonly maxUs: number;
  };
  readonly observationGapMs: DistributionSummary;
  readonly deviceCaptureGapMs: DistributionSummary;
  readonly deviceEncodeMs: DistributionSummary;
  readonly missedSequenceCount: number;
};

type StackChanServoContentionLoadSummary = {
  readonly activeDurationMs: number;
  readonly processedObservations: number;
  readonly observationRateHz: number;
  readonly latestFrameLatencyMs: DistributionSummary;
  readonly frameAgeMs: DistributionSummary;
  readonly duplicateSequenceCount: number;
  readonly inferenceMs: DistributionSummary;
};

type StackChanServoContentionBlock = {
  readonly condition: StackChanServoContentionCondition;
  readonly conditionBlock: number;
  readonly successfulUpdates: number;
  readonly failedUpdates: number;
  readonly updateAcknowledgmentMs: ContentionLatencySummary;
  readonly updateStartGapMs: DistributionSummary;
  readonly camera: StackChanServoContentionCameraSummary;
  readonly headTargetLane: StackChanServoContentionLaneSummary;
  readonly load?: StackChanServoContentionLoadSummary;
  readonly gatewaySessionStable: boolean;
  readonly nativeWrites: NativeWriteSummary;
  readonly autoSleepEnabled: boolean;
  readonly minimumCommandedPitch: number;
  readonly stopAndHomeMs: number;
  readonly boundaryPassed: boolean;
  readonly home: {
    readonly finalPose?: StackChanHeadPose;
    readonly returnedHome: boolean;
  };
};

type StackChanServoContentionLaneSummary = {
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmedApplyReplies: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly maximumActiveCalls: number;
  readonly maximumPendingDepth: number;
  readonly postStopDispatches: number;
};

type StackChanServoContentionConditionSummary = {
  readonly blockCount: number;
  readonly successfulUpdates: number;
  readonly failedUpdates: number;
  readonly updateAcknowledgmentMs: ContentionLatencySummary;
  readonly updateStartGapMs: DistributionSummary;
};

export type StackChanServoContentionReport = {
  readonly status: "passed" | "failed";
  readonly provider: "stackchan-cores3+pinto441-dist";
  readonly details: {
    readonly experiment: "camera-move-contention";
    readonly durationMs: number;
    readonly warmupCommandsPerBlock: 4;
    readonly commandIntervalMs: 500;
    readonly sweepExtentDeg: 3;
    readonly observationIntervalMs: 125;
    readonly homePose: StackChanHeadPose;
    readonly moveSpeedDps: number;
    readonly blockOrder: readonly StackChanServoContentionCondition[];
    readonly blocks: readonly StackChanServoContentionBlock[];
    readonly consecutiveLoadPasses: number;
    readonly conditions: Readonly<
      Record<StackChanServoContentionCondition, StackChanServoContentionConditionSummary>
    >;
  };
};

export type StackChanServoContentionDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>,
    condition: StackChanServoContentionCondition
  ) => StackChanAdapter;
  readonly createHomeAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createHeadTargetLane?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanHeadTargetLane;
  readonly createModel?: (config: PicoAttentionDetectionConfig) => Promise<AttentionDetectionModel>;
  readonly readCameraStatus?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => Promise<StackChanServoContentionCameraStatus>;
  readonly createDiagnostics?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanStabilityDiagnostics;
  readonly monotonicNowMs?: () => number;
  readonly wallNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
  readonly writeReport?: (path: string, report: StackChanServoContentionReport) => Promise<void>;
};

type LatencyAccumulator = {
  readonly buckets: Uint32Array;
  successCount: number;
  failureCount: number;
  over250MsCount: number;
  minMs: number;
  maxMs: number;
};

const measurementOrderDeg = [0, 1, 2, 4] as const;
const contentionWarmupCommands = 4;
const contentionCommandIntervalMs = 500;
const contentionSweepExtentDeg = 3;
const contentionObservationIntervalMs = 125;
const maximumLatencyMs = 10_000;

export function parseStackChanServoLatencyArguments(
  arguments_: readonly string[]
): StackChanServoLatencyOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }
  return {
    enableLiveRun: true,
    samplesPerBin: requireBoundedPositiveInteger(values, "--samples-per-bin", 100)
  };
}

export function parseStackChanServoContentionArguments(
  arguments_: readonly string[]
): StackChanServoContentionOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }
  if (!values.has("--camera-contention")) {
    throw new Error("--camera-contention is required");
  }
  const singleCondition = readOptionalContentionCondition(values, "--single-condition");
  return {
    enableLiveRun: true,
    durationMs: requireBoundedPositiveInteger(values, "--duration-ms", 60_000),
    consecutiveLoadRuns: requireBoundedPositiveInteger(values, "--consecutive-load-runs", 5),
    ...(singleCondition === undefined ? {} : { singleCondition }),
    reportOutput: requireAbsolutePath(values, "--report-output")
  };
}

// eslint-disable-next-line complexity
export async function runStackChanServoContentionField(
  config: PicoConfig,
  options: StackChanServoContentionOptions,
  dependencies: StackChanServoContentionDependencies = {}
): Promise<StackChanServoContentionReport> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  const detection = config.vision.attentionDetection;
  if (stackchan === undefined || follow?.enabled !== true || detection?.enabled !== true) {
    throw new Error("enabled StackChan follow and attention detection are required");
  }

  const createAdapter = dependencies.createAdapter ?? createContentionAdapter;
  const createHomeAdapter = dependencies.createHomeAdapter ?? createServoOnlyAdapterFromConfig;
  const createHeadTargetLane =
    dependencies.createHeadTargetLane ?? createStackChanHeadTargetLaneFromConfig;
  const createModel = dependencies.createModel ?? createContentionModel;
  const readCameraStatus = dependencies.readCameraStatus ?? readContentionCameraStatus;
  const createDiagnostics = dependencies.createDiagnostics ?? createStabilityDiagnostics;
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const wallNowMs = dependencies.wallNowMs ?? Date.now;
  const waitMs = dependencies.waitMs ?? wait;
  const writeReport = dependencies.writeReport ?? writePrivateJsonReport;
  const blockOrder: readonly StackChanServoContentionCondition[] =
    options.singleCondition === undefined
      ? [
          "stream",
          ...Array<StackChanServoContentionCondition>(options.consecutiveLoadRuns).fill("load")
        ]
      : [options.singleCondition];
  const homePose = {
    yaw: follow.homeYaw,
    pitch: follow.homePitch
  };
  const model = await createModel(detection);
  const blocks: StackChanServoContentionBlock[] = [];
  const conditionMeasurements = createConditionMeasurements();
  const blockCounts: Record<StackChanServoContentionCondition, number> = {
    off: 0,
    stream: 0,
    load: 0
  };
  let failed = false;

  for (const condition of blockOrder) {
    blockCounts[condition]++;
    const block = await runContentionBlock({
      stackchan,
      condition,
      conditionBlock: blockCounts[condition],
      durationMs: options.durationMs,
      homePose,
      moveSpeedDps: follow.moveSpeedDps,
      model,
      createAdapter,
      createHomeAdapter,
      createHeadTargetLane,
      laneRateHz: follow.commandRateHz,
      laneMaxStepDeg: follow.maxStepDeg,
      laneMaxPendingAgeMs: follow.maxPendingCommandAgeMs,
      readCameraStatus,
      createDiagnostics,
      monotonicNowMs,
      wallNowMs,
      waitMs,
      conditionMeasurements: conditionMeasurements[condition]
    });
    blocks.push(block);
    if (!contentionBlockPassed(block)) {
      failed = true;
      break;
    }
  }

  const consecutiveLoadPasses = blocks.filter(
    (block) => block.condition === "load" && block.boundaryPassed
  ).length;
  const requiredLoadPasses = blockOrder.filter((condition) => condition === "load").length;

  const report: StackChanServoContentionReport = {
    status:
      !failed &&
      blocks.length === blockOrder.length &&
      consecutiveLoadPasses === requiredLoadPasses &&
      blocks.every((block) => contentionBlockPassed(block))
        ? "passed"
        : "failed",
    provider: "stackchan-cores3+pinto441-dist",
    details: {
      experiment: "camera-move-contention",
      durationMs: options.durationMs,
      warmupCommandsPerBlock: contentionWarmupCommands,
      commandIntervalMs: contentionCommandIntervalMs,
      sweepExtentDeg: contentionSweepExtentDeg,
      observationIntervalMs: contentionObservationIntervalMs,
      homePose,
      moveSpeedDps: follow.moveSpeedDps,
      blockOrder,
      blocks,
      consecutiveLoadPasses,
      conditions: summarizeConditionMeasurements(conditionMeasurements, blocks)
    }
  };
  await writeReport(options.reportOutput, report);
  return report;
}

// eslint-disable-next-line complexity
export async function runStackChanServoLatencyField(
  config: PicoConfig,
  options: StackChanServoLatencyOptions,
  dependencies: StackChanServoLatencyDependencies = {}
): Promise<StackChanServoLatencyReport> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  if (stackchan === undefined || follow?.enabled !== true) {
    throw new Error("enabled camera.stackchan.follow is required");
  }

  const adapter = (dependencies.createAdapter ?? createServoOnlyAdapterFromConfig)(stackchan);
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const waitMs = dependencies.waitMs ?? wait;
  const homePose = {
    yaw: follow.homeYaw,
    pitch: follow.homePitch
  };
  const bins = new Map<number, LatencyAccumulator>(
    measurementOrderDeg.map((delta) => [delta, createLatencyAccumulator()])
  );
  const matrixFailed = await runLatencyMatrix(
    adapter,
    homePose,
    follow.moveSpeedDps,
    options.samplesPerBin,
    bins,
    monotonicNowMs
  );
  const cleanup = await restoreHomeAndClose(adapter, homePose, follow.moveSpeedDps, waitMs);
  const finalPose = cleanup.finalPose;
  const failed = matrixFailed || cleanup.failed;

  const returnedHome =
    finalPose !== undefined &&
    Math.abs(finalPose.yaw - homePose.yaw) <= 1 &&
    Math.abs(finalPose.pitch - homePose.pitch) <= 1;
  const summaries = {
    zero: summarizeLatency(requireLatencyAccumulator(bins, 0)),
    one: summarizeLatency(requireLatencyAccumulator(bins, 1)),
    two: summarizeLatency(requireLatencyAccumulator(bins, 2)),
    four: summarizeLatency(requireLatencyAccumulator(bins, 4))
  };
  const complete = Object.values(summaries).every(
    (summary) => summary.successCount >= options.samplesPerBin && summary.failureCount === 0
  );

  return {
    status: !failed && complete && returnedHome ? "passed" : "failed",
    provider: "stackchan-cores3",
    details: {
      samplesPerBin: options.samplesPerBin,
      measurementOrderDeg,
      homePose,
      moveSpeedDps: follow.moveSpeedDps,
      bins: summaries,
      ...(finalPose === undefined ? {} : { finalPose }),
      returnedHome
    }
  };
}

type ConditionMeasurements = {
  readonly updateAcknowledgmentMs: LatencyAccumulator;
  readonly updateStartGapMs: LatencyAccumulator;
};

type ContentionLoadMeasurements = {
  readonly latestFrameLatencyMs: LatencyAccumulator;
  readonly frameAgeMs: LatencyAccumulator;
  readonly inferenceMs: LatencyAccumulator;
  readonly observationGapMs: LatencyAccumulator;
  readonly deviceCaptureGapMs: LatencyAccumulator;
  readonly deviceEncodeMs: LatencyAccumulator;
  processedObservations: number;
  duplicateSequenceCount: number;
  missedSequenceCount: number;
  failed: boolean;
  startedAtMs: number;
  endedAtMs: number;
};

type RunContentionBlockOptions = {
  readonly stackchan: NonNullable<PicoConfig["camera"]["stackchan"]>;
  readonly condition: StackChanServoContentionCondition;
  readonly conditionBlock: number;
  readonly durationMs: number;
  readonly homePose: StackChanHeadPose;
  readonly moveSpeedDps: number;
  readonly model: AttentionDetectionModel;
  readonly createAdapter: NonNullable<StackChanServoContentionDependencies["createAdapter"]>;
  readonly createHomeAdapter: NonNullable<
    StackChanServoContentionDependencies["createHomeAdapter"]
  >;
  readonly createHeadTargetLane: NonNullable<
    StackChanServoContentionDependencies["createHeadTargetLane"]
  >;
  readonly laneRateHz: number;
  readonly laneMaxStepDeg: number;
  readonly laneMaxPendingAgeMs: number;
  readonly readCameraStatus: NonNullable<StackChanServoContentionDependencies["readCameraStatus"]>;
  readonly createDiagnostics: NonNullable<
    StackChanServoContentionDependencies["createDiagnostics"]
  >;
  readonly monotonicNowMs: () => number;
  readonly wallNowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
  readonly conditionMeasurements: ConditionMeasurements;
};

// eslint-disable-next-line complexity
async function runContentionBlock(
  input: RunContentionBlockOptions
): Promise<StackChanServoContentionBlock> {
  const adapter = input.createAdapter(input.stackchan, input.condition);
  const headTargetLane = input.createHeadTargetLane(input.stackchan);
  const diagnostics = input.createDiagnostics(input.stackchan);
  const updateAcknowledgmentMs = createLatencyAccumulator();
  const updateStartGapMs = createLatencyAccumulator();
  const loadMeasurements = createLoadMeasurements(input.monotonicNowMs());
  let loadLoop: { readonly stop: () => Promise<void> } | undefined;
  let activeCamera = emptyCameraStatus();
  let endingCamera = emptyCameraStatus();
  let cleanupCamera: StackChanServoContentionCameraStatus;
  let headTargetLaneSummary = emptyContentionLaneSummary();
  let failedUpdates = 0;
  let connected = false;
  let laneConnected = false;
  let leaseId: string | undefined;
  let diagnosticsStarted = false;
  let initialSessionId: string | undefined;
  let minimumCommandedPitch = input.homePose.pitch;
  let stopStartedAtMs: number;
  let home: StackChanServoContentionBlock["home"] = { returnedHome: false };
  let nativeWrites: NativeWriteSummary = {
    attemptedWrites: 0,
    ackFailures: 1,
    overflowCount: 0
  };
  let gatewaySessionStable = false;
  let autoSleepEnabled = true;

  try {
    initialSessionId = await diagnostics.readGatewaySessionId();
    await adapter.connect();
    connected = true;
    await diagnostics.beginNativeTelemetry();
    diagnosticsStarted = true;
    await headTargetLane.connect();
    laneConnected = true;
    const lease = await headTargetLane.start({
      rateHz: input.laneRateHz,
      maxStepDeg: input.laneMaxStepDeg,
      maxPendingAgeMs: input.laneMaxPendingAgeMs,
      speedDps: input.moveSpeedDps
    });
    leaseId = lease.leaseId;
    activeCamera = await input.readCameraStatus(input.stackchan);
    if (!cameraStateMatchesCondition(activeCamera, input.condition)) {
      failedUpdates++;
    } else {
      loadLoop = startContentionLoadLoop({
        adapter,
        ...(input.condition === "load" ? { model: input.model } : {}),
        measurements: loadMeasurements,
        monotonicNowMs: input.monotonicNowMs,
        wallNowMs: input.wallNowMs,
        waitMs: input.waitMs
      });
      const commandResult = await measureContentionCommands(
        input,
        headTargetLane,
        leaseId,
        loadMeasurements,
        updateAcknowledgmentMs,
        updateStartGapMs
      );
      failedUpdates += commandResult.failedUpdates;
      minimumCommandedPitch = commandResult.minimumCommandedPitch;
    }
  } catch {
    failedUpdates++;
  } finally {
    stopStartedAtMs = input.monotonicNowMs();
    await loadLoop?.stop();
    loadMeasurements.endedAtMs = input.monotonicNowMs();
    if (connected) {
      endingCamera = await input.readCameraStatus(input.stackchan).catch(() => {
        failedUpdates++;
        return emptyCameraStatus();
      });
    }
    if (leaseId !== undefined) {
      try {
        headTargetLaneSummary = projectContentionLaneSummary(await headTargetLane.stop(leaseId));
      } catch {
        failedUpdates++;
      }
    }
    if (connected) {
      home = await restoreConnectedContentionHome(input, adapter);
    }
    try {
      if (diagnosticsStarted) {
        nativeWrites = await diagnostics.finishNativeTelemetry();
      }
      const finalSessionId = await diagnostics.readGatewaySessionId();
      gatewaySessionStable = initialSessionId !== undefined && finalSessionId === initialSessionId;
      autoSleepEnabled = await diagnostics.readAutoSleepEnabled();
    } catch {
      failedUpdates++;
    }
    if (laneConnected) {
      await headTargetLane.close().catch(() => {
        failedUpdates++;
      });
    }
    if (connected) {
      await adapter.close().catch(() => {
        failedUpdates++;
      });
    }
    cleanupCamera = await input.readCameraStatus(input.stackchan).catch(() => {
      failedUpdates++;
      return emptyCameraStatus();
    });
    await diagnostics.close().catch(() => {
      failedUpdates++;
    });
    if (!connected) {
      home = await restoreContentionHome(input);
    }
  }

  mergeLatencyAccumulator(input.conditionMeasurements.updateStartGapMs, updateStartGapMs);
  const stopAndHomeMs = roundHundredths(input.monotonicNowMs() - stopStartedAtMs);
  const receivedFrames = Math.max(0, endingCamera.receivedFrames - activeCamera.receivedFrames);
  const blockDurationMs = Math.max(0, loadMeasurements.endedAtMs - loadMeasurements.startedAtMs);
  const streamInterruptions =
    input.condition === "off"
      ? 0
      : Number(
          !endingCamera.running ||
            endingCamera.subscribers < 1 ||
            !endingCamera.physicalRunning ||
            receivedFrames === 0
        ) + Number(loadMeasurements.failed);
  const observationGapMs = summarizeDistribution(loadMeasurements.observationGapMs);
  const boundaryPassed =
    gatewaySessionStable &&
    nativeWrites.ackFailures === 0 &&
    nativeWrites.overflowCount === 0 &&
    !autoSleepEnabled &&
    minimumCommandedPitch >= 23 &&
    contentionLanePassed(headTargetLaneSummary) &&
    home.returnedHome &&
    stopAndHomeMs <= 5_000 &&
    (input.condition === "off" || (observationGapMs.count > 0 && observationGapMs.maxMs <= 500));

  return {
    condition: input.condition,
    conditionBlock: input.conditionBlock,
    successfulUpdates: updateAcknowledgmentMs.successCount,
    failedUpdates,
    updateAcknowledgmentMs: summarizeContentionLatency(updateAcknowledgmentMs),
    updateStartGapMs: summarizeDistribution(updateStartGapMs),
    camera: {
      active: projectCameraLifecycle(activeCamera),
      cleanup: projectCameraLifecycle(cleanupCamera),
      receivedFrames,
      receivedFps: roundHundredths(
        blockDurationMs <= 0 ? 0 : receivedFrames / (blockDurationMs / 1_000)
      ),
      streamInterruptions,
      maxJpegBytes: endingCamera.maxJpegBytes,
      creditSend: {
        count: endingCamera.creditSendCount,
        failures: endingCamera.creditSendFailures,
        maxUs: endingCamera.creditSendMaxUs
      },
      observationGapMs,
      deviceCaptureGapMs: summarizeDistribution(loadMeasurements.deviceCaptureGapMs),
      deviceEncodeMs: summarizeDistribution(loadMeasurements.deviceEncodeMs),
      missedSequenceCount: loadMeasurements.missedSequenceCount
    },
    headTargetLane: headTargetLaneSummary,
    ...(input.condition === "load"
      ? {
          load: summarizeLoadMeasurements(loadMeasurements)
        }
      : {}),
    gatewaySessionStable,
    nativeWrites,
    autoSleepEnabled,
    minimumCommandedPitch,
    stopAndHomeMs,
    boundaryPassed,
    home
  };
}

type ContentionCommandResult = {
  readonly failedUpdates: number;
  readonly minimumCommandedPitch: number;
};

async function measureContentionCommands(
  input: RunContentionBlockOptions,
  headTargetLane: StackChanHeadTargetLane,
  leaseId: string,
  loadMeasurements: ContentionLoadMeasurements,
  updateAcknowledgmentMs: LatencyAccumulator,
  updateStartGapMs: LatencyAccumulator
): Promise<ContentionCommandResult> {
  let previousCommandStartedAtMs: number | undefined;
  let minimumCommandedPitch = input.homePose.pitch;
  const startedAtMs = input.monotonicNowMs();
  const deadlineMs = startedAtMs + input.durationMs;
  let commandIndex = 0;
  let nextCommandAtMs = startedAtMs;
  while (nextCommandAtMs < deadlineMs) {
    await input.waitMs(Math.max(0, nextCommandAtMs - input.monotonicNowMs()));
    const terminalFailureCount = contentionCommandTerminalFailureCount(
      input.monotonicNowMs(),
      deadlineMs,
      loadMeasurements.failed
    );
    if (terminalFailureCount !== undefined) {
      return { failedUpdates: terminalFailureCount, minimumCommandedPitch };
    }
    const measured = commandIndex >= contentionWarmupCommands;
    const commandStartedAtMs = input.monotonicNowMs();
    if (measured && previousCommandStartedAtMs !== undefined) {
      recordLatency(updateStartGapMs, commandStartedAtMs - previousCommandStartedAtMs);
    }
    if (measured) {
      previousCommandStartedAtMs = commandStartedAtMs;
    }
    const pose = contentionTrajectoryPose(input.homePose, commandIndex);
    minimumCommandedPitch = Math.min(minimumCommandedPitch, pose.pitch);
    try {
      await headTargetLane.update({
        leaseId,
        sequence: commandIndex,
        pose
      });
    } catch {
      updateAcknowledgmentMs.failureCount++;
      input.conditionMeasurements.updateAcknowledgmentMs.failureCount++;
      return { failedUpdates: 1, minimumCommandedPitch };
    }
    if (measured) {
      const latencyMs = input.monotonicNowMs() - commandStartedAtMs;
      recordLatency(updateAcknowledgmentMs, latencyMs);
      recordLatency(input.conditionMeasurements.updateAcknowledgmentMs, latencyMs);
    }
    commandIndex++;
    nextCommandAtMs += contentionCommandIntervalMs;
  }
  return { failedUpdates: 0, minimumCommandedPitch };
}

function contentionCommandTerminalFailureCount(
  nowMs: number,
  deadlineMs: number,
  loadFailed: boolean
): 0 | 1 | undefined {
  if (nowMs >= deadlineMs) {
    return 0;
  }
  return loadFailed ? 1 : undefined;
}

function createConditionMeasurements(): Record<
  StackChanServoContentionCondition,
  ConditionMeasurements
> {
  return {
    off: {
      updateAcknowledgmentMs: createLatencyAccumulator(),
      updateStartGapMs: createLatencyAccumulator()
    },
    stream: {
      updateAcknowledgmentMs: createLatencyAccumulator(),
      updateStartGapMs: createLatencyAccumulator()
    },
    load: {
      updateAcknowledgmentMs: createLatencyAccumulator(),
      updateStartGapMs: createLatencyAccumulator()
    }
  };
}

function summarizeConditionMeasurements(
  measurements: Readonly<Record<StackChanServoContentionCondition, ConditionMeasurements>>,
  blocks: readonly StackChanServoContentionBlock[]
): Readonly<Record<StackChanServoContentionCondition, StackChanServoContentionConditionSummary>> {
  return {
    off: summarizeConditionMeasurement("off", measurements.off, blocks),
    stream: summarizeConditionMeasurement("stream", measurements.stream, blocks),
    load: summarizeConditionMeasurement("load", measurements.load, blocks)
  };
}

function summarizeConditionMeasurement(
  condition: StackChanServoContentionCondition,
  measurements: ConditionMeasurements,
  blocks: readonly StackChanServoContentionBlock[]
): StackChanServoContentionConditionSummary {
  const conditionBlocks = blocks.filter((block) => block.condition === condition);
  return {
    blockCount: conditionBlocks.length,
    successfulUpdates: conditionBlocks.reduce((total, block) => total + block.successfulUpdates, 0),
    failedUpdates: conditionBlocks.reduce((total, block) => total + block.failedUpdates, 0),
    updateAcknowledgmentMs: summarizeContentionLatency(measurements.updateAcknowledgmentMs),
    updateStartGapMs: summarizeDistribution(measurements.updateStartGapMs)
  };
}

function contentionBlockPassed(block: StackChanServoContentionBlock): boolean {
  return (
    block.successfulUpdates > 0 &&
    block.failedUpdates === 0 &&
    block.camera.streamInterruptions === 0 &&
    contentionCameraPassed(block) &&
    block.home.returnedHome &&
    contentionLoadPassed(block) &&
    block.boundaryPassed
  );
}

function contentionLanePassed(lane: StackChanServoContentionLaneSummary): boolean {
  return (
    lane.accepted > 0 &&
    lane.confirmedApplyReplies > 0 &&
    lane.failed === 0 &&
    lane.staleDiscarded === 0 &&
    lane.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    lane.maximumPendingDepth <= 1 &&
    lane.postStopDispatches === 0
  );
}

function emptyContentionLaneSummary(): StackChanServoContentionLaneSummary {
  return {
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmedApplyReplies: 0,
    failed: 1,
    staleDiscarded: 0,
    maximumActiveCalls: 0,
    maximumPendingDepth: 0,
    postStopDispatches: 0
  };
}

function projectContentionLaneSummary(
  status: StackChanHeadTargetStatus
): StackChanServoContentionLaneSummary {
  return {
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmedApplyReplies: status.confirmedApplyReplies,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    maximumActiveCalls: status.maximumActiveCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    postStopDispatches: status.postStopDispatches
  };
}

function contentionCameraPassed(block: StackChanServoContentionBlock): boolean {
  return (
    cameraLifecycleMatchesCondition(block.camera.active, block.condition) &&
    !block.camera.cleanup.running &&
    block.camera.cleanup.subscribers === 0 &&
    !block.camera.cleanup.physicalRunning &&
    !block.camera.cleanup.available
  );
}

function contentionLoadPassed(block: StackChanServoContentionBlock): boolean {
  return (
    block.condition !== "load" || (block.load !== undefined && block.load.processedObservations > 0)
  );
}

function cameraStateMatchesCondition(
  status: StackChanServoContentionCameraStatus,
  condition: StackChanServoContentionCondition
): boolean {
  return cameraLifecycleMatchesCondition(status, condition);
}

function cameraLifecycleMatchesCondition(
  status: {
    readonly running: boolean;
    readonly subscribers: number;
    readonly physicalRunning: boolean;
  },
  condition: StackChanServoContentionCondition
): boolean {
  return condition === "off"
    ? !status.running && status.subscribers === 0 && !status.physicalRunning
    : status.running && status.subscribers >= 1 && status.physicalRunning;
}

function projectCameraLifecycle(status: StackChanServoContentionCameraStatus) {
  return {
    running: status.running,
    subscribers: status.subscribers,
    physicalRunning: status.physicalRunning,
    available: status.available
  };
}

function emptyCameraStatus(): StackChanServoContentionCameraStatus {
  return {
    running: false,
    subscribers: 0,
    physicalRunning: false,
    available: false,
    receivedFrames: 0,
    maxJpegBytes: 0,
    creditSendCount: 0,
    creditSendFailures: 0,
    creditSendMaxUs: 0
  };
}

function contentionTrajectoryPose(
  homePose: StackChanHeadPose,
  commandIndex: number
): StackChanHeadPose {
  const offsets = [3, 0, -3, 0] as const;
  return {
    yaw: homePose.yaw + (offsets[commandIndex % offsets.length] ?? 0),
    pitch: homePose.pitch
  };
}

async function restoreContentionHome(
  input: RunContentionBlockOptions
): Promise<StackChanServoContentionBlock["home"]> {
  const adapter = input.createHomeAdapter(input.stackchan);
  try {
    await adapter.connect();
    return await restoreConnectedContentionHome(input, adapter);
  } catch {
    return { returnedHome: false };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

async function restoreConnectedContentionHome(
  input: RunContentionBlockOptions,
  adapter: StackChanAdapter
): Promise<StackChanServoContentionBlock["home"]> {
  let finalPose: StackChanHeadPose | undefined;
  try {
    await adapter.moveHead(
      {
        yaw: input.homePose.yaw,
        pitch: Math.min(85, input.homePose.pitch + 4)
      },
      { speedDps: input.moveSpeedDps }
    );
    await input.waitMs(250);
    await adapter.moveHead(input.homePose, { speedDps: input.moveSpeedDps });
    await input.waitMs(1_000);
    finalPose = await adapter.getHeadAngles();
  } catch {
    finalPose = undefined;
  }
  const returnedHome =
    finalPose !== undefined &&
    Math.abs(finalPose.yaw - input.homePose.yaw) <= 1 &&
    Math.abs(finalPose.pitch - input.homePose.pitch) <= 1;
  return {
    ...(finalPose === undefined ? {} : { finalPose }),
    returnedHome
  };
}

function createLoadMeasurements(startedAtMs: number): ContentionLoadMeasurements {
  return {
    latestFrameLatencyMs: createLatencyAccumulator(),
    frameAgeMs: createLatencyAccumulator(),
    inferenceMs: createLatencyAccumulator(),
    observationGapMs: createLatencyAccumulator(),
    deviceCaptureGapMs: createLatencyAccumulator(),
    deviceEncodeMs: createLatencyAccumulator(),
    processedObservations: 0,
    duplicateSequenceCount: 0,
    missedSequenceCount: 0,
    failed: false,
    startedAtMs,
    endedAtMs: startedAtMs
  };
}

type ContentionObservationInput = {
  readonly adapter: StackChanAdapter;
  readonly model?: AttentionDetectionModel;
  readonly measurements: ContentionLoadMeasurements;
  readonly monotonicNowMs: () => number;
  readonly wallNowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
};

type ContentionObservationState = {
  previousSequence?: number;
  previousObservationAtMs?: number;
  previousCapturedAtMs?: number;
};

function startContentionLoadLoop(input: ContentionObservationInput): {
  readonly stop: () => Promise<void>;
} {
  const controller = new AbortController();
  const state: ContentionObservationState = {};
  const task = (async () => {
    while (!controller.signal.aborted) {
      const tickStartedAtMs = input.monotonicNowMs();
      try {
        await observeContentionFrame(input, state);
      } catch {
        input.measurements.failed = true;
        controller.abort();
        break;
      }
      const elapsedMs = input.monotonicNowMs() - tickStartedAtMs;
      await input.waitMs(Math.max(1, contentionObservationIntervalMs - elapsedMs));
    }
  })();

  return {
    stop: async () => {
      controller.abort();
      await task;
    }
  };
}

async function observeContentionFrame(
  input: ContentionObservationInput,
  state: ContentionObservationState
): Promise<void> {
  const frameStartedAtMs = input.monotonicNowMs();
  const frame = await input.adapter.captureJpeg();
  const observedAtMs = input.monotonicNowMs();
  recordLatency(input.measurements.latestFrameLatencyMs, observedAtMs - frameStartedAtMs);
  if (state.previousObservationAtMs !== undefined) {
    recordLatency(
      input.measurements.observationGapMs,
      observedAtMs - state.previousObservationAtMs
    );
  }
  state.previousObservationAtMs = observedAtMs;
  recordContentionFrameTiming(input, state, frame);
  recordContentionSequence(input.measurements, state, frame.sequence);
  if (input.model !== undefined) {
    const inferenceStartedAtMs = input.monotonicNowMs();
    await input.model.detect(frame.bytes);
    recordLatency(input.measurements.inferenceMs, input.monotonicNowMs() - inferenceStartedAtMs);
  }
  input.measurements.processedObservations++;
}

function recordContentionSequence(
  measurements: ContentionLoadMeasurements,
  state: ContentionObservationState,
  sequence: number | undefined
): void {
  if (sequence === undefined) {
    return;
  }
  if (state.previousSequence !== undefined) {
    if (sequence <= state.previousSequence) {
      measurements.duplicateSequenceCount++;
    } else if (sequence > state.previousSequence + 1) {
      measurements.missedSequenceCount += sequence - state.previousSequence - 1;
    }
  }
  state.previousSequence = sequence;
}

function recordContentionFrameTiming(
  input: ContentionObservationInput,
  state: ContentionObservationState,
  frame: {
    readonly capturedAtMs?: number;
    readonly encodedAtMs?: number;
    readonly receivedAtMs?: number;
  }
): void {
  if (frame.receivedAtMs !== undefined) {
    recordLatency(input.measurements.frameAgeMs, input.wallNowMs() - frame.receivedAtMs);
  }
  if (frame.capturedAtMs === undefined) {
    return;
  }
  if (frame.encodedAtMs !== undefined && frame.encodedAtMs >= frame.capturedAtMs) {
    recordLatency(input.measurements.deviceEncodeMs, frame.encodedAtMs - frame.capturedAtMs);
  }
  if (state.previousCapturedAtMs !== undefined) {
    recordLatency(
      input.measurements.deviceCaptureGapMs,
      frame.capturedAtMs - state.previousCapturedAtMs
    );
  }
  state.previousCapturedAtMs = frame.capturedAtMs;
}

function summarizeLoadMeasurements(
  measurements: ContentionLoadMeasurements
): StackChanServoContentionLoadSummary {
  const activeDurationMs = Math.max(0, measurements.endedAtMs - measurements.startedAtMs);
  return {
    activeDurationMs: roundHundredths(activeDurationMs),
    processedObservations: measurements.processedObservations,
    observationRateHz: roundHundredths(
      activeDurationMs <= 0 ? 0 : measurements.processedObservations / (activeDurationMs / 1_000)
    ),
    latestFrameLatencyMs: summarizeDistribution(measurements.latestFrameLatencyMs),
    frameAgeMs: summarizeDistribution(measurements.frameAgeMs),
    duplicateSequenceCount: measurements.duplicateSequenceCount,
    inferenceMs: summarizeDistribution(measurements.inferenceMs)
  };
}

async function runLatencyMatrix(
  adapter: StackChanAdapter,
  homePose: StackChanHeadPose,
  moveSpeedDps: number,
  samplesPerBin: number,
  bins: ReadonlyMap<number, LatencyAccumulator>,
  monotonicNowMs: () => number
): Promise<boolean> {
  try {
    await adapter.connect();
    await adapter.moveHead(homePose, { speedDps: moveSpeedDps });
    for (const delta of measurementOrderDeg) {
      const failed = await measureLatencyBin(
        adapter,
        homePose,
        moveSpeedDps,
        delta,
        samplesPerBin,
        requireLatencyAccumulator(bins, delta),
        monotonicNowMs
      );
      if (failed) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

async function measureLatencyBin(
  adapter: StackChanAdapter,
  homePose: StackChanHeadPose,
  moveSpeedDps: number,
  delta: number,
  samplesPerBin: number,
  accumulator: LatencyAccumulator,
  monotonicNowMs: () => number
): Promise<boolean> {
  for (let sample = 0; sample < samplesPerBin; sample += 1) {
    const startedAtMs = monotonicNowMs();
    try {
      await adapter.moveHead(matrixPose(homePose, delta, sample), {
        speedDps: moveSpeedDps
      });
      recordLatency(accumulator, monotonicNowMs() - startedAtMs);
    } catch {
      accumulator.failureCount++;
      return true;
    }
  }
  return false;
}

async function restoreHomeAndClose(
  adapter: StackChanAdapter,
  homePose: StackChanHeadPose,
  moveSpeedDps: number,
  waitMs: (durationMs: number) => Promise<void>
): Promise<{ readonly finalPose?: StackChanHeadPose; readonly failed: boolean }> {
  let finalPose: StackChanHeadPose | undefined;
  let failed = false;
  try {
    await adapter.moveHead(homePose, { speedDps: moveSpeedDps });
    await waitMs(1_000);
    finalPose = await adapter.getHeadAngles();
  } catch {
    failed = true;
  }
  await adapter.close().catch(() => {
    failed = true;
  });
  return {
    ...(finalPose === undefined ? {} : { finalPose }),
    failed
  };
}

function createServoOnlyAdapterFromConfig(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  environment: NodeJS.ProcessEnv = process.env
): StackChanAdapter {
  const token = environment[config.bearerTokenEnv]?.trim();
  if (token === undefined || token === "") {
    throw new Error("StackChan bearer token is missing");
  }
  const sdkClient = new Client({
    name: "pico-stackchan-servo-latency",
    version: "0.0.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`
      },
      redirect: "error"
    }
  });
  const client: StackChanMcpClient = {
    // The SDK Transport interface and concrete transport disagree under exact optional types.
    connect: async () => sdkClient.connect(transport as unknown as Transport),
    callTool: async (request) =>
      sdkClient.callTool(
        {
          name: request.name,
          arguments: request.arguments
        },
        undefined,
        { timeout: config.timeoutMs }
      ),
    close: async () => closeStackChanMcpSession(transport, sdkClient)
  };
  return createStackChanAdapter({
    client,
    captureRoot: resolve(homedir(), ".stackchan/captures"),
    maxFrameBytes: config.maxFrameBytes
  });
}

function createContentionAdapter(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  condition: StackChanServoContentionCondition
): StackChanAdapter {
  return condition === "off"
    ? createServoOnlyAdapterFromConfig(config)
    : createStackChanAdapterFromConfig(config);
}

function createContentionModel(
  config: PicoAttentionDetectionConfig
): Promise<AttentionDetectionModel> {
  if (!config.enabled) {
    return Promise.reject(new Error("attention detection must be enabled"));
  }
  return createPintoAttentionDetectionModel({
    modelPath: config.modelPath,
    inputWidth: config.inputWidth,
    inputHeight: config.inputHeight,
    headConfidenceThreshold: config.headConfidenceThreshold,
    faceConfidenceThreshold: config.faceConfidenceThreshold
  });
}

type DiagnosticToolCaller = (name: string, arguments_: Record<string, unknown>) => Promise<unknown>;

type NativeTelemetryPage = {
  readonly events: readonly unknown[];
  readonly nextOffset: number;
  readonly hasMore: boolean;
  readonly overflowCount: number;
};

function parseNativeTelemetryPage(value: unknown): NativeTelemetryPage {
  const events = findContentionField(value, "events");
  const nextOffset = findContentionField(value, "next_offset");
  const hasMore = findContentionField(value, "has_more");
  const overflowCount = findContentionField(value, "overflow_count");
  if (
    !Array.isArray(events) ||
    !Number.isSafeInteger(nextOffset) ||
    typeof hasMore !== "boolean" ||
    !Number.isSafeInteger(overflowCount)
  ) {
    throw new Error("StackChan native telemetry page was invalid");
  }
  return {
    events,
    nextOffset: nextOffset as number,
    hasMore,
    overflowCount: overflowCount as number
  };
}

function summarizeNativeWriteEvents(events: readonly unknown[]): NativeWriteSummary {
  let attemptedWrites = 0;
  let ackFailures = 0;
  for (const event of events) {
    if (!isContentionRecord(event) || event.attempted !== true) {
      continue;
    }
    attemptedWrites++;
    if (event.ack_ok !== true) {
      ackFailures++;
    }
  }
  return { attemptedWrites, ackFailures, overflowCount: 0 };
}

async function readNativeWriteTelemetry(
  callTool: DiagnosticToolCaller
): Promise<NativeWriteSummary> {
  let requestedOffset = 0;
  let page = parseNativeTelemetryPage(
    await callTool("get_native_write_telemetry", { offset: requestedOffset, limit: 128 })
  );
  const firstSummary = summarizeNativeWriteEvents(page.events);
  let attemptedWrites = firstSummary.attemptedWrites;
  let ackFailures = firstSummary.ackFailures;
  let overflowCount = page.overflowCount;

  while (page.hasMore) {
    if (page.nextOffset <= requestedOffset) {
      throw new Error("StackChan native telemetry cursor did not advance");
    }
    requestedOffset = page.nextOffset;
    page = parseNativeTelemetryPage(
      await callTool("get_native_write_telemetry", { offset: requestedOffset, limit: 128 })
    );
    const summary = summarizeNativeWriteEvents(page.events);
    attemptedWrites += summary.attemptedWrites;
    ackFailures += summary.ackFailures;
    overflowCount = page.overflowCount;
  }

  return { attemptedWrites, ackFailures, overflowCount };
}

function createStabilityDiagnostics(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  environment: NodeJS.ProcessEnv = process.env
): StackChanStabilityDiagnostics {
  const token = environment[config.bearerTokenEnv]?.trim();
  if (token === undefined || token === "") {
    throw new Error("StackChan bearer token is missing");
  }
  const sdkClient = new Client({
    name: "pico-stackchan-stability-diagnostics",
    version: "0.0.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`
      },
      redirect: "error"
    }
  });
  let connected = false;

  const callTool = async (name: string, arguments_: Record<string, unknown>) => {
    if (!connected) {
      await sdkClient.connect(transport as unknown as Transport);
      connected = true;
    }
    const result = await sdkClient.callTool({ name, arguments: arguments_ }, undefined, {
      timeout: config.timeoutMs
    });
    if (
      (isContentionRecord(result) && result.isError === true) ||
      findContentionField(result, "ok") === false
    ) {
      throw new Error(`StackChan diagnostic tool failed: ${name}`);
    }
    return result;
  };

  return {
    beginNativeTelemetry: async () => {
      const result = await callTool("set_native_write_diagnostics", {
        suppress_duplicate_native_writes: false,
        telemetry_enabled: true,
        clear_telemetry: true
      });
      if (findContentionField(result, "telemetry_enabled") !== true) {
        throw new Error("StackChan native telemetry did not start");
      }
    },
    finishNativeTelemetry: async () => {
      const stopped = await callTool("set_native_write_diagnostics", {
        suppress_duplicate_native_writes: false,
        telemetry_enabled: false,
        clear_telemetry: false
      });
      if (findContentionField(stopped, "telemetry_enabled") !== false) {
        throw new Error("StackChan native telemetry did not stop");
      }
      return readNativeWriteTelemetry(callTool);
    },
    readGatewaySessionId: async () => {
      const result = await callTool("get_status", {});
      const sessionId = findContentionField(result, "session_id");
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error("StackChan gateway session ID was unavailable");
      }
      return sessionId;
    },
    readAutoSleepEnabled: async () => {
      const result = await callTool("get_auto_sleep", {});
      const enabled = findContentionField(result, "enabled");
      if (typeof enabled !== "boolean") {
        throw new Error("StackChan auto-sleep status was invalid");
      }
      return enabled;
    },
    close: async () => {
      if (connected) {
        try {
          await closeStackChanMcpSession(transport, sdkClient);
        } finally {
          connected = false;
        }
      }
    }
  };
}

export async function readContentionCameraStatus(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  environment: NodeJS.ProcessEnv = process.env
): Promise<StackChanServoContentionCameraStatus> {
  const token = environment[config.bearerTokenEnv]?.trim();
  if (token === undefined || token === "") {
    throw new Error("StackChan bearer token is missing");
  }

  const cameraStatusUrl = new URL("/camera/status", config.mcpUrl);
  const [frameResponse, lifecycle] = await Promise.all([
    fetch(cameraStatusUrl, {
      headers: {
        authorization: `Bearer ${token}`
      },
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs)
    }),
    readCameraStreamLifecycle(config, token)
  ]);
  if (!frameResponse.ok) {
    throw new Error("StackChan camera status failed");
  }
  const frameStatus = (await frameResponse.json()) as unknown;
  return {
    running: requireContentionBoolean(lifecycle, "running"),
    subscribers: requireContentionInteger(lifecycle, "subscribers"),
    physicalRunning: requireContentionBoolean(lifecycle, "physical_running"),
    available: requireContentionBoolean(frameStatus, "available"),
    receivedFrames: requireContentionInteger(frameStatus, "received_frames"),
    maxJpegBytes: requireContentionInteger(frameStatus, "max_jpeg_bytes"),
    creditSendCount: requireContentionInteger(lifecycle, "credit_send_count"),
    creditSendFailures: requireContentionInteger(lifecycle, "credit_send_failures"),
    creditSendMaxUs: requireContentionInteger(lifecycle, "credit_send_max_us")
  };
}

async function readCameraStreamLifecycle(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  token: string
): Promise<unknown> {
  const sdkClient = new Client({
    name: "pico-stackchan-servo-contention-status",
    version: "0.0.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`
      },
      redirect: "error"
    }
  });
  try {
    await sdkClient.connect(transport as unknown as Transport);
    const result = await sdkClient.callTool(
      {
        name: "camera_stream",
        arguments: {
          action: "status"
        }
      },
      undefined,
      { timeout: config.timeoutMs }
    );
    if (
      (isContentionRecord(result) && result.isError === true) ||
      findContentionField(result, "error") !== undefined
    ) {
      throw new Error("StackChan camera stream status failed");
    }
    return result;
  } finally {
    await closeStackChanMcpSession(transport, sdkClient).catch(() => undefined);
  }
}

function requireContentionBoolean(value: unknown, field: string): boolean {
  const found = findContentionField(value, field);
  if (typeof found !== "boolean") {
    throw new Error("StackChan camera status was invalid");
  }
  return found;
}

function requireContentionInteger(value: unknown, field: string): number {
  const found = findContentionField(value, field);
  if (!Number.isSafeInteger(found) || (found as number) < 0) {
    throw new Error("StackChan camera status was invalid");
  }
  return found as number;
}

// eslint-disable-next-line complexity
function findContentionField(value: unknown, field: string, depth = 0): unknown {
  if (depth > 12) {
    return undefined;
  }
  if (typeof value === "string") {
    try {
      return findContentionField(JSON.parse(value) as unknown, field, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findContentionField(item, field, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isContentionRecord(value)) {
    return undefined;
  }
  if (Object.hasOwn(value, field)) {
    return value[field];
  }
  return findContentionField(Object.values(value), field, depth + 1);
}

function isContentionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matrixPose(homePose: StackChanHeadPose, delta: number, sample: number): StackChanHeadPose {
  if (delta === 0 || sample % 2 === 1) {
    return homePose;
  }
  const excursion = Math.floor(sample / 2);
  return {
    yaw: homePose.yaw + (excursion % 2 === 0 ? delta : -delta),
    pitch: homePose.pitch
  };
}

function createLatencyAccumulator(): LatencyAccumulator {
  return {
    buckets: new Uint32Array(maximumLatencyMs + 2),
    successCount: 0,
    failureCount: 0,
    over250MsCount: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0
  };
}

function recordLatency(accumulator: LatencyAccumulator, rawLatencyMs: number): void {
  const latencyMs = Math.max(0, rawLatencyMs);
  const bucket = Math.min(maximumLatencyMs + 1, Math.round(latencyMs));
  accumulator.buckets[bucket] = (accumulator.buckets[bucket] ?? 0) + 1;
  accumulator.successCount++;
  if (latencyMs > 250) {
    accumulator.over250MsCount++;
  }
  accumulator.minMs = Math.min(accumulator.minMs, latencyMs);
  accumulator.maxMs = Math.max(accumulator.maxMs, latencyMs);
}

function summarizeLatency(accumulator: LatencyAccumulator): LatencySummary {
  return {
    successCount: accumulator.successCount,
    failureCount: accumulator.failureCount,
    p50Ms: percentile(accumulator, 0.5),
    p95Ms: percentile(accumulator, 0.95),
    minMs: accumulator.successCount === 0 ? 0 : roundHundredths(accumulator.minMs),
    maxMs: accumulator.successCount === 0 ? 0 : roundHundredths(accumulator.maxMs)
  };
}

function summarizeContentionLatency(accumulator: LatencyAccumulator): ContentionLatencySummary {
  return {
    ...summarizeLatency(accumulator),
    over250MsCount: accumulator.over250MsCount
  };
}

function summarizeDistribution(accumulator: LatencyAccumulator): DistributionSummary {
  const summary = summarizeLatency(accumulator);
  return {
    count: summary.successCount,
    p50Ms: summary.p50Ms,
    p95Ms: summary.p95Ms,
    minMs: summary.minMs,
    maxMs: summary.maxMs
  };
}

function mergeLatencyAccumulator(target: LatencyAccumulator, source: LatencyAccumulator): void {
  for (let index = 0; index < source.buckets.length; index += 1) {
    target.buckets[index] = (target.buckets[index] ?? 0) + (source.buckets[index] ?? 0);
  }
  target.successCount += source.successCount;
  target.failureCount += source.failureCount;
  target.over250MsCount += source.over250MsCount;
  if (source.successCount > 0) {
    target.minMs = Math.min(target.minMs, source.minMs);
    target.maxMs = Math.max(target.maxMs, source.maxMs);
  }
}

function percentile(accumulator: LatencyAccumulator, quantile: number): number {
  if (accumulator.successCount === 0) {
    return 0;
  }
  const requiredCount = Math.ceil(accumulator.successCount * quantile);
  let accumulated = 0;
  for (let index = 0; index < accumulator.buckets.length; index += 1) {
    accumulated += accumulator.buckets[index] ?? 0;
    if (accumulated >= requiredCount) {
      return index > maximumLatencyMs ? roundHundredths(accumulator.maxMs) : index;
    }
  }
  return roundHundredths(accumulator.maxMs);
}

function requireLatencyAccumulator(
  bins: ReadonlyMap<number, LatencyAccumulator>,
  delta: number
): LatencyAccumulator {
  const accumulator = bins.get(delta);
  if (accumulator === undefined) {
    throw new Error("servo latency bin is unavailable");
  }
  return accumulator;
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error("field arguments must use named --options");
    }
    if (name === "--enable-live-run" || name === "--camera-contention") {
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

function requireBoundedPositiveInteger(
  values: ReadonlyMap<string, string | true>,
  name: string,
  maximum: number
): number {
  const rawValue = values.get(name);
  const value = typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer up to ${maximum}`);
  }
  return value;
}

function requireAbsolutePath(values: ReadonlyMap<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function readOptionalContentionCondition(
  values: ReadonlyMap<string, string | true>,
  name: string
): "stream" | "load" | undefined {
  const value = values.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "stream" && value !== "load") {
    throw new Error(`${name} must be stream or load`);
  }
  return value;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const arguments_ = process.argv.slice(2);
    const config = loadPicoConfigFromEnvironment();
    const report = arguments_.includes("--camera-contention")
      ? await runStackChanServoContentionField(
          config,
          parseStackChanServoContentionArguments(arguments_)
        )
      : await runStackChanServoLatencyField(
          config,
          parseStackChanServoLatencyArguments(arguments_)
        );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("StackChan servo latency command failed\n");
    process.exitCode = 2;
  }
}
