#!/usr/bin/env jiti
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStackChanHeadTargetLaneFromConfig,
  STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
  type StackChanHeadTargetStatus,
  type StackChanMotionTelemetryLane
} from "../../src/modules/stackchan/head-target-lane.js";
import { createStackChanAdapterFromConfig } from "../../src/modules/stackchan/index.js";
import { writePrivateJsonReport } from "./stackchan-field-report.js";

export type StackChanMotionContinuityOptions = {
  readonly enableLiveRun: true;
  readonly reportOutput: string;
};

export type StackChanMotionSample = {
  readonly observedAtMs: number;
  readonly yaw: number;
  readonly expectedDirection: -1 | 0 | 1;
};

type DistributionSummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

export type StackChanMotionContinuitySummary = {
  readonly sampleCount: number;
  readonly eligibleIntervals: number;
  readonly advancingIntervals: number;
  readonly stationaryIntervals: number;
  readonly reverseIntervals: number;
  readonly stationaryRatio: number;
  readonly longestStationaryMs: number;
  readonly sampleGapMs: DistributionSummary;
  readonly maximumStepDeg: number;
  readonly qualified: boolean;
};

export type StackChanMotionContinuityReport = {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly experiment: "monotonic-triangle-wave";
  readonly sampleIntervalMs: number;
  readonly targetIntervalMs: number;
  readonly reversalGuardMs: number;
  readonly sweepExtentDeg: number;
  readonly targetStepDeg: number;
  readonly speedDps: number;
  readonly continuity: StackChanMotionContinuitySummary;
  readonly lane: {
    readonly accepted: number;
    readonly replaced: number;
    readonly dispatched: number;
    readonly confirmed: number;
    readonly failed: number;
    readonly staleDiscarded: number;
    readonly maximumActiveCalls: number;
    readonly maximumPendingDepth: number;
    readonly postStopDispatches: number;
    readonly deviceDispatchLatencyMs: DistributionSummary;
  };
  readonly finalHomeErrorDeg: {
    readonly yaw: number;
    readonly pitch: number;
  };
};

export type StackChanMotionSweepTarget = {
  readonly yaw: number;
  readonly direction: -1 | 1;
  readonly beginsLeg: boolean;
  readonly continuesAfter: boolean;
};

export type StackChanMotionSweepTiming = {
  readonly sampleIntervalMs: number;
  readonly targetIntervalMs: number;
  readonly reversalGuardMs: number;
  readonly settleMs: number;
};

const sampleIntervalMs = 20;
const targetIntervalMs = 125;
const reversalGuardMs = 250;
const settleMs = 800;
const requestedSweepExtentDeg = 32;
const maximumDistributionMs = 10_000;

export function parseStackChanMotionContinuityArguments(
  arguments_: readonly string[]
): StackChanMotionContinuityOptions {
  const values = parseNamedArguments(arguments_);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }
  const reportOutput = requireString(values, "--report-output");
  const expected = new Set(["--enable-live-run", "--report-output"]);
  if (values.size !== expected.size || [...values.keys()].some((name) => !expected.has(name))) {
    throw new Error("motion continuity arguments are invalid");
  }
  if (!isAbsolute(reportOutput)) {
    throw new Error("--report-output must be an absolute path");
  }
  return {
    enableLiveRun: true,
    reportOutput
  };
}

// eslint-disable-next-line complexity
export function summarizeStackChanMotionContinuity(
  samples: readonly StackChanMotionSample[]
): StackChanMotionContinuitySummary {
  const gaps: number[] = [];
  let eligibleIntervals = 0;
  let advancingIntervals = 0;
  let stationaryIntervals = 0;
  let reverseIntervals = 0;
  let longestStationaryMs = 0;
  let currentStationaryMs = 0;
  let maximumStepDeg = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const gapMs = Math.max(0, current.observedAtMs - previous.observedAtMs);
    gaps.push(gapMs);
    const deltaYaw = current.yaw - previous.yaw;
    maximumStepDeg = Math.max(maximumStepDeg, Math.abs(deltaYaw));

    const direction = current.expectedDirection;
    if (direction === 0 || previous.expectedDirection !== direction) {
      currentStationaryMs = 0;
      continue;
    }

    eligibleIntervals++;
    const directionalDelta = direction * deltaYaw;
    if (directionalDelta > 0) {
      advancingIntervals++;
      currentStationaryMs = 0;
    } else if (directionalDelta < 0) {
      reverseIntervals++;
      currentStationaryMs = 0;
    } else {
      stationaryIntervals++;
      currentStationaryMs += gapMs;
      longestStationaryMs = Math.max(longestStationaryMs, currentStationaryMs);
    }
  }

  const stationaryRatio =
    eligibleIntervals === 0 ? 1 : roundThousandths(stationaryIntervals / eligibleIntervals);
  const sampleGapMs = summarizeDistribution(gaps);
  const qualified =
    eligibleIntervals >= 50 &&
    stationaryRatio <= 0.1 &&
    longestStationaryMs <= 80 &&
    reverseIntervals === 0 &&
    sampleGapMs.p95 <= 40 &&
    maximumStepDeg <= 4;

  return {
    sampleCount: samples.length,
    eligibleIntervals,
    advancingIntervals,
    stationaryIntervals,
    reverseIntervals,
    stationaryRatio,
    longestStationaryMs: roundHundredths(longestStationaryMs),
    sampleGapMs,
    maximumStepDeg,
    qualified
  };
}

// eslint-disable-next-line complexity
async function runStackChanMotionContinuityField(
  config: PicoConfig,
  options: StackChanMotionContinuityOptions
): Promise<StackChanMotionContinuityReport> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  if (stackchan === undefined || follow?.enabled !== true) {
    throw new Error("enabled camera.stackchan.follow is required");
  }

  const adapter = createStackChanAdapterFromConfig(stackchan);
  const lane = createStackChanHeadTargetLaneFromConfig(stackchan);
  const home = { yaw: follow.homeYaw, pitch: follow.homePitch };
  const extent = Math.min(requestedSweepExtentDeg, 90 - home.yaw, home.yaw + 90);
  const step = follow.maxStepDeg;
  if (!Number.isInteger(step) || step < 1 || extent < step * 4) {
    throw new Error("motion continuity sweep is unavailable for this follow config");
  }
  const targets = createTriangleTargets(home.yaw, extent, step);
  let adapterConnected = false;
  let leaseId: string | undefined;

  try {
    await adapter.connect();
    adapterConnected = true;
    await adapter.moveHead(home, { speedDps: follow.moveSpeedDps });
    await wait(1_000);
    await lane.connect();
    const lease = await lane.start({
      rateHz: follow.commandRateHz,
      maxStepDeg: follow.maxStepDeg,
      maxPendingAgeMs: follow.maxPendingCommandAgeMs,
      speedDps: follow.moveSpeedDps
    });
    leaseId = lease.leaseId;

    const samples = await runStackChanMotionContinuitySweep({
      lane,
      leaseId,
      pitch: home.pitch,
      targets
    });
    const stopped = await lane.stop(leaseId);
    leaseId = undefined;
    await adapter.moveHead(home, { speedDps: follow.moveSpeedDps });
    await wait(1_000);
    const finalPose = await adapter.getHeadAngles();
    const finalHomeErrorDeg = {
      yaw: roundHundredths(Math.abs(finalPose.yaw - home.yaw)),
      pitch: roundHundredths(Math.abs(finalPose.pitch - home.pitch))
    };
    const continuity = summarizeStackChanMotionContinuity(samples);
    const laneSummary = projectLaneSummary(stopped);
    const passed = isStackChanMotionContinuityRunQualified({
      continuity,
      lane: laneSummary,
      finalHomeErrorDeg
    });
    const report: StackChanMotionContinuityReport = {
      schemaVersion: 1,
      status: passed ? "passed" : "failed",
      experiment: "monotonic-triangle-wave",
      sampleIntervalMs,
      targetIntervalMs,
      reversalGuardMs,
      sweepExtentDeg: extent,
      targetStepDeg: step,
      speedDps: follow.moveSpeedDps,
      continuity,
      lane: laneSummary,
      finalHomeErrorDeg
    };
    await writePrivateJsonReport(options.reportOutput, report);
    return report;
  } finally {
    if (leaseId !== undefined) {
      await lane.stop(leaseId).catch(() => undefined);
    }
    await lane.close().catch(() => undefined);
    if (adapterConnected) {
      await adapter.close().catch(() => undefined);
    }
  }
}

export function isStackChanMotionContinuityRunQualified(input: {
  readonly continuity: StackChanMotionContinuitySummary;
  readonly lane: StackChanMotionContinuityReport["lane"];
  readonly finalHomeErrorDeg: StackChanMotionContinuityReport["finalHomeErrorDeg"];
}): boolean {
  return (
    input.continuity.qualified &&
    input.lane.failed === 0 &&
    input.lane.staleDiscarded === 0 &&
    input.lane.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS &&
    input.lane.maximumPendingDepth <= 1 &&
    input.lane.postStopDispatches === 0 &&
    input.finalHomeErrorDeg.yaw <= 1 &&
    input.finalHomeErrorDeg.pitch <= 1
  );
}

export async function runStackChanMotionContinuitySweep(options: {
  readonly lane: StackChanMotionTelemetryLane;
  readonly leaseId: string;
  readonly pitch: number;
  readonly targets: readonly StackChanMotionSweepTarget[];
  readonly timing?: StackChanMotionSweepTiming;
}): Promise<StackChanMotionSample[]> {
  const timing = options.timing ?? {
    sampleIntervalMs,
    targetIntervalMs,
    reversalGuardMs,
    settleMs
  };
  const samples: StackChanMotionSample[] = [];
  const startedAtMs = monotonicNowMs();
  const commandDurationMs = options.targets.length * timing.targetIntervalMs;
  const deadlineMs = startedAtMs + commandDurationMs + timing.settleMs;
  const expectedMotion: {
    direction: -1 | 0 | 1;
    eligibleAfterMs: number;
  } = {
    direction: 0,
    eligibleAfterMs: Number.POSITIVE_INFINITY
  };

  await Promise.all([publishMotionTargets(), sampleMotionState()]);
  return samples;

  async function publishMotionTargets(): Promise<void> {
    for (const [index, target] of options.targets.entries()) {
      const targetDueAtMs = startedAtMs + index * timing.targetIntervalMs;
      await waitUntil(targetDueAtMs);
      await options.lane.update({
        leaseId: options.leaseId,
        sequence: index + 1,
        pose: { yaw: target.yaw, pitch: options.pitch }
      });
      if (target.beginsLeg) {
        expectedMotion.direction = target.direction;
        expectedMotion.eligibleAfterMs = monotonicNowMs() + timing.reversalGuardMs;
      }
      if (!target.continuesAfter) {
        expectedMotion.direction = 0;
      }
    }
  }

  async function sampleMotionState(): Promise<void> {
    let nextSampleAtMs = startedAtMs;
    while (monotonicNowMs() < deadlineMs) {
      await waitUntil(nextSampleAtMs);
      if (monotonicNowMs() >= deadlineMs) {
        return;
      }
      const motion = await options.lane.motionStatus(options.leaseId);
      const observedAtMs = monotonicNowMs();
      samples.push({
        observedAtMs: roundHundredths(observedAtMs - startedAtMs),
        yaw: motion.yaw,
        expectedDirection:
          observedAtMs >= expectedMotion.eligibleAfterMs ? expectedMotion.direction : 0
      });
      nextSampleAtMs += timing.sampleIntervalMs;
    }
  }

  async function waitUntil(dueAtMs: number): Promise<void> {
    const remainingMs = dueAtMs - monotonicNowMs();
    if (remainingMs > 0) {
      await wait(remainingMs);
    }
  }
}

function createTriangleTargets(
  homeYaw: number,
  extent: number,
  step: number
): StackChanMotionSweepTarget[] {
  const targets: Array<Omit<StackChanMotionSweepTarget, "continuesAfter">> = [];
  appendLeg(targets, homeYaw, homeYaw + extent, step);
  appendLeg(targets, homeYaw + extent, homeYaw - extent, -step);
  appendLeg(targets, homeYaw - extent, homeYaw, step);
  return targets.map((target, index) => ({
    ...target,
    continuesAfter: index + 1 < targets.length && targets[index + 1]?.direction === target.direction
  }));
}

function appendLeg(
  targets: Array<Omit<StackChanMotionSweepTarget, "continuesAfter">>,
  start: number,
  end: number,
  signedStep: number
): void {
  const direction = Math.sign(signedStep) as -1 | 1;
  let yaw = start + signedStep;
  let first = true;
  while ((direction > 0 && yaw <= end) || (direction < 0 && yaw >= end)) {
    targets.push({
      yaw,
      direction,
      beginsLeg: first
    });
    first = false;
    yaw += signedStep;
  }
}

function projectLaneSummary(
  status: StackChanHeadTargetStatus
): StackChanMotionContinuityReport["lane"] {
  return {
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    maximumActiveCalls: status.maximumActiveCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    postStopDispatches: status.postStopDispatches,
    deviceDispatchLatencyMs: status.deviceDispatchLatencyMs
  };
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--") || values.has(name)) {
      throw new Error("motion continuity arguments are invalid");
    }
    if (name === "--enable-live-run") {
      values.set(name, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.set(name, value);
    index++;
  }
  return values;
}

function requireString(values: ReadonlyMap<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function summarizeDistribution(values: readonly number[]): DistributionSummary {
  const rounded = values.map((value) =>
    Math.max(0, Math.min(maximumDistributionMs, Math.round(value)))
  );
  rounded.sort((left, right) => left - right);
  return {
    count: rounded.length,
    p50: percentile(rounded, 0.5),
    p95: percentile(rounded, 0.95),
    p99: percentile(rounded, 0.99),
    max: rounded.at(-1) ?? 0
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  return values[Math.max(0, Math.ceil(values.length * percentileValue) - 1)] ?? 0;
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundThousandths(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const options = parseStackChanMotionContinuityArguments(process.argv.slice(2));
    const report = await runStackChanMotionContinuityField(
      loadPicoConfigFromEnvironment(),
      options
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("StackChan motion continuity command failed\n");
    process.exitCode = 2;
  }
}
