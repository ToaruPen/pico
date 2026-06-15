#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  type PersonFollowRuntimeOptions,
  type PersonFollowRuntimeProvider,
  type PersonFollowRuntimeReport,
  runPersonFollowRuntime
} from "../../src/runtime/person-follow-runtime.js";

const livePersonFollowEnvironment = "PICO_ENABLE_LIVE_PERSON_FOLLOW";
const durationEnvironment = "PICO_PERSON_FOLLOW_SMOKE_DURATION_MS";
const maxFramesEnvironment = "PICO_PERSON_FOLLOW_SMOKE_MAX_FRAMES";
const defaultDurationMs = 5_000;
const defaultMaxFrames = 10;

export type PersonFollowRuntimeSmokeStatus = "passed" | "failed" | "skipped";

export type PersonFollowRuntimeSmokeReport =
  | PersonFollowRuntimeReport
  | {
      readonly status: "skipped";
      readonly provider: PersonFollowRuntimeProvider;
      readonly reason: string;
    };

export type PersonFollowRuntimeSmokePlan =
  | {
      readonly status: "run";
      readonly durationMs: number;
      readonly maxFrames: number;
      readonly sourceId: string;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

export type PersonFollowRuntimeSmokeDependencies = {
  readonly runRuntime?: (
    config: PicoConfig,
    options: PersonFollowRuntimeOptions
  ) => Promise<PersonFollowRuntimeReport>;
};

export async function runPersonFollowRuntimeSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PersonFollowRuntimeSmokeDependencies = {}
): Promise<PersonFollowRuntimeSmokeReport> {
  const plan = buildPersonFollowRuntimeSmokePlan(config, environment);
  const provider = smokeProvider(config);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider,
      reason: plan.reason
    };
  }

  const runRuntime = dependencies.runRuntime ?? runPersonFollowRuntime;

  return await runRuntime(config, {
    enableLiveRun: true,
    durationMs: plan.durationMs,
    maxFrames: plan.maxFrames
  });
}

export function buildPersonFollowRuntimeSmokePlan(
  config: PicoConfig,
  environment: NodeJS.ProcessEnv = process.env
): PersonFollowRuntimeSmokePlan {
  if (environment[livePersonFollowEnvironment] !== "1") {
    return {
      status: "skip",
      reason: "Set PICO_ENABLE_LIVE_PERSON_FOLLOW=1 to run person-follow runtime smoke."
    };
  }

  if (config.camera.tapo === undefined) {
    return {
      status: "skip",
      reason: "Set camera.tapo in pico config to run person-follow runtime smoke."
    };
  }

  if (!config.camera.personFollow.enabled) {
    return {
      status: "skip",
      reason: "Set camera.personFollow.enabled=true to run person-follow runtime smoke."
    };
  }

  if (!config.vision.personDetection.enabled) {
    return {
      status: "skip",
      reason: "Set vision.personDetection.enabled=true to run person-follow runtime smoke."
    };
  }

  return {
    status: "run",
    durationMs: readBoundedPositiveInteger(
      environment[durationEnvironment],
      durationEnvironment,
      defaultDurationMs
    ),
    maxFrames: readBoundedPositiveInteger(
      environment[maxFramesEnvironment],
      maxFramesEnvironment,
      defaultMaxFrames
    ),
    sourceId:
      config.camera.personFollow.sourceCameraId ??
      config.vision.personDetection.sourceCameraId ??
      ""
  };
}

export function personFollowRuntimeSmokeExitCode(report: PersonFollowRuntimeSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function smokeProvider(config: PicoConfig): PersonFollowRuntimeProvider {
  if (config.vision.personDetection.provider === "onnxruntime") {
    return "tapo-rtsp+onnxruntime+onvif";
  }

  if (config.vision.personDetection.provider === "coreml") {
    return "tapo-rtsp+coreml+onvif";
  }

  return "unsupported";
}

function readBoundedPositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new Error(`${name} must be a positive integer up to 60000`);
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
    const report = await runPersonFollowRuntimeSmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = personFollowRuntimeSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
