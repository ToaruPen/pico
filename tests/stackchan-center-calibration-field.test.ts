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

import { describe, expect, it } from "vitest";

import {
  parseStackChanCenterCalibrationArguments,
  runStackChanCenterCalibrationField,
  type StackChanCenterCalibrationDependencies,
  type StackChanCenterCalibrationOptions,
  type StackChanCenterCalibrationReport
} from "../scripts/field/stackchan-center-calibration.js";
import { definePicoConfig, type PicoConfig } from "../src/config/index.js";
import type { StackChanAdapter, StackChanJpegFrame } from "../src/modules/stackchan/index.js";
import type {
  AttentionDetection,
  PintoAttentionDetectionModelOptions
} from "../src/modules/vision/attention-detection.js";

const defaultOptions: StackChanCenterCalibrationOptions = {
  enableLiveRun: true,
  durationMs: 1_000,
  maxFrames: 20,
  minimumTargetFrames: 20,
  modelPath: "/tmp/attention.onnx",
  reportOutput: "/tmp/stackchan-center-calibration.json"
};

function liveConfig(moveSpeedDps = 120): PicoConfig {
  return definePicoConfig({
    camera: {
      stackchan: {
        sourceId: "stackchan-core-s3",
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        streamFps: 12,
        follow: {
          enabled: true,
          commandTransport: "async-latest",
          stepQuantization: "round",
          targetFilter: { enabled: false },
          homeYaw: 0,
          homePitch: 35,
          deadZone: 0.1,
          moveSpeedDps
        }
      }
    },
    vision: {
      attentionDetection: {
        enabled: true,
        provider: "onnxruntime",
        modelFamily: "pinto441-yolox-body-head-hand-face-dist",
        modelPath: "/tmp/config-attention.onnx",
        inputWidth: 320,
        inputHeight: 256,
        headConfidenceThreshold: 0.25,
        faceConfidenceThreshold: 0.55
      }
    }
  });
}

function frame(sequence: number | undefined, receivedAtMs = 900): StackChanJpegFrame {
  return {
    bytes: Uint8Array.of(0xff, 0xd8, sequence ?? 0, 0xff, 0xd9),
    mimeType: "image/jpeg",
    ...(sequence === undefined ? {} : { sequence }),
    receivedAtMs
  };
}

function freshFrames(count: number): StackChanJpegFrame[] {
  return Array.from({ length: count }, (_, index) => frame(index + 1));
}

function target(
  label: "face" | "head",
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  confidence = 0.9
): AttentionDetection {
  return {
    label,
    confidence,
    boundingBox: { xMin, yMin, xMax, yMax }
  };
}

function createFieldAdapter(input: {
  readonly frames: readonly StackChanJpegFrame[];
  readonly events?: string[];
  readonly finalPose?: { readonly yaw: number; readonly pitch: number };
}): StackChanAdapter {
  const events = input.events ?? [];
  const frames = [...input.frames];

  return {
    connect: () => {
      events.push("connect");
      return Promise.resolve();
    },
    captureJpeg: () => {
      events.push("capture");
      const next = frames.shift();
      return next === undefined
        ? Promise.reject(new Error("unexpected capture"))
        : Promise.resolve(next);
    },
    getHeadAngles: () => {
      events.push("read");
      return Promise.resolve(input.finalPose ?? { yaw: 0, pitch: 35 });
    },
    moveHead: (pose, motion) => {
      events.push(`move:${pose.yaw},${pose.pitch}@${motion?.speedDps ?? "none"}`);
      return Promise.resolve();
    },
    close: () => {
      events.push("close");
      return Promise.resolve();
    }
  };
}

function createClock(step = 5): () => number {
  let value = -step;
  return () => {
    value += step;
    return value;
  };
}

function baseDependencies(
  adapter: StackChanAdapter,
  detections: readonly (readonly AttentionDetection[])[]
): StackChanCenterCalibrationDependencies {
  const results = [...detections];

  return {
    createAdapter: () => adapter,
    createModel: () =>
      Promise.resolve({
        detect: () => Promise.resolve(results.shift() ?? [])
      }),
    writeReport: () => Promise.resolve(),
    monotonicNowMs: createClock(),
    wallNowMs: () => 1_000
  };
}

function requirePassed(
  report: StackChanCenterCalibrationReport
): asserts report is Extract<StackChanCenterCalibrationReport, { readonly status: "passed" }> {
  if (report.status !== "passed") {
    throw new Error("expected calibration to pass");
  }
}

function requireFailed(
  report: StackChanCenterCalibrationReport
): asserts report is Extract<StackChanCenterCalibrationReport, { readonly status: "failed" }> {
  if (report.status !== "failed") {
    throw new Error("expected calibration to fail");
  }
}

const cleanupFailureExpectations = {
  capture: {
    failureCode: "runtime-error",
    framesProcessed: 0,
    finalPoseStatus: "available",
    finalPose: { yaw: 0, pitch: 35 },
    returnedHome: true,
    finalReadEvent: "read:2"
  },
  "initial-move": {
    failureCode: "runtime-error",
    framesProcessed: 0,
    finalPoseStatus: "available",
    finalPose: { yaw: 0, pitch: 35 },
    returnedHome: true,
    finalReadEvent: "read:1"
  },
  "final-move": {
    failureCode: "cleanup-error",
    framesProcessed: 20,
    finalPoseStatus: "available",
    finalPose: { yaw: 0, pitch: 35 },
    returnedHome: true,
    finalReadEvent: "read:3"
  },
  readback: {
    failureCode: "cleanup-error",
    framesProcessed: 20,
    finalPoseStatus: "unavailable",
    finalPose: undefined,
    returnedHome: false,
    finalReadEvent: "read:2"
  },
  close: {
    failureCode: "cleanup-error",
    framesProcessed: 20,
    finalPoseStatus: "available",
    finalPose: { yaw: 0, pitch: 35 },
    returnedHome: true,
    finalReadEvent: "read:2"
  }
} as const;

describe("StackChan center calibration field harness", () => {
  it("requires explicit named and bounded arguments and rejects unknown options", () => {
    expect(() => parseStackChanCenterCalibrationArguments([])).toThrow("--enable-live-run");
    expect(() =>
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "0",
        "--max-frames",
        "1",
        "--minimum-target-frames",
        "1",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow("--duration-ms");
    expect(() =>
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "120001",
        "--max-frames",
        "10001",
        "--minimum-target-frames",
        "10001",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow();
    expect(() =>
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "1000",
        "--max-frames",
        "20",
        "--minimum-target-frames",
        "19",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow("--minimum-target-frames");
    expect(() =>
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "1000",
        "--max-frames",
        "5",
        "--minimum-target-frames",
        "2",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json",
        "--surprise",
        "value"
      ])
    ).toThrow("--surprise");
    expect(() =>
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "1000",
        "--max-frames",
        "5",
        "--minimum-target-frames",
        "2",
        "--model-path",
        "--surprise",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toThrow();

    expect(
      parseStackChanCenterCalibrationArguments([
        "--enable-live-run",
        "--duration-ms",
        "120000",
        "--max-frames",
        "10000",
        "--minimum-target-frames",
        "10000",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/report.json"
      ])
    ).toEqual({
      enableLiveRun: true,
      durationMs: 120_000,
      maxFrames: 10_000,
      minimumTargetFrames: 10_000,
      modelPath: "/tmp/model.onnx",
      reportOutput: "/tmp/report.json"
    });
  });

  it("requires enabled StackChan follow and attention detection configuration", async () => {
    await expect(
      runStackChanCenterCalibrationField(definePicoConfig({}), defaultOptions, {
        writeReport: () => Promise.resolve()
      })
    ).rejects.toThrow("camera.stackchan");
  });

  it("rejects fewer than 20 minimum target frames at the exported run boundary", async () => {
    let adapterCreations = 0;
    const adapter = createFieldAdapter({ frames: freshFrames(20) });

    await expect(
      runStackChanCenterCalibrationField(
        liveConfig(),
        { ...defaultOptions, minimumTargetFrames: 19 },
        {
          ...baseDependencies(
            adapter,
            Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
          ),
          createAdapter: () => {
            adapterCreations += 1;
            return adapter;
          }
        }
      )
    ).rejects.toThrow("--minimum-target-frames");
    expect(adapterCreations).toBe(0);
  });

  it("holds the configured home pose and reports deduplicated face/head error statistics", async () => {
    const events: string[] = [];
    const adapter = createFieldAdapter({
      frames: [frame(1), frame(1), ...freshFrames(20).slice(1)],
      events,
      finalPose: { yaw: 1, pitch: 34 }
    });
    const modelInputs: PintoAttentionDetectionModelOptions[] = [];
    let detectionCalls = 0;
    let written: StackChanCenterCalibrationReport | undefined;
    const report = await runStackChanCenterCalibrationField(
      liveConfig(),
      { ...defaultOptions, maxFrames: 21 },
      {
        createAdapter: () => adapter,
        createModel: (input) => {
          modelInputs.push(input);
          return Promise.resolve({
            detect: (jpeg) => {
              detectionCalls += 1;
              if (jpeg[2] === 1) {
                return Promise.resolve([
                  target("head", 0.45, 0.4, 0.55, 0.6, 0.99),
                  target("face", 0.2, 0.4, 0.4, 0.6)
                ]);
              }
              return Promise.resolve(
                (jpeg[2] ?? 0) <= 10
                  ? [target("face", 0.2, 0.4, 0.4, 0.6)]
                  : [target("head", 0.5, 0.1, 0.7, 0.3)]
              );
            }
          });
        },
        writeReport: (_path, value) => {
          written = value;
          return Promise.resolve();
        },
        monotonicNowMs: createClock(),
        wallNowMs: () => 1_000
      }
    );

    requirePassed(report);
    expect(modelInputs).toEqual([
      {
        modelPath: "/tmp/attention.onnx",
        inputWidth: 320,
        inputHeight: 256,
        headConfidenceThreshold: 0.25,
        faceConfidenceThreshold: 0.55
      }
    ]);
    expect(detectionCalls).toBe(20);
    expect(report).toEqual({
      status: "passed",
      provider: "stackchan-cores3+pinto441-dist",
      details: {
        sourceId: "stackchan-core-s3",
        durationMs: 1_000,
        maxFrames: 21,
        framesProcessed: 20,
        errors: 0,
        stream: {
          requestedFps: 12,
          frameAgeP95Ms: 100
        },
        inference: {
          p95Ms: 5
        },
        attention: {
          targetFrames: 20,
          faceFrames: 10,
          headFrames: 10,
          horizontal: {
            signedP50: -0.2,
            absoluteP50: 0.1,
            absoluteP95: 0.2
          },
          vertical: {
            signedP50: -0.3,
            absoluteP50: 0,
            absoluteP95: 0.3
          },
          maximumLostGapMs: 0
        },
        finalPoseStatus: "available",
        finalPose: { yaw: 1, pitch: 34 },
        returnedHome: true
      }
    });
    expect(written).toEqual(report);
    expect(events).toEqual([
      "connect",
      "move:0,35@120",
      "read",
      ...Array.from({ length: 21 }, () => "capture"),
      "move:0,35@120",
      "read",
      "close"
    ]);
    expect(events.filter((event) => event.startsWith("move:"))).toEqual([
      "move:0,35@120",
      "move:0,35@120"
    ]);
  });

  it("polls until home before capture and again after the final low-speed move", async () => {
    const frames = freshFrames(20);
    const poses = [
      { yaw: -90, pitch: 35 },
      { yaw: 0, pitch: 35 },
      { yaw: 90, pitch: 35 },
      { yaw: 0, pitch: 35 }
    ];
    const waits: number[] = [];
    let monotonicNowMs = 0;
    let reads = 0;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () => {
        const next = frames.shift();
        return next === undefined
          ? Promise.reject(new Error("unexpected capture"))
          : Promise.resolve(next);
      },
      getHeadAngles: () => {
        reads += 1;
        return Promise.resolve(poses.shift() ?? { yaw: 0, pitch: 35 });
      },
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const report = await runStackChanCenterCalibrationField(liveConfig(15), defaultOptions, {
      ...baseDependencies(
        adapter,
        Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
      ),
      monotonicNowMs: () => monotonicNowMs,
      waitMs: (durationMs: number) => {
        waits.push(durationMs);
        monotonicNowMs += durationMs;
        return Promise.resolve();
      }
    });

    requirePassed(report);
    expect(reads).toBe(4);
    expect(waits).toEqual([100, 100]);
  });

  it("fails after a bounded final home timeout and still closes the adapter", async () => {
    const frames = freshFrames(20);
    let moveCalls = 0;
    let readCalls = 0;
    let waitedMs = 0;
    let closed = false;
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () => {
        const next = frames.shift();
        return next === undefined
          ? Promise.reject(new Error("unexpected capture"))
          : Promise.resolve(next);
      },
      getHeadAngles: () => {
        readCalls += 1;
        return Promise.resolve(moveCalls === 1 ? { yaw: 0, pitch: 35 } : { yaw: 20, pitch: 35 });
      },
      moveHead: () => {
        moveCalls += 1;
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      }
    };
    const report = await runStackChanCenterCalibrationField(liveConfig(240), defaultOptions, {
      ...baseDependencies(
        adapter,
        Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
      ),
      monotonicNowMs: () => waitedMs,
      waitMs: (durationMs: number) => {
        waitedMs += durationMs;
        return Promise.resolve();
      }
    });

    expect(report.status).toBe("failed");
    expect(waitedMs).toBeGreaterThanOrEqual(1_750);
    expect(waitedMs).toBeLessThanOrEqual(1_850);
    expect(readCalls).toBeGreaterThan(2);
    expect(closed).toBe(true);
  });

  it("fails closed when fewer than the minimum target frames are observed", async () => {
    const adapter = createFieldAdapter({
      frames: [frame(1), frame(2)],
      finalPose: { yaw: 0, pitch: 35 }
    });
    let written: StackChanCenterCalibrationReport | undefined;
    const report = await runStackChanCenterCalibrationField(
      liveConfig(),
      { ...defaultOptions, maxFrames: 2, minimumTargetFrames: 20 },
      {
        ...baseDependencies(adapter, [[target("face", 0.4, 0.4, 0.6, 0.6)], []]),
        writeReport: (_path, value) => {
          written = value;
          return Promise.resolve();
        }
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "stackchan-cores3+pinto441-dist",
      reason: "StackChan center calibration field run failed",
      failureCode: "insufficient-target",
      details: {
        sourceId: "stackchan-core-s3",
        durationMs: 1_000,
        maxFrames: 2,
        framesProcessed: 2,
        errors: 0,
        stream: {
          requestedFps: 12,
          frameAgeP95Ms: 100
        },
        inference: {
          p95Ms: 5
        },
        attention: {
          targetFrames: 1,
          faceFrames: 1,
          headFrames: 0,
          horizontal: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0
          },
          vertical: {
            signedP50: 0,
            absoluteP50: 0,
            absoluteP95: 0
          },
          maximumLostGapMs: 0
        },
        finalPoseStatus: "available",
        finalPose: { yaw: 0, pitch: 35 },
        returnedHome: true
      }
    });
    expect(written).toEqual(report);
  });

  it("measures target loss only within the capture loop", async () => {
    let wallNowMs = 1_000;
    let readCalls = 0;
    const adapter = createFieldAdapter({ frames: freshFrames(20) });
    const report = await runStackChanCenterCalibrationField(liveConfig(), defaultOptions, {
      createAdapter: () => ({
        ...adapter,
        captureJpeg: async () => {
          wallNowMs = 5_100;
          return adapter.captureJpeg();
        },
        getHeadAngles: async () => {
          readCalls += 1;
          wallNowMs = readCalls === 1 ? 5_000 : 9_000;
          return adapter.getHeadAngles();
        }
      }),
      createModel: () =>
        Promise.resolve({
          detect: () => {
            wallNowMs = 5_200;
            return Promise.resolve([target("face", 0.4, 0.4, 0.6, 0.6)]);
          }
        }),
      writeReport: () => Promise.resolve(),
      monotonicNowMs: createClock(),
      wallNowMs: () => wallNowMs
    });

    requirePassed(report);
    expect(report.details.attention.maximumLostGapMs).toBe(100);
  });

  it("fails closed when a camera frame has no sequence", async () => {
    const events: string[] = [];
    const adapter = createFieldAdapter({ frames: [frame(undefined)], events });
    const report = await runStackChanCenterCalibrationField(
      liveConfig(),
      { ...defaultOptions, maxFrames: 1 },
      baseDependencies(adapter, [[]])
    );

    expect(report.status).toBe("failed");
    expect(events).toEqual([
      "connect",
      "move:0,35@120",
      "read",
      "capture",
      "move:0,35@120",
      "read",
      "close"
    ]);
  });

  it("continues final home polling, close, and report after detection throws", async () => {
    const events: string[] = [];
    const adapter = createFieldAdapter({ frames: [frame(1)], events });
    let written: StackChanCenterCalibrationReport | undefined;
    const report = await runStackChanCenterCalibrationField(
      liveConfig(),
      { ...defaultOptions, maxFrames: 1 },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () => {
              events.push("detect");
              return Promise.reject(new Error("private detector detail"));
            }
          }),
        writeReport: (_path, value) => {
          written = value;
          events.push("report");
          return Promise.resolve();
        },
        monotonicNowMs: createClock(),
        wallNowMs: () => 1_000
      }
    );

    requireFailed(report);
    expect(report).toMatchObject({
      status: "failed",
      provider: "stackchan-cores3+pinto441-dist",
      reason: "StackChan center calibration field run failed",
      failureCode: "runtime-error",
      details: {
        framesProcessed: 0,
        errors: 1,
        attention: {
          targetFrames: 0,
          faceFrames: 0,
          headFrames: 0
        },
        finalPoseStatus: "available",
        finalPose: { yaw: 0, pitch: 35 },
        returnedHome: true
      }
    });
    expect(written).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("private detector detail");
    expect(events).toEqual([
      "connect",
      "move:0,35@120",
      "read",
      "capture",
      "detect",
      "move:0,35@120",
      "read",
      "close",
      "report"
    ]);
  });

  it.each([
    "capture",
    "initial-move",
    "final-move",
    "readback",
    "close"
  ] as const)("continues bounded cleanup after a %s failure", async (failurePoint) => {
    const expected = cleanupFailureExpectations[failurePoint];
    const events: string[] = [];
    const frames = freshFrames(20);
    let moveCalls = 0;
    let readCalls = 0;
    let written: StackChanCenterCalibrationReport | undefined;
    const adapter: StackChanAdapter = {
      connect: () => {
        events.push("connect");
        return Promise.resolve();
      },
      captureJpeg: () => {
        events.push("capture");
        if (failurePoint === "capture") {
          return Promise.reject(new Error("private capture detail"));
        }
        const next = frames.shift();
        return next === undefined
          ? Promise.reject(new Error("unexpected capture"))
          : Promise.resolve(next);
      },
      getHeadAngles: () => {
        readCalls += 1;
        events.push(`read:${readCalls}`);
        if (failurePoint === "readback" && moveCalls >= 2) {
          return Promise.reject(new Error("private readback detail"));
        }
        return Promise.resolve(
          failurePoint === "final-move" && moveCalls >= 2 && readCalls === 2
            ? { yaw: 20, pitch: 35 }
            : { yaw: 0, pitch: 35 }
        );
      },
      moveHead: () => {
        moveCalls += 1;
        events.push(`move:${moveCalls}`);
        if (
          (failurePoint === "initial-move" && moveCalls === 1) ||
          (failurePoint === "final-move" && moveCalls === 2)
        ) {
          return Promise.reject(new Error("private move detail"));
        }
        return Promise.resolve();
      },
      close: () => {
        events.push("close");
        return failurePoint === "close"
          ? Promise.reject(new Error("private close detail"))
          : Promise.resolve();
      }
    };
    const report = await runStackChanCenterCalibrationField(liveConfig(), defaultOptions, {
      ...baseDependencies(
        adapter,
        Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
      ),
      writeReport: (_path, value) => {
        written = value;
        events.push("report");
        return Promise.resolve();
      },
      waitMs: () => Promise.resolve()
    });

    requireFailed(report);
    expect(report.provider).toBe("stackchan-cores3+pinto441-dist");
    expect(report.reason).toBe("StackChan center calibration field run failed");
    expect(report.failureCode).toBe(expected.failureCode);
    expect(report.details.errors).toBe(1);
    expect(report.details.framesProcessed).toBe(expected.framesProcessed);
    expect(report.details.finalPoseStatus).toBe(expected.finalPoseStatus);
    expect(report.details.finalPose).toEqual(expected.finalPose);
    expect(report.details.returnedHome).toBe(expected.returnedHome);
    expect(written).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(events).toContain("move:2");
    expect(events).toContain(expected.finalReadEvent);
    expect(events.at(-2)).toBe("close");
    expect(events.at(-1)).toBe("report");
  });

  it("keeps the successful report aggregate-only", async () => {
    const adapter = createFieldAdapter({ frames: freshFrames(20) });
    const report = await runStackChanCenterCalibrationField(
      liveConfig(),
      defaultOptions,
      baseDependencies(
        adapter,
        Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
      )
    );
    const serialized = JSON.stringify(report);

    requirePassed(report);
    for (const privateField of [
      "confidence",
      "centerX",
      "centerY",
      "boundingBox",
      "bytes",
      "base64",
      "observedAtMs"
    ]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it.each([
    "resolved-same",
    "hardlink",
    "symlink"
  ] as const)("rejects a %s model/report collision before hardware connection", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "pico-calibration-paths-"));
    const modelPath = join(directory, "private-model.onnx");
    const ordinaryReportPath = join(directory, "private-report.json");
    let connectCalls = 0;
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
      const adapter = createFieldAdapter({ frames: freshFrames(20) });
      const result = await runStackChanCenterCalibrationField(
        liveConfig(),
        { ...defaultOptions, modelPath, reportOutput },
        {
          ...baseDependencies(
            adapter,
            Array.from({ length: 20 }, () => [target("face", 0.4, 0.4, 0.6, 0.6)])
          ),
          createAdapter: () => ({
            ...adapter,
            connect: () => {
              connectCalls += 1;
              return adapter.connect();
            }
          })
        }
      ).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(result).toBeInstanceOf(Error);
      const message = result instanceof Error ? result.message : "";
      expect(message).not.toContain(modelPath);
      expect(message).not.toContain(reportOutput);
      expect(connectCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the default JSON report with permission bits 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-center-calibration-"));
    const reportPath = join(directory, "report.json");
    try {
      await writeFile(reportPath, "{}\n", { encoding: "utf8", mode: 0o644 });
      await chmod(reportPath, 0o644);
      const previousInode = (await stat(reportPath)).ino;
      const adapter = createFieldAdapter({ frames: freshFrames(20) });
      const report = await runStackChanCenterCalibrationField(
        liveConfig(),
        {
          ...defaultOptions,
          reportOutput: reportPath
        },
        {
          createAdapter: () => adapter,
          createModel: () =>
            Promise.resolve({
              detect: () => Promise.resolve([target("face", 0.4, 0.4, 0.6, 0.6)])
            }),
          monotonicNowMs: createClock(),
          wallNowMs: () => 1_000
        }
      );

      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
      const reportStatus = await stat(reportPath);
      expect(reportStatus.mode & 0o777).toBe(0o600);
      expect(reportStatus.ino).not.toBe(previousInode);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes the private temporary file when atomic replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-calibration-write-"));
    const reportPath = join(directory, "occupied");
    try {
      await mkdir(reportPath);
      const adapter = createFieldAdapter({ frames: freshFrames(20) });
      const result = await runStackChanCenterCalibrationField(
        liveConfig(),
        { ...defaultOptions, reportOutput: reportPath },
        {
          createAdapter: () => adapter,
          createModel: () =>
            Promise.resolve({
              detect: () => Promise.resolve([target("face", 0.4, 0.4, 0.6, 0.6)])
            }),
          monotonicNowMs: createClock(),
          wallNowMs: () => 1_000
        }
      ).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(result).toEqual(new Error("StackChan center calibration report write failed"));
      expect(result instanceof Error ? result.message : "").not.toContain(reportPath);
      expect((await readdir(directory)).filter((name) => name.startsWith(".occupied."))).toEqual(
        []
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
