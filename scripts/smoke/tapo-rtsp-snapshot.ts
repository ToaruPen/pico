#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource
} from "../../src/modules/camera/index.js";

const defaultTapoStream = "stream2";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;

export type TapoRtspSmokeStatus = "passed" | "failed" | "skipped";

export type TapoRtspSmokeReport = {
  readonly status: TapoRtspSmokeStatus;
  readonly provider: "tapo-rtsp";
  readonly reason?: string;
  readonly details?: {
    readonly sourceId: string;
    readonly frameBytes: number;
    readonly mimeType: "image/jpeg";
  };
};

type TapoRtspSmokePlan =
  | {
      readonly status: "run";
      readonly source: ReturnType<typeof defineRtspSnapshotSource>;
      readonly timeoutMs: number;
      readonly maxFrameBytes: number;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

export async function runTapoRtspSnapshotSmoke(
  env: NodeJS.ProcessEnv = process.env
): Promise<TapoRtspSmokeReport> {
  const plan = buildTapoRtspSmokePlan(env);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "tapo-rtsp",
      reason: plan.reason
    };
  }

  const client = createRtspSnapshotClient(
    plan.source,
    createFfmpegRtspSnapshotTransport({
      timeoutMs: plan.timeoutMs,
      maxFrameBytes: plan.maxFrameBytes
    })
  );
  const result = await client.captureSnapshot();

  if (!result.ok) {
    return {
      status: "failed",
      provider: "tapo-rtsp",
      reason: `pico Tapo RTSP smoke failed: ${result.reason}: ${result.message}`
    };
  }

  return {
    status: "passed",
    provider: "tapo-rtsp",
    details: {
      sourceId: result.sourceId,
      frameBytes: result.frame.byteLength,
      mimeType: result.mimeType
    }
  };
}

export function buildTapoRtspSmokePlan(env: NodeJS.ProcessEnv): TapoRtspSmokePlan {
  const host = readEnvironment(env, "PICO_TAPO_HOST");

  if (host === undefined) {
    return {
      status: "skip",
      reason: "Set PICO_TAPO_HOST to run the Tapo RTSP snapshot smoke."
    };
  }

  return {
    status: "run",
    source: defineRtspSnapshotSource({
      id: readEnvironment(env, "PICO_TAPO_SOURCE_ID") ?? "tapo-rtsp",
      host,
      username: requireEnvironment(
        env,
        "PICO_TAPO_USER",
        "PICO_TAPO_USER is required when PICO_TAPO_HOST is set"
      ),
      password: requireEnvironment(
        env,
        "PICO_TAPO_PASSWORD",
        "PICO_TAPO_PASSWORD is required when PICO_TAPO_HOST is set"
      ),
      stream: readEnvironment(env, "PICO_TAPO_STREAM") ?? defaultTapoStream,
      port: readPositiveIntegerEnvironment(env, "PICO_TAPO_PORT") ?? defaultTapoPort
    }),
    timeoutMs: readPositiveIntegerEnvironment(env, "PICO_TAPO_TIMEOUT_MS") ?? defaultTimeoutMs,
    maxFrameBytes:
      readPositiveIntegerEnvironment(env, "PICO_TAPO_MAX_FRAME_BYTES") ?? defaultMaxFrameBytes
  };
}

export function tapoRtspSmokeExitCode(report: TapoRtspSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function readEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === "" ? undefined : value;
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function readPositiveIntegerEnvironment(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runTapoRtspSnapshotSmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = tapoRtspSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
