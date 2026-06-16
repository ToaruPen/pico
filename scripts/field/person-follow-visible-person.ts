#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  type PersonFollowRuntimeOptions,
  type PersonFollowRuntimeProvider,
  type PersonFollowRuntimeReport,
  runPersonFollowRuntime
} from "../../src/runtime/person-follow-runtime.js";

const liveVisiblePersonEnvironment = "PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE";
const durationEnvironment = "PICO_PERSON_FOLLOW_VISIBLE_DURATION_MS";
const maxFramesEnvironment = "PICO_PERSON_FOLLOW_VISIBLE_MAX_FRAMES";
const defaultDurationMs = 30_000;
const defaultMaxFrames = 60;

export type PersonFollowVisiblePersonFieldReport =
  | PersonFollowRuntimeReport
  | {
      readonly status: "skipped";
      readonly provider: PersonFollowRuntimeProvider;
      readonly reason: string;
    };

export type PersonFollowVisiblePersonFieldDependencies = {
  readonly runRuntime?: (
    config: PicoConfig,
    options: PersonFollowRuntimeOptions
  ) => Promise<PersonFollowRuntimeReport>;
};

export async function runPersonFollowVisiblePersonField(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PersonFollowVisiblePersonFieldDependencies = {}
): Promise<PersonFollowVisiblePersonFieldReport> {
  if (environment[liveVisiblePersonEnvironment] !== "1") {
    return {
      status: "skipped",
      provider: fieldProvider(config),
      reason:
        "Set PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE=1 to run visible-person person-follow field validation."
    };
  }

  const runRuntime = dependencies.runRuntime ?? runPersonFollowRuntime;
  const report = await runRuntime(config, {
    enableLiveRun: true,
    durationMs: readBoundedPositiveInteger(
      environment[durationEnvironment],
      durationEnvironment,
      defaultDurationMs
    ),
    maxFrames: readBoundedPositiveInteger(
      environment[maxFramesEnvironment],
      maxFramesEnvironment,
      defaultMaxFrames
    )
  });

  return requireVisiblePersonFollowEvidence(report);
}

function requireVisiblePersonFollowEvidence(
  report: PersonFollowRuntimeReport
): PersonFollowRuntimeReport {
  if (report.status === "failed") {
    return report;
  }

  if (report.details.personDetectionsTotal <= 0) {
    return {
      status: "failed",
      provider: report.provider,
      reason: "visible-person field validation requires at least one person detection"
    };
  }

  if (report.details.movesIssued <= 0) {
    return {
      status: "failed",
      provider: report.provider,
      reason: "visible-person field validation requires at least one bounded PTZ move"
    };
  }

  return report;
}

export function personFollowVisiblePersonFieldExitCode(
  report: PersonFollowVisiblePersonFieldReport
): number {
  return report.status === "failed" ? 1 : 0;
}

function fieldProvider(config: PicoConfig): PersonFollowRuntimeProvider {
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
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new Error(`${name} must be a positive integer up to 120000`);
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
    const report = await runPersonFollowVisiblePersonField();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = personFollowVisiblePersonFieldExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
