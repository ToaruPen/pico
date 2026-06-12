#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import {
  loadPicoConfigFromEnvironment,
  type PicoConfig,
  type PicoPersonFollowConfig
} from "../../src/config/index.js";
import {
  createOnvifPersonFollowPtzDriver,
  type OnvifPersonFollowPtzDriverInput,
  type PersonFollowPtzDriver,
  type PersonFollowPtzMoveCommand
} from "../../src/modules/camera/index.js";

const livePtzNudgeEnvironment = "PICO_ENABLE_LIVE_PTZ_NUDGE";
const defaultOnvifPort = 2020;
const defaultSafePan = 0.05;

export type TapoPersonFollowSmokeStatus = "passed" | "failed" | "skipped";

export type TapoPersonFollowSmokeReport = {
  readonly status: TapoPersonFollowSmokeStatus;
  readonly provider: "tapo-onvif-ptz";
  readonly reason?: string;
  readonly details?: {
    readonly sourceId: string;
    readonly pan: number;
    readonly tilt: number;
    readonly speed: number;
  };
};

export type TapoPersonFollowSmokePlan =
  | {
      readonly status: "run";
      readonly sourceId: string;
      readonly connection: OnvifPersonFollowPtzDriverInput;
      readonly command: PersonFollowPtzMoveCommand;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

export type TapoPersonFollowSmokeDependencies = {
  readonly createDriver?: (connection: OnvifPersonFollowPtzDriverInput) => PersonFollowPtzDriver;
};

export async function runTapoPersonFollowSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: TapoPersonFollowSmokeDependencies = {}
): Promise<TapoPersonFollowSmokeReport> {
  const plan = buildTapoPersonFollowSmokePlan(config, environment);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "tapo-onvif-ptz",
      reason: plan.reason
    };
  }

  const createDriver = dependencies.createDriver ?? createOnvifPersonFollowPtzDriver;

  try {
    const driver = createDriver(plan.connection);
    await driver.relativeMove(plan.command);
    await driver.stop();

    return {
      status: "passed",
      provider: "tapo-onvif-ptz",
      details: {
        sourceId: plan.sourceId,
        pan: plan.command.pan,
        tilt: plan.command.tilt,
        speed: plan.command.speed
      }
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "tapo-onvif-ptz",
      reason: `pico Tapo ONVIF PTZ smoke failed: ${errorMessage(error)}`
    };
  }
}

export function buildTapoPersonFollowSmokePlan(
  config: PicoConfig,
  environment: NodeJS.ProcessEnv = process.env
): TapoPersonFollowSmokePlan {
  if (environment[livePtzNudgeEnvironment] !== "1") {
    return {
      status: "skip",
      reason: "Set PICO_ENABLE_LIVE_PTZ_NUDGE=1 to run the Tapo ONVIF PTZ smoke."
    };
  }

  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    return {
      status: "skip",
      reason: "Set camera.tapo in pico config to run the Tapo ONVIF PTZ smoke."
    };
  }

  const personFollow = config.camera.personFollow;

  if (!personFollow.enabled) {
    return {
      status: "skip",
      reason: "Set camera.personFollow.enabled=true to run the Tapo ONVIF PTZ smoke."
    };
  }
  const enabledPersonFollow = requireEnabledPersonFollowConfig(personFollow);

  return {
    status: "run",
    sourceId: enabledPersonFollow.sourceCameraId,
    connection: {
      host: tapo.host,
      port: tapo.onvifPort ?? defaultOnvifPort,
      username: tapo.user,
      password: tapo.password
    },
    command: {
      pan: Math.min(defaultSafePan, enabledPersonFollow.maxStep),
      tilt: 0,
      speed: enabledPersonFollow.speed
    }
  };
}

export function tapoPersonFollowSmokeExitCode(report: TapoPersonFollowSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEnabledPersonFollowConfig(config: PicoPersonFollowConfig): {
  readonly sourceCameraId: string;
  readonly maxStep: number;
  readonly speed: number;
} {
  if (
    config.sourceCameraId === undefined ||
    config.maxStep === undefined ||
    config.speed === undefined
  ) {
    throw new Error("pico Tapo ONVIF PTZ smoke requires enabled camera.personFollow settings");
  }

  return {
    sourceCameraId: config.sourceCameraId,
    maxStep: config.maxStep,
    speed: config.speed
  };
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runTapoPersonFollowSmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = tapoPersonFollowSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
