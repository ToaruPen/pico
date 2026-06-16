import { describe, expect, it } from "vitest";

import {
  buildPersonFollowRuntimeSmokePlan,
  personFollowRuntimeSmokeExitCode,
  runPersonFollowRuntimeSmoke
} from "../scripts/smoke/person-follow-runtime.js";
import { definePicoConfig } from "../src/config/index.js";

const enabledConfig = definePicoConfig({
  camera: {
    tapo: {
      sourceId: "tapo-main",
      host: "192.168.10.25",
      user: "camera-user",
      password: "camera-passphrase",
      streams: {
        detection: "stream2"
      }
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
      sourceCameraId: "tapo-main",
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

describe("person-follow runtime smoke", () => {
  it("skips unless live person-follow is explicitly enabled", async () => {
    await expect(runPersonFollowRuntimeSmoke(definePicoConfig({}), {})).resolves.toEqual({
      status: "skipped",
      provider: "unsupported",
      reason: "Set PICO_ENABLE_LIVE_PERSON_FOLLOW=1 to run person-follow runtime smoke."
    });
  });

  it("builds a bounded run plan from existing YAML settings", () => {
    expect(
      buildPersonFollowRuntimeSmokePlan(enabledConfig, {
        PICO_ENABLE_LIVE_PERSON_FOLLOW: "1"
      })
    ).toEqual({
      status: "run",
      durationMs: 5_000,
      maxFrames: 10,
      sourceId: "tapo-main"
    });
  });

  it("runs the bounded runtime through an injected runner", async () => {
    const report = await runPersonFollowRuntimeSmoke(
      enabledConfig,
      {
        PICO_ENABLE_LIVE_PERSON_FOLLOW: "1"
      },
      {
        runRuntime: (config, options) =>
          Promise.resolve({
            status: "passed",
            provider: "tapo-rtsp+coreml+onvif",
            details: {
              sourceId: config.camera.personFollow.sourceCameraId ?? "missing",
              framesProcessed: options.enableLiveRun === true ? (options.maxFrames ?? 0) : 0,
              personDetectionsTotal: 1,
              framesWithPersonDetections: 1,
              maxPersonDetectionsInFrame: 1,
              movesIssued: 1,
              stopsIssued: 1,
              errors: 0
            }
          })
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+coreml+onvif",
      details: {
        sourceId: "tapo-main",
        framesProcessed: 10,
        personDetectionsTotal: 1,
        framesWithPersonDetections: 1,
        maxPersonDetectionsInFrame: 1,
        movesIssued: 1,
        stopsIssued: 1,
        errors: 0
      }
    });
  });

  it("returns a failing exit code only for failed reports", () => {
    expect(
      personFollowRuntimeSmokeExitCode({
        status: "skipped",
        provider: "tapo-rtsp+coreml+onvif",
        reason: "not enabled"
      })
    ).toBe(0);
    expect(
      personFollowRuntimeSmokeExitCode({
        status: "passed",
        provider: "tapo-rtsp+coreml+onvif",
        details: {
          sourceId: "tapo-main",
          framesProcessed: 1,
          personDetectionsTotal: 0,
          framesWithPersonDetections: 0,
          maxPersonDetectionsInFrame: 0,
          movesIssued: 0,
          stopsIssued: 1,
          errors: 0
        }
      })
    ).toBe(0);
    expect(
      personFollowRuntimeSmokeExitCode({
        status: "failed",
        provider: "tapo-rtsp+coreml+onvif",
        reason: "runtime failed"
      })
    ).toBe(1);
  });
});
