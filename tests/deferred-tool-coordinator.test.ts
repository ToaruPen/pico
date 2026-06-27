import { describe, expect, it } from "vitest";

import {
  createDeferredToolCoordinator,
  type DeferredToolExecutionResult
} from "../src/runtime/deferred-tool-coordinator.js";

describe("deferred tool coordinator", () => {
  it("queues a camera scene job and delivers its completed result once for the same active session", async () => {
    const coordinator = createDeferredToolCoordinator({
      now: sequenceNow([
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.250Z",
        "2026-06-23T00:00:00.500Z"
      ])
    });

    const queued = coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () =>
        Promise.resolve({
          status: "completed",
          capturedAt: "2026-06-23T00:00:00.100Z",
          summary: "机の上に教材が見えます。"
        })
    });
    await coordinator.waitForIdle();

    expect(queued).toMatchObject({
      status: "queued",
      kind: "camera_scene_description",
      sessionId: "session-1"
    });
    if (queued.status !== "queued") {
      throw new Error("expected deferred tool job to be queued");
    }

    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:00.500Z"
      })
    ).toEqual([
      {
        jobId: queued.jobId,
        kind: "camera_scene_description",
        status: "completed",
        capturedAt: "2026-06-23T00:00:00.100Z",
        completedAt: "2026-06-23T00:00:00.250Z",
        summary: "机の上に教材が見えます。"
      }
    ]);
    coordinator.acknowledgeDelivered([queued.jobId]);
    expect(coordinator.pendingJobCount()).toBe(0);
    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:00.600Z"
      })
    ).toEqual([]);
  });

  it("delivers failed results so staff gets a follow-up after deferred tool failure", async () => {
    const coordinator = createDeferredToolCoordinator({
      now: sequenceNow([
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.250Z",
        "2026-06-23T00:00:00.500Z"
      ])
    });

    const queued = coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () =>
        Promise.resolve({
          status: "failed",
          summary: "pico perception service configuration failed"
        })
    });
    await coordinator.waitForIdle();

    if (queued.status !== "queued") {
      throw new Error("expected deferred tool job to be queued");
    }

    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:00.500Z"
      })
    ).toEqual([
      {
        jobId: queued.jobId,
        kind: "camera_scene_description",
        status: "failed",
        capturedAt: "2026-06-23T00:00:00.250Z",
        completedAt: "2026-06-23T00:00:00.250Z",
        summary: "pico perception service configuration failed"
      }
    ]);
    coordinator.acknowledgeDelivered([queued.jobId]);
    expect(coordinator.pendingJobCount()).toBe(0);
    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:00.600Z"
      })
    ).toEqual([]);
  });

  it("delivers thrown deferred execution failures so staff gets a follow-up", async () => {
    const coordinator = createDeferredToolCoordinator({
      now: sequenceNow([
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.250Z",
        "2026-06-23T00:00:00.500Z"
      ])
    });

    const queued = coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () => Promise.reject(new Error("vlm tunnel unavailable"))
    });
    await coordinator.waitForIdle();

    if (queued.status !== "queued") {
      throw new Error("expected deferred tool job to be queued");
    }

    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:00.500Z"
      })
    ).toEqual([
      {
        jobId: queued.jobId,
        kind: "camera_scene_description",
        status: "failed",
        capturedAt: "2026-06-23T00:00:00.250Z",
        completedAt: "2026-06-23T00:00:00.250Z",
        summary: "vlm tunnel unavailable"
      }
    ]);
  });

  it("does not deliver completed results to a different or closed session", async () => {
    const coordinator = createDeferredToolCoordinator({
      now: fixedNow("2026-06-23T00:00:00.000Z")
    });

    coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () => Promise.resolve(completedResult("2026-06-23T00:00:00.100Z"))
    });
    await coordinator.waitForIdle();

    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-2",
        now: "2026-06-23T00:00:01.000Z"
      })
    ).toEqual([]);
    expect(coordinator.pendingJobCount()).toBe(0);
    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: undefined,
        now: "2026-06-23T00:00:01.000Z"
      })
    ).toEqual([]);
  });

  it("suppresses cancelled jobs even when the provider resolves later", async () => {
    let resolveJob: ((result: DeferredToolExecutionResult) => void) | undefined;
    const coordinator = createDeferredToolCoordinator({
      now: sequenceNow(["2026-06-23T00:00:00.000Z", "2026-06-23T00:00:02.000Z"])
    });

    coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () =>
        new Promise<DeferredToolExecutionResult>((resolve) => {
          resolveJob = resolve;
        })
    });
    coordinator.cancelSession("session-1", "session_closed");
    expect(coordinator.pendingJobCount()).toBe(0);
    resolveJob?.(completedResult("2026-06-23T00:00:01.000Z"));
    await coordinator.waitForIdle();

    expect(
      coordinator.collectDeliverableResults({
        sessionId: "session-1",
        activeSessionId: "session-1",
        now: "2026-06-23T00:00:02.000Z"
      })
    ).toEqual([]);
  });

  it("rejects a second camera scene job while the same resource is in flight", () => {
    const coordinator = createDeferredToolCoordinator({
      now: fixedNow("2026-06-23T00:00:00.000Z")
    });

    coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () => new Promise(() => undefined)
    });

    expect(
      coordinator.enqueue({
        kind: "camera_scene_description",
        toolCallId: "tool-call-2",
        sessionId: "session-1",
        execute: () => Promise.resolve(completedResult("2026-06-23T00:00:01.000Z"))
      })
    ).toEqual({
      status: "rejected",
      kind: "camera_scene_description",
      reason: "resource_in_flight"
    });
  });

  it("evicts terminal failed jobs after delivery acknowledgement", async () => {
    const coordinator = createDeferredToolCoordinator({
      now: sequenceNow([
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.250Z",
        "2026-06-23T00:00:00.500Z"
      ])
    });

    const queued = coordinator.enqueue({
      kind: "camera_scene_description",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      execute: () => Promise.reject(new Error("vlm tunnel unavailable"))
    });
    await coordinator.waitForIdle();

    if (queued.status !== "queued") {
      throw new Error("expected deferred tool job to be queued");
    }
    coordinator.acknowledgeDelivered([queued.jobId]);

    expect(coordinator.pendingJobCount()).toBe(0);
  });
});

function completedResult(capturedAt: string): DeferredToolExecutionResult {
  return {
    status: "completed",
    capturedAt,
    summary: "室内の様子を確認しました。"
  };
}

function fixedNow(timestamp: string): () => string {
  return () => timestamp;
}

function sequenceNow(timestamps: readonly string[]): () => string {
  let index = 0;

  return () => timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0] ?? "";
}
