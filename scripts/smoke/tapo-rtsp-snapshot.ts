#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
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
  config: PicoConfig = loadPicoConfigFromEnvironment()
): Promise<TapoRtspSmokeReport> {
  const plan = buildTapoRtspSmokePlan(config);

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

export function buildTapoRtspSmokePlan(config: PicoConfig): TapoRtspSmokePlan {
  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    return {
      status: "skip",
      reason: "Set camera.tapo in pico config to run the Tapo RTSP snapshot smoke."
    };
  }

  return {
    status: "run",
    source: defineRtspSnapshotSource({
      id: tapo.sourceId ?? "tapo-rtsp",
      host: tapo.host,
      username: tapo.user,
      password: tapo.password,
      stream: tapo.stream ?? defaultTapoStream,
      port: tapo.port ?? defaultTapoPort
    }),
    timeoutMs: tapo.timeoutMs ?? defaultTimeoutMs,
    maxFrameBytes: tapo.maxFrameBytes ?? defaultMaxFrameBytes
  };
}

export function tapoRtspSmokeExitCode(report: TapoRtspSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
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
