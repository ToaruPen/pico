#!/usr/bin/env jiti
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotResult
} from "../../src/modules/camera/index.js";
import {
  createCoremlPersonDetectionModel,
  createOnnxPersonDetectionModel,
  createSharpRgbTensorPreprocessor,
  normalizePersonDetectionFrame,
  type PersonDetectionModel
} from "../../src/modules/vision/person-detection.js";

const defaultTapoStream = "stream2";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;

export type PersonDetectionSmokeStatus = "passed" | "failed" | "skipped";
export type PersonDetectionSmokeProvider = "tapo-rtsp+onnxruntime" | "tapo-rtsp+coreml";

export type PersonDetectionSmokeReport = {
  readonly status: PersonDetectionSmokeStatus;
  readonly provider: PersonDetectionSmokeProvider;
  readonly reason?: string;
  readonly details?: {
    readonly sourceId: string;
    readonly frameBytes: number;
    readonly detectedPeople: number;
    readonly capturedAt: string;
  };
};

export type PersonDetectionSmokePlan =
  | {
      readonly status: "run";
      readonly config: PicoConfig;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

export type PersonDetectionSmokeDependencies = {
  readonly pathExists?: (path: string) => boolean;
  readonly captureFrame?: (config: PicoConfig) => Promise<RtspSnapshotResult>;
  readonly createModel?: (config: PicoConfig) => Promise<PersonDetectionModel>;
  readonly now?: () => string;
};

type EnabledPersonDetectionConfig = {
  readonly enabled: true;
  readonly sourceCameraId: string;
  readonly modelFamily: "pinto0309";
  readonly provider: "onnxruntime" | "coreml";
  readonly modelPath: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly outputLayout?: "xyxy_score_class" | "cxcywh_score_class" | "yolox_coco_raw";
  readonly coordinateScale?: "pixel" | "normalized";
  readonly frameIntervalMs: number;
  readonly confidenceThreshold: number;
  readonly coremlFlags?: number;
  readonly nmsIouThreshold?: number;
};

export async function runPersonDetectionSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  dependencies: PersonDetectionSmokeDependencies = {}
): Promise<PersonDetectionSmokeReport> {
  const plan = buildPersonDetectionSmokePlan(config, dependencies);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: smokeProvider(config),
      reason: plan.reason
    };
  }

  const captureFrame = dependencies.captureFrame ?? captureTapoFrame;
  const createModel = dependencies.createModel ?? createConfiguredModel;
  const capturedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const snapshot = await captureFrame(plan.config);
  const provider = smokeProvider(plan.config);

  if (!snapshot.ok) {
    return {
      status: "failed",
      provider,
      reason: `pico person detection smoke capture failed: ${snapshot.reason}: ${snapshot.message}`
    };
  }

  const model = await createModel(plan.config);
  const rawDetections = await model.detect(snapshot.frame);
  const detectorConfig = requireEnabledDetector(plan.config);
  const normalized = normalizePersonDetectionFrame({
    sourceId: snapshot.sourceId,
    capturedAt,
    frameSize: {
      width: detectorConfig.inputWidth,
      height: detectorConfig.inputHeight
    },
    confidenceThreshold: detectorConfig.confidenceThreshold,
    detections: rawDetections
  });

  return {
    status: "passed",
    provider,
    details: {
      sourceId: normalized.sourceId,
      frameBytes: snapshot.frame.byteLength,
      detectedPeople: normalized.detections.length,
      capturedAt: normalized.capturedAt
    }
  };
}

export function buildPersonDetectionSmokePlan(
  config: PicoConfig,
  dependencies: Pick<PersonDetectionSmokeDependencies, "pathExists"> = {}
): PersonDetectionSmokePlan {
  const detector = config.vision.personDetection;

  if (!detector.enabled) {
    return {
      status: "skip",
      reason: "Set vision.personDetection.enabled=true to run the person detection smoke."
    };
  }

  if (detector.provider !== "onnxruntime" && detector.provider !== "coreml") {
    return {
      status: "skip",
      reason: "pico person detection smoke currently supports provider=onnxruntime or coreml."
    };
  }

  if (config.camera.tapo === undefined) {
    return {
      status: "skip",
      reason: "Set camera.tapo in pico config to run the person detection smoke."
    };
  }

  const detectorConfig = requireEnabledDetector(config);
  const pathExists = dependencies.pathExists ?? existsSync;
  if (!pathExists(detectorConfig.modelPath)) {
    return {
      status: "skip",
      reason: `pico person detection smoke model file not found: ${detectorConfig.modelPath}`
    };
  }

  return {
    status: "run",
    config
  };
}

export function personDetectionSmokeExitCode(report: PersonDetectionSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

async function captureTapoFrame(config: PicoConfig): Promise<RtspSnapshotResult> {
  const tapo = config.camera.tapo;
  const detector = requireEnabledDetector(config);

  if (tapo === undefined) {
    throw new Error("pico person detection smoke requires camera.tapo config");
  }

  const client = createRtspSnapshotClient(
    defineRtspSnapshotSource({
      id: detector.sourceCameraId,
      host: tapo.host,
      username: tapo.user,
      password: tapo.password,
      stream: tapo.stream ?? defaultTapoStream,
      port: tapo.port ?? defaultTapoPort
    }),
    createFfmpegRtspSnapshotTransport({
      timeoutMs: tapo.timeoutMs ?? defaultTimeoutMs,
      maxFrameBytes: tapo.maxFrameBytes ?? defaultMaxFrameBytes
    })
  );

  return client.captureSnapshot();
}

function createConfiguredModel(config: PicoConfig): Promise<PersonDetectionModel> {
  const detector = requireEnabledDetector(config);
  const commonOptions = {
    modelPath: detector.modelPath,
    frameSize: {
      width: detector.inputWidth,
      height: detector.inputHeight
    },
    confidenceThreshold: detector.confidenceThreshold,
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    ...(detector.nmsIouThreshold === undefined
      ? {}
      : { nmsIouThreshold: detector.nmsIouThreshold }),
    preprocessFrame: createSharpRgbTensorPreprocessor({
      inputWidth: detector.inputWidth,
      inputHeight: detector.inputHeight
    })
  };

  if (detector.provider === "coreml") {
    return createCoremlPersonDetectionModel({
      ...commonOptions,
      ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags })
    });
  }

  return createOnnxPersonDetectionModel({
    ...commonOptions,
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout })
  });
}

function requireEnabledDetector(config: PicoConfig): EnabledPersonDetectionConfig {
  const detector = config.vision.personDetection;

  if (!isRunnablePersonDetector(detector)) {
    throw new Error("pico person detection smoke requires a complete person detector config");
  }

  return {
    enabled: true,
    sourceCameraId: requireDetectorString(detector.sourceCameraId),
    modelFamily: "pinto0309",
    provider: detector.provider,
    modelPath: requireDetectorString(detector.modelPath),
    inputWidth: requireDetectorNumber(detector.inputWidth),
    inputHeight: requireDetectorNumber(detector.inputHeight),
    frameIntervalMs: requireDetectorNumber(detector.frameIntervalMs),
    confidenceThreshold: requireDetectorNumber(detector.confidenceThreshold),
    ...optionalDetectorFields(detector)
  };
}

function isRunnablePersonDetector(
  detector: PicoConfig["vision"]["personDetection"]
): detector is PicoConfig["vision"]["personDetection"] & {
  readonly enabled: true;
  readonly modelFamily: "pinto0309";
  readonly provider: "onnxruntime" | "coreml";
} {
  return (
    detector.enabled &&
    detector.modelFamily === "pinto0309" &&
    (detector.provider === "onnxruntime" || detector.provider === "coreml")
  );
}

function optionalDetectorFields(
  detector: PicoConfig["vision"]["personDetection"]
): Pick<
  EnabledPersonDetectionConfig,
  "outputLayout" | "coordinateScale" | "coremlFlags" | "nmsIouThreshold"
> {
  return {
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags }),
    ...(detector.nmsIouThreshold === undefined ? {} : { nmsIouThreshold: detector.nmsIouThreshold })
  };
}

function requireDetectorString(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("pico person detection smoke requires a complete person detector config");
  }

  return value;
}

function requireDetectorNumber(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("pico person detection smoke requires a complete person detector config");
  }

  return value;
}

function smokeProvider(config: PicoConfig): PersonDetectionSmokeProvider {
  return config.vision.personDetection.provider === "coreml"
    ? "tapo-rtsp+coreml"
    : "tapo-rtsp+onnxruntime";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runPersonDetectionSmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = personDetectionSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
