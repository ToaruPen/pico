#!/usr/bin/env jiti
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStackChanHeadTargetLaneFromConfig,
  STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
  type StackChanHeadTargetLane,
  type StackChanHeadTargetStatus
} from "../../src/modules/stackchan/head-target-lane.js";
import {
  createStackChanAdapterFromConfig,
  type StackChanAdapter
} from "../../src/modules/stackchan/index.js";
import { writePrivateJsonReport } from "./stackchan-field-report.js";

export type StackChanHeadTargetLaneFieldOptions = {
  readonly enableLiveRun: true;
  readonly durationMs: number;
  readonly updateHz: number;
  readonly statusHz: number;
  readonly reportOutput: string;
};

export type StackChanFieldDistribution = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

export type StackChanHeadTargetLaneFieldReport = {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly requestedUpdateHz: number;
  readonly acceptedUpdateRateHz: number;
  readonly deviceDispatchRateHz: number;
  readonly updateAcknowledgmentMs: StackChanFieldDistribution;
  readonly statusLatencyMs: StackChanFieldDistribution;
  readonly pendingAgeMs: StackChanFieldDistribution;
  readonly deviceDispatchLatencyMs: StackChanFieldDistribution;
  readonly successfulReplyLatencyMs: StackChanFieldDistribution;
  readonly firmwareMcpStageUs: StackChanHeadTargetStatus["firmwareMcpStageUs"];
  readonly stopLatencyMs: number;
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly confirmedApplyReplies: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly noOpDiscarded: number;
  readonly maximumActiveCalls: number;
  readonly maximumPendingDepth: number;
  readonly postStopDispatches: number;
  readonly finalHomeErrorDeg: {
    readonly yaw: number;
    readonly pitch: number;
  };
};

export type StackChanHeadTargetLaneFieldDependencies = {
  readonly createLane?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanHeadTargetLane;
  readonly createAdapter?: (
    config: NonNullable<PicoConfig["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly monotonicNowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
  readonly writeReport?: (
    path: string,
    report: StackChanHeadTargetLaneFieldReport
  ) => Promise<void>;
};

type FixedDistribution = {
  readonly buckets: Uint32Array;
  count: number;
  max: number;
};

const maximumDistributionMs = 10_000;
const minimumDeviceDispatchRateHz = 7.5;
const minimumDeviceDispatchRateFraction = 0.75;
const maximumPendingAgeP95Ms = 150;

export function parseStackChanHeadTargetLaneArguments(
  arguments_: readonly string[]
): StackChanHeadTargetLaneFieldOptions {
  const values = parseNamedArguments(arguments_);
  requireExactArguments(values);
  if (!values.has("--enable-live-run")) {
    throw new Error("--enable-live-run is required");
  }
  const durationMs = requireBoundedInteger(values, "--duration-ms", 1_000, 60_000);
  const updateHz = requireBoundedInteger(values, "--update-hz", 1, 50);
  const statusHz = requireBoundedInteger(values, "--status-hz", 1, 10);
  const reportOutput = requireString(values, "--report-output");
  if (!isAbsolute(reportOutput)) {
    throw new Error("--report-output must be an absolute path");
  }
  return {
    enableLiveRun: true,
    durationMs,
    updateHz,
    statusHz,
    reportOutput
  };
}

export async function runStackChanHeadTargetLaneField(
  config: PicoConfig,
  options: StackChanHeadTargetLaneFieldOptions,
  dependencies: StackChanHeadTargetLaneFieldDependencies = {}
): Promise<StackChanHeadTargetLaneFieldReport> {
  const stackchan = requireStackChanFollowConfig(config);
  const createLane = dependencies.createLane ?? createStackChanHeadTargetLaneFromConfig;
  const createAdapter = dependencies.createAdapter ?? createStackChanAdapterFromConfig;
  const nowMs = dependencies.monotonicNowMs ?? monotonicNowMs;
  const waitMs = dependencies.waitMs ?? wait;
  const writeReport = dependencies.writeReport ?? writePrivateJsonReport;
  const lane = createLane(stackchan);
  const adapter = createAdapter(stackchan);
  const updateAcknowledgmentMs = createDistribution();
  const statusLatencyMs = createDistribution();
  let leaseId: string | undefined;
  let stoppedStatus: StackChanHeadTargetStatus | undefined;
  let stopLatencyMs: number;
  let adapterConnected = false;

  try {
    await adapter.connect();
    adapterConnected = true;
    await lane.connect();
    const lease = await lane.start({
      rateHz: stackchan.follow.commandRateHz,
      maxStepDeg: stackchan.follow.maxStepDeg,
      maxPendingAgeMs: stackchan.follow.maxPendingCommandAgeMs,
      speedDps: stackchan.follow.moveSpeedDps
    });
    leaseId = lease.leaseId;

    await Promise.all([
      runUpdateLoad({
        lane,
        leaseId,
        durationMs: options.durationMs,
        rateHz: options.updateHz,
        homeYaw: stackchan.follow.homeYaw,
        homePitch: stackchan.follow.homePitch,
        maxStepDeg: stackchan.follow.maxStepDeg,
        nowMs,
        waitMs,
        latency: updateAcknowledgmentMs
      }),
      runStatusLoad({
        lane,
        leaseId,
        durationMs: options.durationMs,
        rateHz: options.statusHz,
        nowMs,
        waitMs,
        latency: statusLatencyMs
      })
    ]);

    const stopStartedAtMs = nowMs();
    stoppedStatus = await lane.stop(leaseId);
    stopLatencyMs = nowMs() - stopStartedAtMs;
    leaseId = undefined;

    await adapter.moveHead(
      {
        yaw: stackchan.follow.homeYaw,
        pitch: stackchan.follow.homePitch
      },
      { speedDps: stackchan.follow.moveSpeedDps }
    );
    await waitMs(1_000);
    const finalPose = await adapter.getHeadAngles();
    const finalHomeErrorDeg = {
      yaw: roundHundredths(Math.abs(finalPose.yaw - stackchan.follow.homeYaw)),
      pitch: roundHundredths(Math.abs(finalPose.pitch - stackchan.follow.homePitch))
    };
    const report = createReport(
      options,
      updateAcknowledgmentMs,
      statusLatencyMs,
      stopLatencyMs,
      stoppedStatus,
      finalHomeErrorDeg,
      stackchan.follow.maxPendingCommandAgeMs
    );
    await writeReport(options.reportOutput, report);
    return report;
  } finally {
    await closeFieldResources(lane, leaseId, adapter, adapterConnected);
  }
}

async function closeFieldResources(
  lane: StackChanHeadTargetLane,
  leaseId: string | undefined,
  adapter: StackChanAdapter,
  adapterConnected: boolean
): Promise<void> {
  if (leaseId !== undefined) {
    await lane.stop(leaseId).catch(() => undefined);
  }
  await lane.close().catch(() => undefined);
  if (adapterConnected) {
    await adapter.close().catch(() => undefined);
  }
}

type UpdateLoadInput = {
  readonly lane: StackChanHeadTargetLane;
  readonly leaseId: string;
  readonly durationMs: number;
  readonly rateHz: number;
  readonly homeYaw: number;
  readonly homePitch: number;
  readonly maxStepDeg: number;
  readonly nowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
  readonly latency: FixedDistribution;
};

async function runUpdateLoad(input: UpdateLoadInput): Promise<void> {
  let sequence = 0;
  await runPeriodicLoad(input.durationMs, input.rateHz, input.nowMs, input.waitMs, async () => {
    sequence += 1;
    const startedAtMs = input.nowMs();
    const direction = sequence % 2 === 0 ? -1 : 1;
    await input.lane.update({
      leaseId: input.leaseId,
      sequence,
      pose: {
        yaw: clampHeadAngle(Math.round(input.homeYaw + direction * input.maxStepDeg), -90, 90),
        pitch: input.homePitch
      }
    });
    recordDistribution(input.latency, input.nowMs() - startedAtMs);
  });
}

async function runStatusLoad(input: {
  readonly lane: StackChanHeadTargetLane;
  readonly leaseId: string;
  readonly durationMs: number;
  readonly rateHz: number;
  readonly nowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
  readonly latency: FixedDistribution;
}): Promise<void> {
  await runPeriodicLoad(input.durationMs, input.rateHz, input.nowMs, input.waitMs, async () => {
    const startedAtMs = input.nowMs();
    await input.lane.status(input.leaseId);
    recordDistribution(input.latency, input.nowMs() - startedAtMs);
  });
}

async function runPeriodicLoad(
  durationMs: number,
  rateHz: number,
  nowMs: () => number,
  waitMs: (durationMs: number) => Promise<void>,
  operation: () => Promise<void>
): Promise<void> {
  const startedAtMs = nowMs();
  const deadlineMs = startedAtMs + durationMs;
  const intervalMs = 1_000 / rateHz;
  let nextAtMs = startedAtMs;
  while (nextAtMs < deadlineMs) {
    await waitMs(Math.max(0, nextAtMs - nowMs()));
    await operation();
    nextAtMs += intervalMs;
  }
  await waitMs(Math.max(0, deadlineMs - nowMs()));
}

function createReport(
  options: StackChanHeadTargetLaneFieldOptions,
  updateAcknowledgmentMs: FixedDistribution,
  statusLatencyMs: FixedDistribution,
  stopLatencyMs: number,
  status: StackChanHeadTargetStatus,
  finalHomeErrorDeg: { readonly yaw: number; readonly pitch: number },
  maximumPendingAgeMs: number
): StackChanHeadTargetLaneFieldReport {
  const updateSummary = summarizeDistribution(updateAcknowledgmentMs);
  const statusSummary = summarizeDistribution(statusLatencyMs);
  const durationSeconds = options.durationMs / 1_000;
  const acceptedUpdateRateHz = roundHundredths(status.accepted / durationSeconds);
  const deviceDispatchRateHz = roundHundredths(status.confirmedApplyReplies / durationSeconds);
  const passed = stressPassed(
    updateSummary,
    statusSummary,
    status,
    finalHomeErrorDeg,
    maximumPendingAgeMs,
    deviceDispatchRateHz,
    options.updateHz
  );
  return {
    schemaVersion: 1,
    passed,
    durationMs: options.durationMs,
    requestedUpdateHz: options.updateHz,
    acceptedUpdateRateHz,
    deviceDispatchRateHz,
    updateAcknowledgmentMs: updateSummary,
    statusLatencyMs: statusSummary,
    pendingAgeMs: status.pendingAgeMs,
    deviceDispatchLatencyMs: status.deviceDispatchLatencyMs,
    successfulReplyLatencyMs: status.successfulReplyLatencyMs,
    firmwareMcpStageUs: status.firmwareMcpStageUs,
    stopLatencyMs: roundHundredths(stopLatencyMs),
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    confirmedApplyReplies: status.confirmedApplyReplies,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    noOpDiscarded: status.noOpDiscarded,
    maximumActiveCalls: status.maximumActiveCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    postStopDispatches: status.postStopDispatches,
    finalHomeErrorDeg
  };
}

function stressPassed(
  update: StackChanFieldDistribution,
  statusLatency: StackChanFieldDistribution,
  status: StackChanHeadTargetStatus,
  finalHomeErrorDeg: { readonly yaw: number; readonly pitch: number },
  maximumPendingAgeMs: number,
  deviceDispatchRateHz: number,
  requestedUpdateHz: number
): boolean {
  return [
    update.count > 0,
    statusLatency.count > 0,
    update.p95 <= 25,
    update.p99 <= 50,
    statusLatency.p95 <= 100,
    deviceDispatchRateHz >=
      Math.min(minimumDeviceDispatchRateHz, requestedUpdateHz * minimumDeviceDispatchRateFraction),
    status.pendingAgeMs.p95 <= maximumPendingAgeP95Ms,
    status.pendingAgeMs.p99 <= maximumPendingAgeMs,
    status.phase === "stopped",
    status.dispatched > 0,
    status.confirmedApplyReplies > 0,
    status.failed === 0,
    status.staleDiscarded === 0,
    status.maximumActiveCalls <= STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
    status.maximumPendingDepth <= 1,
    status.postStopDispatches === 0,
    finalHomeErrorDeg.yaw <= 1,
    finalHomeErrorDeg.pitch <= 1
  ].every(Boolean);
}

function createDistribution(): FixedDistribution {
  return {
    buckets: new Uint32Array(maximumDistributionMs + 1),
    count: 0,
    max: 0
  };
}

function recordDistribution(distribution: FixedDistribution, valueMs: number): void {
  const value = Math.max(0, Math.round(valueMs));
  const bucket = Math.min(maximumDistributionMs, value);
  distribution.buckets[bucket] = (distribution.buckets[bucket] ?? 0) + 1;
  distribution.count += 1;
  distribution.max = Math.max(distribution.max, value);
}

function summarizeDistribution(distribution: FixedDistribution): StackChanFieldDistribution {
  return {
    count: distribution.count,
    p50: percentile(distribution, 0.5),
    p95: percentile(distribution, 0.95),
    p99: percentile(distribution, 0.99),
    max: distribution.max
  };
}

function percentile(distribution: FixedDistribution, percentileValue: number): number {
  if (distribution.count === 0) {
    return 0;
  }
  const rank = Math.max(1, Math.ceil(distribution.count * percentileValue));
  let seen = 0;
  for (let index = 0; index < distribution.buckets.length; index += 1) {
    seen += distribution.buckets[index] ?? 0;
    if (seen >= rank) {
      return index;
    }
  }
  return distribution.max;
}

function requireStackChanFollowConfig(config: PicoConfig): NonNullable<
  PicoConfig["camera"]["stackchan"]
> & {
  readonly follow: Extract<
    NonNullable<PicoConfig["camera"]["stackchan"]>["follow"],
    { readonly enabled: true }
  >;
} {
  const stackchan = config.camera.stackchan;
  if (stackchan === undefined || !stackchan.follow.enabled) {
    throw new Error("StackChan head target lane field config is unavailable");
  }
  return {
    ...stackchan,
    follow: stackchan.follow
  };
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === undefined || !name.startsWith("--") || values.has(name)) {
      throw new Error("head target lane field arguments are invalid");
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
    index += 1;
  }
  return values;
}

function requireExactArguments(values: ReadonlyMap<string, string | true>): void {
  const expected = new Set([
    "--enable-live-run",
    "--duration-ms",
    "--update-hz",
    "--status-hz",
    "--report-output"
  ]);
  if (
    values.size !== expected.size ||
    Array.from(values.keys()).some((name) => !expected.has(name))
  ) {
    throw new Error("head target lane field arguments are invalid");
  }
}

function requireString(values: ReadonlyMap<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireBoundedInteger(
  values: ReadonlyMap<string, string | true>,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(requireString(values, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function clampHeadAngle(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runStackChanHeadTargetLaneField(
      loadPicoConfigFromEnvironment(),
      parseStackChanHeadTargetLaneArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    process.stderr.write("StackChan head target lane field command failed\n");
    process.exitCode = 2;
  }
}
