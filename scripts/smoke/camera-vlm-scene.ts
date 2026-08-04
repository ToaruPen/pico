#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient
} from "../../src/modules/camera/index.js";
import type { StackChanJpegFrame } from "../../src/modules/stackchan/index.js";
import {
  createOllamaSceneDescriptionClient,
  type SceneDescription,
  type SceneDescriptionRequest
} from "../../src/modules/vision/index.js";
import {
  createPicoPerceptionService,
  PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON,
  type PicoCameraSceneFrameResult
} from "../../src/runtime/perception-service.js";
import { buildOllamaVlmSmokePlan } from "./ollama-vlm-connectivity.js";
import { readRtspSensitiveValues, redactRtspSensitiveValues } from "./rtsp-redaction.js";
import { buildTapoRtspSmokePlan } from "./tapo-rtsp-snapshot.js";

export type CameraVlmSceneSmokeStatus = "passed" | "failed" | "skipped";

export type CameraVlmSceneSmokeReport =
  | {
      readonly status: "failed";
      readonly reason: string;
    }
  | {
      readonly status: "passed";
      readonly provider: "tapo-rtsp+ollama";
      readonly details: {
        readonly sourceId: string;
        readonly frameBytes: number;
        readonly vlmFrameBytes: number;
        readonly mimeType: "image/jpeg";
        readonly endpointId: string;
        readonly model: "qwen3.5:9b";
        readonly timeoutMs: number;
        readonly scene: SceneDescription;
      };
    }
  | {
      readonly status: "passed";
      readonly provider: "agent";
      readonly source: "tapo" | "stackchan";
      readonly details: {
        readonly sourceId: string;
        readonly frameBytes: number;
        readonly vlmFrameBytes: number;
        readonly mimeType: "image/jpeg";
        readonly timeoutMs: number;
        readonly preparedForActiveAgent: true;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "tapo-rtsp+ollama";
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly provider: "agent";
      readonly source: "tapo" | "stackchan";
      readonly reason: string;
    }
  | {
      readonly status: "passed";
      readonly provider: "stackchan+ollama";
      readonly source: "stackchan";
      readonly details: {
        readonly sourceId: string;
        readonly frameBytes: number;
        readonly vlmFrameBytes: number;
        readonly mimeType: "image/jpeg";
        readonly endpointId: string;
        readonly model: "qwen3.5:9b";
        readonly timeoutMs: number;
        readonly scene: SceneDescription;
      };
    }
  | {
      readonly status: "failed";
      readonly provider: "stackchan+ollama";
      readonly source: "stackchan";
      readonly reason: string;
    };

type CameraVlmSceneSmokePlan = {
  readonly camera: Extract<ReturnType<typeof buildTapoRtspSmokePlan>, { readonly status: "run" }>;
  readonly vlm: Extract<ReturnType<typeof buildOllamaVlmSmokePlan>, { readonly status: "run" }>;
  readonly timeoutMs: number;
  readonly maxImageEdgePixels: number;
  readonly sensitiveValues: readonly string[];
};

type CapturedFrame = {
  readonly sourceId: string;
  readonly mimeType: "image/jpeg";
  readonly frame: Uint8Array;
};

export type CameraVlmSceneSmokeDependencies = {
  readonly captureFrame?: (plan: CameraVlmSceneSmokePlan) => Promise<CapturedFrame>;
  readonly prepareFrame?: (frame: Uint8Array, maxImageEdgePixels: number) => Promise<Uint8Array>;
  readonly describeFrame?: (request: SceneDescriptionRequest) => Promise<SceneDescription>;
  readonly captureAgentSceneFrame?: () => Promise<PicoCameraSceneFrameResult>;
  readonly captureStackChanFrame?: () => Promise<StackChanJpegFrame>;
};

// eslint-disable-next-line complexity
export async function runCameraVlmSceneSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  dependencies: CameraVlmSceneSmokeDependencies = {}
): Promise<CameraVlmSceneSmokeReport> {
  const route = config.vision.sceneDescription;
  if (route === undefined) {
    return {
      status: "failed",
      reason: PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON
    };
  }

  if (route.provider === "agent") {
    return runAgentScenePreparation(config, dependencies);
  }

  if (route.source === "stackchan") {
    return runStackChanOllamaScene(config, dependencies);
  }

  const plan = buildCameraVlmSceneSmokePlan(config);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "tapo-rtsp+ollama",
      reason: plan.reason
    };
  }

  const captureFrame = dependencies.captureFrame ?? captureFrameWithRtsp;
  const prepareFrame = dependencies.prepareFrame ?? resizeJpegForVlm;
  const describeFrame =
    dependencies.describeFrame ?? createOllamaSceneDescriptionClient().describeScene;

  let captured: CapturedFrame;
  let preparedFrame: Uint8Array;
  let scene: SceneDescription;

  try {
    captured = await captureSceneFrame(plan, captureFrame);
    preparedFrame = await prepareSceneFrame(plan, captured.frame, prepareFrame);
    scene = await describeSceneFrame(plan, preparedFrame, describeFrame);
  } catch (error) {
    return cameraVlmSceneFailureReport(error);
  }

  return {
    status: "passed",
    provider: "tapo-rtsp+ollama",
    details: {
      sourceId: captured.sourceId,
      frameBytes: captured.frame.byteLength,
      vlmFrameBytes: preparedFrame.byteLength,
      mimeType: captured.mimeType,
      endpointId: scene.source.endpointId,
      model: scene.source.model,
      timeoutMs: plan.timeoutMs,
      scene
    }
  };
}

async function runAgentScenePreparation(
  config: PicoConfig,
  dependencies: CameraVlmSceneSmokeDependencies
): Promise<CameraVlmSceneSmokeReport> {
  const route = config.vision.sceneDescription;
  if (route?.provider !== "agent") {
    throw new Error("agent scene route is required");
  }

  try {
    const frame = await (
      dependencies.captureAgentSceneFrame ?? createPicoPerceptionService(config).captureSceneFrame
    )();
    if (frame.status === "failed") {
      return {
        status: "failed",
        provider: "agent",
        source: route.source,
        reason: frame.reason
      };
    }

    return {
      status: "passed",
      provider: "agent",
      source: route.source,
      details: {
        sourceId: frame.sourceId,
        frameBytes: frame.frameBytes,
        vlmFrameBytes: frame.vlmFrameBytes,
        mimeType: frame.mimeType,
        timeoutMs: route.timeoutMs,
        preparedForActiveAgent: true
      }
    };
  } catch {
    return {
      status: "failed",
      provider: "agent",
      source: route.source,
      reason: "pico agent scene preparation failed"
    };
  }
}

async function runStackChanOllamaScene(
  config: PicoConfig,
  dependencies: CameraVlmSceneSmokeDependencies
): Promise<CameraVlmSceneSmokeReport> {
  const route = config.vision.sceneDescription;
  if (route?.provider !== "ollama" || route.source !== "stackchan") {
    throw new Error("StackChan Ollama scene route is required");
  }

  const result = await createPicoPerceptionService(config, {
    ...(dependencies.captureStackChanFrame === undefined
      ? {}
      : { captureStackChanFrame: dependencies.captureStackChanFrame }),
    ...(dependencies.prepareFrame === undefined
      ? {}
      : { prepareFrameForVlm: dependencies.prepareFrame }),
    ...(dependencies.describeFrame === undefined
      ? {}
      : { describeFrame: dependencies.describeFrame })
  }).describeCameraScene();

  if (result.status === "failed") {
    return {
      status: "failed",
      provider: "stackchan+ollama",
      source: "stackchan",
      reason: result.reason
    };
  }

  return {
    status: "passed",
    provider: "stackchan+ollama",
    source: "stackchan",
    details: {
      sourceId: result.sourceId,
      frameBytes: result.frameBytes,
      vlmFrameBytes: result.vlmFrameBytes,
      mimeType: result.mimeType,
      endpointId: result.scene.source.endpointId,
      model: result.scene.source.model,
      timeoutMs: route.timeoutMs,
      scene: result.scene
    }
  };
}

function cameraVlmSceneFailureReport(error: unknown): CameraVlmSceneSmokeReport {
  if (error instanceof CameraVlmSceneSmokeError) {
    return {
      status: "failed",
      provider: "tapo-rtsp+ollama",
      reason: error.message
    };
  }

  throw error;
}

export function cameraVlmSceneSmokeExitCode(report: CameraVlmSceneSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

export function formatCameraVlmSceneSmokeFatalError(error: unknown, config?: PicoConfig): string {
  const sensitiveValues = config === undefined ? [] : readDirectExecutionSensitiveValues(config);

  return redactRtspSensitiveValues(errorMessage(error), sensitiveValues);
}

function buildCameraVlmSceneSmokePlan(config: PicoConfig):
  | ({ readonly status: "run" } & CameraVlmSceneSmokePlan)
  | {
      readonly status: "skip";
      readonly reason: string;
    } {
  const route = config.vision.sceneDescription;
  if (route?.provider !== "ollama" || route.source !== "tapo") {
    throw new Error("Tapo Ollama scene route is required");
  }

  const cameraPlan = buildTapoRtspSmokePlan(config);
  const vlmPlan = buildOllamaVlmSmokePlan(config);

  if (cameraPlan.status === "skip" && vlmPlan.status === "skip") {
    return {
      status: "skip",
      reason:
        "Set camera.tapo and vision.ollama in pico config to run the camera to VLM scene smoke."
    };
  }

  if (cameraPlan.status === "skip") {
    return {
      status: "skip",
      reason: cameraPlan.reason
    };
  }

  if (vlmPlan.status === "skip") {
    return {
      status: "skip",
      reason: vlmPlan.reason
    };
  }

  return {
    status: "run",
    camera: cameraPlan,
    vlm: vlmPlan,
    timeoutMs: route.timeoutMs,
    maxImageEdgePixels: route.maxImageEdgePixels,
    sensitiveValues: readSensitiveValues(config, cameraPlan.source.url)
  };
}

async function captureSceneFrame(
  plan: CameraVlmSceneSmokePlan,
  captureFrame: (plan: CameraVlmSceneSmokePlan) => Promise<CapturedFrame>
): Promise<CapturedFrame> {
  try {
    return await captureFrame(plan);
  } catch (error) {
    throw new CameraVlmSceneSmokeError(
      `pico camera to VLM scene smoke capture failed: ${redactRtspSensitiveValues(
        errorMessage(error),
        plan.sensitiveValues
      )}`
    );
  }
}

async function prepareSceneFrame(
  plan: CameraVlmSceneSmokePlan,
  frame: Uint8Array,
  prepareFrame: (frame: Uint8Array, maxImageEdgePixels: number) => Promise<Uint8Array>
): Promise<Uint8Array> {
  try {
    return await prepareFrame(frame, plan.maxImageEdgePixels);
  } catch (error) {
    throw new CameraVlmSceneSmokeError(
      `pico camera to VLM scene smoke frame preparation failed: ${redactRtspSensitiveValues(
        errorMessage(error),
        plan.sensitiveValues
      )}`
    );
  }
}

async function describeSceneFrame(
  plan: CameraVlmSceneSmokePlan,
  frame: Uint8Array,
  describeFrame: (request: SceneDescriptionRequest) => Promise<SceneDescription>
): Promise<SceneDescription> {
  try {
    return await describeFrame({
      endpoint: plan.vlm.endpoint,
      image: frame,
      mimeType: "image/jpeg",
      purpose: "staff_requested_snapshot",
      timeoutMs: plan.timeoutMs
    });
  } catch (error) {
    throw new CameraVlmSceneSmokeError(
      `pico camera to VLM scene smoke description failed: ${redactRtspSensitiveValues(
        errorMessage(error),
        plan.sensitiveValues
      )}`
    );
  }
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

async function captureFrameWithRtsp(plan: CameraVlmSceneSmokePlan): Promise<CapturedFrame> {
  const client = createRtspSnapshotClient(
    plan.camera.source,
    createFfmpegRtspSnapshotTransport({
      timeoutMs: plan.camera.timeoutMs,
      maxFrameBytes: plan.camera.maxFrameBytes
    })
  );
  const result = await client.captureSnapshot();

  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.message}`);
  }

  return {
    sourceId: result.sourceId,
    mimeType: result.mimeType,
    frame: result.frame
  };
}

class CameraVlmSceneSmokeError extends Error {}

function readSensitiveValues(config: PicoConfig, rtspUrl: string): readonly string[] {
  return readRtspSensitiveValues({
    username: config.camera.tapo?.user,
    password: config.camera.tapo?.password,
    rtspUrl
  });
}

function readDirectExecutionSensitiveValues(config: PicoConfig): readonly string[] {
  return readRtspSensitiveValues({
    username: config.camera.tapo?.user,
    password: config.camera.tapo?.password
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  let config: PicoConfig | undefined;

  try {
    config = loadPicoConfigFromEnvironment();
    const report = await runCameraVlmSceneSmoke(config);
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = cameraVlmSceneSmokeExitCode(report);
  } catch (error) {
    if (error instanceof CameraVlmSceneSmokeError) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "failed",
            provider: "tapo-rtsp+ollama",
            reason: error.message
          } satisfies CameraVlmSceneSmokeReport,
          undefined,
          2
        )}\n`
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(`${formatCameraVlmSceneSmokeFatalError(error, config)}\n`);
      process.exitCode = 2;
    }
  }
}
