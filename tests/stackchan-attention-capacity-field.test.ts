import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCapacitySyntheticTarget,
  parseStackChanAttentionCapacityArguments,
  runStackChanAttentionCapacityField as runStackChanAttentionCapacityFieldBase
} from "../scripts/field/stackchan-face-follow.js";
import { definePicoConfig } from "../src/config/index.js";
import {
  advanceAttentionState,
  initialAttentionState
} from "../src/modules/stackchan/attention-controller.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";

const intervals = [250, 167, 125] as const;

function applyLaneStep(
  current: { readonly yaw: number; readonly pitch: number },
  target: { readonly yaw: number; readonly pitch: number },
  maximumStep: number
): { readonly yaw: number; readonly pitch: number } {
  const step = (from: number, to: number): number =>
    from + Math.max(-maximumStep, Math.min(maximumStep, to - from));
  return {
    yaw: step(current.yaw, target.yaw),
    pitch: step(current.pitch, target.pitch)
  };
}

function runStackChanAttentionCapacityField(
  ...[config, options, dependencies = {}]: Parameters<typeof runStackChanAttentionCapacityFieldBase>
): ReturnType<typeof runStackChanAttentionCapacityFieldBase> {
  return runStackChanAttentionCapacityFieldBase(config, options, {
    createHeadTargetLane: () => capacityHeadTargetLane(),
    ...dependencies
  });
}

describe("StackChan attention capacity field harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts only the bounded field cadence matrix without changing configured defaults", () => {
    const config = capacityConfig();

    expect(
      parseStackChanAttentionCapacityArguments([
        "--enable-live-run",
        "--capacity",
        "--capacity-intervals",
        "250,167,125",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/capacity.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      capacity: true,
      intervals,
      modelPath: "/tmp/model.onnx",
      reportOutput: "/tmp/capacity.json"
    });
    expect(config.camera.stackchan?.follow).toMatchObject({
      enabled: true,
      frameIntervalMs: 250
    });

    expect(() =>
      parseStackChanAttentionCapacityArguments([
        "--enable-live-run",
        "--capacity",
        "--capacity-intervals",
        "250,100,125",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/capacity.json"
      ])
    ).toThrow("--capacity-intervals");
  });

  it("uses one stream lease for the symmetric OBS/CTRL matrix and emits aggregates only", async () => {
    const events: string[] = [];
    const adapter = capacityAdapter(events);
    const runBlock = vi.fn(
      (input: { condition: "obs" | "ctrl"; intervalMs: (typeof intervals)[number] }) =>
        Promise.resolve(capacityBlock(input.condition, input.intervalMs))
    );
    let written: unknown;

    const report = await runStackChanAttentionCapacityField(capacityConfig(), capacityOptions(), {
      createAdapter: () => adapter,
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      runBlock,
      readCameraStatus: () =>
        Promise.resolve({
          ...activeCameraStatus(),
          available: false
        }),
      writeReport: (_path, value) => {
        written = value;
        return Promise.resolve();
      }
    });

    expect(events).toEqual(["connect", "close"]);
    expect(runBlock.mock.calls.map(([input]) => [input.condition, input.intervalMs])).toEqual([
      ["obs", 250],
      ["ctrl", 250],
      ["obs", 167],
      ["ctrl", 167],
      ["obs", 125],
      ["ctrl", 125],
      ["ctrl", 125],
      ["obs", 125],
      ["ctrl", 167],
      ["obs", 167],
      ["ctrl", 250],
      ["obs", 250]
    ]);
    expect(report).toEqual(written);
    expect(report).toMatchObject({
      status: "passed",
      details: {
        warmupMs: 2_000,
        measuredMs: 8_000,
        intervals
      }
    });
    const obsBlock = report.details.blocks.find((block) => block.condition === "obs");
    const ctrlBlock = report.details.blocks.find((block) => block.condition === "ctrl");
    expect(obsBlock?.headCommands).toBe(0);
    expect(ctrlBlock?.control).toMatchObject({
      updateAcknowledgmentMs: {
        p95: 20,
        p99: 23
      },
      headTargetLane: {
        failed: 0,
        staleDiscarded: 0,
        noOpDiscarded: 0,
        maximumActiveCalls: 1,
        maximumPendingDepth: 1,
        postStopDispatches: 0
      },
      maximumConcurrentObservationTicks: 1,
      maximumConcurrentMoves: 1,
      postDrainInFlightObservations: 0,
      postDrainInFlightMoves: 0
    });
    expect(JSON.stringify(report)).not.toMatch(
      /jpegBytes|image|frameDump|centerX|centerY|boundingBox|detection|sequence(?:s|List)|commandSeries|angleSeries|targetSeries|latencySeries|capturePath/i
    );
  });

  it("fails closed when OBS sends a command or CTRL leaves the bounded trajectory", async () => {
    const adapter = capacityAdapter([]);
    const report = await runStackChanAttentionCapacityField(capacityConfig(), capacityOptions(), {
      createAdapter: () => adapter,
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      runBlock: (input) =>
        Promise.resolve({
          ...capacityBlock(input.condition, input.intervalMs),
          ...(input.condition === "obs" ? { headCommands: 1 } : { outOfBoundsCommands: 1 })
        }),
      readCameraStatus: () => Promise.resolve(activeCameraStatus()),
      writeReport: () => Promise.resolve()
    });

    expect(report.status).toBe("failed");
  });

  it("drives only the deterministic 0,+4,0,-4,0 yaw path at pitch 33", () => {
    const target = createCapacitySyntheticTarget({ yaw: 0, pitch: 33 });
    const controllerConfig = {
      deadZone: 0.1,
      deadZoneRelease: 0.14,
      stepQuantization: "round" as const,
      targetFilter: { enabled: false } as const,
      yawGainDeg: 44,
      pitchGainDeg: 30,
      flipYaw: 1 as const,
      flipPitch: -1 as const,
      maxStepDeg: 4,
      trackingPitchMin: 23,
      lostHoldMs: 1_000,
      scanDwellMs: 900,
      scanYaw: [-35, 0, 35] as const,
      scanPitch: [33, 23] as const
    };
    let pose = { yaw: 0, pitch: 33 };
    let state = initialAttentionState();
    const poses: Array<{ yaw: number; pitch: number }> = [];

    for (let index = 0; index < 5; index += 1) {
      const result = advanceAttentionState(
        state,
        {
          nowMs: index * 250,
          currentPose: pose,
          detections: target.next(pose)
        },
        controllerConfig
      );
      expect(result.effect.kind).toBe("move");
      if (result.effect.kind !== "move") {
        throw new Error("expected deterministic move");
      }
      pose = applyLaneStep(pose, result.effect.pose, controllerConfig.maxStepDeg);
      state = result.state;
      poses.push(pose);
    }

    expect(poses).toEqual([
      { yaw: 4, pitch: 33 },
      { yaw: 0, pitch: 33 },
      { yaw: -4, pitch: 33 },
      { yaw: 0, pitch: 33 },
      { yaw: 4, pitch: 33 }
    ]);
  });

  it("keeps one-degree quantized feedback on the same bounded trajectory", () => {
    const target = createCapacitySyntheticTarget({ yaw: 0, pitch: 33 });
    const controllerConfig = {
      deadZone: 0.1,
      deadZoneRelease: 0.14,
      stepQuantization: "round" as const,
      targetFilter: { enabled: false } as const,
      yawGainDeg: 44,
      pitchGainDeg: 30,
      flipYaw: 1 as const,
      flipPitch: -1 as const,
      maxStepDeg: 4,
      trackingPitchMin: 23,
      lostHoldMs: 1_000,
      scanDwellMs: 900,
      scanYaw: [-35, 0, 35] as const,
      scanPitch: [33, 23] as const
    };
    let pose = { yaw: -1, pitch: 32 };
    let state = initialAttentionState();
    const poses: Array<{ yaw: number; pitch: number }> = [];

    for (let index = 0; index < 5; index += 1) {
      const result = advanceAttentionState(
        state,
        {
          nowMs: index * 250,
          currentPose: pose,
          detections: target.next(pose)
        },
        controllerConfig
      );
      expect(result.effect.kind).toBe("move");
      if (result.effect.kind !== "move") {
        throw new Error("expected deterministic move");
      }
      pose = applyLaneStep(pose, result.effect.pose, controllerConfig.maxStepDeg);
      state = result.state;
      poses.push(pose);
    }

    expect(poses).toEqual([
      { yaw: 3, pitch: 32 },
      { yaw: -1, pitch: 32 },
      { yaw: -5, pitch: 32 },
      { yaw: -1, pitch: 32 },
      { yaw: 3, pitch: 32 }
    ]);
  });

  it("runs OBS without commands and CTRL with one-degree device quantization", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]
    });
    vi.setSystemTime(0);
    let sequence = 0;
    let pose = { yaw: -1, pitch: 32 };
    const events: string[] = [];
    const adapter = capacityAdapter(events);
    const run = runStackChanAttentionCapacityField(capacityConfig(), capacityOptions(), {
      createAdapter: () => ({
        ...adapter,
        captureJpeg: () =>
          Promise.resolve({
            bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
            mimeType: "image/jpeg" as const,
            sequence: ++sequence,
            receivedAtMs: Date.now()
          }),
        getHeadAngles: () => Promise.resolve({ ...pose }),
        moveHead: (nextPose) => {
          return new Promise<void>((resolvePromise) => {
            setTimeout(() => {
              pose = {
                yaw: nextPose.yaw - 1,
                pitch: nextPose.pitch - 1
              };
              resolvePromise();
            }, 200);
          });
        }
      }),
      createHeadTargetLane: () => capacityHeadTargetLane(() => pose),
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      readCameraStatus: () => Promise.resolve(activeCameraStatus()),
      writeReport: () => Promise.resolve(),
      monotonicNowMs: () => Date.now(),
      wallNowMs: () => Date.now()
    });

    await waitForScheduledTimer();
    await vi.advanceTimersByTimeAsync(150_000);
    const report = await run;

    expect(report.status, JSON.stringify(report.details.blocks, undefined, 2)).toBe("passed");
    expect(
      report.details.blocks
        .filter((block) => block.condition === "obs")
        .every((block) => block.headCommands === 0)
    ).toBe(true);
    const controlBlocks = report.details.blocks.filter((block) => block.condition === "ctrl");
    for (const block of controlBlocks) {
      expect(block.headCommands).toBeGreaterThan(0);
      expect(block.outOfBoundsCommands).toBe(0);
      expect(block.servoLimitCommands).toBe(0);
      expect(block.control).toMatchObject({
        maximumConcurrentObservationTicks: 1,
        maximumConcurrentMoves: 1,
        moveOverlapAttempts: 0,
        postDrainInFlightObservations: 0,
        postDrainInFlightMoves: 0
      });
      expect(block.home?.returnedHome).toBe(true);
    }
    expect(
      controlBlocks.every(
        (block) =>
          block.control?.preStopInFlightObservations === 0 &&
          block.control.preStopInFlightMoves === 0
      )
    ).toBe(true);
    expect(events).toEqual(["connect", "close"]);
  });
});

function capacityConfig() {
  return definePicoConfig({
    camera: {
      stackchan: {
        sourceId: "stackchan-core-s3",
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        follow: {
          enabled: true,
          commandTransport: "async-latest",
          stepQuantization: "round",
          targetFilter: { enabled: false },
          frameIntervalMs: 250,
          homeYaw: 0,
          homePitch: 33,
          deadZone: 0.1,
          yawGainDeg: 44,
          maxStepDeg: 4,
          moveSpeedDps: 90,
          scanPitch: [33, 23]
        }
      }
    },
    vision: {
      attentionDetection: {
        enabled: true,
        provider: "onnxruntime",
        modelFamily: "pinto441-yolox-body-head-hand-face-dist",
        modelPath: "/tmp/config-model.onnx",
        inputWidth: 320,
        inputHeight: 256
      }
    }
  });
}

function capacityOptions() {
  return {
    enableLiveRun: true as const,
    capacity: true as const,
    intervals,
    modelPath: "/tmp/model.onnx",
    reportOutput: "/tmp/capacity.json"
  };
}

function capacityAdapter(events: string[]): StackChanAdapter {
  return {
    connect: () => {
      events.push("connect");
      return Promise.resolve();
    },
    captureJpeg: () =>
      Promise.resolve({
        bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
        mimeType: "image/jpeg",
        sequence: 1,
        receivedAtMs: 1
      }),
    getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 33 }),
    moveHead: () => Promise.resolve(),
    close: () => {
      events.push("close");
      return Promise.resolve();
    }
  };
}

function activeCameraStatus() {
  return {
    running: true,
    subscribers: 1,
    physicalRunning: true,
    available: true
  };
}

function capacityBlock(condition: "obs" | "ctrl", intervalMs: (typeof intervals)[number]) {
  return {
    condition,
    intervalMs,
    measuredDurationMs: 8_000,
    processedObservations: 48,
    observationRateHz: 6,
    theoreticalRateAchievement: 1,
    tickWallMs: distribution(),
    interObservationGapMs: distribution(),
    latestFrameLatencyMs: distribution(),
    frameAgeMs: distribution(),
    inferenceMs: distribution(),
    duplicateSequenceCount: 0,
    cameraInterruptions: 0,
    headCommands: condition === "obs" ? 0 : 32,
    outOfBoundsCommands: 0,
    servoLimitCommands: 0,
    camera: activeCameraStatus(),
    ...(condition === "ctrl"
      ? {
          control: {
            acceptedUpdates: 32,
            failedUpdates: 0,
            updatesPerSecond: 4,
            updateAcknowledgmentMs: faceDistribution(),
            headTargetLane: {
              accepted: 32,
              replaced: 0,
              dispatched: 32,
              applyReplies: 32,
              failed: 0,
              staleDiscarded: 0,
              noOpDiscarded: 0,
              maximumActiveCalls: 1,
              maximumPendingDepth: 1,
              postStopDispatches: 0,
              pendingAgeMs: laneDistribution(32),
              deviceDispatchLatencyMs: laneDistribution(32)
            },
            observationsWhileMoveInFlight: 2,
            staleFramesDiscarded: 0,
            staleFrameDispatches: 0,
            maximumPendingMoveDepth: 1 as const,
            pendingMoveReplacements: 1,
            pendingMoveDispatches: 1,
            maximumConcurrentObservationTicks: 1,
            maximumConcurrentMoves: 1,
            observationOverlapAttempts: 0,
            moveOverlapAttempts: 0,
            preStopInFlightObservations: 0,
            preStopInFlightMoves: 0,
            postDrainInFlightObservations: 0,
            postDrainInFlightMoves: 0,
            stopAfterCommands: 0
          },
          home: {
            returnedHome: true
          }
        }
      : {})
  };
}

function distribution() {
  return {
    count: 48,
    p50Ms: 16,
    p95Ms: 20,
    p99Ms: 23,
    maxMs: 24
  };
}

function faceDistribution() {
  return {
    count: 48,
    p50: 16,
    p95: 20,
    p99: 23,
    min: 12,
    max: 24
  };
}

function capacityHeadTargetLane(
  confirmedPose: () => { readonly yaw: number; readonly pitch: number } = () => ({
    yaw: 0,
    pitch: 33
  })
): StackChanHeadTargetLane {
  const leaseId = "capacity-lease";
  let accepted = 0;
  let phase: StackChanHeadTargetStatus["phase"] = "running";
  const status = (): StackChanHeadTargetStatus => ({
    phase,
    leaseId,
    leaseIdMatch: true,
    accepted,
    replaced: 0,
    dispatched: accepted,
    confirmed: accepted,
    confirmedApplyReplies: accepted,
    failed: 0,
    staleDiscarded: 0,
    noOpDiscarded: 0,
    activeCalls: 0,
    pendingDepth: 0,
    maximumActiveCalls: accepted === 0 ? 0 : 1,
    maximumPendingDepth: accepted === 0 ? 0 : 1,
    postStopDispatches: 0,
    updateAcknowledgmentMs: laneDistribution(accepted),
    pendingAgeMs: laneDistribution(accepted),
    deviceDispatchLatencyMs: laneDistribution(accepted),
    successfulReplyLatencyMs: laneDistribution(accepted),
    firmwareMcpStageUs: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    }
  });
  return {
    connect: () => Promise.resolve(),
    start: () =>
      Promise.resolve({
        leaseId,
        confirmedPose: confirmedPose(),
        status: status()
      }),
    update: (target) => {
      accepted += 1;
      return Promise.resolve({
        accepted: true,
        replaced: false,
        pendingDepth: 1,
        acceptedCount: accepted,
        replacedCount: 0,
        lastAcceptedSequence: target.sequence
      });
    },
    clear: () => Promise.resolve(status()),
    status: () => Promise.resolve(status()),
    stop: () => {
      phase = "stopped";
      return Promise.resolve(status());
    },
    close: () => Promise.resolve()
  };
}

function laneDistribution(count: number) {
  return {
    count,
    p50: count === 0 ? 0 : 10,
    p95: count === 0 ? 0 : 20,
    p99: count === 0 ? 0 : 23,
    max: count === 0 ? 0 : 24
  };
}

async function waitForScheduledTimer(): Promise<void> {
  while (vi.getTimerCount() === 0) {
    await new Promise<void>((resolvePromise) => {
      setImmediate(resolvePromise);
    });
  }
}
