import { describe, expect, it } from "vitest";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";
import type { AttentionDetectionModel } from "../src/modules/vision/attention-detection.js";
import {
  type CreateStackChanAttentionRuntimeOptions,
  createStackChanAttentionRuntime as createRuntimeImplementation,
  type StackChanAttentionScheduler
} from "../src/runtime/stackchan-attention-runtime.js";

const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const followConfig = {
  enabled: true as const,
  commandTransport: "async-latest" as const,
  stepQuantization: "round" as const,
  targetFilter: { enabled: false } as const,
  commandRateHz: 10,
  maxPendingCommandAgeMs: 180,
  frameIntervalMs: 1000,
  maxFrameAgeMs: 180,
  homeYaw: 0,
  homePitch: 35,
  trackingPitchMin: 25,
  deadZone: 0.08,
  deadZoneRelease: 0.14,
  yawGainDeg: 40,
  pitchGainDeg: 30,
  flipYaw: 1 as const,
  flipPitch: -1 as const,
  maxStepDeg: 8,
  moveSpeedDps: 90,
  lostHoldMs: 1000,
  scanDwellMs: 900,
  scanYaw: [-35, 0, 35],
  scanPitch: [35, 25]
};

function laneStatus(overrides: Partial<StackChanHeadTargetStatus> = {}): StackChanHeadTargetStatus {
  const emptyDistribution = {
    count: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0
  };
  return {
    phase: "running",
    leaseId: "lease-a",
    leaseIdMatch: true,
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmed: 0,
    confirmedApplyReplies: 0,
    failed: 0,
    staleDiscarded: 0,
    noOpDiscarded: 0,
    activeCalls: 0,
    pendingDepth: 0,
    maximumActiveCalls: 0,
    maximumPendingDepth: 0,
    postStopDispatches: 0,
    confirmedPose: { yaw: 0, pitch: 35 },
    updateAcknowledgmentMs: emptyDistribution,
    pendingAgeMs: emptyDistribution,
    deviceDispatchLatencyMs: emptyDistribution,
    successfulReplyLatencyMs: emptyDistribution,
    firmwareMcpStageUs: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    },
    ...overrides
  };
}

function inertHeadTargetLane(): StackChanHeadTargetLane {
  let accepted = 0;
  const replaced = 0;
  let status = laneStatus();

  return {
    connect: () => Promise.resolve(),
    start: () =>
      Promise.resolve({
        leaseId: "lease-a",
        confirmedPose: { yaw: 0, pitch: 35 },
        status
      }),
    update: (target) => {
      accepted += 1;
      status = {
        ...status,
        accepted,
        replaced,
        pendingDepth: 1,
        maximumPendingDepth: 1,
        lastAcceptedSequence: target.sequence
      };
      return Promise.resolve({
        accepted: true,
        replaced: false,
        pendingDepth: 1,
        acceptedCount: accepted,
        replacedCount: replaced,
        lastAcceptedSequence: target.sequence
      });
    },
    clear: () => {
      status = { ...status, pendingDepth: 0 };
      return Promise.resolve(status);
    },
    status: () => Promise.resolve(status),
    stop: () => {
      status = {
        ...status,
        phase: "stopped",
        pendingDepth: 0
      };
      return Promise.resolve(status);
    },
    close: () => Promise.resolve()
  };
}

function oneShotHeadTargetLane(requestedYaws: number[]): StackChanHeadTargetLane {
  let status = laneStatus();

  return {
    connect: () => Promise.resolve(),
    start: () =>
      Promise.resolve({
        leaseId: "lease-a",
        confirmedPose: { yaw: 0, pitch: 35 },
        status
      }),
    update: (target) => {
      requestedYaws.push(target.pose.yaw);
      const confirmedPose = status.confirmedPose ?? { yaw: 0, pitch: 35 };
      const step = (current: number, requested: number): number =>
        current + Math.max(-4, Math.min(4, requested - current));
      status = {
        ...status,
        accepted: status.accepted + 1,
        dispatched: status.dispatched + 1,
        confirmed: status.confirmed + 1,
        confirmedApplyReplies: status.confirmedApplyReplies + 1,
        confirmedPose: {
          yaw: step(confirmedPose.yaw, target.pose.yaw),
          pitch: step(confirmedPose.pitch, target.pose.pitch)
        },
        lastAcceptedSequence: target.sequence,
        lastConfirmedSequence: target.sequence
      };
      return Promise.resolve({
        accepted: true,
        replaced: false,
        pendingDepth: 0,
        acceptedCount: status.accepted,
        replacedCount: status.replaced,
        lastAcceptedSequence: target.sequence
      });
    },
    clear: () => Promise.resolve(status),
    status: () => Promise.resolve(status),
    stop: () => {
      status = { ...status, phase: "stopped" };
      return Promise.resolve(status);
    },
    close: () => Promise.resolve()
  };
}

function replaceableOneShotHeadTargetLane(input: {
  readonly nowMs: () => number;
  readonly requestedYaws: number[];
  readonly deviceDispatches: Array<{
    readonly from: { readonly yaw: number; readonly pitch: number };
    readonly pose: { readonly yaw: number; readonly pitch: number };
  }>;
}): StackChanHeadTargetLane {
  let status = laneStatus();
  let active:
    | {
        readonly pose: { readonly yaw: number; readonly pitch: number };
        readonly sequence: number;
        readonly completesAtMs: number;
      }
    | undefined;
  let pending:
    | {
        readonly pose: { readonly yaw: number; readonly pitch: number };
        readonly sequence: number;
      }
    | undefined;

  const startDispatch = (target: {
    readonly pose: { readonly yaw: number; readonly pitch: number };
    readonly sequence: number;
  }): void => {
    const confirmedPose = status.confirmedPose ?? { yaw: 0, pitch: 35 };
    const step = (current: number, requested: number): number =>
      current + Math.max(-4, Math.min(4, requested - current));
    const pose = {
      yaw: step(confirmedPose.yaw, target.pose.yaw),
      pitch: step(confirmedPose.pitch, target.pose.pitch)
    };
    input.deviceDispatches.push({ from: { ...confirmedPose }, pose });
    active = {
      pose,
      sequence: target.sequence,
      completesAtMs: input.nowMs() + 200
    };
    status = {
      ...status,
      dispatched: status.dispatched + 1,
      activeCalls: 1,
      maximumActiveCalls: 1
    };
  };

  const completeDueDispatch = (): void => {
    if (active === undefined || input.nowMs() < active.completesAtMs) {
      return;
    }
    status = {
      ...status,
      confirmed: status.confirmed + 1,
      confirmedApplyReplies: status.confirmedApplyReplies + 1,
      confirmedPose: { ...active.pose },
      lastConfirmedSequence: active.sequence,
      activeCalls: 0
    };
    active = undefined;
    if (pending !== undefined) {
      const next = pending;
      pending = undefined;
      status = { ...status, pendingDepth: 0 };
      startDispatch(next);
    }
  };

  return {
    connect: () => Promise.resolve(),
    start: () =>
      Promise.resolve({
        leaseId: "lease-a",
        confirmedPose: { yaw: 0, pitch: 35 },
        status
      }),
    update: (target) => {
      input.requestedYaws.push(target.pose.yaw);
      const replaced = pending !== undefined;
      status = {
        ...status,
        accepted: status.accepted + 1,
        replaced: status.replaced + (replaced ? 1 : 0),
        lastAcceptedSequence: target.sequence
      };
      if (active === undefined) {
        startDispatch(target);
      } else {
        pending = {
          pose: { ...target.pose },
          sequence: target.sequence
        };
        status = {
          ...status,
          pendingDepth: 1,
          maximumPendingDepth: 1
        };
      }
      return Promise.resolve({
        accepted: true,
        replaced,
        pendingDepth: status.pendingDepth,
        acceptedCount: status.accepted,
        replacedCount: status.replaced,
        lastAcceptedSequence: target.sequence
      });
    },
    clear: () => {
      pending = undefined;
      status = { ...status, pendingDepth: 0 };
      return Promise.resolve(status);
    },
    status: () => {
      completeDueDispatch();
      return Promise.resolve(status);
    },
    stop: () => {
      active = undefined;
      pending = undefined;
      status = {
        ...status,
        phase: "stopped",
        activeCalls: 0,
        pendingDepth: 0
      };
      return Promise.resolve(status);
    },
    close: () => Promise.resolve()
  };
}

function createStackChanAttentionRuntime(
  options: Omit<CreateStackChanAttentionRuntimeOptions, "headTargetLane"> & {
    readonly headTargetLane?: StackChanHeadTargetLane;
  }
) {
  return createRuntimeImplementation({
    ...options,
    waitMs: options.waitMs ?? (() => Promise.resolve()),
    headTargetLane: options.headTargetLane ?? inertHeadTargetLane()
  });
}

function controlledScheduler(): {
  readonly scheduler: StackChanAttentionScheduler;
  readonly tick: () => Promise<void>;
  readonly events: string[];
} {
  const events: string[] = [];
  let callback: (() => Promise<void>) | undefined;

  return {
    events,
    scheduler(task, intervalMs) {
      events.push(`schedule:${intervalMs}`);
      callback = task;
      return {
        cancel() {
          events.push("cancel");
        }
      };
    },
    async tick() {
      if (callback === undefined) {
        throw new Error("attention runtime was not scheduled");
      }
      await callback();
    }
  };
}

function device(events: string[]): StackChanAdapter {
  let pose = { yaw: 0, pitch: 35 };

  return {
    connect() {
      events.push("connect");
      return Promise.resolve();
    },
    captureJpeg() {
      events.push("capture");
      return Promise.resolve({ bytes: jpeg, mimeType: "image/jpeg" });
    },
    getHeadAngles() {
      events.push("angles");
      return Promise.resolve(pose);
    },
    moveHead(nextPose) {
      pose = nextPose;
      events.push(`move:${nextPose.yaw},${nextPose.pitch}`);
      return Promise.resolve();
    },
    close() {
      events.push("close");
      return Promise.resolve();
    }
  };
}

function emptyModel(events: string[]): AttentionDetectionModel {
  return {
    detect() {
      events.push("detect");
      return Promise.resolve([]);
    }
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    }
  };
}

async function flushMicrotasks(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe("StackChan attention runtime", () => {
  it("emits one default-off diagnostic without changing commands, status, or timing", async () => {
    const run = async (observe: boolean) => {
      const events: string[] = [];
      const schedule = controlledScheduler();
      const requestedYaws: number[] = [];
      const diagnostics: unknown[] = [];
      const runtime = createStackChanAttentionRuntime({
        adapter: device(events),
        headTargetLane: oneShotHeadTargetLane(requestedYaws),
        model: {
          detect: () =>
            Promise.resolve([
              {
                label: "face" as const,
                confidence: 0.9,
                boundingBox: { xMin: 0.55, yMin: 0.4, xMax: 0.67, yMax: 0.6 }
              }
            ])
        },
        config: { ...followConfig, stepQuantization: "error-feedback" },
        scheduler: schedule.scheduler,
        nowMs: () => 250,
        ...(observe ? { onDecision: (diagnostic: unknown) => diagnostics.push(diagnostic) } : {})
      });

      await runtime.start();
      await schedule.tick();
      const status = runtime.status();
      await runtime.stop();
      return { events, requestedYaws, status, diagnostics };
    };

    const withoutObserver = await run(false);
    const withObserver = await run(true);

    expect(withObserver.events).toEqual(withoutObserver.events);
    expect(withObserver.requestedYaws).toEqual(withoutObserver.requestedYaws);
    expect(withObserver.status).toEqual(withoutObserver.status);
    expect(withoutObserver.diagnostics).toEqual([]);
    expect(withObserver.diagnostics).toHaveLength(1);
    expect(withObserver.diagnostics[0]).toMatchObject({
      decisionAtMs: 250,
      quantizationMode: "error-feedback",
      baseConfirmedPose: { yaw: 0, pitch: 35 },
      requestedPose: { yaw: 1, pitch: 35 }
    });
  });

  it("starts the lane after camera home and stops it before final home", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const lane = inertHeadTargetLane();
    const headTargetLane: StackChanHeadTargetLane = {
      ...lane,
      connect: () => {
        events.push("lane:connect");
        return lane.connect();
      },
      start: (config) => {
        events.push("lane:start");
        return lane.start(config);
      },
      stop: (leaseId) => {
        events.push("lane:stop");
        return lane.stop(leaseId);
      },
      close: () => {
        events.push("lane:close");
        return lane.close();
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane,
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await runtime.stop();

    expect(events).toEqual([
      "connect",
      "move:0,35",
      "lane:connect",
      "lane:start",
      "lane:stop",
      "move:0,39",
      "move:0,35",
      "lane:close",
      "close"
    ]);
  });

  it("is single-use after stop before start", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");

    expect(events).toEqual([]);
    expect(schedule.events).toEqual([]);
    expect(runtime.status().phase).toBe("stopped");
  });

  it("connects, homes, and schedules exactly one loop across repeated starts", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await Promise.all([runtime.start(), runtime.start()]);

    expect(events).toEqual(["connect", "move:0,35"]);
    expect(schedule.events).toEqual(["schedule:1000"]);
    expect(runtime.status()).toMatchObject({
      phase: "running",
      framesProcessed: 0,
      moveCount: 0
    });
  });

  it("uses the configured speed for lane startup and both home moves", async () => {
    const events: string[] = [];
    const motions: Array<{
      readonly yaw: number;
      readonly pitch: number;
      readonly speed: number | undefined;
    }> = [];
    const laneStarts: Array<{
      readonly speedDps: number;
    }> = [];
    const laneUpdates: number[] = [];
    const schedule = controlledScheduler();
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        moveHead(pose, motion) {
          motions.push({ ...pose, speed: motion?.speedDps });
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        start(config) {
          laneStarts.push({ speedDps: config.speedDps });
          return lane.start(config);
        },
        update(target) {
          laneUpdates.push(target.pose.yaw);
          return lane.update(target);
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await runtime.stop();

    expect(motions).toEqual([
      { yaw: 0, pitch: 35, speed: 90 },
      { yaw: 0, pitch: 39, speed: 90 },
      { yaw: 0, pitch: 35, speed: 90 }
    ]);
    expect(laneStarts).toEqual([{ speedDps: 90 }]);
    expect(laneUpdates).toEqual([-35]);
  });

  it("does not accumulate target steps while the gateway pose remains unconfirmed", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let angleReads = 0;
    const commandedYaws: number[] = [];
    const laneYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        getHeadAngles() {
          angleReads += 1;
          return Promise.resolve({ yaw: -40, pitch: 35 });
        },
        moveHead(pose) {
          commandedYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          laneYaws.push(target.pose.yaw);
          return lane.update(target);
        }
      },
      model: {
        detect: () =>
          Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ])
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();

    expect(angleReads).toBe(0);
    expect(commandedYaws).toEqual([0]);
    expect(laneYaws).toEqual([8, 8]);

    await runtime.stop();
  });

  it("repeats a scan waypoint through one-shot gateway steps and dwells after confirmation", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const requestedYaws: number[] = [];
    let nowMs = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: oneShotHeadTargetLane(requestedYaws),
      model: emptyModel(events),
      config: {
        ...followConfig,
        frameIntervalMs: 125,
        maxStepDeg: 4
      },
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    for (let index = 0; index < 9; index += 1) {
      await schedule.tick();
      nowMs += 125;
    }

    expect(requestedYaws).toEqual([-35, -35, -35, -35, -35, -35, -35, -35, -35]);

    await schedule.tick();
    const arrivalAtMs = nowMs;
    nowMs += 125;
    expect(requestedYaws).toHaveLength(9);

    while (nowMs - arrivalAtMs < 900) {
      await schedule.tick();
      nowMs += 125;
      expect(requestedYaws).toHaveLength(9);
    }

    await schedule.tick();
    expect(requestedYaws.at(-1)).toBe(0);
    expect(requestedYaws).toHaveLength(10);

    await runtime.stop();
  });

  it("submits one scan step per confirmed advance without leaving a same-pose dispatch", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const requestedYaws: number[] = [];
    const deviceDispatches: Array<{
      readonly from: { readonly yaw: number; readonly pitch: number };
      readonly pose: { readonly yaw: number; readonly pitch: number };
    }> = [];
    let nowMs = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: replaceableOneShotHeadTargetLane({
        nowMs: () => nowMs,
        requestedYaws,
        deviceDispatches
      }),
      model: emptyModel(events),
      config: {
        ...followConfig,
        frameIntervalMs: 125,
        maxStepDeg: 4
      },
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    for (let index = 0; index < 40 && !requestedYaws.includes(0); index += 1) {
      await schedule.tick();
      nowMs += 125;
    }

    expect(requestedYaws).toEqual([-35, -35, -35, -35, -35, -35, -35, -35, -35, 0]);
    expect(
      deviceDispatches.filter(
        (dispatch) =>
          dispatch.from.yaw === dispatch.pose.yaw && dispatch.from.pitch === dispatch.pose.pitch
      )
    ).toEqual([]);
    expect(deviceDispatches.slice(0, 9).map((dispatch) => dispatch.pose.yaw)).toEqual([
      -4, -8, -12, -16, -20, -24, -28, -32, -35
    ]);

    await runtime.stop();
  });

  it("retries a scan waypoint when the lane becomes idle without confirmed progress", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const requestedYaws: number[] = [];
    let status = laneStatus();
    const lane: StackChanHeadTargetLane = {
      ...inertHeadTargetLane(),
      update(target) {
        requestedYaws.push(target.pose.yaw);
        status = {
          ...status,
          accepted: status.accepted + 1,
          pendingDepth: 1,
          maximumPendingDepth: 1,
          lastAcceptedSequence: target.sequence
        };
        return Promise.resolve({
          accepted: true,
          replaced: false,
          pendingDepth: 1,
          acceptedCount: status.accepted,
          replacedCount: 0,
          lastAcceptedSequence: target.sequence
        });
      },
      status() {
        if (status.accepted > 0) {
          status = {
            ...status,
            failed: status.failed + 1,
            pendingDepth: 0
          };
        }
        return Promise.resolve(status);
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: lane,
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();

    expect(requestedYaws).toEqual([-35, -35]);

    await runtime.stop();
  });

  it("clears the pending scan waypoint when a centered target is reacquired", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const lane = inertHeadTargetLane();
    const requestedYaws: number[] = [];
    let clearCount = 0;
    let detections = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: {
        ...lane,
        update(target) {
          requestedYaws.push(target.pose.yaw);
          return lane.update(target);
        },
        clear(leaseId) {
          clearCount += 1;
          return lane.clear(leaseId);
        }
      },
      model: {
        detect() {
          detections += 1;
          return Promise.resolve(
            detections === 1
              ? []
              : [
                  {
                    label: "face" as const,
                    confidence: 0.9,
                    boundingBox: { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 }
                  }
                ]
          );
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();

    expect(requestedYaws).toEqual([-35]);
    expect(clearCount).toBe(1);
    expect(runtime.status().attention.mode).toBe("track");
    expect(runtime.status().flow.pendingMoveDepth).toBe(0);

    await runtime.stop();
  });

  it("starts scan dwell when delayed lane status confirms arrival, not at observation time", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const delayedStatus = deferred<StackChanHeadTargetStatus>();
    const requestedYaws: number[] = [];
    let nowMs = 0;
    let statusCalls = 0;
    const confirmedAtWaypoint = laneStatus({
      confirmedPose: { yaw: -35, pitch: 35 }
    });
    const lane: StackChanHeadTargetLane = {
      ...inertHeadTargetLane(),
      start: () =>
        Promise.resolve({
          leaseId: "lease-a",
          confirmedPose: { yaw: -35, pitch: 35 },
          status: confirmedAtWaypoint
        }),
      update(target) {
        requestedYaws.push(target.pose.yaw);
        return Promise.resolve({
          accepted: true,
          replaced: false,
          pendingDepth: 0,
          acceptedCount: requestedYaws.length,
          replacedCount: 0,
          lastAcceptedSequence: target.sequence
        });
      },
      status() {
        statusCalls += 1;
        return statusCalls === 1 ? delayedStatus.promise : Promise.resolve(confirmedAtWaypoint);
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: lane,
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    const arrivalTick = schedule.tick();
    await flushMicrotasks();
    nowMs = 1_000;
    delayedStatus.resolve(confirmedAtWaypoint);
    await arrivalTick;

    nowMs = 1_001;
    await schedule.tick();
    expect(requestedYaws).toEqual([]);

    nowMs = 1_899;
    await schedule.tick();
    expect(requestedYaws).toEqual([]);

    nowMs = 1_900;
    await schedule.tick();
    expect(requestedYaws).toEqual([0]);

    await runtime.stop();
  });

  it("keeps target loss timing anchored to observation before delayed lane status", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const delayedStatus = deferred<StackChanHeadTargetStatus>();
    let nowMs = 100;
    let detections = 0;
    let statusCalls = 0;
    const status = laneStatus();
    const lane: StackChanHeadTargetLane = {
      ...inertHeadTargetLane(),
      status() {
        statusCalls += 1;
        return statusCalls === 1 ? delayedStatus.promise : Promise.resolve(status);
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: lane,
      model: {
        detect() {
          detections += 1;
          return Promise.resolve(
            detections === 1
              ? [
                  {
                    label: "face" as const,
                    confidence: 0.9,
                    boundingBox: { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 }
                  }
                ]
              : []
          );
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    const targetTick = schedule.tick();
    await flushMicrotasks();
    nowMs = 1_100;
    delayedStatus.resolve(status);
    await targetTick;

    expect(runtime.status().attention.lastTarget?.observedAtMs).toBe(100);

    nowMs = 1_500;
    await schedule.tick();
    expect(runtime.status().attention.mode).toBe("scan");
    expect(runtime.status().attention.lastTarget?.observedAtMs).toBe(100);

    await runtime.stop();
  });

  it("keeps the confirmed control reference when a lane update fails", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let angleReads = 0;
    let updateAttempts = 0;
    const commandedYaws: number[] = [];
    const laneYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        getHeadAngles() {
          angleReads += 1;
          return Promise.resolve({ yaw: 50, pitch: 35 });
        },
        moveHead(pose) {
          commandedYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          updateAttempts += 1;
          laneYaws.push(target.pose.yaw);
          return updateAttempts === 1
            ? Promise.reject(new Error("lane update failed"))
            : lane.update(target);
        }
      },
      model: {
        detect: () =>
          Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ])
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();

    expect(angleReads).toBe(0);
    expect(commandedYaws).toEqual([0]);
    expect(laneYaws).toEqual([8, 8]);
    expect(runtime.status()).toMatchObject({
      moveCount: 1,
      errors: [
        {
          code: "tick_failed",
          message: "StackChan attention tick failed"
        }
      ]
    });

    await runtime.stop();
  });

  it("reports whether the latest target is centered without retaining image detections", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let nowMs = 100;
    let detectionCount = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model: {
        detect() {
          detectionCount += 1;
          return Promise.resolve(
            detectionCount === 1
              ? [
                  {
                    label: "face" as const,
                    confidence: 0.9,
                    boundingBox: { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 }
                  }
                ]
              : []
          );
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });
    await runtime.start();
    await schedule.tick();

    nowMs = 125;
    expect(runtime.status()).toMatchObject({
      attention: {
        mode: "track",
        targetVisible: true,
        targetFrames: 1,
        centeredFrames: 1,
        lastTarget: {
          label: "face",
          confidence: 0.9,
          centerX: 0.5,
          centerY: 0.5,
          horizontalError: 0,
          verticalError: 0,
          centered: true,
          observedAtMs: 100,
          ageMs: 25
        }
      }
    });

    nowMs = 500;
    await schedule.tick();
    nowMs = 525;
    expect(runtime.status()).toMatchObject({
      attention: {
        mode: "hold",
        targetVisible: false,
        targetFrames: 1,
        centeredFrames: 1,
        lastTarget: {
          observedAtMs: 100,
          ageMs: 425
        }
      }
    });
    expect(JSON.stringify(runtime.status())).not.toContain("boundingBox");

    await runtime.stop();
  });

  it("discards repeated and over-age stream frames before inference", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let captureIndex = 0;
    let detectCalls = 0;
    const frames = [
      { sequence: 10, receivedAtMs: 990 },
      { sequence: 10, receivedAtMs: 1_000 },
      { sequence: 11, receivedAtMs: 700 }
    ] as const;
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...device(events),
        captureJpeg() {
          const frame = frames[captureIndex];
          captureIndex += 1;
          if (frame === undefined) {
            throw new Error("unexpected capture");
          }
          return Promise.resolve({
            bytes: jpeg,
            mimeType: "image/jpeg" as const,
            sequence: frame.sequence,
            capturedAtMs: frame.receivedAtMs,
            encodedAtMs: frame.receivedAtMs,
            receivedAtMs: frame.receivedAtMs
          });
        }
      },
      model: {
        detect() {
          detectCalls += 1;
          return Promise.resolve([]);
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 1_000
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();
    await schedule.tick();

    expect(detectCalls).toBe(1);
    expect(runtime.status()).toMatchObject({
      framesProcessed: 1,
      flow: {
        lastAcceptedFrameSequence: 10,
        staleFramesDiscarded: 2,
        staleFrameDispatches: 0
      }
    });

    await runtime.stop();
  });

  it("discards a frame that ages out while confirmed lane status is pending", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const delayedStatus = deferred<StackChanHeadTargetStatus>();
    const lane = inertHeadTargetLane();
    const laneYaws: number[] = [];
    let nowMs = 0;
    let detectCalls = 0;
    let statusCalls = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...device(events),
        captureJpeg() {
          return Promise.resolve({
            bytes: jpeg,
            mimeType: "image/jpeg" as const,
            sequence: 1,
            receivedAtMs: 0
          });
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          laneYaws.push(target.pose.yaw);
          return lane.update(target);
        },
        status() {
          statusCalls += 1;
          return statusCalls === 1 ? delayedStatus.promise : lane.status("lease-a");
        }
      },
      model: {
        detect() {
          detectCalls += 1;
          return Promise.resolve([]);
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    const tick = schedule.tick();
    await flushMicrotasks();
    nowMs = 181;
    delayedStatus.resolve(laneStatus());
    await tick;

    expect(detectCalls).toBe(1);
    expect(laneYaws).toEqual([]);
    expect(runtime.status()).toMatchObject({
      framesProcessed: 0,
      attention: {
        mode: "acquire",
        targetVisible: false,
        targetFrames: 0
      },
      flow: {
        staleFramesDiscarded: 1
      }
    });
    expect(runtime.status().flow).not.toHaveProperty("lastAcceptedFrameSequence");

    await runtime.stop();
  });

  it("never overlaps capture and inference ticks", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let releaseDetection: (() => void) | undefined;
    const model: AttentionDetectionModel = {
      detect() {
        events.push("detect:start");
        return new Promise((resolve) => {
          releaseDetection = () => {
            events.push("detect:end");
            resolve([]);
          };
        });
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model,
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });
    await runtime.start();

    const firstTick = schedule.tick();
    await Promise.resolve();
    await Promise.resolve();
    const secondTick = schedule.tick();
    releaseDetection?.();
    await Promise.all([firstTick, secondTick]);

    expect(events.filter((event) => event === "capture")).toHaveLength(1);
    expect(events.filter((event) => event === "detect:start")).toHaveLength(1);
  });

  it("does not compound image-space error against unconfirmed accepted targets", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let captures = 0;
    let detections = 0;
    const adapterYaws: number[] = [];
    const laneYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          captures += 1;
          events.push(`capture:${captures}`);
          return Promise.resolve({ bytes: jpeg, mimeType: "image/jpeg" });
        },
        moveHead(pose) {
          adapterYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        async update(target) {
          laneYaws.push(target.pose.yaw);
          const acknowledgment = await lane.update(target);
          return {
            ...acknowledgment,
            replaced: target.sequence > 1,
            replacedCount: Math.max(0, target.sequence - 1)
          };
        }
      },
      model: {
        detect() {
          detections += 1;
          events.push(`detect:${detections}`);
          return Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ]);
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();
    await schedule.tick();

    expect(captures).toBe(3);
    expect(detections).toBe(3);
    expect(adapterYaws).toEqual([0]);
    expect(laneYaws).toEqual([8, 8, 8]);
    expect(runtime.status().flow).toMatchObject({
      pendingMoveDepth: 1,
      pendingMoveReplacements: 2,
      pendingMoveDispatches: 0,
      maximumConcurrentObservationTicks: 1,
      maximumConcurrentMoves: 0,
      moveOverlapAttempts: 0
    });
    expect(runtime.status()).toMatchObject({
      moveCount: 3,
      headTargetLane: {
        accepted: 3,
        replaced: 2,
        noOpDiscarded: 0,
        pendingDepth: 1,
        maximumPendingDepth: 1
      }
    });

    await runtime.stop();
  });

  it("clears the gateway pending target once when tracking becomes centered", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let detectionCount = 0;
    let nowMs = 0;
    const adapterYaws: number[] = [];
    const laneYaws: number[] = [];
    let clearCount = 0;
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        moveHead(pose) {
          adapterYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          laneYaws.push(target.pose.yaw);
          return lane.update(target);
        },
        clear(leaseId) {
          clearCount += 1;
          return lane.clear(leaseId);
        }
      },
      model: {
        detect() {
          detectionCount += 1;
          return Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox:
                detectionCount === 1
                  ? { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
                  : { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 }
            }
          ]);
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    await schedule.tick();
    nowMs = 900;
    await schedule.tick();
    await schedule.tick();
    expect(runtime.status().flow).toMatchObject({
      pendingMoveDepth: 0
    });

    expect(detectionCount).toBe(3);
    expect(adapterYaws).toEqual([0]);
    expect(laneYaws).toEqual([8]);
    expect(clearCount).toBe(1);
    expect(runtime.status().flow).toMatchObject({
      pendingMoveDepth: 0,
      pendingMoveDispatches: 0
    });

    await runtime.stop();
  });

  it("holds through a short loss and enters configured scan at timeout", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const lane = inertHeadTargetLane();
    const requestedYaws: number[] = [];
    let clearCount = 0;
    let detectionCount = 0;
    let nowMs = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      headTargetLane: {
        ...lane,
        update(target) {
          requestedYaws.push(target.pose.yaw);
          return lane.update(target);
        },
        clear(leaseId) {
          clearCount += 1;
          return lane.clear(leaseId);
        }
      },
      model: {
        detect() {
          detectionCount += 1;
          return Promise.resolve(
            detectionCount === 1
              ? [
                  {
                    label: "face" as const,
                    confidence: 0.9,
                    boundingBox: { xMin: 0.9, yMin: 0.4, xMax: 1, yMax: 0.6 }
                  }
                ]
              : []
          );
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => nowMs
    });

    await runtime.start();
    await schedule.tick();
    nowMs = 500;
    await schedule.tick();
    nowMs = 1_000;
    await schedule.tick();

    expect(requestedYaws).toEqual([8]);
    expect(clearCount).toBe(1);
    expect(runtime.status().attention.mode).toBe("scan");

    await runtime.stop();
  });

  it("clears the pending target when inference resolves to a short loss", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const busyDetection = deferred<readonly []>();
    let captureCount = 0;
    let detectionCount = 0;
    const adapterYaws: number[] = [];
    const laneYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          captureCount += 1;
          return Promise.resolve({ bytes: jpeg, mimeType: "image/jpeg" });
        },
        moveHead(pose) {
          adapterYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          laneYaws.push(target.pose.yaw);
          return lane.update(target);
        }
      },
      model: {
        detect() {
          detectionCount += 1;
          if (detectionCount === 2) {
            return busyDetection.promise;
          }
          return Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ]);
        }
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    const busyTick = schedule.tick();
    await flushMicrotasks(2);
    busyDetection.resolve([]);
    await busyTick;
    await flushMicrotasks();

    expect(captureCount).toBe(2);
    expect(detectionCount).toBe(2);
    expect(adapterYaws).toEqual([0]);
    expect(laneYaws).toEqual([8]);
    expect(runtime.status().flow).toMatchObject({
      pendingMoveDepth: 0,
      pendingMoveDispatches: 0,
      maximumConcurrentObservationTicks: 1,
      maximumConcurrentMoves: 0
    });

    await runtime.stop();
  });

  it("leaves failure rebase to the gateway and retries only on a new observation", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let updateAttempts = 0;
    const adapterYaws: number[] = [];
    const laneYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        moveHead(pose) {
          adapterYaws.push(pose.yaw);
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        update(target) {
          updateAttempts += 1;
          laneYaws.push(target.pose.yaw);
          return updateAttempts === 1
            ? Promise.reject(new Error("gateway update failed"))
            : lane.update(target);
        }
      },
      model: {
        detect: () =>
          Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ])
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    expect(runtime.status().flow).toMatchObject({
      pendingMoveDepth: 0
    });
    await schedule.tick();

    expect(adapterYaws).toEqual([0]);
    expect(laneYaws).toEqual([8, 8]);
    expect(runtime.status()).toMatchObject({
      moveCount: 1,
      flow: {
        activeMoves: 0,
        pendingMoveDepth: 1,
        pendingMoveDispatches: 0,
        maximumConcurrentMoves: 0,
        moveOverlapAttempts: 0
      }
    });

    await runtime.stop();
  });

  it("stops the lane before final home and suppresses later ticks", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const laneStop = deferred<StackChanHeadTargetStatus>();
    let captureCount = 0;
    const adapterYaws: number[] = [];
    const adapter = device(events);
    const lane = inertHeadTargetLane();
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          captureCount += 1;
          return Promise.resolve({ bytes: jpeg, mimeType: "image/jpeg" });
        },
        moveHead(pose) {
          adapterYaws.push(pose.yaw);
          events.push(`adapter:move:${pose.yaw}`);
          return Promise.resolve();
        },
        close() {
          events.push("adapter:close");
          return Promise.resolve();
        }
      },
      headTargetLane: {
        ...lane,
        stop() {
          events.push("lane:stop:start");
          return laneStop.promise.then((status) => {
            events.push("lane:stop:end");
            return status;
          });
        },
        close() {
          events.push("lane:close");
          return Promise.resolve();
        }
      },
      model: {
        detect: () =>
          Promise.resolve([
            {
              label: "face",
              confidence: 0.9,
              boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
            }
          ])
      },
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await runtime.start();
    await schedule.tick();
    await schedule.tick();
    expect(runtime.status().flow).toMatchObject({
      activeObservationTicks: 0,
      activeMoves: 0,
      pendingMoveDepth: 1
    });

    const stopping = runtime.stop();
    await schedule.tick();
    await flushMicrotasks(2);
    expect(adapterYaws).toEqual([0]);
    expect(captureCount).toBe(2);
    expect(events.at(-1)).toBe("lane:stop:start");

    laneStop.resolve(laneStatus({ phase: "stopped", pendingDepth: 0 }));
    await stopping;

    expect(adapterYaws).toEqual([0, 0, 0]);
    expect(captureCount).toBe(2);
    expect(runtime.status().flow).toMatchObject({
      activeObservationTicks: 0,
      activeMoves: 0,
      pendingMoveDepth: 0,
      pendingMoveDispatches: 0
    });
    expect(runtime.status().phase).toBe("stopped");
    expect(events.slice(-6)).toEqual([
      "lane:stop:start",
      "lane:stop:end",
      "adapter:move:0",
      "adapter:move:0",
      "lane:close",
      "adapter:close"
    ]);
  });

  it("reports capture or inference failures without moving the head", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const adapter = device(events);
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          events.push("capture:error");
          return Promise.reject(new Error("camera unavailable"));
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });
    await runtime.start();
    await schedule.tick();

    expect(events).toEqual(["connect", "move:0,35", "capture:error"]);
    expect(runtime.status()).toMatchObject({
      phase: "running",
      framesProcessed: 0,
      moveCount: 0,
      lastError: "StackChan attention tick failed",
      errors: [
        {
          code: "tick_failed",
          message: "StackChan attention tick failed"
        }
      ]
    });
  });

  it("closes exactly once without homing after connection rejects", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const adapter = device(events);
    const connectionError = new Error(
      "Bearer secret-token at /Users/operator/private/device body={raw-tool-output}"
    );
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        connect() {
          events.push("connect:error");
          return Promise.reject(connectionError);
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await expect(runtime.start()).rejects.toBe(connectionError);
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();

    expect(schedule.events).toEqual([]);
    expect(events).toEqual(["connect:error", "close"]);
    expect(runtime.status()).toMatchObject({
      phase: "stopped",
      framesProcessed: 0,
      moveCount: 0,
      lastError: "StackChan attention startup failed",
      errors: [
        {
          code: "start_failed",
          message: "StackChan attention startup failed"
        }
      ]
    });
    const serializedStatus = JSON.stringify(runtime.status());
    expect(serializedStatus).not.toContain("secret-token");
    expect(serializedStatus).not.toContain("/Users/operator");
    expect(serializedStatus).not.toContain("raw-tool-output");
  });

  it("keeps stop exclusive during failed startup cleanup and remains single-use afterward", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let connectCount = 0;
    let closeCount = 0;
    let rejectFirstConnect: ((error: Error) => void) | undefined;
    let releaseFirstClose: (() => void) | undefined;
    let markFirstCloseStarted: (() => void) | undefined;
    const firstCloseStarted = new Promise<void>((resolve) => {
      markFirstCloseStarted = resolve;
    });
    const adapter = device(events);
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        connect() {
          connectCount += 1;
          events.push(`connect:${connectCount}`);
          if (connectCount === 1) {
            return new Promise<void>((_resolve, reject) => {
              rejectFirstConnect = reject;
            });
          }
          return Promise.resolve();
        },
        close() {
          closeCount += 1;
          events.push(`close:start:${closeCount}`);
          if (closeCount === 1) {
            markFirstCloseStarted?.();
            return new Promise<void>((resolve) => {
              releaseFirstClose = () => {
                events.push("close:end:1");
                resolve();
              };
            });
          }
          events.push(`close:end:${closeCount}`);
          return Promise.resolve();
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    const initialStart = runtime.start();
    const reentrantStart = initialStart.catch(() => runtime.start());
    const stopping = runtime.stop();
    rejectFirstConnect?.(new Error("private startup failure"));

    await expect(initialStart).rejects.toThrow("private startup failure");
    await expect(reentrantStart).rejects.toThrow("StackChan attention runtime is stopping");
    await firstCloseStarted;

    expect(runtime.status().phase).toBe("stopping");
    expect(events.filter((event) => event.startsWith("connect:"))).toEqual(["connect:1"]);

    releaseFirstClose?.();
    await stopping;
    expect(runtime.status().phase).toBe("stopped");

    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");
    await runtime.stop();
    expect(events.filter((event) => event.startsWith("connect:"))).toEqual(["connect:1"]);
    expect(runtime.status().phase).toBe("stopped");
  });

  it("bounds fixed error history", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const adapter = device(events);
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          return Promise.reject(new Error("secret capture body"));
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });
    await runtime.start();

    for (let index = 0; index < 10; index += 1) {
      await schedule.tick();
    }

    expect(runtime.status().errors).toHaveLength(8);
    expect(runtime.status().errors).toEqual(
      Array.from({ length: 8 }, () => ({
        code: "tick_failed",
        message: "StackChan attention tick failed"
      }))
    );
    expect(JSON.stringify(runtime.status())).not.toContain("secret capture body");

    await runtime.stop();
  });

  it("cleans up exactly once after the initial home move rejects", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    const adapter = device(events);
    let moveAttempts = 0;
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        moveHead(nextPose) {
          moveAttempts += 1;
          events.push(`move:${nextPose.yaw},${nextPose.pitch}:${moveAttempts}`);
          return moveAttempts === 1
            ? Promise.reject(new Error("initial home move failed"))
            : Promise.resolve();
        }
      },
      model: emptyModel(events),
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 0
    });

    await expect(runtime.start()).rejects.toThrow("initial home move failed");
    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();

    expect(schedule.events).toEqual([]);
    expect(events).toEqual(["connect", "move:0,35:1", "move:0,39:2", "move:0,35:3", "close"]);
    expect(runtime.status().phase).toBe("stopped");
    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
  });

  it("suppresses a retained scheduler tick after scheduler creation rejects", async () => {
    const events: string[] = [];
    const scheduleEvents: string[] = [];
    let retainedTick: (() => Promise<void>) | undefined;
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model: emptyModel(events),
      config: followConfig,
      scheduler(task, intervalMs) {
        retainedTick = task;
        scheduleEvents.push(`schedule:${intervalMs}`);
        throw new Error("scheduler unavailable");
      },
      nowMs: () => 0
    });

    await expect(runtime.start()).rejects.toThrow("scheduler unavailable");
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.stop();
    await retainedTick?.();

    expect(scheduleEvents).toEqual(["schedule:1000"]);
    expect(events).toEqual(["connect", "move:0,35", "move:0,39", "move:0,35", "close"]);
    expect(runtime.status().phase).toBe("stopped");
  });

  it("drains an active tick, suppresses its late move, homes, closes, and stops once", async () => {
    const events: string[] = [];
    const schedule = controlledScheduler();
    let releaseDetection: (() => void) | undefined;
    const model: AttentionDetectionModel = {
      detect() {
        events.push("detect:start");
        return new Promise((resolve) => {
          releaseDetection = () => {
            events.push("detect:end");
            resolve([
              {
                label: "face",
                confidence: 0.9,
                boundingBox: { xMin: 0.7, yMin: 0.4, xMax: 0.9, yMax: 0.6 }
              }
            ]);
          };
        });
      }
    };
    const runtime = createStackChanAttentionRuntime({
      adapter: device(events),
      model,
      config: followConfig,
      scheduler: schedule.scheduler,
      nowMs: () => 100
    });
    await runtime.start();
    const tick = schedule.tick();
    await Promise.resolve();
    await Promise.resolve();

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    releaseDetection?.();
    await Promise.all([tick, firstStop, secondStop]);

    expect(schedule.events).toEqual(["schedule:1000", "cancel"]);
    expect(events).toEqual([
      "connect",
      "move:0,35",
      "capture",
      "detect:start",
      "detect:end",
      "move:0,39",
      "move:0,35",
      "close"
    ]);
    expect(runtime.status().phase).toBe("stopped");
    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
  });

  it("drains an active tick and retains every fixed cleanup failure when cancel throws", async () => {
    const events: string[] = [];
    let captureCount = 0;
    let moveCount = 0;
    let scheduledTick: (() => Promise<void>) | undefined;
    let releaseDetection: (() => void) | undefined;
    const adapter = device(events);
    const runtime = createStackChanAttentionRuntime({
      adapter: {
        ...adapter,
        captureJpeg() {
          captureCount += 1;
          if (captureCount === 1) {
            events.push("capture:error");
            return Promise.reject(new Error("token=private-camera-token"));
          }
          events.push("capture");
          return Promise.resolve({ bytes: jpeg, mimeType: "image/jpeg" });
        },
        moveHead(nextPose) {
          moveCount += 1;
          if (moveCount === 1) {
            events.push(`move:${nextPose.yaw},${nextPose.pitch}`);
            return Promise.resolve();
          }
          events.push("move:cleanup:error");
          return Promise.reject(new Error("/Users/operator/private/home-position"));
        },
        close() {
          events.push("close:error");
          return Promise.reject(new Error("body={private-close-tool-output}"));
        }
      },
      model: {
        detect() {
          events.push("detect:start");
          return new Promise((resolve) => {
            releaseDetection = () => {
              events.push("detect:end");
              resolve([]);
            };
          });
        }
      },
      config: followConfig,
      scheduler(task, intervalMs) {
        events.push(`schedule:${intervalMs}`);
        scheduledTick = task;
        return {
          cancel() {
            events.push("cancel:error");
            throw new Error("Bearer private-scheduler-token");
          }
        };
      },
      nowMs: () => 0
    });
    await runtime.start();
    await scheduledTick?.();
    const activeTick = scheduledTick?.();
    await Promise.resolve();
    await Promise.resolve();

    const stopping = runtime.stop();
    releaseDetection?.();
    await Promise.all([activeTick, stopping]);
    await runtime.stop();

    expect(events).toEqual([
      "connect",
      "move:0,35",
      "schedule:1000",
      "capture:error",
      "capture",
      "detect:start",
      "cancel:error",
      "detect:end",
      "move:cleanup:error",
      "close:error"
    ]);
    expect(runtime.status()).toMatchObject({
      phase: "stopped",
      errors: [
        {
          code: "tick_failed",
          message: "StackChan attention tick failed"
        },
        {
          code: "scheduler_cancel_failed",
          message: "StackChan attention scheduler cancellation failed"
        },
        {
          code: "home_failed",
          message: "StackChan attention home move failed"
        },
        {
          code: "close_failed",
          message: "StackChan attention adapter close failed"
        }
      ],
      lastError: "StackChan attention adapter close failed"
    });
    const serializedStatus = JSON.stringify(runtime.status());
    expect(serializedStatus).not.toContain("private-camera-token");
    expect(serializedStatus).not.toContain("/Users/operator");
    expect(serializedStatus).not.toContain("private-close-tool-output");
    expect(serializedStatus).not.toContain("private-scheduler-token");
    await expect(runtime.start()).rejects.toThrow("StackChan attention runtime is stopped");
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
  });
});
