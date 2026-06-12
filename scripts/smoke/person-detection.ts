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

export type PersonDetectionSmokeReport = {
  readonly status: PersonDetectionSmokeStatus;
  readonly provider: "tapo-rtsp+onnxruntime";
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

type EnabledOnnxPersonDetectionConfig = {
  readonly enabled: true;
  readonly sourceCameraId: string;
  readonly modelFamily: "pinto0309";
  readonly provider: "onnxruntime";
  readonly modelPath: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly outputLayout?: "xyxy_score_class" | "cxcywh_score_class";
  readonly coordinateScale?: "pixel" | "normalized";
  readonly frameIntervalMs: number;
  readonly confidenceThreshold: number;
};

export async function runPersonDetectionSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  dependencies: PersonDetectionSmokeDependencies = {}
): Promise<PersonDetectionSmokeReport> {
  const plan = buildPersonDetectionSmokePlan(config, dependencies);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "tapo-rtsp+onnxruntime",
      reason: plan.reason
    };
  }

  const captureFrame = dependencies.captureFrame ?? captureTapoFrame;
  const createModel = dependencies.createModel ?? createConfiguredOnnxModel;
  const capturedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const snapshot = await captureFrame(plan.config);

  if (!snapshot.ok) {
    return {
      status: "failed",
      provider: "tapo-rtsp+onnxruntime",
      reason: `pico person detection smoke capture failed: ${snapshot.reason}: ${snapshot.message}`
    };
  }

  const model = await createModel(plan.config);
  const rawDetections = await model.detect(snapshot.frame);
  const detectorConfig = requireEnabledOnnxDetector(plan.config);
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
    provider: "tapo-rtsp+onnxruntime",
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

  if (detector.provider !== "onnxruntime") {
    return {
      status: "skip",
      reason: "pico person detection smoke currently supports provider=onnxruntime."
    };
  }

  if (config.camera.tapo === undefined) {
    return {
      status: "skip",
      reason: "Set camera.tapo in pico config to run the person detection smoke."
    };
  }

  const onnxDetector = requireEnabledOnnxDetector(config);
  const pathExists = dependencies.pathExists ?? existsSync;
  if (!pathExists(onnxDetector.modelPath)) {
    return {
      status: "skip",
      reason: `pico person detection smoke model file not found: ${onnxDetector.modelPath}`
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
  const detector = requireEnabledOnnxDetector(config);

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

function createConfiguredOnnxModel(config: PicoConfig): Promise<PersonDetectionModel> {
  const detector = requireEnabledOnnxDetector(config);

  return createOnnxPersonDetectionModel({
    modelPath: detector.modelPath,
    frameSize: {
      width: detector.inputWidth,
      height: detector.inputHeight
    },
    confidenceThreshold: detector.confidenceThreshold,
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    preprocessFrame: createSharpRgbTensorPreprocessor({
      inputWidth: detector.inputWidth,
      inputHeight: detector.inputHeight
    })
  });
}

function requireEnabledOnnxDetector(config: PicoConfig): EnabledOnnxPersonDetectionConfig {
  const detector = config.vision.personDetection;

  if (
    !detector.enabled ||
    detector.modelFamily !== "pinto0309" ||
    detector.provider !== "onnxruntime"
  ) {
    throw new Error("pico person detection smoke requires a complete ONNX detector config");
  }

  return {
    enabled: true,
    sourceCameraId: requireDetectorString(detector.sourceCameraId),
    modelFamily: "pinto0309",
    provider: "onnxruntime",
    modelPath: requireDetectorString(detector.modelPath),
    inputWidth: requireDetectorNumber(detector.inputWidth),
    inputHeight: requireDetectorNumber(detector.inputHeight),
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    frameIntervalMs: requireDetectorNumber(detector.frameIntervalMs),
    confidenceThreshold: requireDetectorNumber(detector.confidenceThreshold)
  };
}

function requireDetectorString(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("pico person detection smoke requires a complete ONNX detector config");
  }

  return value;
}

function requireDetectorNumber(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("pico person detection smoke requires a complete ONNX detector config");
  }

  return value;
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
