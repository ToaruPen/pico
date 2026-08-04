import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseStackChanFaceFollowArguments,
  runBoundedRuntime,
  runStackChanFaceFollowField as runStackChanFaceFollowFieldBase,
  waitForHeadToSettle
} from "../scripts/field/stackchan-face-follow.js";
import { definePicoConfig } from "../src/config/index.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";
import type { StackChanAttentionStatus } from "../src/runtime/stackchan-attention-runtime.js";

function liveConfig() {
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
          frameIntervalMs: 100,
          homeYaw: 0,
          homePitch: 35
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

function runStackChanFaceFollowField(
  ...[config, options, dependencies = {}]: Parameters<typeof runStackChanFaceFollowFieldBase>
): ReturnType<typeof runStackChanFaceFollowFieldBase> {
  return runStackChanFaceFollowFieldBase(config, options, {
    createHeadTargetLane: () => fieldHeadTargetLane(),
    ...dependencies
  });
}

describe("StackChan face follow field harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires live permission and bounded duration, frame count, model, and report path", () => {
    expect(() => parseStackChanFaceFollowArguments([])).toThrow("--enable-live-run");
    expect(() =>
      parseStackChanFaceFollowArguments([
        "--enable-live-run",
        "--duration-ms",
        "0",
        "--max-frames",
        "5",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow("--duration-ms");
  });

  it("parses a field-only max-step override without changing repository defaults", () => {
    expect(
      parseStackChanFaceFollowArguments([
        "--enable-live-run",
        "--duration-ms",
        "20000",
        "--max-frames",
        "100",
        "--max-step-deg",
        "2",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toMatchObject({
      maxStepDeg: 2
    });
  });

  it("starts the requested observation duration after runtime startup completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let stoppedAtMs: number | undefined;
    const runtime = {
      start: () => {
        vi.setSystemTime(5_000);
        return Promise.resolve();
      },
      stop: () => {
        stoppedAtMs = Date.now();
        return Promise.resolve();
      },
      status: () => attentionStatus(0)
    };

    const run = runBoundedRuntime(
      runtime,
      { durationMs: 100, maxFrames: 1 },
      () => undefined,
      () => undefined,
      Date.now
    );
    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(stoppedAtMs).toBe(5_100);
  });

  it("polls actual head angles until home is physically reached", async () => {
    let nowMs = 0;
    let reads = 0;
    const adapter = fieldAdapter({
      getHeadAngles: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? { yaw: -6, pitch: 32 }
            : reads === 2
              ? { yaw: -3, pitch: 33 }
              : { yaw: -1, pitch: 33 }
        );
      }
    });

    const finalPose = await waitForHeadToSettle(
      adapter,
      { yaw: 0, pitch: 33 },
      {
        intervalMs: 100,
        timeoutMs: 1_000,
        monotonicNowMs: () => nowMs,
        waitMs: (durationMs) => {
          nowMs += durationMs;
          return Promise.resolve();
        }
      }
    );

    expect(finalPose).toEqual({ yaw: -1, pitch: 33 });
    expect(reads).toBe(3);
    expect(nowMs).toBe(200);
  });

  it("reports aggregate command cadence without retaining per-frame motion data", async () => {
    let monotonicMs = 0;
    let moveCalls = 0;
    let runtimeMaxStepDeg: number | undefined;
    const adapter = fieldAdapter({
      captureJpeg: () => {
        monotonicMs += 10;
        return Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        });
      },
      moveHead: () => {
        moveCalls++;
        monotonicMs += moveCalls === 1 ? 20 : moveCalls === 2 ? 120 : 220;
        return Promise.resolve();
      }
    });
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        ...faceFollowOptions({ maxFrames: 3 }),
        maxStepDeg: 2
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => {
              monotonicMs += 20;
              return Promise.resolve([]);
            }
          }),
        createHeadTargetLane: () =>
          fieldHeadTargetLane({
            update: () => {
              monotonicMs += monotonicMs < 80 ? 12 : 22;
              return Promise.resolve();
            }
          }),
        createRuntime: ({ adapter: runtimeAdapter, config, headTargetLane, model }) => {
          runtimeMaxStepDeg = config.maxStepDeg;
          return {
            start: async () => {
              await runtimeAdapter.moveHead({ yaw: 0, pitch: 35 });

              const first = await runtimeAdapter.captureJpeg();
              await model.detect(first.bytes);
              await headTargetLane.update({
                leaseId: "field-lease",
                sequence: 1,
                pose: { yaw: 4, pitch: 35 }
              });

              const second = await runtimeAdapter.captureJpeg();
              await model.detect(second.bytes);

              const third = await runtimeAdapter.captureJpeg();
              await model.detect(third.bytes);
              await headTargetLane.update({
                leaseId: "field-lease",
                sequence: 2,
                pose: { yaw: 6, pitch: 35 }
              });
            },
            stop: () => runtimeAdapter.moveHead({ yaw: 0, pitch: 35 }),
            status: () => attentionStatus(3, { moveCount: 2 })
          };
        },
        runRuntime: async (runtime, _options, onStatus, onRunEnded) => {
          await runtime.start();
          onStatus(attentionStatus(1));
          onStatus(attentionStatus(2, { moveCount: 1 }));
          const status = attentionStatus(3, { moveCount: 2 });
          onStatus(status);
          onRunEnded();
          await runtime.stop();
          return status;
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        monotonicNowMs: () => monotonicMs,
        controlNowMs: () => monotonicMs,
        wallNowMs: () => 1_000
      }
    );

    expect(runtimeMaxStepDeg).toBe(2);
    expect(report).toMatchObject({
      status: "passed",
      details: {
        control: {
          maxStepDeg: 2,
          commandRequests: 2,
          successfulUpdates: 2,
          failedUpdates: 0,
          requestedDeltaBins: {
            zero: 0,
            one: 0,
            two: 1,
            three: 0,
            four: 1,
            fivePlus: 0
          },
          updateAcknowledgmentMs: {
            count: 2,
            p50: 12,
            p95: 22,
            min: 12,
            max: 22
          },
          headTargetLane: {
            accepted: 2,
            applyReplies: 0,
            failed: 0,
            staleDiscarded: 0,
            noOpDiscarded: 0,
            maximumActiveCalls: 0,
            maximumPendingDepth: 1,
            postStopDispatches: 0,
            pendingDispatchLatencyMs: laneDistribution(0),
            deviceDispatchLatencyMs: laneDistribution(0),
            successfulReplyLatencyMs: laneDistribution(0),
            firmwareMcpStageUs: {
              count: 0,
              receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
              toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
              applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
              schedulerHops: {}
            }
          },
          captureToCommandMs: {
            count: 2,
            p50: 20,
            p95: 20,
            min: 20,
            max: 20
          },
          observationTickWallMs: {
            count: 3,
            p50: 30,
            p95: 30,
            min: 30,
            max: 30
          },
          interObservationGapMs: {
            allTicks: {
              count: 2,
              p50: 30,
              p95: 42,
              min: 30,
              max: 42
            },
            moveTicks: {
              count: 1,
              p50: 30,
              p95: 30,
              min: 30,
              max: 30
            },
            noMoveTicks: {
              count: 1,
              p50: 42,
              p95: 42,
              min: 42,
              max: 42
            }
          },
          flow: {
            observationsWhileMoveInFlight: 0,
            staleFramesDiscarded: 0,
            staleFrameDispatches: 0,
            pendingMoveDepth: 0,
            maximumPendingMoveDepth: 0,
            pendingMoveReplacements: 0,
            pendingMoveDispatches: 0,
            maximumConcurrentObservationTicks: 0,
            maximumConcurrentMoves: 0,
            observationOverlapAttempts: 0,
            moveOverlapAttempts: 0,
            preStopInFlightObservations: 0,
            preStopInFlightMoves: 0,
            postDrainInFlightObservations: 0,
            postDrainInFlightMoves: 0
          }
        }
      }
    });
    if (report.status !== "passed") {
      throw new Error("expected passing report");
    }
    expect(report.details.control.headTargetLane).not.toHaveProperty("confirmed");
    expect(JSON.stringify(report)).not.toMatch(
      /samples|timeline|capturePath|frameDump|centerX|centerY|boundingBox|observedAtMs/i
    );
  });

  it("reports a command still in flight when the pre-stop snapshot is taken", async () => {
    let resolveTrackingMove: (() => void) | undefined;
    const trackingMove = new Promise<void>((resolvePromise) => {
      resolveTrackingMove = resolvePromise;
    });
    let pendingMove: Promise<void> | undefined;
    const report = await runStackChanFaceFollowField(liveConfig(), faceFollowOptions(), {
      createAdapter: () => fieldAdapter(),
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      createHeadTargetLane: () =>
        fieldHeadTargetLane({
          update: () => trackingMove
        }),
      createRuntime: ({ adapter, headTargetLane, model }) => ({
        start: async () => {
          await adapter.moveHead({ yaw: 0, pitch: 35 });
          const frame = await adapter.captureJpeg();
          await model.detect(frame.bytes);
          pendingMove = headTargetLane
            .update({
              leaseId: "field-lease",
              sequence: 1,
              pose: { yaw: 4, pitch: 35 }
            })
            .then(() => undefined);
        },
        stop: () => adapter.moveHead({ yaw: 0, pitch: 35 }),
        status: () => attentionStatus(1)
      }),
      runRuntime: async (runtime, _options, onStatus, onRunEnded) => {
        await runtime.start();
        const status = runtime.status();
        onStatus(status);
        onRunEnded();
        resolveTrackingMove?.();
        await pendingMove;
        await runtime.stop();
        return status;
      },
      settleHead: () => Promise.resolve(),
      writeReport: () => Promise.resolve()
    });

    expect(report).toMatchObject({
      status: "passed",
      details: {
        control: {
          commandRequests: 1,
          successfulUpdates: 0,
          failedUpdates: 0,
          requestedDeltaBins: {
            four: 1
          },
          updateAcknowledgmentMs: {
            count: 0
          }
        }
      }
    });
  });

  it("runs the production attention boundary and verifies the final home pose", async () => {
    const events: string[] = [];
    let pose = { yaw: 0, pitch: 35 };
    let closed = false;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: pose.yaw, pitch: pose.pitch - 1 }),
      moveHead: (nextPose) => {
        pose = nextPose;
        events.push(`move:${nextPose.yaw},${nextPose.pitch}`);
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        events.push("close");
        return Promise.resolve();
      }
    };
    let written: unknown;
    const monotonicTimes = [0, 1000];
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 1000,
        maxFrames: 3,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        runRuntime: async (runtime) => {
          await runtime.start();
          await runtime.stop();
          return {
            ...runtime.status(),
            framesProcessed: 1,
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
          };
        },
        settleHead: () => {
          events.push("settle");
          return Promise.resolve();
        },
        writeReport: (_path, value) => {
          written = value;
          return Promise.resolve();
        },
        monotonicNowMs: () => monotonicTimes.shift() ?? 1000,
        wallNowMs: monotonicClock(0, 1_000)
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "stackchan-cores3+pinto441-dist",
      details: {
        sourceId: "stackchan-core-s3",
        durationMs: 1000,
        maxFrames: 3,
        framesProcessed: 1,
        movesIssued: 0,
        errors: 0,
        stream: {
          requestedFps: 20,
          observedDurationMs: 1000,
          receivedFps: 1,
          frameAgeP50Ms: 0,
          frameAgeP95Ms: 0,
          frameAgeP99Ms: 0,
          sequenceGaps: 0,
          maxJpegBytes: 0
        },
        inference: {
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0
        },
        attention: {
          targetFrames: 1,
          centeredFrames: 1,
          centeredRatio: 1
        },
        diagnostics: {
          firstTargetMs: 100,
          firstCenteredMs: 100,
          maximumLostGapMs: 900,
          evaluationWindow: {
            targetFrames: 0,
            centeredFrames: 0,
            centeredRatio: 0
          },
          horizontal: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 0
          },
          vertical: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 0
          },
          servoLimitFrames: 0
        },
        control: {
          maxStepDeg: 4,
          commandRequests: 0,
          successfulUpdates: 0,
          failedUpdates: 0,
          requestedDeltaBins: {
            zero: 0,
            one: 0,
            two: 0,
            three: 0,
            four: 0,
            fivePlus: 0
          },
          updateAcknowledgmentMs: {
            count: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            min: 0,
            max: 0
          },
          headTargetLane: {
            accepted: 0,
            replaced: 0,
            dispatched: 0,
            applyReplies: 0,
            failed: 0,
            staleDiscarded: 0,
            noOpDiscarded: 0,
            maximumActiveCalls: 0,
            maximumPendingDepth: 0,
            postStopDispatches: 0,
            pendingDispatchLatencyMs: laneDistribution(0),
            deviceDispatchLatencyMs: laneDistribution(0),
            successfulReplyLatencyMs: laneDistribution(0),
            firmwareMcpStageUs: {
              count: 0,
              receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
              toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
              applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
              schedulerHops: {}
            }
          },
          captureToCommandMs: {
            count: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            min: 0,
            max: 0
          },
          observationTickWallMs: {
            count: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            min: 0,
            max: 0
          },
          interObservationGapMs: {
            allTicks: {
              count: 0,
              p50: 0,
              p95: 0,
              p99: 0,
              min: 0,
              max: 0
            },
            moveTicks: {
              count: 0,
              p50: 0,
              p95: 0,
              p99: 0,
              min: 0,
              max: 0
            },
            noMoveTicks: {
              count: 0,
              p50: 0,
              p95: 0,
              p99: 0,
              min: 0,
              max: 0
            }
          },
          flow: {
            observationsWhileMoveInFlight: 0,
            staleFramesDiscarded: 0,
            staleFrameDispatches: 0,
            pendingMoveDepth: 0,
            maximumPendingMoveDepth: 0,
            pendingMoveReplacements: 0,
            pendingMoveDispatches: 0,
            maximumConcurrentObservationTicks: 0,
            maximumConcurrentMoves: 0,
            observationOverlapAttempts: 0,
            moveOverlapAttempts: 0,
            preStopInFlightObservations: 0,
            preStopInFlightMoves: 0,
            postDrainInFlightObservations: 0,
            postDrainInFlightMoves: 0
          }
        },
        moveRateHz: 0,
        finalPose: { yaw: 0, pitch: 34 },
        returnedHome: true
      }
    });
    expect(written).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("lastTarget");
    expect(JSON.stringify(report)).not.toContain("confidence");
    expect(JSON.stringify(report)).not.toContain("centerX");
    expect(JSON.stringify(report)).not.toContain("centerY");
    expect(closed).toBe(true);
    expect(events).toEqual(["move:0,35", "move:0,39", "move:0,35", "settle", "close"]);
  });

  it("fails closed when the bounded runtime processes no camera frame", async () => {
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () => Promise.reject(new Error("must not capture")),
      getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 1,
        maxFrames: 1,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        runRuntime: () =>
          Promise.resolve({
            phase: "stopped",
            framesProcessed: 0,
            moveCount: 0,
            flow: flowStatus(),
            attention: {
              mode: "acquire",
              targetVisible: false,
              targetFrames: 0,
              centeredFrames: 0
            }
          }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(report).toMatchObject({
      status: "failed",
      provider: "stackchan-cores3+pinto441-dist",
      reason: "StackChan face follow field run failed or did not return home",
      details: {
        framesProcessed: 0,
        movesIssued: 0,
        control: {
          commandRequests: 0,
          successfulUpdates: 0,
          failedUpdates: 0
        },
        finalPose: { yaw: 0, pitch: 35 },
        returnedHome: true
      }
    });
    if (report.status !== "failed") throw new Error("expected failed field report");
    expect(report.details?.failureChecks).toEqual(
      expect.arrayContaining(["report_counters_invalid", "post_drain_counters_invalid"])
    );
  });

  it.each([
    {
      name: "NaN target count",
      status: attentionStatus(1, { targetFrames: Number.NaN })
    },
    {
      name: "infinite target count",
      status: attentionStatus(1, { targetFrames: Number.POSITIVE_INFINITY })
    },
    {
      name: "negative target count",
      status: attentionStatus(1, { targetFrames: -1 })
    },
    {
      name: "negative centered count",
      status: attentionStatus(1, { centeredFrames: -1 })
    },
    {
      name: "negative move count",
      status: attentionStatus(1, { moveCount: -1 })
    },
    {
      name: "fractional target count",
      status: attentionStatus(1, { targetFrames: 0.5 })
    },
    {
      name: "more targets than frames",
      status: attentionStatus(1, { targetFrames: 2 })
    },
    {
      name: "more centered frames than targets",
      status: attentionStatus(1, { targetFrames: 1, centeredFrames: 2 })
    },
    {
      name: "more moves than frames",
      status: attentionStatus(1, { moveCount: 2 })
    }
  ])("fails closed for impossible runtime counters: $name", async ({ status }) => {
    const report = await runStackChanFaceFollowField(liveConfig(), faceFollowOptions(), {
      createAdapter: () => fieldAdapter(),
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      runRuntime: () => Promise.resolve(status),
      settleHead: () => Promise.resolve(),
      writeReport: () => Promise.resolve()
    });

    expect(report).toEqual({
      status: "failed",
      provider: "stackchan-cores3+pinto441-dist",
      reason: "StackChan face follow field run failed or did not return home"
    });
  });

  it("reports a zero centered ratio when no target was detected", async () => {
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const monotonicTimes = [0, 1000];
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 1000,
        maxFrames: 1,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        runRuntime: () =>
          Promise.resolve({
            phase: "stopped",
            framesProcessed: 1,
            moveCount: 0,
            flow: flowStatus(),
            attention: {
              mode: "scan",
              targetVisible: false,
              targetFrames: 0,
              centeredFrames: 0
            }
          }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        monotonicNowMs: () => monotonicTimes.shift() ?? 1000,
        wallNowMs: monotonicClock(0, 1_000)
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        attention: {
          targetFrames: 0,
          centeredFrames: 0,
          centeredRatio: 0
        },
        diagnostics: {
          maximumLostGapMs: 1000,
          evaluationWindow: {
            targetFrames: 0,
            centeredFrames: 0,
            centeredRatio: 0
          },
          horizontal: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 0
          },
          vertical: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 0
          },
          servoLimitFrames: 0
        }
      }
    });
    expect(JSON.stringify(report)).not.toMatch(/firstTargetMs|firstCenteredMs/);
  });

  it("records each callback frame once with target-loss and instrumented pose diagnostics", async () => {
    let headReads = 0;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => {
        headReads++;
        return Promise.resolve(headReads === 1 ? { yaw: 89, pitch: 35 } : { yaw: 0, pitch: 35 });
      },
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const statuses = [
      attentionStatus(1, {
        targetVisible: true,
        targetFrames: 1,
        centeredFrames: 0,
        lastTarget: targetStatus(1_100, -4, 2, false)
      }),
      attentionStatus(1, {
        targetVisible: true,
        targetFrames: 1,
        centeredFrames: 0,
        lastTarget: targetStatus(1_200, 99, 99, true)
      }),
      attentionStatus(2, {
        targetVisible: false,
        targetFrames: 1,
        centeredFrames: 0,
        lastTarget: targetStatus(1_100, -4, 2, false)
      }),
      attentionStatus(3, {
        targetVisible: true,
        targetFrames: 2,
        centeredFrames: 1,
        lastTarget: targetStatus(6_000, 4, -2, true)
      })
    ];
    const wallTimes = [1_000, 2_000, 7_000];
    const monotonicTimes = [0, 1_000];
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 30_000,
        maxFrames: 10,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        createRuntime: ({ adapter: runtimeAdapter, model }) => ({
          start: async () => {
            await runtimeAdapter.getHeadAngles();
            const frame = await runtimeAdapter.captureJpeg();
            await model.detect(frame.bytes);
          },
          stop: () => Promise.resolve(),
          status: () => statuses.at(-1) ?? attentionStatus(0)
        }),
        runRuntime: async (runtime, _options, onStatus) => {
          await runtime.start();
          for (const status of statuses) {
            onStatus(status);
          }
          await runtime.stop();
          return statuses.at(-1) ?? attentionStatus(0);
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        monotonicNowMs: () => monotonicTimes.shift() ?? 1_000,
        wallNowMs: () => wallTimes.shift() ?? 7_000
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        attention: {
          targetFrames: 2,
          centeredFrames: 1,
          centeredRatio: 0.5
        },
        diagnostics: {
          firstTargetMs: 100,
          firstCenteredMs: 5_000,
          maximumLostGapMs: 4_000,
          evaluationWindow: {
            targetFrames: 1,
            centeredFrames: 1,
            centeredRatio: 1
          },
          horizontal: {
            signedP50: -4,
            absoluteP50: 4,
            absoluteP95: 4,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 1,
            negativeOutsideFrames: 1
          },
          vertical: {
            signedP50: -2,
            absoluteP50: 2,
            absoluteP95: 2,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 1,
            negativeOutsideFrames: 1
          },
          servoLimitFrames: 1
        }
      }
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(
      /lastTarget|confidence|centerX|centerY|observedAtMs|ageMs|boundingBox|"observations":|errorSamples|horizontalErrors|verticalErrors/i
    );
  });

  it("uses the returned final status when a custom runner does not publish callbacks", async () => {
    let wallTimeMs = 1_000;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 1_000,
        maxFrames: 1,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        runRuntime: () => {
          wallTimeMs = 1_500;
          return Promise.resolve(
            attentionStatus(1, {
              targetVisible: true,
              targetFrames: 1,
              centeredFrames: 1,
              lastTarget: targetStatus(1_250, 3, -5, true)
            })
          );
        },
        settleHead: () => {
          wallTimeMs = 9_000;
          return Promise.resolve();
        },
        writeReport: () => Promise.resolve(),
        monotonicNowMs: monotonicClock(0, 250),
        wallNowMs: () => wallTimeMs
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        diagnostics: {
          firstTargetMs: 250,
          firstCenteredMs: 250,
          maximumLostGapMs: 250,
          horizontal: {
            signedP50: 3,
            absoluteP50: 3,
            absoluteP95: 3,
            positiveOutsideFrames: 1,
            negativeOutsideFrames: 0
          },
          vertical: {
            signedP50: -5,
            absoluteP50: 5,
            absoluteP95: 5,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 1
          },
          servoLimitFrames: 0
        }
      }
    });
  });

  it("polls often enough to observe each 60 ms field frame before publishing stop", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    vi.setSystemTime(10_000);
    const statusReads: number[] = [];
    let startedAtMs = 0;
    let stopped = false;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const run = runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 180,
        maxFrames: 3,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        createRuntime: () => ({
          start: () => {
            startedAtMs = Date.now();
            return Promise.resolve();
          },
          stop: () => {
            stopped = true;
            return Promise.resolve();
          },
          status: () => {
            statusReads.push(Date.now() - startedAtMs);
            return attentionStatus(Math.min(3, Math.floor((Date.now() - startedAtMs) / 60)), {
              phase: stopped ? "stopped" : "running"
            });
          }
        }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    await waitUntil(() => startedAtMs > 0);
    await vi.advanceTimersByTimeAsync(200);
    const report = await run;

    expect(statusReads.some((elapsedMs) => elapsedMs < 60)).toBe(true);
    expect(report).toMatchObject({
      status: "passed",
      details: {
        framesProcessed: 3,
        diagnostics: {
          maximumLostGapMs: 180
        }
      }
    });
  });

  it("ends diagnostics before bounded runtime stop cleanup", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    vi.setSystemTime(20_000);
    let startedAtMs = 0;
    let stopped = false;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const run = runStackChanFaceFollowField(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 1_000,
        maxFrames: 1,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/follow.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        createRuntime: () => ({
          start: () => {
            startedAtMs = Date.now();
            return Promise.resolve();
          },
          stop: () => {
            stopped = true;
            vi.setSystemTime(Date.now() + 10_000);
            return Promise.resolve();
          },
          status: () =>
            attentionStatus(1, {
              phase: stopped ? "stopped" : "running",
              targetVisible: true,
              targetFrames: 1,
              centeredFrames: 1,
              lastTarget: targetStatus(startedAtMs + 100, 0, 0, true)
            })
        }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    await waitUntil(() => startedAtMs > 0);
    await vi.advanceTimersByTimeAsync(100);
    const report = await run;

    expect(report).toMatchObject({
      status: "passed",
      details: {
        diagnostics: {
          firstTargetMs: 100,
          firstCenteredMs: 100,
          maximumLostGapMs: 100
        }
      }
    });
  });

  it.each([
    "resolved-same",
    "hardlink",
    "symlink"
  ] as const)("rejects a %s model/report collision before model or hardware access", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "pico-face-follow-paths-"));
    const modelPath = join(directory, "private-model.onnx");
    const ordinaryReportPath = join(directory, "private-report.json");
    let adapterCreations = 0;
    let modelCreations = 0;
    try {
      await writeFile(modelPath, "private-model", { encoding: "utf8", mode: 0o600 });
      const reportOutput =
        kind === "resolved-same"
          ? join(directory, "unused", "..", "private-model.onnx")
          : ordinaryReportPath;
      if (kind === "hardlink") {
        await link(modelPath, reportOutput);
      } else if (kind === "symlink") {
        await symlink(modelPath, reportOutput);
      }

      const result = await runStackChanFaceFollowField(
        liveConfig(),
        {
          enableLiveRun: true,
          durationMs: 1_000,
          maxFrames: 1,
          modelPath,
          reportOutput
        },
        {
          createAdapter: () => {
            adapterCreations++;
            return fieldAdapter();
          },
          createModel: () => {
            modelCreations++;
            return Promise.resolve({ detect: () => Promise.resolve([]) });
          },
          runRuntime: () => Promise.resolve(attentionStatus(1)),
          settleHead: () => Promise.resolve(),
          writeReport: () => Promise.resolve()
        }
      ).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(result).toBeInstanceOf(Error);
      expect(result instanceof Error ? result.message : "").not.toContain(directory);
      expect(adapterCreations).toBe(0);
      expect(modelCreations).toBe(0);
      expect(await readFile(modelPath, "utf8")).toBe("private-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically replaces an existing report with mode 0600 without changing the model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-face-follow-report-"));
    const modelPath = join(directory, "private-model.onnx");
    const reportOutput = join(directory, "report.json");
    try {
      await writeFile(modelPath, "private-model", { encoding: "utf8", mode: 0o600 });
      await writeFile(reportOutput, "{}\n", { encoding: "utf8", mode: 0o644 });
      await chmod(reportOutput, 0o644);
      const previousInode = (await stat(reportOutput)).ino;
      const report = await runStackChanFaceFollowField(
        liveConfig(),
        {
          enableLiveRun: true,
          durationMs: 1_000,
          maxFrames: 1,
          modelPath,
          reportOutput
        },
        {
          createAdapter: () => fieldAdapter(),
          createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
          runRuntime: () => Promise.resolve(attentionStatus(1)),
          settleHead: () => Promise.resolve(),
          monotonicNowMs: monotonicClock(0, 1_000),
          wallNowMs: monotonicClock(0, 1_000)
        }
      );

      expect(JSON.parse(await readFile(reportOutput, "utf8"))).toEqual(report);
      const reportStatus = await stat(reportOutput);
      expect(reportStatus.mode & 0o777).toBe(0o600);
      expect(reportStatus.ino).not.toBe(previousInode);
      expect(await readFile(modelPath, "utf8")).toBe("private-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes a private temporary report after atomic replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-face-follow-write-"));
    const modelPath = join(directory, "private-model.onnx");
    const reportOutput = join(directory, "occupied");
    try {
      await writeFile(modelPath, "private-model", { encoding: "utf8", mode: 0o600 });
      await mkdir(reportOutput);
      const result = await runStackChanFaceFollowField(
        liveConfig(),
        {
          enableLiveRun: true,
          durationMs: 1_000,
          maxFrames: 1,
          modelPath,
          reportOutput
        },
        {
          createAdapter: () => fieldAdapter(),
          createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
          runRuntime: () => Promise.resolve(attentionStatus(1)),
          settleHead: () => Promise.resolve(),
          monotonicNowMs: monotonicClock(0, 1_000),
          wallNowMs: monotonicClock(0, 1_000)
        }
      ).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(result).toEqual(new Error("StackChan face follow report write failed"));
      expect((await readdir(directory)).filter((name) => name.startsWith(".occupied."))).toEqual(
        []
      );
      expect(await readFile(modelPath, "utf8")).toBe("private-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when callback frame sequences skip a processed frame", async () => {
    const statuses = [attentionStatus(1), attentionStatus(3)];
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 3 }),
      {
        createAdapter: () => fieldAdapter(),
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        runRuntime: (_runtime, _options, onStatus) => {
          for (const status of statuses) {
            onStatus(status);
          }
          return Promise.resolve(statuses[1] ?? attentionStatus(0));
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(report.status).toBe("failed");
  });

  it("exposes each newly processed frame to a diagnostic observer once", async () => {
    const observedFrames: number[] = [];
    const statuses = [attentionStatus(1), attentionStatus(1), attentionStatus(2)];
    const dependencies = {
      createAdapter: () => fieldAdapter(),
      createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
      runRuntime: (
        _runtime: unknown,
        _options: unknown,
        onStatus: (status: ReturnType<typeof attentionStatus>) => void,
        onRunEnded: () => void
      ) => {
        for (const status of statuses) {
          onStatus(status);
        }
        onRunEnded();
        return Promise.resolve(statuses[2] ?? attentionStatus(0));
      },
      onFrameStatus: (status: StackChanAttentionStatus) => {
        observedFrames.push(status.framesProcessed);
      },
      settleHead: () => Promise.resolve(),
      writeReport: () => Promise.resolve()
    };

    await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 2 }),
      dependencies
    );

    expect(observedFrames).toEqual([1, 2]);
  });

  it("fails closed when the final frame count exceeds maxFrames", async () => {
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 2 }),
      {
        createAdapter: () => fieldAdapter(),
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        runRuntime: () => Promise.resolve(attentionStatus(3)),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(report.status).toBe("failed");
  });

  it("associates a completed frame with its own pose when the next pose is already pending", async () => {
    const adapter = fieldAdapter();
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 1 }),
      {
        createAdapter: () => adapter,
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        createRuntime: ({ adapter: runtimeAdapter, model }) => ({
          start: async () => {
            await runtimeAdapter.moveHead({ yaw: 89, pitch: 35 });
            const frame = await runtimeAdapter.captureJpeg();
            await runtimeAdapter.moveHead({ yaw: 0, pitch: 35 });
            await model.detect(frame.bytes);
          },
          stop: () => Promise.resolve(),
          status: () =>
            attentionStatus(1, {
              targetVisible: true,
              targetFrames: 1,
              centeredFrames: 1,
              lastTarget: targetStatus(100, 0, 0, true)
            })
        }),
        runRuntime: async (runtime, _options, onStatus) => {
          await runtime.start();
          const status = runtime.status();
          onStatus(status);
          return status;
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        wallNowMs: monotonicClock(0, 1_000)
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        diagnostics: {
          servoLimitFrames: 1
        }
      }
    });
  });

  it("does not associate a failed detection pose with the next completed frame", async () => {
    let detectionCalls = 0;
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 1 }),
      {
        createAdapter: () => fieldAdapter(),
        createModel: () =>
          Promise.resolve({
            detect: () => {
              detectionCalls++;
              return detectionCalls === 1
                ? Promise.reject(new Error("detection failed"))
                : Promise.resolve([]);
            }
          }),
        createRuntime: ({ adapter, model }) => ({
          start: async () => {
            await adapter.moveHead({ yaw: 89, pitch: 35 });
            const failedFrame = await adapter.captureJpeg();
            await model.detect(failedFrame.bytes).catch(() => undefined);
            await adapter.moveHead({ yaw: 0, pitch: 35 });
            const completedFrame = await adapter.captureJpeg();
            await model.detect(completedFrame.bytes);
          },
          stop: () => Promise.resolve(),
          status: () =>
            attentionStatus(1, {
              targetVisible: true,
              targetFrames: 1,
              centeredFrames: 1,
              lastTarget: targetStatus(100, 0, 0, true)
            })
        }),
        runRuntime: async (runtime, _options, onStatus) => {
          await runtime.start();
          const status = runtime.status();
          onStatus(status);
          return status;
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        wallNowMs: monotonicClock(0, 1_000)
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        diagnostics: {
          servoLimitFrames: 0
        }
      }
    });
  });

  it("passes a field scheduler that prevents ticks after maxFrames", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    vi.setSystemTime(30_000);
    let framesProcessed = 0;
    let scheduledLoop: { cancel: () => void } | undefined;
    const run = runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ durationMs: 1_000, maxFrames: 2 }),
      {
        createAdapter: () => fieldAdapter(),
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        createRuntime: ({ scheduler }) => ({
          start: () => {
            if (scheduler === undefined) {
              throw new Error("field scheduler is required");
            }
            scheduledLoop = scheduler(() => {
              framesProcessed++;
              return Promise.resolve();
            }, 100);
            return Promise.resolve();
          },
          stop: () => {
            scheduledLoop?.cancel();
            return Promise.resolve();
          },
          status: () => attentionStatus(framesProcessed)
        }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    await waitUntil(() => scheduledLoop !== undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await run;

    expect(framesProcessed).toBe(2);
    expect(report).toMatchObject({
      status: "passed",
      details: { framesProcessed: 2 }
    });
  });

  it("freezes report counters, duration, and measurements at the pre-stop snapshot", async () => {
    let monotonicMs = 0;
    const poses = [
      { yaw: 0, pitch: 35 },
      { yaw: 89, pitch: 35 },
      { yaw: 0, pitch: 35 }
    ];
    let status = attentionStatus(1, {
      targetVisible: true,
      targetFrames: 1,
      centeredFrames: 0,
      lastTarget: targetStatus(6_000, -2, -3, false)
    });
    const report = await runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ maxFrames: 5 }),
      {
        createAdapter: () =>
          fieldAdapter({
            getHeadAngles: () => Promise.resolve(poses.shift() ?? { yaw: 0, pitch: 35 }),
            captureJpeg: () =>
              Promise.resolve({
                bytes:
                  monotonicMs < 100 ? Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) : new Uint8Array(1_000),
                mimeType: "image/jpeg",
                sequence: monotonicMs < 100 ? 1 : 100
              })
          }),
        createModel: () =>
          Promise.resolve({
            detect: () => {
              monotonicMs += monotonicMs < 100 ? 5 : 500;
              return Promise.resolve([]);
            }
          }),
        createRuntime: ({ adapter, model }) => ({
          start: async () => {
            await adapter.getHeadAngles();
            await adapter.captureJpeg();
            await model.detect(Uint8Array.of(1));
          },
          stop: async () => {
            await adapter.getHeadAngles();
            await adapter.captureJpeg();
            await model.detect(Uint8Array.of(2));
            status = {
              ...attentionStatus(2, {
                targetVisible: true,
                targetFrames: 2,
                centeredFrames: 1,
                lastTarget: targetStatus(6_500, 10, 12, true)
              }),
              moveCount: 2
            };
          },
          status: () => status
        }),
        runRuntime: async (runtime, _options, onStatus, onRunEnded) => {
          await runtime.start();
          onStatus(runtime.status());
          monotonicMs = 100;
          onRunEnded();
          await runtime.stop();
          const finalStatus = runtime.status();
          onStatus(finalStatus);
          return finalStatus;
        },
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        monotonicNowMs: () => monotonicMs,
        wallNowMs: monotonicClock(1_000, 7_000)
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      details: {
        framesProcessed: 1,
        movesIssued: 0,
        stream: {
          observedDurationMs: 100,
          receivedFps: 10,
          sequenceGaps: 0,
          maxJpegBytes: 4
        },
        inference: {
          p95Ms: 5
        },
        moveRateHz: 0,
        diagnostics: {
          firstTargetMs: 5_000,
          maximumLostGapMs: 5_000,
          evaluationWindow: {
            targetFrames: 1,
            centeredFrames: 0,
            centeredRatio: 0
          },
          horizontal: {
            signedP50: -2,
            absoluteP50: 2,
            absoluteP95: 2,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 1
          },
          vertical: {
            signedP50: -3,
            absoluteP50: 3,
            absoluteP95: 3,
            signFlips: 0,
            eligibleSignComparisons: 0,
            positiveOutsideFrames: 0,
            negativeOutsideFrames: 1
          },
          servoLimitFrames: 0
        }
      }
    });
  });

  it("uses monotonic duration when the wall clock jumps", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    vi.setSystemTime(40_000);
    let framesProcessed = 0;
    let monotonicMs = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = runStackChanFaceFollowField(
      liveConfig(),
      faceFollowOptions({ durationMs: 300, maxFrames: 10 }),
      {
        createAdapter: () => fieldAdapter(),
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        createRuntime: () => ({
          start: () => {
            timer = setInterval(() => {
              framesProcessed++;
              monotonicMs = framesProcessed * 100;
              vi.setSystemTime(framesProcessed === 1 ? 400_000 : 4_000);
            }, 100);
            return Promise.resolve();
          },
          stop: () => {
            if (timer !== undefined) {
              clearInterval(timer);
            }
            return Promise.resolve();
          },
          status: () => attentionStatus(framesProcessed)
        }),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve(),
        monotonicNowMs: () => monotonicMs,
        wallNowMs: () => 1_000
      }
    );

    await waitUntil(() => timer !== undefined);
    await vi.advanceTimersByTimeAsync(300);
    const report = await run;

    expect(report).toMatchObject({
      status: "passed",
      details: {
        framesProcessed: 3,
        stream: {
          observedDurationMs: 300,
          receivedFps: 10
        }
      }
    });
  });
});

type StatusOverrides = Partial<{
  phase: "idle" | "starting" | "running" | "stopping" | "stopped";
  moveCount: number;
  targetVisible: boolean;
  targetFrames: number;
  centeredFrames: number;
  lastTarget: ReturnType<typeof targetStatus>;
}>;

function attentionStatus(framesProcessed: number, overrides: StatusOverrides = {}) {
  return {
    phase: overrides.phase ?? ("stopped" as const),
    framesProcessed,
    moveCount: overrides.moveCount ?? 0,
    flow: flowStatus(),
    attention: {
      mode: "track" as const,
      targetVisible: overrides.targetVisible ?? false,
      targetFrames: overrides.targetFrames ?? 0,
      centeredFrames: overrides.centeredFrames ?? 0,
      ...(overrides.lastTarget === undefined ? {} : { lastTarget: overrides.lastTarget })
    }
  };
}

function flowStatus() {
  return {
    observationTicksStarted: 0,
    observationTicksCompleted: 0,
    observationsWhileMoveInFlight: 0,
    staleFramesDiscarded: 0,
    staleFrameDispatches: 0,
    pendingMoveDepth: 0 as const,
    maximumPendingMoveDepth: 0 as const,
    pendingMoveReplacements: 0,
    pendingMoveDispatches: 0,
    activeObservationTicks: 0,
    activeMoves: 0,
    maximumConcurrentObservationTicks: 0,
    maximumConcurrentMoves: 0,
    observationOverlapAttempts: 0,
    moveOverlapAttempts: 0
  };
}

function targetStatus(
  observedAtMs: number,
  horizontalError: number,
  verticalError: number,
  centered: boolean
) {
  return {
    label: "face" as const,
    confidence: 0.9,
    centerX: 0.5,
    centerY: 0.5,
    horizontalError,
    verticalError,
    centered,
    observedAtMs,
    ageMs: 0
  };
}

function monotonicClock(...values: number[]): () => number {
  return () => values.shift() ?? values.at(-1) ?? 0;
}

function faceFollowOptions(
  overrides: Partial<{ readonly durationMs: number; readonly maxFrames: number }> = {}
) {
  return {
    enableLiveRun: true as const,
    durationMs: overrides.durationMs ?? 1_000,
    maxFrames: overrides.maxFrames ?? 1,
    modelPath: "/tmp/model.onnx",
    reportOutput: "/tmp/follow.json"
  };
}

function fieldAdapter(overrides: Partial<StackChanAdapter> = {}): StackChanAdapter {
  return {
    connect: () => Promise.resolve(),
    captureJpeg: () =>
      Promise.resolve({
        bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
        mimeType: "image/jpeg"
      }),
    getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
    moveHead: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides
  };
}

function fieldHeadTargetLane(
  overrides: { readonly update?: () => Promise<void> } = {}
): StackChanHeadTargetLane {
  const leaseId = "field-lease";
  let accepted = 0;
  let replaced = 0;
  let phase: StackChanHeadTargetStatus["phase"] = "running";
  const status = (): StackChanHeadTargetStatus => ({
    phase,
    leaseId,
    leaseIdMatch: true,
    accepted,
    replaced,
    dispatched: accepted,
    confirmed: accepted,
    confirmedApplyReplies: accepted,
    failed: 0,
    staleDiscarded: 0,
    noOpDiscarded: 0,
    activeCalls: 0,
    pendingDepth: 0,
    maximumActiveCalls: accepted === 0 ? 0 : 2,
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
        confirmedPose: { yaw: 0, pitch: 35 },
        status: status()
      }),
    update: async (target) => {
      await overrides.update?.();
      accepted += 1;
      replaced += Number(accepted > 1);
      return {
        accepted: true,
        replaced: accepted > 1,
        pendingDepth: 1,
        acceptedCount: accepted,
        replacedCount: replaced,
        lastAcceptedSequence: target.sequence
      };
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
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise<void>((resolvePromise) => {
      setImmediate(resolvePromise);
    });
  }
}
