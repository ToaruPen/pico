import { existsSync } from "node:fs";

import sharp from "sharp";

import type { PicoConfig } from "../config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotResult,
  type RtspSnapshotSource
} from "../modules/camera/index.js";
import { defineSelectedModelEndpoint } from "../modules/local-models/index.js";
import {
  createOllamaSceneDescriptionClient,
  type SceneDescription,
  type SceneDescriptionRequest
} from "../modules/vision/index.js";
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
const defaultOllamaEndpointId = "windows-ollama-qwen3-5";
const defaultOllamaTunnelKind = "tailscale_ssh";
const defaultOllamaSshTarget = "pico-vision-host";
const defaultOllamaTimeoutMs = 10_000;
const defaultOllamaMaxImageEdgePixels = 512;

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

export type PicoCameraSceneDescriptionResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly frameBytes: number;
      readonly vlmFrameBytes: number;
      readonly mimeType: "image/jpeg";
      readonly capturedAt: string;
      readonly scene: SceneDescription;
    }
  | {
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
  readonly prepareFrameForVlm?: (
    frame: Uint8Array,
    maxImageEdgePixels: number
  ) => Promise<Uint8Array>;
  readonly describeFrame?: (request: SceneDescriptionRequest) => Promise<SceneDescription>;
  readonly now?: () => string;
};

export function createPicoPerceptionService(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies = {}
): PicoPerceptionService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const inFlightCapturePurposes = new Set<"scene" | "detection">();
  let cameraSceneDescriptionInFlight = false;

  return {
    async captureSceneSnapshot() {
      let source: RtspSnapshotSource;
      try {
        source = buildTapoSceneSnapshotSource(config, "pico_camera_snapshot");
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
    async describeCameraScene() {
      let endpoint: SceneDescriptionRequest["endpoint"];
      let source: RtspSnapshotSource;

      try {
        endpoint = requireOllamaEndpoint(config);
        source = buildTapoSceneSnapshotSource(config, "pico_camera_scene_description");
      } catch (error: unknown) {
        return {
          status: "failed",
          reason: sanitizeRtspMessage(errorMessage(error), config)
        };
      }

      if (cameraSceneDescriptionInFlight) {
        return {
          status: "failed",
          reason:
            "pico camera scene description failed: in_flight: previous camera scene description is still in flight"
        };
      }

      cameraSceneDescriptionInFlight = true;

      try {
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
            reason: `pico camera scene description failed: ${snapshot.reason}: ${sanitizeRtspMessage(
              snapshot.message,
              config,
              source
            )}`
          };
        }

        return await describeSnapshotScene({
          config,
          dependencies,
          endpoint,
          source,
          snapshot,
          now
        });
      } finally {
        cameraSceneDescriptionInFlight = false;
      }
    }
  };
}

function buildTapoSceneSnapshotSource(
  config: PicoConfig,
  toolName: "pico_camera_snapshot" | "pico_camera_scene_description"
): RtspSnapshotSource {
  const tapo = requireTapoConfig(config, toolName);

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
  toolName: "pico_camera_snapshot" | "pico_person_detection" | "pico_camera_scene_description"
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

async function resizeJpegForVlm(
  frame: Uint8Array,
  maxImageEdgePixels: number
): Promise<Uint8Array> {
  return await sharp(frame)
    .rotate()
    .resize({
      width: maxImageEdgePixels,
      height: maxImageEdgePixels,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

type DescribeSnapshotSceneInput = {
  readonly config: PicoConfig;
  readonly dependencies: PicoPerceptionServiceDependencies;
  readonly endpoint: SceneDescriptionRequest["endpoint"];
  readonly source: RtspSnapshotSource;
  readonly snapshot: Extract<RtspSnapshotResult, { readonly ok: true }>;
  readonly now: () => string;
};

async function describeSnapshotScene({
  config,
  dependencies,
  endpoint,
  source,
  snapshot,
  now
}: DescribeSnapshotSceneInput): Promise<PicoCameraSceneDescriptionResult> {
  let preparedFrame: Uint8Array | undefined;

  try {
    const maxImageEdgePixels =
      config.vision.ollama?.maxImageEdgePixels ?? defaultOllamaMaxImageEdgePixels;
    const prepareFrame = dependencies.prepareFrameForVlm ?? resizeJpegForVlm;
    const describeFrame =
      dependencies.describeFrame ?? createOllamaSceneDescriptionClient().describeScene;
    preparedFrame = await prepareFrame(snapshot.frame, maxImageEdgePixels);
    const scene = await describeFrame({
      endpoint,
      image: preparedFrame,
      mimeType: "image/jpeg",
      purpose: "staff_requested_snapshot",
      timeoutMs: config.vision.ollama?.timeoutMs ?? defaultOllamaTimeoutMs
    });
    const imageSensitiveValues = readImageSensitiveValues(snapshot.frame, preparedFrame);

    return {
      status: "passed",
      sourceId: snapshot.sourceId,
      streamPurpose: "scene",
      frameBytes: snapshot.frame.byteLength,
      vlmFrameBytes: preparedFrame.byteLength,
      mimeType: snapshot.mimeType,
      capturedAt: now(),
      scene: sanitizeSceneDescription(scene, config, source, imageSensitiveValues)
    };
  } catch (error: unknown) {
    return {
      status: "failed",
      reason: `pico camera scene description failed: ${sanitizeRtspMessage(
        errorMessage(error),
        config,
        source,
        readImageSensitiveValues(snapshot.frame, preparedFrame)
      )}`
    };
  }
}

function sanitizeSceneDescription(
  scene: SceneDescription,
  config: PicoConfig,
  source: RtspSnapshotSource,
  imageSensitiveValues: readonly string[]
): SceneDescription {
  const sanitizeText = (text: string) =>
    sanitizeRtspMessage(text, config, source, imageSensitiveValues);

  return {
    summary: sanitizeText(scene.summary),
    observedPeople: scene.observedPeople.map(sanitizeText),
    environment: scene.environment.map(sanitizeText),
    humanAttention: scene.humanAttention.map(sanitizeText),
    uncertainty: scene.uncertainty.map(sanitizeText),
    source: scene.source
  };
}

function requireOllamaEndpoint(config: PicoConfig): SceneDescriptionRequest["endpoint"] {
  const ollama = config.vision.ollama;

  if (ollama === undefined) {
    throw new Error("vision.ollama is required to use pico_camera_scene_description");
  }

  return defineSelectedModelEndpoint({
    id: ollama.endpointId ?? defaultOllamaEndpointId,
    provider: "ollama",
    model: "qwen3.5:9b",
    host: {
      platform: "windows",
      tunnel: {
        kind: ollama.tunnel?.kind ?? defaultOllamaTunnelKind,
        localBaseUrl: ollama.localBaseUrl,
        sshTarget: ollama.tunnel?.sshTarget ?? defaultOllamaSshTarget
      },
      ...defineOllamaEndpointAuth(ollama.auth)
    }
  });
}

function defineOllamaEndpointAuth(auth: NonNullable<PicoConfig["vision"]["ollama"]>["auth"]): {
  readonly auth?: NonNullable<SceneDescriptionRequest["endpoint"]["host"]["auth"]>;
} {
  if (auth === undefined) {
    return {};
  }

  return {
    auth: {
      ...(auth.headerName === undefined ? {} : { headerName: auth.headerName }),
      apiKey: auth.apiKey
    }
  };
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
  source?: RtspSnapshotSource,
  imageSensitiveValues: readonly string[] = []
): string {
  let sanitized = message
    .replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]")
    .replaceAll(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[redacted-image]");

  for (const value of rtspSensitiveValues(config, source)) {
    sanitized = sanitized.replaceAll(value, "[redacted]");
  }

  for (const value of imageSensitiveValues) {
    sanitized = sanitized.replaceAll(value, "[redacted-image]");
  }

  return redactKnownImageBase64Tokens(sanitized, imageSensitiveValues);
}

function redactKnownImageBase64Tokens(
  message: string,
  imageSensitiveValues: readonly string[]
): string {
  return message.replaceAll(/[A-Za-z0-9+/]{32,}={0,2}/gu, (candidate) =>
    imageSensitiveValues.some((value) => value.startsWith(candidate))
      ? "[redacted-image]"
      : candidate
  );
}

function readImageSensitiveValues(
  ...frames: readonly (Uint8Array | undefined)[]
): readonly string[] {
  return frames.flatMap((frame) =>
    frame === undefined || frame.byteLength === 0 ? [] : [Buffer.from(frame).toString("base64")]
  );
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
  appendSensitiveValue(values, config.vision.ollama?.auth?.apiKey);

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
