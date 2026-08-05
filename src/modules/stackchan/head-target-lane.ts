import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { PicoStackChanConfig } from "../../config/index.js";
import {
  closeStackChanMcpSession,
  type StackChanHeadPose,
  type StackChanMcpClient
} from "./index.js";

const laneToolName = "stackchan_head_target_lane";
const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const jsonNull: unknown = JSON.parse("null") as unknown;

export const STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS = 1;

export type StackChanHeadTargetStartConfig = {
  readonly rateHz: number;
  readonly maxStepDeg: number;
  readonly maxPendingAgeMs: number;
  readonly speedDps: number;
};

export type StackChanHeadTargetUpdate = {
  readonly leaseId: string;
  readonly sequence: number;
  readonly pose: StackChanHeadPose;
};

export type StackChanLatencyDistribution = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

export type StackChanStageDistribution = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

export type StackChanFirmwareMcpStageMetrics = {
  readonly count: number;
  readonly receiveToApply: StackChanStageDistribution;
  readonly toolApply: StackChanStageDistribution;
  readonly applyToReplyEnqueue: StackChanStageDistribution;
  readonly schedulerHops: Readonly<Record<string, number>>;
};

export type StackChanHeadTargetPhase = "starting" | "running" | "stopping" | "stopped" | "failed";

export type StackChanHeadTargetStatus = {
  readonly phase: StackChanHeadTargetPhase;
  readonly leaseId?: string;
  readonly leaseIdMatch?: boolean;
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly confirmedApplyReplies: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly noOpDiscarded: number;
  readonly activeCalls: number;
  readonly pendingDepth: number;
  readonly maximumActiveCalls: number;
  readonly maximumPendingDepth: number;
  readonly postStopDispatches: number;
  readonly lastAcceptedSequence?: number;
  readonly lastConfirmedSequence?: number;
  readonly confirmedPose?: StackChanHeadPose;
  readonly updateAcknowledgmentMs: StackChanLatencyDistribution;
  readonly pendingAgeMs: StackChanLatencyDistribution;
  readonly deviceDispatchLatencyMs: StackChanLatencyDistribution;
  readonly successfulReplyLatencyMs: StackChanLatencyDistribution;
  readonly firmwareMcpStageUs: StackChanFirmwareMcpStageMetrics;
  readonly lastError?: string;
};

export type StackChanHeadTargetLease = {
  readonly leaseId: string;
  readonly confirmedPose: StackChanHeadPose;
  readonly status: StackChanHeadTargetStatus;
};

export type StackChanHeadTargetUpdateAcknowledgment = {
  readonly accepted: true;
  readonly replaced: boolean;
  readonly pendingDepth: number;
  readonly acceptedCount: number;
  readonly replacedCount: number;
  readonly lastAcceptedSequence: number;
};

export type StackChanHeadMotionStatus = {
  readonly yaw: number;
  readonly pitch: number;
  readonly targetYaw: number;
  readonly targetPitch: number;
  readonly moving: boolean;
};

export type StackChanHeadTargetLane = {
  readonly connect: () => Promise<void>;
  readonly start: (config: StackChanHeadTargetStartConfig) => Promise<StackChanHeadTargetLease>;
  readonly update: (
    target: StackChanHeadTargetUpdate
  ) => Promise<StackChanHeadTargetUpdateAcknowledgment>;
  readonly clear: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly status: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly stop: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly close: () => Promise<void>;
};

export type StackChanMotionTelemetryLane = StackChanHeadTargetLane & {
  readonly motionStatus: (leaseId: string) => Promise<StackChanHeadMotionStatus>;
};

export function createStackChanHeadTargetLane(options: {
  readonly client: StackChanMcpClient;
}): StackChanMotionTelemetryLane {
  return {
    connect: async () => {
      try {
        await options.client.connect();
      } catch {
        throw laneError("connect");
      }
    },
    start: async (config) =>
      containLaneFailure("start", async () => {
        requireFiniteNumber(config.rateHz, 1, 10);
        requireFiniteNumber(config.maxStepDeg, Number.MIN_VALUE, 30);
        requireInteger(config.maxPendingAgeMs, 50, 500);
        requireInteger(config.speedDps, 15, 240);
        const payload = await callLaneTool(options.client, {
          action: "start",
          rate_hz: config.rateHz,
          max_step_deg: config.maxStepDeg,
          max_pending_age_ms: config.maxPendingAgeMs,
          speed_dps: config.speedDps
        });
        const status = parseStatus(payload);
        if (
          status.phase !== "running" ||
          status.leaseId === undefined ||
          status.leaseIdMatch !== true ||
          status.confirmedPose === undefined
        ) {
          throw new Error("invalid start status");
        }
        return {
          leaseId: status.leaseId,
          confirmedPose: status.confirmedPose,
          status
        };
      }),
    update: async (target) =>
      containLaneFailure("update", async () => {
        requireLeaseId(target.leaseId);
        requireInteger(target.sequence, 0, maximumSafeInteger);
        requireInteger(target.pose.yaw, -90, 90);
        requireInteger(target.pose.pitch, 5, 85);
        const payload = await callLaneTool(options.client, {
          action: "update",
          lease_id: target.leaseId,
          sequence: target.sequence,
          yaw: target.pose.yaw,
          pitch: target.pose.pitch
        });
        return parseUpdateAcknowledgment(payload, target.sequence);
      }),
    clear: async (leaseId) => callStatusAction(options.client, "clear", leaseId),
    motionStatus: async (leaseId) =>
      containLaneFailure("motion status", async () => {
        requireLeaseId(leaseId);
        const payload = await callLaneTool(options.client, {
          action: "motion_status",
          lease_id: leaseId
        });
        return parseMotionStatus(payload);
      }),
    status: async (leaseId) => callStatusAction(options.client, "status", leaseId),
    stop: async (leaseId) => callStatusAction(options.client, "stop", leaseId),
    close: async () => {
      try {
        await options.client.close();
      } catch {
        throw laneError("close");
      }
    }
  };
}

export function createStackChanHeadTargetLaneFromConfig(
  config: PicoStackChanConfig,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    readonly client?: StackChanMcpClient;
  } = {}
): StackChanMotionTelemetryLane {
  const token = environment[config.bearerTokenEnv]?.trim();
  if (token === undefined || token === "") {
    throw new Error("StackChan bearer token is missing");
  }
  if (dependencies.client !== undefined) {
    return createStackChanHeadTargetLane({ client: dependencies.client });
  }

  const sdkClient = new Client({
    name: "pico-stackchan-head-target",
    version: "0.0.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`
      },
      redirect: "error"
    }
  });
  const client: StackChanMcpClient = {
    connect: async () => sdkClient.connect(transport as unknown as Transport),
    callTool: async (request) =>
      sdkClient.callTool(
        {
          name: request.name,
          arguments: request.arguments
        },
        undefined,
        { timeout: config.timeoutMs }
      ),
    close: async () => closeStackChanMcpSession(transport, sdkClient)
  };
  return createStackChanHeadTargetLane({ client });
}

async function callStatusAction(
  client: StackChanMcpClient,
  action: "clear" | "status" | "stop",
  leaseId: string
): Promise<StackChanHeadTargetStatus> {
  return containLaneFailure(action, async () => {
    requireLeaseId(leaseId);
    const payload = await callLaneTool(client, {
      action,
      lease_id: leaseId
    });
    const status = parseStatus(payload);
    if (status.leaseIdMatch !== true) {
      throw new Error("lease mismatch");
    }
    return status;
  });
}

async function callLaneTool(
  client: StackChanMcpClient,
  arguments_: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: laneToolName,
    arguments: arguments_
  });
  return decodeToolPayload(result);
}

async function containLaneFailure<T>(action: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw laneError(action);
  }
}

function laneError(action: string): Error {
  return new Error(`StackChan head target lane ${action} failed`);
}

function decodeToolPayload(result: unknown): Record<string, unknown> {
  const text = requireToolText(result);
  const payload = parseToolText(text);
  if (typeof payload.error === "string") {
    throw new Error("tool payload failed");
  }
  return payload;
}

function requireToolText(result: unknown): string {
  if (!isRecord(result) || result.isError === true) {
    throw new Error("tool result failed");
  }
  const contentValue = result.content;
  if (!Array.isArray(contentValue) || contentValue.length !== 1) {
    throw new Error("tool content is invalid");
  }
  const item: unknown = contentValue[0] as unknown;
  if (!isRecord(item) || typeof item.text !== "string") {
    throw new Error("tool text is invalid");
  }
  return item.text;
}

function parseToolText(text: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("tool JSON is invalid");
  }
  if (!isRecord(payload)) {
    throw new Error("tool payload is invalid");
  }
  return payload;
}

const statusFields = new Set([
  "phase",
  "lease_id",
  "lease_id_match",
  "accepted",
  "replaced",
  "dispatched",
  "confirmed",
  "confirmed_apply_replies",
  "failed",
  "stale_discarded",
  "no_op_discarded",
  "active_calls",
  "pending_depth",
  "maximum_active_calls",
  "maximum_pending_depth",
  "post_stop_dispatches",
  "last_accepted_sequence",
  "last_confirmed_sequence",
  "confirmed_pose",
  "update_acknowledgment_ms",
  "pending_age_ms",
  "device_dispatch_latency_ms",
  "successful_reply_latency_ms",
  "firmware_mcp_stage_us",
  "last_error"
]);

function parseStatus(payload: Record<string, unknown>): StackChanHeadTargetStatus {
  requireExactFields(payload, statusFields);
  const phase = requireOneOf(payload.phase, [
    "starting",
    "running",
    "stopping",
    "stopped",
    "failed"
  ] as const);
  const leaseId = requireOptionalJsonString(payload.lease_id);
  const leaseIdMatch = requireOptionalJsonBoolean(payload.lease_id_match);
  const confirmedPose =
    payload.confirmed_pose === jsonNull ? undefined : requirePose(payload.confirmed_pose);
  const lastError = requireOptionalJsonString(payload.last_error, 240);
  const lastAcceptedSequence = requireOptionalJsonCounter(payload.last_accepted_sequence);
  const lastConfirmedSequence = requireOptionalJsonCounter(payload.last_confirmed_sequence);
  const confirmed = requireCounter(payload.confirmed);
  const confirmedApplyReplies = requireConfirmedApplyReplies(payload, confirmed);

  return {
    phase,
    ...(leaseId === undefined ? {} : { leaseId }),
    ...(leaseIdMatch === undefined ? {} : { leaseIdMatch }),
    accepted: requireCounter(payload.accepted),
    replaced: requireCounter(payload.replaced),
    dispatched: requireCounter(payload.dispatched),
    confirmed,
    confirmedApplyReplies,
    failed: requireCounter(payload.failed),
    staleDiscarded: requireCounter(payload.stale_discarded),
    noOpDiscarded: requireCounter(payload.no_op_discarded),
    activeCalls: requireCounter(payload.active_calls),
    pendingDepth: requireCounter(payload.pending_depth),
    maximumActiveCalls: requireCounter(payload.maximum_active_calls),
    maximumPendingDepth: requireCounter(payload.maximum_pending_depth),
    postStopDispatches: requireCounter(payload.post_stop_dispatches),
    ...(lastAcceptedSequence === undefined ? {} : { lastAcceptedSequence }),
    ...(lastConfirmedSequence === undefined ? {} : { lastConfirmedSequence }),
    ...(confirmedPose === undefined ? {} : { confirmedPose }),
    updateAcknowledgmentMs: requireDistribution(payload.update_acknowledgment_ms),
    pendingAgeMs: requireDistribution(payload.pending_age_ms),
    deviceDispatchLatencyMs: requireDistribution(payload.device_dispatch_latency_ms),
    successfulReplyLatencyMs: requireDistribution(payload.successful_reply_latency_ms),
    firmwareMcpStageUs: requireFirmwareMcpStageMetrics(payload.firmware_mcp_stage_us),
    ...(lastError === undefined ? {} : { lastError })
  };
}

function requireConfirmedApplyReplies(payload: Record<string, unknown>, confirmed: number): number {
  const confirmedApplyReplies = requireCounter(payload.confirmed_apply_replies);
  if (confirmedApplyReplies !== confirmed) {
    throw new Error("confirmed apply reply count does not match");
  }
  return confirmedApplyReplies;
}

const updateFields = new Set([
  "accepted",
  "replaced",
  "pending_depth",
  "accepted_count",
  "replaced_count",
  "last_accepted_sequence"
]);

function parseUpdateAcknowledgment(
  payload: Record<string, unknown>,
  expectedSequence: number
): StackChanHeadTargetUpdateAcknowledgment {
  requireExactFields(payload, updateFields);
  if (payload.accepted !== true || typeof payload.replaced !== "boolean") {
    throw new Error("update acknowledgment is invalid");
  }
  const lastAcceptedSequence = requireCounter(payload.last_accepted_sequence);
  if (lastAcceptedSequence !== expectedSequence) {
    throw new Error("update sequence does not match");
  }
  const pendingDepth = requireCounter(payload.pending_depth);
  if (pendingDepth > 1) {
    throw new Error("pending depth is invalid");
  }
  return {
    accepted: true,
    replaced: payload.replaced,
    pendingDepth,
    acceptedCount: requireCounter(payload.accepted_count),
    replacedCount: requireCounter(payload.replaced_count),
    lastAcceptedSequence
  };
}

function parseMotionStatus(payload: Record<string, unknown>): StackChanHeadMotionStatus {
  requireExactFields(payload, new Set(["yaw", "pitch", "target_yaw", "target_pitch", "moving"]));
  if (typeof payload.moving !== "boolean") {
    throw new Error("motion status moving flag is invalid");
  }
  return {
    yaw: requireInteger(payload.yaw, -90, 90),
    pitch: requireInteger(payload.pitch, 5, 85),
    targetYaw: requireInteger(payload.target_yaw, -90, 90),
    targetPitch: requireInteger(payload.target_pitch, 5, 85),
    moving: payload.moving
  };
}

function requireDistribution(value: unknown): StackChanLatencyDistribution {
  if (!isRecord(value)) {
    throw new Error("latency distribution is invalid");
  }
  requireExactFields(value, new Set(["count", "p50", "p95", "p99", "max"]));
  const distribution = {
    count: requireCounter(value.count),
    p50: requireCounter(value.p50),
    p95: requireCounter(value.p95),
    p99: requireCounter(value.p99),
    max: requireCounter(value.max)
  };
  if (
    distribution.p50 > distribution.p95 ||
    distribution.p95 > distribution.p99 ||
    distribution.p99 > distribution.max
  ) {
    throw new Error("latency percentiles are invalid");
  }
  return distribution;
}

function requireFirmwareMcpStageMetrics(value: unknown): StackChanFirmwareMcpStageMetrics {
  if (!isRecord(value)) {
    throw new Error("firmware MCP stage metrics are invalid");
  }
  requireExactFields(
    value,
    new Set(["count", "receiveToApply", "toolApply", "applyToReplyEnqueue", "schedulerHops"])
  );
  const count = requireCounter(value.count);
  const receiveToApply = requireStageDistribution(value.receiveToApply);
  const toolApply = requireStageDistribution(value.toolApply);
  const applyToReplyEnqueue = requireStageDistribution(value.applyToReplyEnqueue);
  const schedulerHops = requireSchedulerHopCounts(value.schedulerHops);
  if (
    receiveToApply.count !== count ||
    toolApply.count !== count ||
    applyToReplyEnqueue.count !== count ||
    Object.values(schedulerHops).reduce((sum, item) => sum + item, 0) !== count
  ) {
    throw new Error("firmware MCP stage metric counts do not match");
  }
  return {
    count,
    receiveToApply,
    toolApply,
    applyToReplyEnqueue,
    schedulerHops
  };
}

function requireStageDistribution(value: unknown): StackChanStageDistribution {
  if (!isRecord(value)) {
    throw new Error("stage distribution is invalid");
  }
  requireExactFields(value, new Set(["count", "p50", "p95", "max"]));
  const distribution = {
    count: requireCounter(value.count),
    p50: requireCounter(value.p50),
    p95: requireCounter(value.p95),
    max: requireCounter(value.max)
  };
  if (distribution.p50 > distribution.p95 || distribution.p95 > distribution.max) {
    throw new Error("stage percentiles are invalid");
  }
  return distribution;
}

function requireSchedulerHopCounts(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    throw new Error("scheduler hop counts are invalid");
  }
  const result: Record<string, number> = {};
  for (const [hops, count] of Object.entries(value)) {
    if (!/^(?:0|[1-9]\d*)$/u.test(hops) || Number(hops) > 64) {
      throw new Error("scheduler hop count key is invalid");
    }
    result[hops] = requireCounter(count);
  }
  return result;
}

function requirePose(value: unknown): StackChanHeadPose {
  if (!isRecord(value)) {
    throw new Error("pose is invalid");
  }
  requireExactFields(value, new Set(["yaw", "pitch"]));
  const yaw = requireInteger(value.yaw, -90, 90);
  const pitch = requireInteger(value.pitch, 5, 85);
  return { yaw, pitch };
}

function requireExactFields(value: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((field) => !expected.has(field))) {
    throw new Error("response fields are invalid");
  }
}

function requireLeaseId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("lease ID is invalid");
  }
  return value;
}

function requireOptionalJsonString(value: unknown, maximumLength = 256): string | undefined {
  if (value === jsonNull) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error("nullable string is invalid");
  }
  return value;
}

function requireOptionalJsonBoolean(value: unknown): boolean | undefined {
  if (value === jsonNull) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error("nullable boolean is invalid");
}

function requireOptionalJsonCounter(value: unknown): number | undefined {
  return value === jsonNull ? undefined : requireCounter(value);
}

function requireCounter(value: unknown): number {
  return requireInteger(value, 0, maximumSafeInteger);
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("integer is outside its contract");
  }
  return value;
}

function requireFiniteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error("number is outside its contract");
  }
  return value;
}

function requireOneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error("string is outside its contract");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
