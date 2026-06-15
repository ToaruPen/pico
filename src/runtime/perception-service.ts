import { existsSync } from "node:fs";

import type { PicoConfig } from "../config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotResult,
  type RtspSnapshotSource
} from "../modules/camera/index.js";
import {
  createCoremlPersonDetectionModel,
  createOnnxPersonDetectionModel,
  createSharpRgbTensorPreprocessor,
  normalizePersonDetectionFrame,
  type PersonDetection,
  type PersonDetectionModel
} from "../modules/vision/person-detection.js";

const defaultTapoSceneStream = "stream1";
const defaultTapoDetectionStream = "stream2";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;

export type PicoCameraSnapshotResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly mimeType: "image/jpeg";
      readonly frameBytes: number;
      readonly capturedAt: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoPersonDetectionResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "detection";
      readonly frameBytes: number;
      readonly capturedAt: string;
      readonly detectedPeople: number;
      readonly detections: readonly PersonDetection[];
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoCameraSceneDescriptionResult = {
  readonly status: "failed";
  readonly reason: string;
};

export type PicoPerceptionService = {
  readonly captureSceneSnapshot: () => Promise<PicoCameraSnapshotResult>;
  readonly detectPeople: () => Promise<PicoPersonDetectionResult>;
  readonly describeCameraScene: () => Promise<PicoCameraSceneDescriptionResult>;
};

export type PicoPerceptionServiceDependencies = {
  readonly captureSnapshot?: (
    source: RtspSnapshotSource,
    timeoutMs: number,
    maxFrameBytes: number
  ) => Promise<RtspSnapshotResult>;
  readonly pathExists?: (path: string) => boolean;
  readonly createPersonDetectionModel?: (config: PicoConfig) => Promise<PersonDetectionModel>;
  readonly now?: () => string;
};

export function createPicoPerceptionService(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies = {}
): PicoPerceptionService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const inFlightCapturePurposes = new Set<"scene" | "detection">();

  return {
    async captureSceneSnapshot() {
      let source: RtspSnapshotSource;
      try {
        source = buildTapoSceneSnapshotSource(config);
      } catch (error: unknown) {
        return {
          status: "failed",
          reason: sanitizeRtspMessage(errorMessage(error), config)
        };
      }

      const snapshot = await captureSnapshotSafely(
        config,
        source,
        "scene",
        inFlightCapturePurposes,
        dependencies
      );

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico camera snapshot failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      return {
        status: "passed",
        sourceId: snapshot.sourceId,
        streamPurpose: "scene",
        mimeType: snapshot.mimeType,
        frameBytes: snapshot.frame.byteLength,
        capturedAt: now()
      };
    },
    async detectPeople() {
      let detector: EnabledPersonDetectionConfig;
      let source: RtspSnapshotSource;

      try {
        detector = requireEnabledPersonDetectionConfig(config);
        source = buildTapoDetectionSnapshotSource(config, detector.sourceCameraId);
      } catch (error: unknown) {
        return {
          status: "failed",
          reason: sanitizeRtspMessage(errorMessage(error), config)
        };
      }

      const pathExists = dependencies.pathExists ?? existsSync;

      if (!pathExists(detector.modelPath)) {
        return {
          status: "failed",
          reason: "vision.personDetection model file is required to use pico_person_detection"
        };
      }

      const snapshot = await captureSnapshotSafely(
        config,
        source,
        "detection",
        inFlightCapturePurposes,
        dependencies
      );

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico person detection failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      const capturedAt = now();

      try {
        const model =
          dependencies.createPersonDetectionModel === undefined
            ? await createConfiguredPersonDetectionModel(config)
            : await dependencies.createPersonDetectionModel(config);
        const detections = await model.detect(snapshot.frame);
        const normalized = normalizePersonDetectionFrame({
          sourceId: snapshot.sourceId,
          capturedAt,
          frameSize: {
            width: detector.inputWidth,
            height: detector.inputHeight
          },
          confidenceThreshold: detector.confidenceThreshold,
          detections
        });

        return {
          status: "passed",
          sourceId: normalized.sourceId,
          streamPurpose: "detection",
          frameBytes: snapshot.frame.byteLength,
          capturedAt: normalized.capturedAt,
          detectedPeople: normalized.detections.length,
          detections: normalized.detections
        };
      } catch (error: unknown) {
        return {
          status: "failed",
          reason: `pico person detection failed: detect_failed: ${sanitizeRtspMessage(
            errorMessage(error),
            config,
            source
          )}`
        };
      }
    },
    describeCameraScene() {
      return Promise.resolve({
        status: "failed",
        reason: "pico camera scene description is not implemented yet"
      });
    }
  };
}

function buildTapoSceneSnapshotSource(config: PicoConfig): RtspSnapshotSource {
  const tapo = requireTapoConfig(config, "pico_camera_snapshot");

  return defineRtspSnapshotSource({
    id: tapo.sourceId ?? "tapo-rtsp",
    host: tapo.host,
    username: tapo.user,
    password: tapo.password,
    stream: tapo.streams?.scene ?? defaultTapoSceneStream,
    port: tapo.port ?? defaultTapoPort
  });
}

function buildTapoDetectionSnapshotSource(
  config: PicoConfig,
  sourceCameraId: string
): RtspSnapshotSource {
  const tapo = requireTapoConfig(config, "pico_person_detection");

  return defineRtspSnapshotSource({
    id: sourceCameraId,
    host: tapo.host,
    username: tapo.user,
    password: tapo.password,
    stream: tapo.streams?.detection ?? defaultTapoDetectionStream,
    port: tapo.port ?? defaultTapoPort
  });
}

function requireTapoConfig(
  config: PicoConfig,
  toolName: "pico_camera_snapshot" | "pico_person_detection"
): NonNullable<PicoConfig["camera"]["tapo"]> {
  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    throw new Error(`camera.tapo is required to use ${toolName}`);
  }

  return tapo;
}

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

function requireEnabledPersonDetectionConfig(config: PicoConfig): EnabledPersonDetectionConfig {
  const detector = config.vision.personDetection;

  if (!detector.enabled || detector.modelFamily !== "pinto0309") {
    throw new Error("vision.personDetection.enabled=true is required to use pico_person_detection");
  }

  const provider = requireSupportedPersonDetectionProvider(detector.provider);

  return {
    enabled: true,
    sourceCameraId: requireString(
      detector.sourceCameraId,
      "vision.personDetection.sourceCameraId is required"
    ),
    modelFamily: "pinto0309",
    provider,
    modelPath: requireString(detector.modelPath, "vision.personDetection.modelPath is required"),
    inputWidth: requireNumber(detector.inputWidth, "vision.personDetection.inputWidth is required"),
    inputHeight: requireNumber(
      detector.inputHeight,
      "vision.personDetection.inputHeight is required"
    ),
    frameIntervalMs: requireNumber(
      detector.frameIntervalMs,
      "vision.personDetection.frameIntervalMs is required"
    ),
    confidenceThreshold: requireNumber(
      detector.confidenceThreshold,
      "vision.personDetection.confidenceThreshold is required"
    ),
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags }),
    ...(detector.nmsIouThreshold === undefined ? {} : { nmsIouThreshold: detector.nmsIouThreshold })
  };
}

function requireSupportedPersonDetectionProvider(
  provider: PicoConfig["vision"]["personDetection"]["provider"]
): "onnxruntime" | "coreml" {
  if (provider !== "onnxruntime" && provider !== "coreml") {
    throw new Error(
      "vision.personDetection.provider must be onnxruntime or coreml to use pico_person_detection"
    );
  }

  return provider;
}

function createConfiguredPersonDetectionModel(config: PicoConfig): Promise<PersonDetectionModel> {
  const detector = requireEnabledPersonDetectionConfig(config);
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

function requireString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function requireNumber(value: number | undefined, message: string): number {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

async function captureSnapshotSafely(
  config: PicoConfig,
  source: RtspSnapshotSource,
  purpose: "scene" | "detection",
  inFlightCapturePurposes: Set<"scene" | "detection">,
  dependencies: PicoPerceptionServiceDependencies
): Promise<RtspSnapshotResult> {
  const tapo = config.camera.tapo;
  const timeoutMs = tapo?.timeoutMs ?? defaultTimeoutMs;
  const maxFrameBytes = tapo?.maxFrameBytes ?? defaultMaxFrameBytes;

  if (inFlightCapturePurposes.has(purpose)) {
    return {
      ok: false,
      sourceId: source.id,
      reason: "in_flight",
      message: "previous RTSP snapshot capture is still in flight"
    };
  }

  try {
    inFlightCapturePurposes.add(purpose);

    return await (dependencies.captureSnapshot ?? captureSnapshotWithRtsp)(
      source,
      timeoutMs,
      maxFrameBytes
    );
  } catch (error: unknown) {
    return {
      ok: false,
      sourceId: source.id,
      reason: "capture_failed",
      message: errorMessage(error)
    };
  } finally {
    inFlightCapturePurposes.delete(purpose);
  }
}

function captureSnapshotWithRtsp(
  source: RtspSnapshotSource,
  timeoutMs: number,
  maxFrameBytes: number
): Promise<RtspSnapshotResult> {
  const transport = createFfmpegRtspSnapshotTransport({
    timeoutMs,
    maxFrameBytes
  });
  const client = createRtspSnapshotClient(source, transport);

  return client.captureSnapshot();
}

function sanitizeRtspMessage(
  message: string,
  config: PicoConfig,
  source?: RtspSnapshotSource
): string {
  let sanitized = message.replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]");

  for (const value of rtspSensitiveValues(config, source)) {
    sanitized = sanitized.replaceAll(value, "[redacted]");
  }

  return sanitized;
}

function rtspSensitiveValues(config: PicoConfig, source?: RtspSnapshotSource): readonly string[] {
  const values: string[] = [];
  const tapo = config.camera.tapo;

  appendSensitiveValue(values, source?.url);

  if (tapo !== undefined) {
    appendSensitiveValue(values, tapo.user);
    appendSensitiveValue(values, tapo.password);
  }

  appendSensitiveValue(values, config.vision.personDetection.modelPath);

  return values;
}

function appendSensitiveValue(values: string[], value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    return;
  }

  values.push(value, encodeURIComponent(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
