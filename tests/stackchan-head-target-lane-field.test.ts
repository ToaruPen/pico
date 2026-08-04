import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseStackChanHeadTargetLaneArguments,
  runStackChanHeadTargetLaneField,
  type StackChanHeadTargetLaneFieldReport
} from "../scripts/field/stackchan-head-target-lane.js";
import { definePicoConfig } from "../src/config/index.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";

describe("StackChan head target lane field harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts only explicit bounded stress arguments and an absolute report path", () => {
    expect(
      parseStackChanHeadTargetLaneArguments([
        "--enable-live-run",
        "--duration-ms",
        "30000",
        "--update-hz",
        "20",
        "--status-hz",
        "5",
        "--report-output",
        "/tmp/stackchan-head-target-lane.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      durationMs: 30_000,
      updateHz: 20,
      statusHz: 5,
      reportOutput: "/tmp/stackchan-head-target-lane.json"
    });

    expect(() =>
      parseStackChanHeadTargetLaneArguments([
        "--enable-live-run",
        "--duration-ms",
        "999",
        "--update-hz",
        "20",
        "--status-hz",
        "5",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow("--duration-ms");
    expect(() =>
      parseStackChanHeadTargetLaneArguments([
        "--enable-live-run",
        "--duration-ms",
        "30000",
        "--update-hz",
        "51",
        "--status-hz",
        "5",
        "--report-output",
        "relative.json"
      ])
    ).toThrow("--update-hz");
    expect(() =>
      parseStackChanHeadTargetLaneArguments([
        "--enable-live-run",
        "--duration-ms",
        "30000",
        "--update-hz",
        "20",
        "--status-hz",
        "11",
        "--report-output",
        "relative.json"
      ])
    ).toThrow("--status-hz");
    expect(() =>
      parseStackChanHeadTargetLaneArguments([
        "--enable-live-run",
        "--duration-ms",
        "30000",
        "--update-hz",
        "20",
        "--status-hz",
        "5",
        "--report-output",
        "relative.json"
      ])
    ).toThrow("--report-output");
  });

  it("runs 20 Hz updates beside 5 Hz status polls and writes aggregate-only mode 0600", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const directory = await mkdtemp(join(tmpdir(), "pico-head-target-lane-"));
    const reportOutput = resolve(directory, "report.json");
    const lane = simulatedLane();
    const events: string[] = [];
    const adapter = homeAdapter(events);

    try {
      const run = runStackChanHeadTargetLaneField(
        fieldConfig(),
        {
          enableLiveRun: true,
          durationMs: 30_000,
          updateHz: 20,
          statusHz: 5,
          reportOutput
        },
        {
          createLane: () => lane,
          createAdapter: () => adapter,
          monotonicNowMs: () => Date.now()
        }
      );

      await vi.advanceTimersByTimeAsync(31_500);
      const report = await run;
      const serialized = await readFile(reportOutput, "utf8");

      expect(report.passed).toBe(true);
      expect(report).toMatchObject({
        schemaVersion: 1,
        durationMs: 30_000,
        requestedUpdateHz: 20,
        acceptedUpdateRateHz: 20,
        deviceDispatchRateHz: 10,
        updateAcknowledgmentMs: {
          count: 600,
          p95: 5,
          p99: 5
        },
        statusLatencyMs: {
          count: 150,
          p95: 10,
          p99: 10
        },
        pendingAgeMs: {
          count: 300,
          p95: 50,
          p99: 50
        },
        deviceDispatchLatencyMs: {
          count: 300,
          p95: 82,
          p99: 82
        },
        successfulReplyLatencyMs: {
          count: 300,
          p95: 80,
          p99: 80
        },
        firmwareMcpStageUs: {
          count: 300,
          receiveToApply: { count: 300, p50: 100, p95: 100, max: 100 },
          toolApply: { count: 300, p50: 20, p95: 20, max: 20 },
          applyToReplyEnqueue: { count: 300, p50: 7, p95: 7, max: 7 },
          schedulerHops: { "1": 300 }
        },
        stopLatencyMs: 20,
        accepted: 600,
        confirmedApplyReplies: 300,
        failed: 0,
        staleDiscarded: 0,
        noOpDiscarded: 0,
        maximumActiveCalls: 1,
        maximumPendingDepth: 1,
        postStopDispatches: 0,
        finalHomeErrorDeg: {
          yaw: 0,
          pitch: 0
        }
      });
      expect(events).toEqual(["connect", "home", "read", "close"]);
      expect((await stat(reportOutput)).mode & 0o777).toBe(0o600);
      expect(serialized).not.toMatch(
        /targetSeries|commandSeries|angleSeries|sequence(?:s|List)|detections|jpeg|image|boundingBox|centerX|centerY|confirmedPose|leaseId/i
      );
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when effective device dispatch stays below the documented 7.5 Hz gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lane = simulatedLane(3);
    const events: string[] = [];
    let written: StackChanHeadTargetLaneFieldReport | undefined;

    const run = runStackChanHeadTargetLaneField(
      fieldConfig(),
      {
        enableLiveRun: true,
        durationMs: 30_000,
        updateHz: 20,
        statusHz: 5,
        reportOutput: "/tmp/not-written.json"
      },
      {
        createLane: () => lane,
        createAdapter: () => homeAdapter(events),
        monotonicNowMs: () => Date.now(),
        writeReport: (_path, report) => {
          written = report;
          return Promise.resolve();
        }
      }
    );

    await vi.advanceTimersByTimeAsync(31_500);
    const report = await run;

    expect(report).toMatchObject({
      passed: false,
      acceptedUpdateRateHz: 20,
      deviceDispatchRateHz: 6.67,
      accepted: 600,
      dispatched: 200
    });
    expect(written).toEqual(report);
  });

  it("uses confirmed apply-correlated replies rather than send starts for the rate gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lane = simulatedLane(2, 3);
    const events: string[] = [];

    const run = runStackChanHeadTargetLaneField(
      fieldConfig(),
      {
        enableLiveRun: true,
        durationMs: 30_000,
        updateHz: 20,
        statusHz: 5,
        reportOutput: "/tmp/not-written.json"
      },
      {
        createLane: () => lane,
        createAdapter: () => homeAdapter(events),
        monotonicNowMs: () => Date.now(),
        writeReport: () => Promise.resolve()
      }
    );

    await vi.advanceTimersByTimeAsync(31_500);
    const report = await run;

    expect(report).toMatchObject({
      passed: false,
      deviceDispatchRateHz: 6.67,
      dispatched: 300,
      confirmed: 200,
      confirmedApplyReplies: 200
    });
  });
});

function fieldConfig() {
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
          commandRateHz: 10,
          maxPendingCommandAgeMs: 180,
          homeYaw: 0,
          homePitch: 33,
          maxStepDeg: 4,
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

function simulatedLane(
  dispatchDivisor = 2,
  confirmationDivisor = dispatchDivisor
): StackChanHeadTargetLane {
  const leaseId = "field-lease";
  let accepted = 0;
  let statusCalls = 0;
  const status = (): StackChanHeadTargetStatus => {
    const dispatched = Math.floor(accepted / dispatchDivisor);
    const confirmed = Math.floor(accepted / confirmationDivisor);
    return {
      phase: "running",
      leaseId,
      leaseIdMatch: true,
      accepted,
      replaced: accepted - dispatched,
      dispatched,
      confirmed,
      confirmedApplyReplies: confirmed,
      failed: 0,
      staleDiscarded: 0,
      noOpDiscarded: 0,
      activeCalls: accepted === 0 ? 0 : 1,
      pendingDepth: accepted % 2 === 0 ? 0 : 1,
      maximumActiveCalls: accepted === 0 ? 0 : 1,
      maximumPendingDepth: accepted === 0 ? 0 : 1,
      postStopDispatches: 0,
      updateAcknowledgmentMs: distribution(accepted, 5),
      pendingAgeMs: distribution(dispatched, 50),
      deviceDispatchLatencyMs: distribution(dispatched, 82),
      successfulReplyLatencyMs: distribution(confirmed, 80),
      firmwareMcpStageUs: firmwareStageMetrics(confirmed)
    };
  };
  return {
    connect: () => Promise.resolve(),
    start: () =>
      Promise.resolve({
        leaseId,
        confirmedPose: { yaw: 0, pitch: 33 },
        status: status()
      }),
    update: (target) =>
      new Promise((resolvePromise) => {
        setTimeout(() => {
          accepted += 1;
          resolvePromise({
            accepted: true,
            replaced: accepted > 1,
            pendingDepth: 1,
            acceptedCount: accepted,
            replacedCount: Math.max(0, accepted - Math.floor(accepted / 2)),
            lastAcceptedSequence: target.sequence
          });
        }, 5);
      }),
    clear: () => Promise.resolve(status()),
    status: () =>
      new Promise((resolvePromise) => {
        setTimeout(() => {
          statusCalls += 1;
          resolvePromise(status());
        }, 10);
      }),
    stop: () =>
      new Promise((resolvePromise) => {
        setTimeout(() => {
          const value = status();
          resolvePromise({
            ...value,
            phase: "stopped",
            activeCalls: 0,
            pendingDepth: 0,
            updateAcknowledgmentMs: distribution(accepted, 5),
            pendingAgeMs: distribution(value.dispatched, 50),
            deviceDispatchLatencyMs: distribution(value.dispatched, 82),
            successfulReplyLatencyMs: distribution(value.confirmed, 80),
            firmwareMcpStageUs: firmwareStageMetrics(value.confirmed)
          });
        }, 20);
      }),
    close: () => {
      expect(statusCalls).toBe(150);
      return Promise.resolve();
    }
  };
}

function homeAdapter(events: string[]): StackChanAdapter {
  let pose = { yaw: 8, pitch: 33 };
  return {
    connect: () => {
      events.push("connect");
      return Promise.resolve();
    },
    captureJpeg: () => Promise.reject(new Error("capture is not used")),
    getHeadAngles: () => {
      events.push("read");
      return Promise.resolve({ ...pose });
    },
    moveHead: (nextPose) => {
      events.push("home");
      pose = { ...nextPose };
      return Promise.resolve();
    },
    close: () => {
      events.push("close");
      return Promise.resolve();
    }
  };
}

function distribution(count: number, value: number) {
  return {
    count,
    p50: count === 0 ? 0 : value,
    p95: count === 0 ? 0 : value,
    p99: count === 0 ? 0 : value,
    max: count === 0 ? 0 : value
  };
}

function firmwareStageMetrics(count: number) {
  return {
    count,
    receiveToApply: firmwareStageDistribution(count, 100),
    toolApply: firmwareStageDistribution(count, 20),
    applyToReplyEnqueue: firmwareStageDistribution(count, 7),
    schedulerHops: firmwareSchedulerHops(count)
  };
}

function firmwareStageDistribution(count: number, value: number) {
  const measured = count === 0 ? 0 : value;
  return { count, p50: measured, p95: measured, max: measured };
}

function firmwareSchedulerHops(count: number) {
  return count === 0 ? {} : { "1": count };
}
