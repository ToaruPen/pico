#!/usr/bin/env jiti
import { lstat, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStackChanAdapterFromConfig,
  type StackChanAdapter,
  type StackChanHeadPose
} from "../../src/modules/stackchan/index.js";
import {
  type AttentionDetection,
  type AttentionDetectionModel,
  createPintoAttentionDetectionModel,
  selectAttentionTarget
} from "../../src/modules/vision/attention-detection.js";
import {
  type AttentionMetricsAccumulator,
  type AttentionMetricsSummary,
  createAttentionMetricsAccumulator
} from "./stackchan-attention-metrics.js";
import { writePrivateJsonReport } from "./stackchan-field-report.js";

export type StackChanCenterCalibrationOptions = {
  readonly enableLiveRun: true;
  readonly durationMs: number;
  readonly maxFrames: number;
  readonly minimumTargetFrames: number;
  readonly modelPath: string;
  readonly reportOutput: string;
};

type CalibrationAxisSummary = {
  readonly signedP50: number;
  readonly absoluteP50: number;
  readonly absoluteP95: number;
};

type CalibrationFailureCode =
  | "runtime-error"
  | "cleanup-error"
  | "no-frames"
  | "insufficient-target"
  | "home-not-restored";

type CalibrationAggregateDetails = {
  readonly sourceId: string;
  readonly durationMs: number;
  readonly maxFrames: number;
  readonly framesProcessed: number;
  readonly errors: 0 | 1;
  readonly stream: {
    readonly requestedFps: number;
    readonly frameAgeP95Ms: number;
  };
  readonly inference: {
    readonly p95Ms: number;
  };
  readonly attention: {
    readonly targetFrames: number;
    readonly faceFrames: number;
    readonly headFrames: number;
    readonly horizontal: CalibrationAxisSummary;
    readonly vertical: CalibrationAxisSummary;
    readonly maximumLostGapMs: number;
  };
  readonly finalPoseStatus: "available" | "unavailable";
  readonly finalPose?: StackChanHeadPose;
  readonly returnedHome: boolean;
};

export type StackChanCenterCalibrationReport =
  | {
      readonly status: "passed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly details: CalibrationAggregateDetails & {
        readonly errors: 0;
        readonly finalPoseStatus: "available";
        readonly finalPose: StackChanHeadPose;
        readonly returnedHome: true;
      };
    }
  | {
      readonly status: "failed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly reason: string;
      readonly failureCode: CalibrationFailureCode;
      readonly details: CalibrationAggregateDetails;
    };

type CalibrationModelOptions = {
  readonly modelPath: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly headConfidenceThreshold: number;
  readonly faceConfidenceThreshold: number;
};

export type StackChanCenterCalibrationDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createModel?: (options: CalibrationModelOptions) => Promise<AttentionDetectionModel>;
  readonly monotonicNowMs?: () => number;
  readonly wallNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
  readonly writeReport?: (path: string, report: StackChanCenterCalibrationReport) => Promise<void>;
};

const provider = "stackchan-cores3+pinto441-dist" as const;
const failedReason = "StackChan center calibration field run failed";
const allowedOptions = new Set([
  "--enable-live-run",
  "--duration-ms",
  "--max-frames",
  "--minimum-target-frames",
  "--model-path",
  "--report-output"
]);

export function parseStackChanCenterCalibrationArguments(
  arguments_: readonly string[]
): StackChanCenterCalibrationOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }

  return {
    enableLiveRun: true,
    durationMs: requireBoundedPositiveInteger(values, "--duration-ms", 120_000),
    maxFrames: requireBoundedPositiveInteger(values, "--max-frames", 10_000),
    minimumTargetFrames: requireBoundedIntegerRange(values, "--minimum-target-frames", 20, 10_000),
    modelPath: requireStringArgument(values, "--model-path"),
    reportOutput: requireStringArgument(values, "--report-output")
  };
}

// eslint-disable-next-line complexity
export async function runStackChanCenterCalibrationField(
  config: PicoConfig,
  options: StackChanCenterCalibrationOptions,
  dependencies: StackChanCenterCalibrationDependencies = {}
): Promise<StackChanCenterCalibrationReport> {
  requireMinimumTargetFrames(options.minimumTargetFrames);
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  const attention = config.vision.attentionDetection;
  if (stackchan === undefined || follow?.enabled !== true || attention?.enabled !== true) {
    throw new Error("enabled camera.stackchan.follow and vision.attentionDetection are required");
  }
  await validateCalibrationPaths(options.modelPath, options.reportOutput);

  const createAdapter = dependencies.createAdapter ?? createStackChanAdapterFromConfig;
  const createModel = dependencies.createModel ?? createPintoAttentionDetectionModel;
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const wallNowMs = dependencies.wallNowMs ?? (() => Date.now());
  const waitMs = dependencies.waitMs ?? wait;
  const writeReport = dependencies.writeReport ?? writeJsonReport;
  const home = { yaw: follow.homeYaw, pitch: follow.homePitch };
  const motion = { speedDps: follow.moveSpeedDps };
  const homeTimeoutMs = Math.ceil((180 / follow.moveSpeedDps) * 1_000) + 1_000;
  const frameAgesMs: number[] = [];
  const inferenceMs: number[] = [];
  let adapter: StackChanAdapter | undefined;
  let metrics: AttentionMetricsAccumulator | undefined;
  let runEndedWallMs: number | undefined;
  let connected = false;
  let finalPose: StackChanHeadPose | undefined;
  let failure: unknown;
  let lifecycleFailureCode: CalibrationFailureCode | undefined;

  try {
    adapter = createAdapter(stackchan);
    const model = await createModel({
      modelPath: options.modelPath,
      inputWidth: attention.inputWidth,
      inputHeight: attention.inputHeight,
      headConfidenceThreshold: attention.headConfidenceThreshold,
      faceConfidenceThreshold: attention.faceConfidenceThreshold
    });
    await adapter.connect();
    connected = true;
    await adapter.moveHead(home, motion);
    const initialHome = await pollForHome({
      adapter,
      home,
      timeoutMs: homeTimeoutMs,
      monotonicNowMs,
      waitMs
    });
    if (!initialHome.returnedHome) {
      throw new Error("StackChan did not reach home before calibration");
    }
    metrics = createAttentionMetricsAccumulator({
      runStartedAtMs: wallNowMs(),
      deadZone: follow.deadZone
    });
    try {
      await runCalibrationLoop({
        adapter,
        model,
        home,
        deadZone: follow.deadZone,
        options,
        metrics,
        frameAgesMs,
        inferenceMs,
        monotonicNowMs,
        wallNowMs
      });
    } finally {
      runEndedWallMs = wallNowMs();
    }
  } catch (error) {
    failure = error;
    lifecycleFailureCode = "runtime-error";
  } finally {
    if (connected && adapter !== undefined) {
      try {
        await adapter.moveHead(home, motion);
      } catch (error) {
        failure ??= error;
        lifecycleFailureCode ??= "cleanup-error";
      }
      try {
        const finalHome = await pollForHome({
          adapter,
          home,
          timeoutMs: homeTimeoutMs,
          monotonicNowMs,
          waitMs
        });
        finalPose = finalHome.pose;
        const finalHomeFailure = finalHome.returnedHome
          ? undefined
          : new Error("StackChan did not return home after calibration");
        failure ??= finalHomeFailure;
        lifecycleFailureCode ??= finalHomeFailure === undefined ? undefined : "home-not-restored";
      } catch (error) {
        failure ??= error;
        lifecycleFailureCode ??= "cleanup-error";
      }
    }
    if (adapter !== undefined) {
      try {
        await adapter.close();
      } catch (error) {
        failure ??= error;
        lifecycleFailureCode ??= "cleanup-error";
      }
    }
  }

  const summary = summarizeMetrics(metrics, runEndedWallMs, follow.deadZone);
  const returnedHome = finalPose !== undefined && samePose(finalPose, home);
  const failureCode = classifyCalibrationFailure({
    lifecycleFailureCode,
    failure,
    framesProcessed: summary.framesProcessed,
    targetFrames: summary.targetFrames,
    minimumTargetFrames: options.minimumTargetFrames,
    finalPose,
    returnedHome
  });
  const details: CalibrationAggregateDetails = {
    sourceId: stackchan.sourceId ?? "stackchan-core-s3",
    durationMs: options.durationMs,
    maxFrames: options.maxFrames,
    framesProcessed: summary.framesProcessed,
    errors: failure === undefined ? 0 : 1,
    stream: {
      requestedFps: stackchan.streamFps,
      frameAgeP95Ms: percentile(frameAgesMs, 0.95)
    },
    inference: {
      p95Ms: percentile(inferenceMs, 0.95)
    },
    attention: {
      targetFrames: summary.targetFrames,
      faceFrames: summary.faceFrames,
      headFrames: summary.headFrames,
      horizontal: calibrationAxis(summary.horizontal),
      vertical: calibrationAxis(summary.vertical),
      maximumLostGapMs: summary.maximumLostGapMs
    },
    finalPoseStatus: finalPose === undefined ? "unavailable" : "available",
    ...(finalPose === undefined ? {} : { finalPose }),
    returnedHome
  };
  const report: StackChanCenterCalibrationReport =
    failureCode === undefined && finalPose !== undefined
      ? {
          status: "passed",
          provider,
          details: {
            ...details,
            errors: 0,
            finalPoseStatus: "available",
            finalPose,
            returnedHome: true
          }
        }
      : {
          status: "failed",
          provider,
          reason: failedReason,
          failureCode: failureCode ?? "runtime-error",
          details
        };
  await writeReport(options.reportOutput, report);
  return report;
}

function classifyCalibrationFailure(input: {
  readonly lifecycleFailureCode: CalibrationFailureCode | undefined;
  readonly failure: unknown;
  readonly framesProcessed: number;
  readonly targetFrames: number;
  readonly minimumTargetFrames: number;
  readonly finalPose: StackChanHeadPose | undefined;
  readonly returnedHome: boolean;
}): CalibrationFailureCode | undefined {
  if (input.lifecycleFailureCode !== undefined) {
    return input.lifecycleFailureCode;
  }
  if (input.failure !== undefined) {
    return "runtime-error";
  }
  if (input.framesProcessed === 0) {
    return "no-frames";
  }
  if (input.targetFrames < input.minimumTargetFrames) {
    return "insufficient-target";
  }
  if (input.finalPose === undefined || !input.returnedHome) {
    return "home-not-restored";
  }
  return undefined;
}

type CalibrationLoopOptions = {
  readonly adapter: StackChanAdapter;
  readonly model: AttentionDetectionModel;
  readonly home: StackChanHeadPose;
  readonly deadZone: number;
  readonly options: StackChanCenterCalibrationOptions;
  readonly metrics: AttentionMetricsAccumulator;
  readonly frameAgesMs: number[];
  readonly inferenceMs: number[];
  readonly monotonicNowMs: () => number;
  readonly wallNowMs: () => number;
};

async function runCalibrationLoop(input: CalibrationLoopOptions): Promise<void> {
  const startedAtMs = input.monotonicNowMs();
  const deadlineMs = startedAtMs + input.options.durationMs;
  const inferredSequences = new Set<number>();
  let captures = 0;

  while (captures < input.options.maxFrames && input.monotonicNowMs() < deadlineMs) {
    const frame = await input.adapter.captureJpeg();
    captures += 1;
    const sequence = requireFrameSequence(frame.sequence);
    if (inferredSequences.has(sequence)) {
      continue;
    }
    inferredSequences.add(sequence);
    await recordCalibrationFrame(input, frame, sequence);
  }
}

async function recordCalibrationFrame(
  input: CalibrationLoopOptions,
  frame: Awaited<ReturnType<StackChanAdapter["captureJpeg"]>>,
  sequence: number
): Promise<void> {
  const observedAtMs = input.wallNowMs();
  if (frame.receivedAtMs !== undefined) {
    input.frameAgesMs.push(Math.max(0, observedAtMs - frame.receivedAtMs));
  }
  const detections = await detectWithMeasurement(input, frame.bytes);
  const target = calibrationTarget(selectAttentionTarget(detections), input.deadZone);
  input.metrics.record({
    sequence,
    observedAtMs,
    pose: input.home,
    ...(target === undefined ? {} : { target })
  });
}

function requireFrameSequence(sequence: number | undefined): number {
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("StackChan center calibration frame sequence is required");
  }
  return sequence;
}

async function detectWithMeasurement(
  input: CalibrationLoopOptions,
  jpeg: Uint8Array
): Promise<readonly AttentionDetection[]> {
  const startedAtMs = input.monotonicNowMs();
  try {
    return await input.model.detect(jpeg);
  } finally {
    input.inferenceMs.push(Math.max(0, input.monotonicNowMs() - startedAtMs));
  }
}

function calibrationTarget(selected: AttentionDetection | undefined, deadZone: number) {
  if (selected === undefined) {
    return undefined;
  }
  const horizontalError = (selected.boundingBox.xMin + selected.boundingBox.xMax) / 2 - 0.5;
  const verticalError = (selected.boundingBox.yMin + selected.boundingBox.yMax) / 2 - 0.5;

  return {
    label: selected.label,
    horizontalError,
    verticalError,
    centered: Math.abs(horizontalError) <= deadZone && Math.abs(verticalError) <= deadZone
  };
}

function calibrationAxis(input: {
  readonly signedP50: number;
  readonly absoluteP50: number;
  readonly absoluteP95: number;
}): CalibrationAxisSummary {
  return {
    signedP50: input.signedP50,
    absoluteP50: input.absoluteP50,
    absoluteP95: input.absoluteP95
  };
}

function summarizeMetrics(
  metrics: AttentionMetricsAccumulator | undefined,
  runEndedAtMs: number | undefined,
  deadZone: number
): AttentionMetricsSummary {
  if (metrics !== undefined && runEndedAtMs !== undefined) {
    return metrics.summarize(runEndedAtMs);
  }
  return createAttentionMetricsAccumulator({
    runStartedAtMs: 0,
    deadZone
  }).summarize(0);
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

function samePose(left: StackChanHeadPose, right: StackChanHeadPose): boolean {
  return Math.abs(left.yaw - right.yaw) <= 1 && Math.abs(left.pitch - right.pitch) <= 1;
}

type PollForHomeOptions = {
  readonly adapter: StackChanAdapter;
  readonly home: StackChanHeadPose;
  readonly timeoutMs: number;
  readonly monotonicNowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
};

async function pollForHome(
  options: PollForHomeOptions
): Promise<{ readonly pose: StackChanHeadPose; readonly returnedHome: boolean }> {
  const startedAtMs = options.monotonicNowMs();
  let pose = await options.adapter.getHeadAngles();

  while (!samePose(pose, options.home)) {
    const remainingMs = options.timeoutMs - (options.monotonicNowMs() - startedAtMs);
    if (remainingMs <= 0) {
      return { pose, returnedHome: false };
    }
    await options.waitMs(Math.min(100, remainingMs));
    pose = await options.adapter.getHeadAngles();
  }
  return { pose, returnedHome: true };
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function writeJsonReport(
  path: string,
  report: StackChanCenterCalibrationReport
): Promise<void> {
  try {
    await writePrivateJsonReport(path, report);
  } catch {
    throw new Error("StackChan center calibration report write failed");
  }
}

async function validateCalibrationPaths(modelPath: string, reportOutput: string): Promise<void> {
  const resolvedModelPath = resolve(modelPath);
  const resolvedReportOutput = resolve(reportOutput);
  if (resolvedModelPath === resolvedReportOutput) {
    throw new Error("calibration model and report paths must be distinct");
  }
  const reportLinkStatus = await optionalFileStatus(resolvedReportOutput, lstat);
  if (reportLinkStatus?.isSymbolicLink() === true) {
    throw new Error("calibration report output must not be a symbolic link");
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
    throw new Error("calibration model and report paths must be distinct");
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
  throw new Error("calibration path validation failed");
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
    if (!allowedOptions.has(name)) {
      throw new Error(`unknown option: ${name}`);
    }
    if (name === "--enable-live-run") {
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

function requireBoundedIntegerRange(
  values: ReadonlyMap<string, string | true>,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(requireStringArgument(values, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireMinimumTargetFrames(value: number): void {
  if (!Number.isInteger(value) || value < 20 || value > 10_000) {
    throw new Error("--minimum-target-frames must be an integer from 20 through 10000");
  }
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runStackChanCenterCalibrationField(
      loadPicoConfigFromEnvironment(),
      parseStackChanCenterCalibrationArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("StackChan center calibration command failed\n");
    process.exitCode = 2;
  }
}
