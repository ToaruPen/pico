import { describe, expect, it } from "vitest";
import {
  createStackChanHeadTargetLane,
  STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS,
  type StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanMcpClient } from "../src/modules/stackchan/index.js";

type ToolCall = {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
};

const distribution = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0
};
const jsonNull: unknown = JSON.parse("null") as unknown;

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "running",
    lease_id: "lease-a",
    lease_id_match: true,
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmed: 0,
    confirmed_apply_replies: 0,
    failed: 0,
    stale_discarded: 0,
    no_op_discarded: 0,
    active_calls: 0,
    pending_depth: 0,
    maximum_active_calls: 0,
    maximum_pending_depth: 0,
    post_stop_dispatches: 0,
    last_accepted_sequence: jsonNull,
    last_confirmed_sequence: jsonNull,
    confirmed_pose: { yaw: 0, pitch: 33 },
    update_acknowledgment_ms: distribution,
    pending_age_ms: distribution,
    device_dispatch_latency_ms: distribution,
    successful_reply_latency_ms: distribution,
    firmware_mcp_stage_us: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    },
    last_error: jsonNull,
    ...overrides
  };
}

function result(payload: unknown): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload)
      }
    ]
  };
}

function recordingClient(results: readonly unknown[]): {
  readonly client: StackChanMcpClient;
  readonly calls: ToolCall[];
  readonly lifecycle: string[];
} {
  const calls: ToolCall[] = [];
  const lifecycle: string[] = [];
  let index = 0;

  return {
    calls,
    lifecycle,
    client: {
      connect: () => {
        lifecycle.push("connect");
        return Promise.resolve();
      },
      callTool: (request) => {
        calls.push(request);
        const next = results[index];
        index += 1;
        return Promise.resolve(next);
      },
      close: () => {
        lifecycle.push("close");
        return Promise.resolve();
      }
    }
  };
}

describe("StackChan head target lane client", () => {
  it("matches the gateway single-flight active-call bound", () => {
    expect(STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS).toBe(1);
  });

  it("reads the firmware cached motion state through the active lease", async () => {
    const { client, calls } = recordingClient([
      result(statusPayload()),
      result({
        yaw: 7,
        pitch: 33,
        target_yaw: 12,
        target_pitch: 33,
        moving: true
      })
    ]);
    const lane = createStackChanHeadTargetLane({ client });
    const lease = await lane.start({
      rateHz: 10,
      maxStepDeg: 4,
      maxPendingAgeMs: 180,
      speedDps: 90
    });

    await expect(lane.motionStatus(lease.leaseId)).resolves.toEqual({
      yaw: 7,
      pitch: 33,
      targetYaw: 12,
      targetPitch: 33,
      moving: true
    });
    expect(calls.at(-1)).toEqual({
      name: "stackchan_head_target_lane",
      arguments: {
        action: "motion_status",
        lease_id: "lease-a"
      }
    });
  });

  it("uses one strict typed MCP lifecycle", async () => {
    const { client, calls, lifecycle } = recordingClient([
      result(statusPayload()),
      result({
        accepted: true,
        replaced: false,
        pending_depth: 1,
        accepted_count: 1,
        replaced_count: 0,
        last_accepted_sequence: 1
      }),
      result(statusPayload({ accepted: 1 })),
      result(statusPayload({ accepted: 1 })),
      result(
        statusPayload({
          phase: "stopped",
          lease_id: jsonNull,
          accepted: 1
        })
      )
    ]);
    const lane = createStackChanHeadTargetLane({ client });

    await lane.connect();
    const lease = await lane.start({
      rateHz: 10,
      maxStepDeg: 4,
      maxPendingAgeMs: 180,
      speedDps: 90
    });
    const update = await lane.update({
      leaseId: lease.leaseId,
      sequence: 1,
      pose: { yaw: 4, pitch: 33 }
    });
    const cleared = await lane.clear(lease.leaseId);
    const status = await lane.status(lease.leaseId);
    const stopped = await lane.stop(lease.leaseId);
    await lane.close();

    expect(lease.leaseId).toBe("lease-a");
    expect(lease.confirmedPose).toEqual({ yaw: 0, pitch: 33 });
    expect(lease.status.phase).toBe("running");
    expect(update).toEqual({
      accepted: true,
      replaced: false,
      pendingDepth: 1,
      acceptedCount: 1,
      replacedCount: 0,
      lastAcceptedSequence: 1
    });
    expect(cleared.accepted).toBe(1);
    expect(status.accepted).toBe(1);
    expect(status.noOpDiscarded).toBe(0);
    expect(stopped.phase).toBe("stopped");
    expect(lifecycle).toEqual(["connect", "close"]);
    expect(calls).toEqual([
      {
        name: "stackchan_head_target_lane",
        arguments: {
          action: "start",
          rate_hz: 10,
          max_step_deg: 4,
          max_pending_age_ms: 180,
          speed_dps: 90
        }
      },
      {
        name: "stackchan_head_target_lane",
        arguments: {
          action: "update",
          lease_id: "lease-a",
          sequence: 1,
          yaw: 4,
          pitch: 33
        }
      },
      {
        name: "stackchan_head_target_lane",
        arguments: { action: "clear", lease_id: "lease-a" }
      },
      {
        name: "stackchan_head_target_lane",
        arguments: { action: "status", lease_id: "lease-a" }
      },
      {
        name: "stackchan_head_target_lane",
        arguments: { action: "stop", lease_id: "lease-a" }
      }
    ]);
  });

  it.each([
    { content: [{ type: "text", text: "{" }] },
    result({ error: "private device detail" }),
    { isError: true, content: [{ type: "text", text: "private detail" }] },
    result(statusPayload({ accepted: Number.MAX_SAFE_INTEGER + 1 })),
    result({ phase: "running", lease_id: "lease-a" })
  ])("contains malformed start response %# behind one fixed error", async (response) => {
    const { client } = recordingClient([response]);
    const lane = createStackChanHeadTargetLane({ client });

    await expect(
      lane.start({
        rateHz: 10,
        maxStepDeg: 4,
        maxPendingAgeMs: 180,
        speedDps: 90
      })
    ).rejects.toThrow("StackChan head target lane start failed");
  });

  it("rejects a response for a different lease", async () => {
    const { client } = recordingClient([
      result(statusPayload()),
      result(statusPayload({ lease_id_match: false }))
    ]);
    const lane = createStackChanHeadTargetLane({ client });
    const lease = await lane.start({
      rateHz: 10,
      maxStepDeg: 4,
      maxPendingAgeMs: 180,
      speedDps: 90
    });

    await expect(lane.status(lease.leaseId)).rejects.toThrow(
      "StackChan head target lane status failed"
    );
  });

  it("exposes aggregate status without target history", () => {
    const expected: keyof StackChanHeadTargetStatus = "pendingAgeMs";
    expect(expected).toBe("pendingAgeMs");
    expect(JSON.stringify(statusPayload())).not.toMatch(
      /targets|series|history|center_x|center_y|image|jpeg/u
    );
  });
});
