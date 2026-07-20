#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  measureResidentAudioInputLevel,
  type ResidentAudioInputLevel,
  type ResidentAudioInputLevelOptions
} from "../../src/runtime/resident-audio-io.js";

const defaultCaptureMs = 3_000;
const defaultTimeoutMs = 10_000;
const defaultMinimumRmsDatabase = -55;

export type ResidentAudioInputSmokeReport =
  | {
      readonly status: "passed";
      readonly provider: "resident-audio-input";
      readonly details: ResidentAudioInputSmokeDetails;
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "resident-audio-input";
      readonly reason: string;
      readonly details?: ResidentAudioInputSmokeDetails;
    };

export type ResidentAudioInputSmokeDetails = {
  readonly audioProvider: ResidentAudioInputLevel["provider"];
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly capturedMs: number;
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly rmsDb: number;
  readonly peakDb: number;
  readonly minimumRmsDb: number;
};

export type ResidentAudioInputSmokeDependencies = {
  readonly loadConfig?: () => PicoConfig;
  readonly measureInputLevel?: (
    config: PicoConfig,
    options: ResidentAudioInputLevelOptions
  ) => Promise<ResidentAudioInputLevel>;
  readonly captureMs?: number;
  readonly timeoutMs?: number;
};

export async function runResidentAudioInputSmoke(
  config?: PicoConfig,
  dependencies: ResidentAudioInputSmokeDependencies = {}
): Promise<ResidentAudioInputSmokeReport> {
  try {
    return await executeResidentAudioInputSmoke(config, dependencies);
  } catch (error) {
    return {
      status: "failed",
      provider: "resident-audio-input",
      reason: `pico resident audio input smoke failed: ${errorMessage(error)}`
    };
  }
}

async function executeResidentAudioInputSmoke(
  config: PicoConfig | undefined,
  dependencies: ResidentAudioInputSmokeDependencies
): Promise<ResidentAudioInputSmokeReport> {
  const resolvedConfig = config ?? dependencies.loadConfig?.() ?? loadPicoConfigFromEnvironment();
  const skipReason = residentAudioInputSkipReason(
    resolvedConfig,
    dependencies.measureInputLevel !== undefined
  );

  if (skipReason !== undefined) {
    return skipped(skipReason);
  }

  const minimumRmsDatabase = residentAudioMinimumRmsDatabase(resolvedConfig);
  const level = await (dependencies.measureInputLevel ?? measureResidentAudioInputLevel)(
    resolvedConfig,
    {
      captureMs: dependencies.captureMs ?? defaultCaptureMs,
      minimumRmsDb: minimumRmsDatabase,
      timeoutMs: dependencies.timeoutMs ?? defaultTimeoutMs
    }
  );

  return evaluateResidentAudioInputLevel(level, minimumRmsDatabase);
}

function residentAudioMinimumRmsDatabase(config: PicoConfig): number {
  return config.voice.resident.vad.provider === "energy"
    ? config.voice.resident.vad.minRmsDb
    : defaultMinimumRmsDatabase;
}

function residentAudioInputSkipReason(
  config: PicoConfig,
  hasInjectedMeasurement: boolean
): string | undefined {
  if (!config.voice.resident.enabled || config.voice.resident.audioInput === undefined) {
    return "Set voice.resident.enabled=true and voice.resident.audioInput to run the resident audio input smoke.";
  }

  if (config.voice.resident.audioInput.provider === "avaudioengine" && !hasInjectedMeasurement) {
    return "AVAudioEngine admits audio only inside native PTT; run just field-resident-hold-to-talk for input signal validation.";
  }

  return undefined;
}

function evaluateResidentAudioInputLevel(
  level: ResidentAudioInputLevel,
  minimumRmsDatabase: number
): ResidentAudioInputSmokeReport {
  const details = residentAudioInputSmokeDetails(level, minimumRmsDatabase);

  if (!level.signalDetected) {
    return {
      status: "failed",
      provider: "resident-audio-input",
      reason: `pico resident audio input RMS ${formatDatabase(
        level.rmsDb
      )} dB is below minimum ${formatDatabase(minimumRmsDatabase)} dB`,
      details
    };
  }

  return {
    status: "passed",
    provider: "resident-audio-input",
    details
  };
}

export function residentAudioInputSmokeExitCode(report: ResidentAudioInputSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function residentAudioInputSmokeDetails(
  level: ResidentAudioInputLevel,
  minimumRmsDatabase: number
): ResidentAudioInputSmokeDetails {
  return {
    audioProvider: level.provider,
    sampleRateHz: level.sampleRateHz,
    channels: level.channels,
    capturedMs: level.capturedMs,
    sampleCount: level.sampleCount,
    durationMs: level.durationMs,
    rmsDb: level.rmsDb,
    peakDb: level.peakDb,
    minimumRmsDb: minimumRmsDatabase
  };
}

function skipped(reason: string): ResidentAudioInputSmokeReport {
  return {
    status: "skipped",
    provider: "resident-audio-input",
    reason
  };
}

function formatDatabase(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runResidentAudioInputSmoke();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = residentAudioInputSmokeExitCode(report);
}
