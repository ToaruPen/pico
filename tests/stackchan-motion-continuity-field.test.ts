import { describe, expect, it } from "vitest";

import {
  isStackChanMotionContinuityRunQualified,
  parseStackChanMotionContinuityArguments,
  runStackChanMotionContinuitySweep,
  type StackChanMotionSample,
  summarizeStackChanMotionContinuity
} from "../scripts/field/stackchan-motion-continuity.js";
import type { StackChanMotionTelemetryLane } from "../src/modules/stackchan/head-target-lane.js";

describe("StackChan motion continuity field harness", () => {
  it("requires explicit live permission and an aggregate report path", () => {
    expect(() =>
      parseStackChanMotionContinuityArguments([
        "--report-output",
        "/tmp/stackchan-motion-continuity.json"
      ])
    ).toThrow("--enable-live-run");
    expect(() => parseStackChanMotionContinuityArguments(["--enable-live-run"])).toThrow(
      "--report-output"
    );
    expect(
      parseStackChanMotionContinuityArguments([
        "--enable-live-run",
        "--report-output",
        "/tmp/stackchan-motion-continuity.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      reportOutput: "/tmp/stackchan-motion-continuity.json"
    });
  });

  it("qualifies a continuously advancing, bounded trajectory", () => {
    const samples: StackChanMotionSample[] = Array.from({ length: 62 }, (_, index) =>
      sample(index * 20, index, index === 0 || index === 61 ? 0 : 1)
    );

    expect(summarizeStackChanMotionContinuity(samples)).toEqual({
      sampleCount: 62,
      eligibleIntervals: 59,
      advancingIntervals: 59,
      stationaryIntervals: 0,
      reverseIntervals: 0,
      stationaryRatio: 0,
      longestStationaryMs: 0,
      sampleGapMs: {
        count: 61,
        p50: 20,
        p95: 20,
        p99: 20,
        max: 20
      },
      maximumStepDeg: 1,
      qualified: true
    });
  });

  it("detects the move-stop-move cadence described by the operator", () => {
    const samples: StackChanMotionSample[] = [
      sample(0, 0, 0),
      sample(20, 1, 1),
      sample(40, 2, 1),
      sample(60, 2, 1),
      sample(80, 2, 1),
      sample(100, 3, 1),
      sample(120, 4, 1),
      sample(140, 4, 1),
      sample(160, 4, 1),
      sample(180, 5, 1),
      sample(200, 5, 0)
    ];

    expect(summarizeStackChanMotionContinuity(samples)).toMatchObject({
      eligibleIntervals: 8,
      advancingIntervals: 4,
      stationaryIntervals: 4,
      reverseIntervals: 0,
      stationaryRatio: 0.5,
      longestStationaryMs: 40,
      maximumStepDeg: 1,
      qualified: false
    });
  });

  it("does not classify reversal coast or inactive dwell as a stop", () => {
    const samples: StackChanMotionSample[] = [
      sample(0, 0, 0),
      sample(20, 2, 1),
      sample(40, 4, 1),
      sample(60, 5, 0),
      sample(80, 5, 0),
      sample(100, 6, 0),
      sample(120, 5, -1),
      sample(140, 3, -1)
    ];

    expect(summarizeStackChanMotionContinuity(samples)).toMatchObject({
      eligibleIntervals: 2,
      advancingIntervals: 2,
      stationaryIntervals: 0,
      reverseIntervals: 0
    });
  });

  it("accepts the bounded single-flight pipeline and rejects a deeper lane", () => {
    const continuity = summarizeStackChanMotionContinuity(
      Array.from({ length: 62 }, (_, index) =>
        sample(index * 20, index, index === 0 || index === 61 ? 0 : 1)
      )
    );
    const lane = {
      accepted: 60,
      replaced: 0,
      dispatched: 60,
      confirmed: 60,
      failed: 0,
      staleDiscarded: 0,
      maximumActiveCalls: 1,
      maximumPendingDepth: 1,
      postStopDispatches: 0,
      deviceDispatchLatencyMs: {
        count: 60,
        p50: 80,
        p95: 120,
        p99: 140,
        max: 150
      }
    };
    const finalHomeErrorDeg = { yaw: 0, pitch: 0 };

    expect(
      isStackChanMotionContinuityRunQualified({
        continuity,
        lane,
        finalHomeErrorDeg
      })
    ).toBe(true);
    expect(
      isStackChanMotionContinuityRunQualified({
        continuity,
        lane: { ...lane, maximumActiveCalls: 2 },
        finalHomeErrorDeg
      })
    ).toBe(false);
  });

  it("keeps publishing scheduled targets while a telemetry sample is pending", async () => {
    let releaseTelemetry: (() => void) | undefined;
    const telemetryGate = new Promise<void>((resolve) => {
      releaseTelemetry = resolve;
    });
    const updates: number[] = [];
    const lane: StackChanMotionTelemetryLane = {
      connect: () => Promise.resolve(),
      start: () => Promise.reject(new Error("not used")),
      update: (target) => {
        updates.push(target.sequence);
        return Promise.resolve({
          accepted: true,
          replaced: false,
          pendingDepth: 1,
          acceptedCount: updates.length,
          replacedCount: 0,
          lastAcceptedSequence: target.sequence
        });
      },
      clear: () => Promise.reject(new Error("not used")),
      status: () => Promise.reject(new Error("not used")),
      stop: () => Promise.reject(new Error("not used")),
      close: () => Promise.resolve(),
      motionStatus: async () => {
        await telemetryGate;
        return {
          yaw: 0,
          pitch: 33,
          targetYaw: 12,
          targetPitch: 33,
          moving: true
        };
      }
    };

    const run = runStackChanMotionContinuitySweep({
      lane,
      leaseId: "lease-a",
      pitch: 33,
      targets: [
        { yaw: 4, direction: 1, beginsLeg: true, continuesAfter: true },
        { yaw: 8, direction: 1, beginsLeg: false, continuesAfter: true },
        { yaw: 12, direction: 1, beginsLeg: false, continuesAfter: false }
      ],
      timing: {
        sampleIntervalMs: 1,
        targetIntervalMs: 5,
        reversalGuardMs: 0,
        settleMs: 5
      }
    });

    await waitFor(() => updates.length === 3);
    expect(updates).toEqual([1, 2, 3]);
    releaseTelemetry?.();
    await run;
  });
});

function sample(
  observedAtMs: number,
  yaw: number,
  expectedDirection: -1 | 0 | 1
): StackChanMotionSample {
  return {
    observedAtMs,
    yaw,
    expectedDirection
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
