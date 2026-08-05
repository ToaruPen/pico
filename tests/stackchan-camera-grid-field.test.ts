import { describe, expect, it } from "vitest";

import {
  parseStackChanCameraGridArguments,
  runStackChanCameraGridField,
  type StackChanCameraGridReport
} from "../scripts/field/stackchan-camera-grid.js";
import { definePicoConfig } from "../src/config/index.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";

function requirePassedReport(
  report: StackChanCameraGridReport
): asserts report is Extract<StackChanCameraGridReport, { readonly status: "passed" }> {
  if (report.status !== "passed") {
    throw new Error("expected the camera grid report to pass");
  }
}

function expectFirstPoseQualityMetrics(report: StackChanCameraGridReport): void {
  requirePassedReport(report);
  const firstPose = report.details.poses[0];
  if (firstPose === undefined || firstPose.selected === undefined) {
    throw new Error("expected a selected target in the first camera-grid pose");
  }

  expect(firstPose.captureLatencyMs).toBeGreaterThanOrEqual(0);
  expect(firstPose.inferenceLatencyMs).toBeGreaterThanOrEqual(0);
  expect(firstPose.selected.centerX).toBeCloseTo(0.4);
  expect(firstPose.selected.centerY).toBeCloseTo(0.45);
  expect(firstPose.selected.coverage).toBeCloseTo(0.2);
}

describe("StackChan camera grid field harness", () => {
  it("requires explicit live permission, model path, and report output", () => {
    expect(() => parseStackChanCameraGridArguments([])).toThrow("--enable-live-run");
    expect(() =>
      parseStackChanCameraGridArguments(["--enable-live-run", "--model-path", "/tmp/model.onnx"])
    ).toThrow("--report-output");
    expect(() =>
      parseStackChanCameraGridArguments(["--enable-live-run", "--report-output", "/tmp/out.json"])
    ).toThrow("--model-path");
    expect(() =>
      parseStackChanCameraGridArguments([
        "--enable-live-run",
        "--model-path",
        "/tmp/model.onnx",
        "--report-output",
        "/tmp/out.json",
        "--surprise",
        "value"
      ])
    ).toThrow("unknown option: --surprise");
  });

  it("records aggregate quality and detection metadata without image bytes", async () => {
    const events: string[] = [];
    let pose = { yaw: 0, pitch: 35 };
    const adapter: StackChanAdapter = {
      connect: () => {
        events.push("connect");
        return Promise.resolve();
      },
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, pose.yaw + 90, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: pose.yaw, pitch: pose.pitch - 1 }),
      moveHead: (nextPose) => {
        pose = nextPose;
        events.push(`move:${nextPose.yaw},${nextPose.pitch}`);
        return Promise.resolve();
      },
      close: () => {
        events.push("close");
        return Promise.resolve();
      }
    };
    let written: unknown;
    const report = await runStackChanCameraGridField(
      definePicoConfig({
        camera: {
          stackchan: {
            sourceId: "stackchan-core-s3",
            mcpUrl: "http://127.0.0.1:18767/mcp",
            bearerTokenEnv: "STACKCHAN_TOKEN",
            follow: {
              enabled: false
            }
          }
        }
      }),
      {
        enableLiveRun: true,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/grid.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () =>
          Promise.resolve({
            detect: () =>
              Promise.resolve([
                {
                  label: "face",
                  confidence: 0.9,
                  boundingBox: { xMin: 0.2, yMin: 0.2, xMax: 0.6, yMax: 0.7 }
                }
              ])
          }),
        inspectImage: () => Promise.resolve({ width: 640, height: 480 }),
        hashModel: () => Promise.resolve("a".repeat(64)),
        settleHead: () => {
          events.push("settle");
          return Promise.resolve();
        },
        writeReport: (_path, value) => {
          written = value;
          return Promise.resolve();
        }
      }
    );

    expect(report).toMatchObject({
      status: "passed",
      provider: "stackchan-cores3+pinto441-dist",
      details: {
        sourceId: "stackchan-core-s3",
        poses: [
          {
            yaw: 0,
            pitch: 35,
            width: 640,
            height: 480,
            faceDetections: 1,
            selected: {
              label: "face",
              confidence: 0.9
            }
          },
          { yaw: -35, pitch: 35, width: 640, height: 480, faceDetections: 1 },
          { yaw: 35, pitch: 35, width: 640, height: 480, faceDetections: 1 }
        ],
        returnedHome: true
      }
    });
    expectFirstPoseQualityMetrics(report);
    expect(written).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("base64");
    expect(events).toEqual([
      "connect",
      "move:0,35",
      "move:-35,35",
      "move:35,35",
      "move:0,35",
      "settle",
      "close"
    ]);
  });

  it("fails closed when the final angle readback is not home", async () => {
    const adapter: StackChanAdapter = {
      connect: () => Promise.resolve(),
      captureJpeg: () =>
        Promise.resolve({
          bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          mimeType: "image/jpeg"
        }),
      getHeadAngles: () => Promise.resolve({ yaw: 35, pitch: 35 }),
      moveHead: () => Promise.resolve(),
      close: () => Promise.resolve()
    };

    const report = await runStackChanCameraGridField(
      definePicoConfig({
        camera: {
          stackchan: {
            mcpUrl: "http://127.0.0.1:18767/mcp",
            bearerTokenEnv: "STACKCHAN_TOKEN",
            follow: { enabled: false }
          }
        }
      }),
      {
        enableLiveRun: true,
        modelPath: "/tmp/model.onnx",
        reportOutput: "/tmp/grid.json"
      },
      {
        createAdapter: () => adapter,
        createModel: () => Promise.resolve({ detect: () => Promise.resolve([]) }),
        inspectImage: () => Promise.resolve({ width: 320, height: 240 }),
        hashModel: () => Promise.resolve("a".repeat(64)),
        settleHead: () => Promise.resolve(),
        writeReport: () => Promise.resolve()
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "stackchan-cores3+pinto441-dist",
      reason: "StackChan camera grid field run failed"
    });
  });
});
