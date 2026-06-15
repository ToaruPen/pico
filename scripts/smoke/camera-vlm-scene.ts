#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient
} from "../../src/modules/camera/index.js";
import {
  createOllamaSceneDescriptionClient,
  type SceneDescription,
  type SceneDescriptionRequest
} from "../../src/modules/vision/index.js";
import { buildOllamaVlmSmokePlan } from "./ollama-vlm-connectivity.js";
import { readRtspSensitiveValues, redactRtspSensitiveValues } from "./rtsp-redaction.js";
import { buildTapoRtspSmokePlan } from "./tapo-rtsp-snapshot.js";

export type CameraVlmSceneSmokeStatus = "passed" | "failed" | "skipped";

export type CameraVlmSceneSmokeReport =
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
      readonly status: "failed" | "skipped";
      readonly provider: "tapo-rtsp+ollama";
      readonly reason: string;
    };

type CameraVlmSceneSmokePlan = {
  readonly camera: Extract<ReturnType<typeof buildTapoRtspSmokePlan>, { readonly status: "run" }>;
  readonly vlm: Extract<ReturnType<typeof buildOllamaVlmSmokePlan>, { readonly status: "run" }>;
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
};

const defaultMaxImageEdgePixels = 512;

export async function runCameraVlmSceneSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  dependencies: CameraVlmSceneSmokeDependencies = {}
): Promise<CameraVlmSceneSmokeReport> {
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
      timeoutMs: plan.vlm.timeoutMs,
      scene
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
    maxImageEdgePixels: config.vision.ollama?.maxImageEdgePixels ?? defaultMaxImageEdgePixels,
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
      timeoutMs: plan.vlm.timeoutMs
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
  let directExecutionConfig: PicoConfig | undefined;

  try {
    directExecutionConfig = loadPicoConfigFromEnvironment();
    const report = await runCameraVlmSceneSmoke(directExecutionConfig);
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
      process.stderr.write(
        `${formatCameraVlmSceneSmokeFatalError(error, directExecutionConfig)}\n`
      );
      process.exitCode = 2;
    }
  }
}
