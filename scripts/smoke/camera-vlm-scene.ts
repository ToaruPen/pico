#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

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
import { buildTapoRtspSmokePlan } from "./tapo-rtsp-snapshot.js";

export type CameraVlmSceneSmokeStatus = "passed" | "failed" | "skipped";

export type CameraVlmSceneSmokeReport =
  | {
      readonly status: "passed";
      readonly provider: "tapo-rtsp+ollama";
      readonly details: {
        readonly sourceId: string;
        readonly frameBytes: number;
        readonly mimeType: "image/jpeg";
        readonly endpointId: string;
        readonly model: "qwen3.5:9b";
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
  readonly sensitiveValues: readonly string[];
};

type CapturedFrame = {
  readonly sourceId: string;
  readonly mimeType: "image/jpeg";
  readonly frame: Uint8Array;
};

export type CameraVlmSceneSmokeDependencies = {
  readonly captureFrame?: (plan: CameraVlmSceneSmokePlan) => Promise<CapturedFrame>;
  readonly describeFrame?: (request: SceneDescriptionRequest) => Promise<SceneDescription>;
};

export async function runCameraVlmSceneSmoke(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CameraVlmSceneSmokeDependencies = {}
): Promise<CameraVlmSceneSmokeReport> {
  const plan = buildCameraVlmSceneSmokePlan(env);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "tapo-rtsp+ollama",
      reason: plan.reason
    };
  }

  const captureFrame = dependencies.captureFrame ?? captureFrameWithRtsp;
  const describeFrame =
    dependencies.describeFrame ?? createOllamaSceneDescriptionClient().describeScene;

  let captured: CapturedFrame;
  let scene: SceneDescription;

  try {
    captured = await captureSceneFrame(plan, captureFrame);
    scene = await describeSceneFrame(plan, captured.frame, describeFrame);
  } catch (error) {
    if (error instanceof CameraVlmSceneSmokeError) {
      return {
        status: "failed",
        provider: "tapo-rtsp+ollama",
        reason: error.message
      };
    }

    throw error;
  }

  return {
    status: "passed",
    provider: "tapo-rtsp+ollama",
    details: {
      sourceId: captured.sourceId,
      frameBytes: captured.frame.byteLength,
      mimeType: captured.mimeType,
      endpointId: scene.source.endpointId,
      model: scene.source.model,
      scene
    }
  };
}

export function cameraVlmSceneSmokeExitCode(report: CameraVlmSceneSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

export function formatCameraVlmSceneSmokeFatalError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env
): string {
  return sanitizeMessage(errorMessage(error), readDirectExecutionSensitiveValues(env));
}

function buildCameraVlmSceneSmokePlan(env: NodeJS.ProcessEnv):
  | {
      readonly status: "run";
      readonly camera: CameraVlmSceneSmokePlan["camera"];
      readonly vlm: CameraVlmSceneSmokePlan["vlm"];
      readonly sensitiveValues: readonly string[];
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    } {
  const cameraPlan = buildTapoRtspSmokePlan(env);
  const vlmPlan = buildOllamaVlmSmokePlan(env);

  if (cameraPlan.status === "skip" && vlmPlan.status === "skip") {
    return {
      status: "skip",
      reason:
        "Set PICO_TAPO_HOST and PICO_VISION_LOCAL_BASE_URL to run the camera to VLM scene smoke."
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
    sensitiveValues: readSensitiveValues(env, cameraPlan.source.url)
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
      `pico camera to VLM scene smoke capture failed: ${sanitizeMessage(
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
      purpose: "staff_requested_snapshot"
    });
  } catch (error) {
    throw new CameraVlmSceneSmokeError(
      `pico camera to VLM scene smoke description failed: ${sanitizeMessage(
        errorMessage(error),
        plan.sensitiveValues
      )}`
    );
  }
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

function readSensitiveValues(env: NodeJS.ProcessEnv, rtspUrl: string): readonly string[] {
  const values = [
    readEnvironment(env, "PICO_TAPO_USER"),
    readEnvironment(env, "PICO_TAPO_PASSWORD"),
    rtspUrl
  ].flatMap((value) => (value === undefined ? [] : [value, encodeURIComponent(value)]));

  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function readDirectExecutionSensitiveValues(env: NodeJS.ProcessEnv): readonly string[] {
  const values = [
    readEnvironment(env, "PICO_TAPO_USER"),
    readEnvironment(env, "PICO_TAPO_PASSWORD")
  ].flatMap((value) => (value === undefined ? [] : [value, encodeURIComponent(value)]));

  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function readEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === "" ? undefined : value;
}

function sanitizeMessage(message: string, sensitiveValues: readonly string[]): string {
  let sanitized = message.replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]");

  for (const value of sensitiveValues) {
    sanitized = sanitized.replaceAll(value, "[redacted]");
  }

  return sanitized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runCameraVlmSceneSmoke();
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
      process.stderr.write(`${formatCameraVlmSceneSmokeFatalError(error)}\n`);
      process.exitCode = 2;
    }
  }
}
