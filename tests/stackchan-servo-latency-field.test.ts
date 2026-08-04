import { describe, expect, it } from "vitest";
import * as servoLatencyField from "../scripts/field/stackchan-servo-latency.js";
import { definePicoConfig } from "../src/config/index.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStartConfig,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter, StackChanHeadPose } from "../src/modules/stackchan/index.js";
import type { AttentionDetectionModel } from "../src/modules/vision/attention-detection.js";

const { parseStackChanServoLatencyArguments, runStackChanServoLatencyField } = servoLatencyField;

describe("StackChan servo latency field harness", () => {
  it("requires explicit live permission and a bounded sample count", () => {
    expect(() => parseStackChanServoLatencyArguments([])).toThrow("--enable-live-run");
    expect(() =>
      parseStackChanServoLatencyArguments(["--enable-live-run", "--samples-per-bin", "0"])
    ).toThrow("--samples-per-bin");
  });

  it("measures fixed delta bins and returns aggregate-only latency summaries", async () => {
    let monotonicMs = 0;
    let currentPose = { yaw: 0, pitch: 33 };
    const measuredDeltas: number[] = [];
    let moveCount = 0;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () => Promise.reject(new Error("camera must not be used")),
      getHeadAngles: () => Promise.resolve(currentPose),
      moveHead: (pose) => {
        const delta = maximumAxisDelta(currentPose, pose);
        moveCount++;
        if (moveCount > 1 && moveCount <= 33) {
          measuredDeltas.push(delta);
        }
        monotonicMs += 100 + delta * 10;
        currentPose = pose;
        return Promise.resolve();
      },
      close: () => Promise.resolve()
    };

    const report = await runStackChanServoLatencyField(
      liveConfig(),
      {
        enableLiveRun: true,
        samplesPerBin: 8
      },
      {
        createAdapter: () => adapter,
        monotonicNowMs: () => monotonicMs,
        waitMs: () => Promise.resolve()
      }
    );

    expect(measuredDeltas).toEqual([
      ...Array<number>(8).fill(0),
      ...Array<number>(8).fill(1),
      ...Array<number>(8).fill(2),
      ...Array<number>(8).fill(4)
    ]);
    expect(report).toEqual({
      status: "passed",
      provider: "stackchan-cores3",
      details: {
        samplesPerBin: 8,
        measurementOrderDeg: [0, 1, 2, 4],
        homePose: { yaw: 0, pitch: 33 },
        moveSpeedDps: 90,
        bins: {
          zero: latencySummary(8, 100),
          one: latencySummary(8, 110),
          two: latencySummary(8, 120),
          four: latencySummary(8, 140)
        },
        finalPose: { yaw: 0, pitch: 33 },
        returnedHome: true
      }
    });
    expect(JSON.stringify(report)).not.toMatch(
      /sampleValues|latencySamples|timeline|commandSeries|capture|frame|face|centerX|centerY|boundingBox/i
    );
  });

  it("runs symmetric camera contention blocks with one aggregate report", async () => {
    const parseContentionArguments = Reflect.get(
      servoLatencyField,
      "parseStackChanServoContentionArguments"
    );
    const runContentionField = Reflect.get(servoLatencyField, "runStackChanServoContentionField");
    expect(parseContentionArguments).toBeTypeOf("function");
    expect(runContentionField).toBeTypeOf("function");
    if (
      typeof parseContentionArguments !== "function" ||
      typeof runContentionField !== "function"
    ) {
      return;
    }

    expect(
      parseContentionArguments([
        "--enable-live-run",
        "--camera-contention",
        "--duration-ms",
        "20000",
        "--consecutive-load-runs",
        "3",
        "--report-output",
        "/tmp/stackchan-stability.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      durationMs: 20_000,
      consecutiveLoadRuns: 3,
      reportOutput: "/tmp/stackchan-stability.json"
    });
    expect(
      parseContentionArguments([
        "--enable-live-run",
        "--camera-contention",
        "--duration-ms",
        "8000",
        "--consecutive-load-runs",
        "1",
        "--single-condition",
        "load",
        "--report-output",
        "/tmp/stackchan-load-only.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      durationMs: 8_000,
      consecutiveLoadRuns: 1,
      singleCondition: "load",
      reportOutput: "/tmp/stackchan-load-only.json"
    });

    let monotonicMs = 0;
    let wallMs = 10_000;
    let cameraRunning = false;
    let receivedFrames = 0;
    let sequence = 0;
    let modelCalls = 0;
    let closeCount = 0;
    let laneCloseCount = 0;
    let activeCondition: CameraCondition = "off";
    const homeApproachPoses: StackChanHeadPose[] = [];
    const workloadConditions: CameraCondition[] = [];
    const laneLifecycles: string[][] = [];
    const blockLifecycles: string[][] = [];
    let activeBlockLifecycle: string[] = [];
    const laneConfigs: StackChanHeadTargetStartConfig[] = [];
    const measuredTargets: Record<CameraCondition, StackChanHeadPose[]> = {
      off: [],
      stream: [],
      load: []
    };

    const report = await (runContentionField as ContentionRunner)(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 20_000,
        consecutiveLoadRuns: 3,
        reportOutput: "/tmp/stackchan-stability.json"
      },
      {
        createAdapter: (_config, condition) => {
          workloadConditions.push(condition);
          activeCondition = condition;
          activeBlockLifecycle = [];
          blockLifecycles.push(activeBlockLifecycle);
          let currentPose = { yaw: 0, pitch: 33 };
          return {
            connect: () => {
              activeBlockLifecycle.push("camera-connect");
              cameraRunning = condition !== "off";
              return Promise.resolve();
            },
            captureJpeg: () => {
              sequence++;
              receivedFrames++;
              monotonicMs += 5;
              wallMs += 5;
              return Promise.resolve({
                bytes: new Uint8Array([255, 216, 255, 217]),
                mimeType: "image/jpeg" as const,
                sequence,
                capturedAtMs: wallMs - 4,
                encodedAtMs: wallMs - 3,
                receivedAtMs: wallMs - 2
              });
            },
            getHeadAngles: () => Promise.resolve(currentPose),
            moveHead: (pose) => {
              activeBlockLifecycle.push("home");
              homeApproachPoses.push(pose);
              currentPose = pose;
              return Promise.resolve();
            },
            close: () => {
              activeBlockLifecycle.push("camera-close");
              closeCount++;
              cameraRunning = false;
              return Promise.resolve();
            }
          };
        },
        createHeadTargetLane: () => {
          const condition = activeCondition;
          const lifecycle: string[] = [];
          laneLifecycles.push(lifecycle);
          return contentionHeadTargetLane({
            condition,
            lifecycle,
            laneConfigs,
            measuredTargets,
            event: (event) => {
              activeBlockLifecycle.push(event);
            },
            advanceTime: (durationMs) => {
              monotonicMs += durationMs;
              wallMs += durationMs;
            },
            close: () => {
              laneCloseCount++;
            }
          });
        },
        createHomeAdapter: () => {
          throw new Error("connected production adapter must own home restore");
        },
        createModel: () =>
          Promise.resolve({
            detect: () => {
              modelCalls++;
              monotonicMs += 10;
              wallMs += 10;
              return Promise.resolve([]);
            }
          }),
        readCameraStatus: () =>
          Promise.resolve({
            running: cameraRunning,
            subscribers: cameraRunning ? 1 : 0,
            physicalRunning: cameraRunning,
            available: cameraRunning && receivedFrames > 0,
            receivedFrames,
            maxJpegBytes: cameraRunning ? 4 : 0,
            creditSendCount: cameraRunning ? 12 : 0,
            creditSendFailures: 0,
            creditSendMaxUs: cameraRunning ? 240 : 0
          }),
        createDiagnostics: () => stableDiagnostics(activeBlockLifecycle),
        monotonicNowMs: () => monotonicMs,
        wallNowMs: () => wallMs,
        waitMs: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(workloadConditions).toEqual(["stream", "load", "load", "load"]);
    expect(laneLifecycles).toEqual(
      Array.from({ length: 4 }, () => ["connect", "start", "stop", "close"])
    );
    expect(laneConfigs).toEqual(
      Array.from({ length: 4 }, () => ({
        rateHz: 10,
        maxStepDeg: 4,
        maxPendingAgeMs: 180,
        speedDps: 90
      }))
    );
    expect(
      blockLifecycles.every(
        (events) =>
          events.indexOf("camera-connect") < events.indexOf("telemetry-begin") &&
          events.indexOf("telemetry-begin") < events.indexOf("lane-start") &&
          events.lastIndexOf("home") < events.indexOf("telemetry-finish") &&
          events.indexOf("telemetry-finish") < events.indexOf("camera-close")
      )
    ).toBe(true);
    expect(measuredTargets.off).toEqual([]);
    expect(measuredTargets.stream.length).toBeGreaterThan(0);
    expect(measuredTargets.load.length).toBeGreaterThan(0);
    expect(modelCalls).toBeGreaterThan(0);
    expect(closeCount).toBe(4);
    expect(laneCloseCount).toBe(4);
    expect(homeApproachPoses).toEqual(
      Array.from({ length: 4 }, () => [
        { yaw: 0, pitch: 37 },
        { yaw: 0, pitch: 33 }
      ]).flat()
    );
    expect(report.status).toBe("passed");
    expect(report.details.blockOrder).toEqual(["stream", "load", "load", "load"]);
    expect(report.details.durationMs).toBe(20_000);
    expect(report.details.commandIntervalMs).toBe(500);
    expect(report.details.sweepExtentDeg).toBe(3);
    expect(report.details.blocks).toHaveLength(4);
    expect(report.details.conditions.off.blockCount).toBe(0);
    expect(report.details.conditions.off.updateAcknowledgmentMs.over250MsCount).toBe(0);
    expect(report.details.conditions.stream.updateAcknowledgmentMs.over250MsCount).toBe(0);
    expect(report.details.conditions.load.updateAcknowledgmentMs.over250MsCount).toBe(0);
    expect(
      report.details.blocks.every(
        (block) => block.successfulUpdates > 0 && block.failedUpdates === 0
      )
    ).toBe(true);
    expect(report.details.blocks.every((block) => block.home.returnedHome)).toBe(true);
    expect(
      report.details.blocks.every(
        (block) =>
          block.headTargetLane.failed === 0 &&
          block.headTargetLane.staleDiscarded === 0 &&
          block.headTargetLane.maximumActiveCalls === 1 &&
          block.headTargetLane.maximumPendingDepth === 1 &&
          block.headTargetLane.postStopDispatches === 0
      )
    ).toBe(true);
    expect(report.details.consecutiveLoadPasses).toBe(3);
    expect(
      report.details.blocks.every(
        (block) =>
          block.gatewaySessionStable &&
          block.nativeWrites.ackFailures === 0 &&
          block.nativeWrites.overflowCount === 0 &&
          !block.autoSleepEnabled &&
          block.minimumCommandedPitch === 33 &&
          block.stopAndHomeMs <= 5_000
      )
    ).toBe(true);
    expect(
      report.details.blocks
        .filter((block) => block.condition !== "off")
        .every(hasHealthyContentionCamera)
    ).toBe(true);
    expect(
      report.details.blocks.every(
        (block) =>
          !block.camera.cleanup.running &&
          block.camera.cleanup.subscribers === 0 &&
          !block.camera.cleanup.physicalRunning &&
          !block.camera.cleanup.available
      )
    ).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /successfulMoves|failedMoves|moveLatencyMs|commandStartGapMs|commandSeries|latencySamples|angles|sequenceSeries|frameSeries|image|jpegBase64|face|boundingBox|targetSeries|targetHistory|targetPose|capturePath/i
    );
  });

  it("stops a failed load block, homes under the stream lease, then releases camera bytes", async () => {
    const runContentionField = Reflect.get(servoLatencyField, "runStackChanServoContentionField");
    expect(runContentionField).toBeTypeOf("function");
    if (typeof runContentionField !== "function") {
      return;
    }

    let cameraRunning = false;
    let closeCount = 0;
    let homeCount = 0;
    let sequence = 0;
    const cleanupOrder: string[] = [];
    const report = await (runContentionField as ContentionRunner)(
      liveConfig(),
      {
        enableLiveRun: true,
        durationMs: 20_000,
        consecutiveLoadRuns: 3,
        reportOutput: "/tmp/stackchan-stability-failed.json"
      },
      {
        createAdapter: (_config, condition) => ({
          connect: () => {
            cameraRunning = condition !== "off";
            return Promise.resolve();
          },
          captureJpeg: () => {
            sequence++;
            return Promise.resolve({
              bytes: new Uint8Array([255, 216, 255, 217]),
              mimeType: "image/jpeg" as const,
              sequence,
              capturedAtMs: sequence,
              encodedAtMs: sequence,
              receivedAtMs: sequence
            });
          },
          getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 33 }),
          moveHead: () => {
            homeCount++;
            cleanupOrder.push("home");
            return Promise.resolve();
          },
          close: () => {
            closeCount++;
            cleanupOrder.push("camera-close");
            cameraRunning = false;
            return Promise.resolve();
          }
        }),
        createHomeAdapter: () => ({
          connect: () => Promise.resolve(),
          captureJpeg: () => Promise.reject(new Error("home cleanup must not use camera")),
          getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 33 }),
          moveHead: () => {
            homeCount++;
            return Promise.resolve();
          },
          close: () => {
            closeCount++;
            return Promise.resolve();
          }
        }),
        createHeadTargetLane: () => contentionHeadTargetLane(),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.reject(new Error("inference failed"))
          }),
        readCameraStatus: () =>
          Promise.resolve({
            running: cameraRunning,
            subscribers: cameraRunning ? 1 : 0,
            physicalRunning: cameraRunning,
            available: cameraRunning,
            receivedFrames: sequence,
            maxJpegBytes: cameraRunning ? 4 : 0,
            creditSendCount: cameraRunning ? 3 : 0,
            creditSendFailures: 0,
            creditSendMaxUs: cameraRunning ? 180 : 0
          }),
        createDiagnostics: () => stableDiagnostics(),
        monotonicNowMs: () => sequence,
        wallNowMs: () => sequence,
        waitMs: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(report.status).toBe("failed");
    expect(cameraRunning).toBe(false);
    expect(closeCount).toBeGreaterThan(0);
    expect(homeCount).toBeGreaterThan(0);
    expect(cleanupOrder.indexOf("home")).toBeLessThan(cleanupOrder.indexOf("camera-close"));
    expect(report.details.blocks.at(-1)?.camera.cleanup).toEqual({
      running: false,
      subscribers: 0,
      physicalRunning: false,
      available: false
    });
  });
});

function hasHealthyContentionCamera(block: ContentionReport["details"]["blocks"][number]): boolean {
  return hasHealthyFrameTiming(block) && hasHealthyCreditFlow(block);
}

function hasHealthyFrameTiming(block: ContentionReport["details"]["blocks"][number]): boolean {
  return (
    block.camera.observationGapMs.maxMs <= 500 &&
    block.camera.deviceCaptureGapMs.count > 0 &&
    block.camera.deviceCaptureGapMs.maxMs <= 500 &&
    block.camera.deviceEncodeMs.count > 0 &&
    block.camera.deviceEncodeMs.maxMs === 1 &&
    block.camera.missedSequenceCount === 0
  );
}

function hasHealthyCreditFlow(block: ContentionReport["details"]["blocks"][number]): boolean {
  return (
    block.camera.creditSend.count === 12 &&
    block.camera.creditSend.failures === 0 &&
    block.camera.creditSend.maxUs === 240
  );
}

type CameraCondition = "off" | "stream" | "load";

type CameraStatus = {
  readonly running: boolean;
  readonly subscribers: number;
  readonly physicalRunning: boolean;
  readonly available: boolean;
  readonly receivedFrames: number;
  readonly maxJpegBytes: number;
  readonly creditSendCount: number;
  readonly creditSendFailures: number;
  readonly creditSendMaxUs: number;
};

type ContentionDependencies = {
  readonly createAdapter: (
    config: NonNullable<ReturnType<typeof liveConfig>["camera"]["stackchan"]>,
    condition: CameraCondition
  ) => StackChanAdapter;
  readonly createHomeAdapter: (
    config: NonNullable<ReturnType<typeof liveConfig>["camera"]["stackchan"]>
  ) => StackChanAdapter;
  readonly createHeadTargetLane: (
    config: NonNullable<ReturnType<typeof liveConfig>["camera"]["stackchan"]>
  ) => StackChanHeadTargetLane;
  readonly createModel: (
    config: ReturnType<typeof liveConfig>["vision"]["attentionDetection"]
  ) => Promise<AttentionDetectionModel>;
  readonly readCameraStatus: (
    config: NonNullable<ReturnType<typeof liveConfig>["camera"]["stackchan"]>
  ) => Promise<CameraStatus>;
  readonly createDiagnostics: () => StackChanStabilityDiagnostics;
  readonly monotonicNowMs: () => number;
  readonly wallNowMs: () => number;
  readonly waitMs: (durationMs: number) => Promise<void>;
  readonly writeReport: (path: string, report: ContentionReport) => Promise<void>;
};

type ContentionReport = {
  readonly status: "passed" | "failed";
  readonly details: {
    readonly blockOrder: readonly CameraCondition[];
    readonly durationMs: number;
    readonly commandIntervalMs: number;
    readonly sweepExtentDeg: number;
    readonly blocks: readonly {
      readonly condition: CameraCondition;
      readonly successfulUpdates: number;
      readonly failedUpdates: number;
      readonly gatewaySessionStable: boolean;
      readonly nativeWrites: {
        readonly attemptedWrites: number;
        readonly ackFailures: number;
        readonly overflowCount: number;
      };
      readonly autoSleepEnabled: boolean;
      readonly minimumCommandedPitch: number;
      readonly stopAndHomeMs: number;
      readonly home: { readonly returnedHome: boolean };
      readonly headTargetLane: {
        readonly failed: number;
        readonly staleDiscarded: number;
        readonly maximumActiveCalls: number;
        readonly maximumPendingDepth: number;
        readonly postStopDispatches: number;
      };
      readonly camera: {
        readonly creditSend: {
          readonly count: number;
          readonly failures: number;
          readonly maxUs: number;
        };
        readonly observationGapMs: {
          readonly maxMs: number;
        };
        readonly deviceCaptureGapMs: {
          readonly count: number;
          readonly maxMs: number;
        };
        readonly deviceEncodeMs: {
          readonly count: number;
          readonly maxMs: number;
        };
        readonly missedSequenceCount: number;
        readonly cleanup: {
          readonly running: boolean;
          readonly subscribers: number;
          readonly physicalRunning: boolean;
          readonly available: boolean;
        };
      };
    }[];
    readonly consecutiveLoadPasses: number;
    readonly conditions: Record<
      CameraCondition,
      {
        readonly blockCount: number;
        readonly updateAcknowledgmentMs: {
          readonly over250MsCount: number;
        };
      }
    >;
  };
};

function contentionHeadTargetLane(
  options: {
    readonly condition?: CameraCondition;
    readonly lifecycle?: string[];
    readonly laneConfigs?: StackChanHeadTargetStartConfig[];
    readonly measuredTargets?: Record<CameraCondition, StackChanHeadPose[]>;
    readonly advanceTime?: (durationMs: number) => void;
    readonly event?: (event: string) => void;
    readonly close?: () => void;
  } = {}
): StackChanHeadTargetLane {
  const leaseId = "contention-lease";
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
    confirmedPose: { yaw: 0, pitch: 33 },
    updateAcknowledgmentMs: contentionLaneDistribution(accepted),
    pendingAgeMs: contentionLaneDistribution(accepted),
    deviceDispatchLatencyMs: contentionLaneDistribution(accepted),
    successfulReplyLatencyMs: contentionLaneDistribution(accepted),
    firmwareMcpStageUs: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    }
  });
  return {
    connect: () => {
      options.lifecycle?.push("connect");
      return Promise.resolve();
    },
    start: (config) => {
      options.lifecycle?.push("start");
      options.event?.("lane-start");
      options.laneConfigs?.push(config);
      return Promise.resolve({ leaseId, confirmedPose: { yaw: 0, pitch: 33 }, status: status() });
    },
    update: (target) => {
      accepted++;
      if (options.condition !== undefined) {
        options.measuredTargets?.[options.condition].push(target.pose);
        const latency =
          options.condition === "off" ? 80 : options.condition === "stream" ? 160 : 180;
        options.advanceTime?.(latency);
      }
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
      options.lifecycle?.push("stop");
      options.event?.("lane-stop");
      phase = "stopped";
      return Promise.resolve(status());
    },
    close: () => {
      options.lifecycle?.push("close");
      options.close?.();
      return Promise.resolve();
    }
  };
}

function contentionLaneDistribution(count: number) {
  return {
    count,
    p50: count === 0 ? 0 : 10,
    p95: count === 0 ? 0 : 20,
    p99: count === 0 ? 0 : 23,
    max: count === 0 ? 0 : 24
  };
}

type StackChanStabilityDiagnostics = {
  readonly beginNativeTelemetry: () => Promise<void>;
  readonly finishNativeTelemetry: () => Promise<{
    readonly attemptedWrites: number;
    readonly ackFailures: number;
    readonly overflowCount: number;
  }>;
  readonly readGatewaySessionId: () => Promise<string>;
  readonly readAutoSleepEnabled: () => Promise<boolean>;
  readonly close: () => Promise<void>;
};

type ContentionRunner = (
  config: ReturnType<typeof liveConfig>,
  options: {
    readonly enableLiveRun: true;
    readonly durationMs: number;
    readonly consecutiveLoadRuns: number;
    readonly singleCondition?: "stream" | "load";
    readonly reportOutput: string;
  },
  dependencies: ContentionDependencies
) => Promise<ContentionReport>;

function liveConfig() {
  return definePicoConfig({
    camera: {
      stackchan: {
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        follow: {
          enabled: true,
          commandTransport: "async-latest",
          stepQuantization: "round",
          targetFilter: { enabled: false },
          homeYaw: 0,
          homePitch: 33,
          moveSpeedDps: 90
        }
      }
    },
    vision: {
      attentionDetection: {
        enabled: true,
        provider: "onnxruntime",
        modelFamily: "pinto441-yolox-body-head-hand-face-dist",
        modelPath: "/tmp/model.onnx",
        inputWidth: 320,
        inputHeight: 256
      }
    }
  });
}

function maximumAxisDelta(currentPose: StackChanHeadPose, nextPose: StackChanHeadPose): number {
  return Math.max(
    Math.abs(nextPose.yaw - currentPose.yaw),
    Math.abs(nextPose.pitch - currentPose.pitch)
  );
}

function stableDiagnostics(lifecycle?: string[]): StackChanStabilityDiagnostics {
  return {
    beginNativeTelemetry: () => {
      lifecycle?.push("telemetry-begin");
      return Promise.resolve();
    },
    finishNativeTelemetry: () => {
      lifecycle?.push("telemetry-finish");
      return Promise.resolve({ attemptedWrites: 16, ackFailures: 0, overflowCount: 0 });
    },
    readGatewaySessionId: () => Promise.resolve("session-1"),
    readAutoSleepEnabled: () => Promise.resolve(false),
    close: () => Promise.resolve()
  };
}

function latencySummary(successCount: number, latencyMs: number) {
  return {
    successCount,
    failureCount: 0,
    p50Ms: latencyMs,
    p95Ms: latencyMs,
    minMs: latencyMs,
    maxMs: latencyMs
  };
}
