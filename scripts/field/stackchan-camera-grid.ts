#!/usr/bin/env jiti
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

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

export type StackChanCameraGridOptions = {
  readonly enableLiveRun: true;
  readonly modelPath: string;
  readonly reportOutput: string;
};

export type StackChanCameraGridReport =
  | {
      readonly status: "passed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly details: StackChanCameraGridDetails;
    }
  | {
      readonly status: "failed";
      readonly provider: "stackchan-cores3+pinto441-dist";
      readonly reason: string;
    };

type StackChanCameraGridDetails = {
  readonly sourceId: string;
  readonly modelSha256: string;
  readonly poses: readonly {
    readonly yaw: number;
    readonly pitch: number;
    readonly frameBytes: number;
    readonly width: number;
    readonly height: number;
    readonly captureLatencyMs: number;
    readonly inferenceLatencyMs: number;
    readonly headDetections: number;
    readonly faceDetections: number;
    readonly maxConfidence: number;
    readonly selected?: {
      readonly label: "head" | "face";
      readonly confidence: number;
      readonly centerX: number;
      readonly centerY: number;
      readonly coverage: number;
    };
  }[];
  readonly returnedHome: boolean;
};

export type StackChanCameraGridDependencies = {
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createModel?: (modelPath: string) => Promise<AttentionDetectionModel>;
  readonly inspectImage?: (
    jpeg: Uint8Array
  ) => Promise<{ readonly width: number; readonly height: number }>;
  readonly hashModel?: (modelPath: string) => Promise<string>;
  readonly settleHead?: () => Promise<void>;
  readonly writeReport?: (path: string, report: StackChanCameraGridReport) => Promise<void>;
};

const provider = "stackchan-cores3+pinto441-dist" as const;

export function parseStackChanCameraGridArguments(
  arguments_: readonly string[]
): StackChanCameraGridOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }

  return {
    enableLiveRun: true,
    modelPath: requireArgument(values, "--model-path"),
    reportOutput: requireArgument(values, "--report-output")
  };
}

// eslint-disable-next-line complexity
export async function runStackChanCameraGridField(
  config: PicoConfig,
  options: StackChanCameraGridOptions,
  dependencies: StackChanCameraGridDependencies = {}
): Promise<StackChanCameraGridReport> {
  const stackchan = config.camera.stackchan;
  if (stackchan === undefined) {
    throw new Error("camera.stackchan is required");
  }

  const createAdapter = dependencies.createAdapter ?? createStackChanAdapterFromConfig;
  const createModel = dependencies.createModel ?? createFieldAttentionModel;
  const inspectImage = dependencies.inspectImage ?? inspectJpeg;
  const hashModel = dependencies.hashModel ?? sha256File;
  const settleHead = dependencies.settleHead ?? waitForHeadToSettle;
  const writeReport = dependencies.writeReport ?? writeJsonReport;
  const adapter = createAdapter(stackchan);
  const model = await createModel(options.modelPath);
  const modelSha256 = await hashModel(options.modelPath);
  const home = readHomePose(stackchan);
  const poses = readGridPoses(stackchan, home);
  const observations: StackChanCameraGridDetails["poses"][number][] = [];
  let returnedHome = false;
  let failure: unknown;

  try {
    await adapter.connect();
    for (const pose of poses) {
      await adapter.moveHead(pose);
      const captureStartedAt = performance.now();
      const frame = await adapter.captureJpeg();
      const captureLatencyMs = roundedDuration(captureStartedAt);
      const inferenceStartedAt = performance.now();
      const [detectionResult, dimensions] = await Promise.all([
        model.detect(frame.bytes).then((detections) => ({
          detections,
          inferenceLatencyMs: roundedDuration(inferenceStartedAt)
        })),
        inspectImage(frame.bytes)
      ]);
      const { detections, inferenceLatencyMs } = detectionResult;
      const selected = selectAttentionTarget(detections);
      observations.push({
        ...pose,
        frameBytes: frame.bytes.byteLength,
        ...dimensions,
        captureLatencyMs,
        inferenceLatencyMs,
        headDetections: detections.filter(({ label }) => label === "head").length,
        faceDetections: detections.filter(({ label }) => label === "face").length,
        maxConfidence: detections.reduce(
          (maximum, detection) => Math.max(maximum, detection.confidence),
          0
        ),
        ...(selected === undefined ? {} : { selected: summarizeDetection(selected) })
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await adapter.moveHead(home);
      await settleHead();
      returnedHome = samePose(await adapter.getHeadAngles(), home);
      if (!returnedHome) {
        failure ??= new Error("StackChan did not return to the configured home pose");
      }
    } catch (error) {
      failure ??= error;
    }
    try {
      await adapter.close();
    } catch (error) {
      failure ??= error;
    }
  }

  const report: StackChanCameraGridReport =
    failure === undefined
      ? {
          status: "passed",
          provider,
          details: {
            sourceId: stackchan.sourceId ?? "stackchan-core-s3",
            modelSha256,
            poses: observations,
            returnedHome
          }
        }
      : {
          status: "failed",
          provider,
          reason: "StackChan camera grid field run failed"
        };
  await writeReport(options.reportOutput, report);
  return report;
}

function readHomePose(config: NonNullable<PicoConfig["camera"]["stackchan"]>): StackChanHeadPose {
  return config.follow.enabled
    ? { yaw: config.follow.homeYaw, pitch: config.follow.homePitch }
    : { yaw: 0, pitch: 35 };
}

function readGridPoses(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>,
  home: StackChanHeadPose
): readonly StackChanHeadPose[] {
  const yaw = config.follow.enabled ? config.follow.scanYaw : [-35, 0, 35];
  return [
    home,
    { yaw: Math.min(...yaw), pitch: home.pitch },
    { yaw: Math.max(...yaw), pitch: home.pitch }
  ];
}

function createFieldAttentionModel(modelPath: string): Promise<AttentionDetectionModel> {
  return createPintoAttentionDetectionModel({
    modelPath,
    inputWidth: 320,
    inputHeight: 256,
    headConfidenceThreshold: 0.35,
    faceConfidenceThreshold: 0.4
  });
}

async function inspectJpeg(
  jpeg: Uint8Array
): Promise<{ readonly width: number; readonly height: number }> {
  const metadata = await sharp(jpeg).metadata();
  return { width: metadata.width, height: metadata.height };
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function writeJsonReport(path: string, report: StackChanCameraGridReport): Promise<void> {
  return writeFile(path, `${JSON.stringify(report, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--")) {
      throw new Error("field arguments must use named --options");
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

function requireArgument(values: ReadonlyMap<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function samePose(left: StackChanHeadPose, right: StackChanHeadPose): boolean {
  return Math.abs(left.yaw - right.yaw) <= 1 && Math.abs(left.pitch - right.pitch) <= 1;
}

function waitForHeadToSettle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1_000);
  });
}

function summarizeDetection(
  detection: AttentionDetection
): NonNullable<StackChanCameraGridDetails["poses"][number]["selected"]> {
  const { boundingBox } = detection;

  return {
    label: detection.label,
    confidence: detection.confidence,
    centerX: (boundingBox.xMin + boundingBox.xMax) / 2,
    centerY: (boundingBox.yMin + boundingBox.yMax) / 2,
    coverage: (boundingBox.xMax - boundingBox.xMin) * (boundingBox.yMax - boundingBox.yMin)
  };
}

function roundedDuration(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runStackChanCameraGridField(
      loadPicoConfigFromEnvironment(),
      parseStackChanCameraGridArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
