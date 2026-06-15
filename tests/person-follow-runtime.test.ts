import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import { runPersonFollowRuntime } from "../src/runtime/person-follow-runtime.js";

describe("person-follow runtime", () => {
  it("requires an explicit live run authorization", async () => {
    const report = await runPersonFollowRuntime(enabledPersonFollowConfig());

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime requires enableLiveRun=true"
    });
  });

  it("forwards streamed person detections to the bounded follow controller", async () => {
    const moves: unknown[] = [];
    const stops: unknown[] = [];
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 5_000
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          drain() {
            return Promise.resolve();
          },
          start() {
            options.publish({
              sourceId: "tapo-main",
              capturedAt: "2026-06-16T00:00:00.000Z",
              detections: [
                {
                  label: "person",
                  confidence: 0.9,
                  boundingBox: {
                    xMin: 0.7,
                    yMin: 0.6,
                    xMax: 0.9,
                    yMax: 0.8
                  }
                }
              ]
            });
          },
          stop() {}
        }),
        createDriver: () => ({
          relativeMove(command) {
            moves.push(command);

            return Promise.resolve();
          },
          stop() {
            stops.push("stop");

            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+coreml+onvif",
      details: {
        sourceId: "tapo-main",
        framesProcessed: 1,
        movesIssued: 1,
        stopsIssued: 1,
        errors: 0
      }
    });
    expect(moves).toEqual([
      {
        pan: 0.25,
        tilt: -0.2,
        speed: 0.4
      }
    ]);
    expect(stops).toEqual(["stop"]);
  });

  it("fails when the detection stream reports runtime errors", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          drain() {
            return Promise.resolve();
          },
          start() {
            options.reportError?.(new Error("capture failed"));
          },
          stop() {}
        }),
        createDriver: () => ({
          relativeMove() {
            return Promise.resolve();
          },
          stop() {
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined)
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime finished with 1 error"
    });
  });

  it("fails when no frames are processed", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1
      },
      {
        pathExists: () => true,
        createDetectionStream: () => ({
          drain() {
            return Promise.resolve();
          },
          start() {},
          stop() {}
        }),
        createDriver: () => ({
          relativeMove() {
            return Promise.resolve();
          },
          stop() {
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined)
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime processed no frames"
    });
  });

  it("fails when detection and follow source IDs differ", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig({ detectorSourceId: "other-camera" }),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1
      },
      {
        pathExists: () => true
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "vision.personDetection.sourceCameraId must match camera.personFollow.sourceCameraId"
    });
  });

  it("waits for in-flight frame processing before reporting", async () => {
    const moves: unknown[] = [];
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1,
        finishDrainTimeoutMs: 100
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          drain() {
            return Promise.resolve();
          },
          start() {
            options.publish({
              sourceId: "tapo-main",
              capturedAt: "2026-06-16T00:00:00.000Z",
              detections: [
                {
                  label: "person",
                  confidence: 0.9,
                  boundingBox: {
                    xMin: 0.7,
                    yMin: 0.6,
                    xMax: 0.9,
                    yMax: 0.8
                  }
                }
              ]
            });
          },
          stop() {}
        }),
        createDriver: () => ({
          async relativeMove(command) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            moves.push(command);
          },
          stop() {
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+coreml+onvif",
      details: {
        sourceId: "tapo-main",
        framesProcessed: 1,
        movesIssued: 1,
        stopsIssued: 1,
        errors: 0
      }
    });
    expect(moves).toHaveLength(1);
  });

  it("waits for in-flight stream drain before reporting", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1,
        finishDrainTimeoutMs: 100
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          async drain() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            options.reportError?.(new Error("capture failed after stop"));
          },
          start() {
            options.publish({
              sourceId: "tapo-main",
              capturedAt: "2026-06-16T00:00:00.000Z",
              detections: [
                {
                  label: "person",
                  confidence: 0.9,
                  boundingBox: {
                    xMin: 0.4,
                    yMin: 0.4,
                    xMax: 0.6,
                    yMax: 0.6
                  }
                }
              ]
            });
          },
          stop() {}
        }),
        createDriver: () => ({
          relativeMove() {
            return Promise.resolve();
          },
          stop() {
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime finished with 1 error"
    });
  });

  it("fails instead of hanging when stream drain rejects", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1,
        finishDrainTimeoutMs: 100
      },
      {
        pathExists: () => true,
        createDetectionStream: () => ({
          drain() {
            return Promise.reject(new Error("drain failed"));
          },
          start() {},
          stop() {}
        }),
        createDriver: () => ({
          relativeMove() {
            return Promise.resolve();
          },
          stop() {
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime finished with 1 error"
    });
  });

  it("stops the stream as soon as the frame budget is reached", async () => {
    const events: string[] = [];
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 5_000,
        finishDrainTimeoutMs: 100
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          drain() {
            return Promise.resolve();
          },
          start() {
            options.publish({
              sourceId: "tapo-main",
              capturedAt: "2026-06-16T00:00:00.000Z",
              detections: [
                {
                  label: "person",
                  confidence: 0.9,
                  boundingBox: {
                    xMin: 0.7,
                    yMin: 0.6,
                    xMax: 0.9,
                    yMax: 0.8
                  }
                }
              ]
            });
          },
          stop() {
            events.push("stream-stop");
          }
        }),
        createDriver: () => ({
          async relativeMove() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            events.push("relative-move");
          },
          stop() {
            events.push("driver-stop");
            return Promise.resolve();
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report.status).toBe("passed");
    expect(events).toEqual(["stream-stop", "relative-move", "driver-stop"]);
  });

  it("fails instead of hanging when the final controller stop does not settle", async () => {
    const report = await runPersonFollowRuntime(
      enabledPersonFollowConfig(),
      {
        enableLiveRun: true,
        maxFrames: 1,
        durationMs: 1,
        finishDrainTimeoutMs: 10
      },
      {
        pathExists: () => true,
        createDetectionStream: (options) => ({
          drain() {
            return Promise.resolve();
          },
          start() {
            options.publish({
              sourceId: "tapo-main",
              capturedAt: "2026-06-16T00:00:00.000Z",
              detections: []
            });
          },
          stop() {}
        }),
        createDriver: () => ({
          relativeMove() {
            return Promise.resolve();
          },
          stop() {
            return new Promise<never>(() => undefined);
          }
        }),
        createModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          }),
        captureFrame: () => Promise.resolve(undefined),
        nowMs: () => 1_000
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "person-follow runtime finished with 1 error"
    });
  });
});

function enabledPersonFollowConfig(
  options: { readonly detectorSourceId?: string } = {}
): ReturnType<typeof definePicoConfig> {
  return definePicoConfig({
    camera: {
      tapo: {
        sourceId: "tapo-main",
        host: "192.168.10.25",
        user: "camera-user",
        password: "camera-passphrase"
      },
      personFollow: {
        enabled: true,
        sourceCameraId: "tapo-main",
        deadZone: 0.1,
        maxStep: 0.25,
        speed: 0.4,
        cooldownMs: 500,
        lostTargetTimeoutMs: 1500
      }
    },
    vision: {
      personDetection: {
        enabled: true,
        sourceCameraId: options.detectorSourceId ?? "tapo-main",
        modelFamily: "pinto0309",
        provider: "coreml",
        modelPath: "/opt/pico/models/pinto0309/yolox.onnx",
        inputWidth: 320,
        inputHeight: 320,
        outputLayout: "yolox_coco_raw",
        frameIntervalMs: 500,
        confidenceThreshold: 0.55
      }
    }
  });
}
