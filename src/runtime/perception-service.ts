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
  createStackChanAdapterFromConfig,
  type StackChanJpegFrame
} from "../modules/stackchan/index.js";
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
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";

const defaultTapoSceneStream = "stream1";
const defaultTapoDetectionStream = "stream2";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;
const defaultOllamaEndpointId = "windows-ollama-qwen3-5";
const defaultOllamaTunnelKind = "tailscale_ssh";
const defaultOllamaSshTarget = "pico-vision-host";

export const PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON =
  "pico camera scene description route is not configured";

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

export type PicoSceneRoute = {
  readonly provider: "ollama" | "agent";
  readonly source: "tapo" | "stackchan";
  readonly timeoutMs: number;
  readonly maxImageEdgePixels: number;
};

export type PicoCameraSceneFrameResult =
  | {
      readonly status: "passed";
      readonly provider: "ollama" | "agent";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly frameBytes: number;
      readonly vlmFrameBytes: number;
      readonly mimeType: "image/jpeg";
      readonly capturedAt: string;
      readonly image: Uint8Array;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoPerceptionService = {
  readonly sceneRoute?: PicoSceneRoute;
  readonly captureSceneSnapshot: () => Promise<PicoCameraSnapshotResult>;
  readonly captureSceneFrame: () => Promise<PicoCameraSceneFrameResult>;
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
  readonly captureStackChanFrame?: () => Promise<StackChanJpegFrame>;
  readonly probe?: VoiceStageProbe;
  readonly now?: () => string;
};

function resolveSceneRoute(config: PicoConfig): PicoSceneRoute | undefined {
  return config.vision.sceneDescription;
}

export function createPicoPerceptionService(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies = {}
): PicoPerceptionService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sceneRoute = resolveSceneRoute(config);
  const inFlightCapturePurposes = new Set<"scene" | "detection">();
  let cameraSceneDescriptionInFlight = false;

  return {
    ...(sceneRoute === undefined ? {} : { sceneRoute }),
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
        dependencies,
        now
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
    async captureSceneFrame() {
      if (sceneRoute === undefined) {
        return {
          status: "failed",
          reason: PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON
        };
      }

      if (cameraSceneDescriptionInFlight) {
        return {
          status: "failed",
          reason:
            "pico camera scene frame failed: in_flight: previous camera scene operation is still in flight"
        };
      }

      cameraSceneDescriptionInFlight = true;
      try {
        return await capturePreparedSceneFrame({
          config,
          dependencies,
          route: sceneRoute,
          inFlightCapturePurposes,
          now
        });
      } finally {
        cameraSceneDescriptionInFlight = false;
      }
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
        dependencies,
        now
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
      if (sceneRoute === undefined) {
        return {
          status: "failed",
          reason: PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON
        };
      }

      if (sceneRoute.provider === "agent") {
        return {
          status: "failed",
          reason:
            "pico camera scene description failed: agent route requires the standard image-capable scene tool"
        };
      }

      let endpoint: SceneDescriptionRequest["endpoint"];
      try {
        endpoint = requireOllamaEndpoint(config);
        if (sceneRoute.source === "tapo") {
          buildTapoSceneSnapshotSource(config, "pico_camera_scene_description");
        } else if (config.camera.stackchan === undefined) {
          throw new Error("camera.stackchan is required to use pico_camera_scene_description");
        }
      } catch (error) {
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
        const frame = await capturePreparedSceneFrame({
          config,
          dependencies,
          route: sceneRoute,
          inFlightCapturePurposes,
          now
        });

        if (frame.status === "failed") {
          return frame;
        }

        return await describePreparedSceneFrame({
          config,
          dependencies,
          route: sceneRoute,
          frame,
          endpoint,
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

type CapturedRawSceneFrame = {
  readonly sourceId: string;
  readonly mimeType: "image/jpeg";
  readonly frame: Uint8Array;
  readonly source?: RtspSnapshotSource;
};

type CapturePreparedSceneFrameInput = {
  readonly config: PicoConfig;
  readonly dependencies: PicoPerceptionServiceDependencies;
  readonly route: PicoSceneRoute;
  readonly inFlightCapturePurposes: Set<"scene" | "detection">;
  readonly now: () => string;
};

async function capturePreparedSceneFrame({
  config,
  dependencies,
  route,
  inFlightCapturePurposes,
  now
}: CapturePreparedSceneFrameInput): Promise<PicoCameraSceneFrameResult> {
  let captured: CapturedRawSceneFrame;

  try {
    captured = await captureConfiguredSceneFrame(
      config,
      route,
      inFlightCapturePurposes,
      dependencies,
      now
    );
  } catch (error) {
    return {
      status: "failed",
      reason: `pico camera scene description failed: ${sanitizeRtspMessage(
        errorMessage(error),
        config
      )}`
    };
  }

  let preparedFrame: Uint8Array | undefined;
  const preparationStartedAt = now();
  const preparationStartedMs = performance.now();
  try {
    const prepareFrame = dependencies.prepareFrameForVlm ?? resizeJpegForVlm;
    preparedFrame = await prepareFrame(captured.frame, route.maxImageEdgePixels);

    return {
      status: "passed",
      provider: route.provider,
      sourceId: captured.sourceId,
      streamPurpose: "scene",
      frameBytes: captured.frame.byteLength,
      vlmFrameBytes: preparedFrame.byteLength,
      mimeType: captured.mimeType,
      capturedAt: now(),
      image: preparedFrame
    };
  } catch (error) {
    recordPerceptionStage(
      dependencies.probe,
      "vlm_scene_description",
      "error",
      preparationStartedAt,
      preparationStartedMs
    );
    return {
      status: "failed",
      reason: `pico camera scene description failed: ${sanitizeRtspMessage(
        errorMessage(error),
        config,
        captured.source,
        readImageSensitiveValues(captured.frame, preparedFrame)
      )}`
    };
  }
}

async function captureConfiguredSceneFrame(
  config: PicoConfig,
  route: PicoSceneRoute,
  inFlightCapturePurposes: Set<"scene" | "detection">,
  dependencies: PicoPerceptionServiceDependencies,
  now: () => string
): Promise<CapturedRawSceneFrame> {
  if (route.source === "stackchan") {
    return captureStackChanSceneFrame(config, dependencies, now);
  }

  const source = buildTapoSceneSnapshotSource(config, "pico_camera_scene_description");
  const snapshot = await captureSnapshotSafely(
    config,
    source,
    "scene",
    inFlightCapturePurposes,
    dependencies,
    now
  );

  if (!snapshot.ok) {
    throw new Error(`${snapshot.reason}: ${sanitizeRtspMessage(snapshot.message, config, source)}`);
  }

  return {
    sourceId: snapshot.sourceId,
    mimeType: snapshot.mimeType,
    frame: snapshot.frame,
    source
  };
}

async function captureStackChanSceneFrame(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies,
  now: () => string
): Promise<CapturedRawSceneFrame> {
  const stackchan = config.camera.stackchan;
  if (stackchan === undefined) {
    throw new Error("camera.stackchan is required to capture a StackChan scene");
  }

  const startedAt = now();
  const startedMs = performance.now();

  try {
    const frame = await (
      dependencies.captureStackChanFrame ?? (() => captureStackChanFrameOnce(stackchan))
    )();
    recordPerceptionStage(dependencies.probe, "camera_capture", "ok", startedAt, startedMs, {
      "pico.voice.frame_bytes": frame.bytes.byteLength
    });

    return {
      sourceId: stackchan.sourceId ?? "stackchan-core-s3",
      mimeType: frame.mimeType,
      frame: frame.bytes
    };
  } catch (error) {
    recordPerceptionStage(dependencies.probe, "camera_capture", "error", startedAt, startedMs);
    throw error;
  }
}

async function captureStackChanFrameOnce(
  config: NonNullable<PicoConfig["camera"]["stackchan"]>
): Promise<StackChanJpegFrame> {
  const adapter = createStackChanAdapterFromConfig(config);
  await adapter.connect();
  try {
    return await adapter.captureJpeg();
  } finally {
    await adapter.close();
  }
}

type DescribePreparedSceneFrameInput = {
  readonly config: PicoConfig;
  readonly dependencies: PicoPerceptionServiceDependencies;
  readonly route: PicoSceneRoute;
  readonly frame: Extract<PicoCameraSceneFrameResult, { readonly status: "passed" }>;
  readonly endpoint: SceneDescriptionRequest["endpoint"];
  readonly now: () => string;
};

async function describePreparedSceneFrame({
  config,
  dependencies,
  route,
  frame,
  endpoint,
  now
}: DescribePreparedSceneFrameInput): Promise<PicoCameraSceneDescriptionResult> {
  const vlmStartedAt = now();
  const vlmStartedMs = performance.now();

  try {
    const describeFrame =
      dependencies.describeFrame ?? createOllamaSceneDescriptionClient().describeScene;
    const scene = await describeFrame({
      endpoint,
      image: frame.image,
      mimeType: "image/jpeg",
      purpose: "staff_requested_snapshot",
      timeoutMs: route.timeoutMs
    });
    recordPerceptionStage(
      dependencies.probe,
      "vlm_scene_description",
      "ok",
      vlmStartedAt,
      vlmStartedMs,
      {
        "pico.voice.frame_bytes": frame.frameBytes,
        "pico.voice.vlm_frame_bytes": frame.vlmFrameBytes
      }
    );
    const imageSensitiveValues = readImageSensitiveValues(frame.image);

    return {
      status: "passed",
      sourceId: frame.sourceId,
      streamPurpose: "scene",
      frameBytes: frame.frameBytes,
      vlmFrameBytes: frame.vlmFrameBytes,
      mimeType: frame.mimeType,
      capturedAt: frame.capturedAt,
      scene: sanitizeSceneDescription(scene, config, undefined, imageSensitiveValues)
    };
  } catch (error: unknown) {
    recordVlmSceneDescriptionError(dependencies.probe, frame, vlmStartedAt, vlmStartedMs);

    return {
      status: "failed",
      reason: `pico camera scene description failed: ${sanitizeRtspMessage(
        errorMessage(error),
        config,
        undefined,
        readImageSensitiveValues(frame.image)
      )}`
    };
  }
}

function recordVlmSceneDescriptionError(
  probe: VoiceStageProbe | undefined,
  frame: Extract<PicoCameraSceneFrameResult, { readonly status: "passed" }>,
  startedAt: string,
  startedMs: number
): void {
  recordPerceptionStage(probe, "vlm_scene_description", "error", startedAt, startedMs, {
    "pico.voice.frame_bytes": frame.frameBytes,
    "pico.voice.vlm_frame_bytes": frame.vlmFrameBytes
  });
}

function sanitizeSceneDescription(
  scene: SceneDescription,
  config: PicoConfig,
  source: RtspSnapshotSource | undefined,
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
  dependencies: PicoPerceptionServiceDependencies,
  now: () => string
): Promise<RtspSnapshotResult> {
  const tapo = config.camera.tapo;
  const timeoutMs = tapo?.timeoutMs ?? defaultTimeoutMs;
  const maxFrameBytes = tapo?.maxFrameBytes ?? defaultMaxFrameBytes;
  const startedAt = now();
  const startedMs = performance.now();

  if (inFlightCapturePurposes.has(purpose)) {
    return skippedCaptureResult(source, dependencies.probe, startedAt, startedMs);
  }

  try {
    inFlightCapturePurposes.add(purpose);

    return await captureSnapshotWithProbe({
      source,
      timeoutMs,
      maxFrameBytes,
      dependencies,
      startedAt,
      startedMs
    });
  } catch (error: unknown) {
    recordPerceptionStage(dependencies.probe, "camera_capture", "error", startedAt, startedMs);

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

function skippedCaptureResult(
  source: RtspSnapshotSource,
  probe: VoiceStageProbe | undefined,
  startedAt: string,
  startedMs: number
): RtspSnapshotResult {
  recordPerceptionStage(probe, "camera_capture", "skipped", startedAt, startedMs);

  return {
    ok: false,
    sourceId: source.id,
    reason: "in_flight",
    message: "previous RTSP snapshot capture is still in flight"
  };
}

async function captureSnapshotWithProbe(input: {
  readonly source: RtspSnapshotSource;
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
  readonly dependencies: PicoPerceptionServiceDependencies;
  readonly startedAt: string;
  readonly startedMs: number;
}): Promise<RtspSnapshotResult> {
  const result = await (input.dependencies.captureSnapshot ?? captureSnapshotWithRtsp)(
    input.source,
    input.timeoutMs,
    input.maxFrameBytes
  );

  recordPerceptionStage(
    input.dependencies.probe,
    "camera_capture",
    result.ok ? "ok" : "error",
    input.startedAt,
    input.startedMs,
    result.ok ? { "pico.voice.frame_bytes": result.frame.byteLength } : {}
  );

  return result;
}

function recordPerceptionStage(
  probe: VoiceStageProbe | undefined,
  stage: "camera_capture" | "vlm_scene_description",
  status: "ok" | "error" | "skipped",
  startedAt: string,
  startedMs: number,
  attributes: Readonly<Record<string, number>> = {}
): void {
  recordVoiceStageProbe(probe ?? {}, {
    stage,
    status,
    startedAt,
    durationMs: Math.max(0, performance.now() - startedMs),
    attributes
  });
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
    imageSensitiveValues.some((value) => value.includes(candidate)) ? "[redacted-image]" : candidate
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
