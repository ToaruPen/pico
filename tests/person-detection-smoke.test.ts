import { describe, expect, it } from "vitest";

import {
  buildPersonDetectionSmokePlan,
  runPersonDetectionSmoke
} from "../scripts/smoke/person-detection.js";
import { definePicoConfig } from "../src/config/index.js";
import type { PersonDetectionModel } from "../src/modules/vision/person-detection.js";

const configured = definePicoConfig({
  camera: {
    tapo: {
      sourceId: "tapo-main",
      host: "192.168.3.212",
      user: "camera-user",
      password: "camera-password"
    }
  },
  vision: {
    personDetection: {
      enabled: true,
      sourceCameraId: "tapo-main",
      modelFamily: "pinto0309",
      provider: "onnxruntime",
      modelPath: "/opt/pico/models/pinto0309/person.onnx",
      inputWidth: 320,
      inputHeight: 320,
      outputLayout: "xyxy_score_class",
      coordinateScale: "pixel",
      frameIntervalMs: 500,
      confidenceThreshold: 0.55
    }
  }
});

const configuredCoreml = definePicoConfig({
  camera: {
    tapo: {
      sourceId: "tapo-main",
      host: "192.168.3.212",
      user: "camera-user",
      password: "camera-password"
    }
  },
  vision: {
    personDetection: {
      enabled: true,
      sourceCameraId: "tapo-main",
      modelFamily: "pinto0309",
      provider: "coreml",
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      inputWidth: 320,
      inputHeight: 320,
      outputLayout: "yolox_coco_raw",
      coordinateScale: "pixel",
      frameIntervalMs: 500,
      confidenceThreshold: 0.55,
      coremlFlags: 18,
      nmsIouThreshold: 0.45
    }
  }
});

describe("person detection smoke", () => {
  it("skips when person detection is disabled", () => {
    expect(buildPersonDetectionSmokePlan(definePicoConfig({}))).toEqual({
      status: "skip",
      reason: "Set vision.personDetection.enabled=true to run the person detection smoke."
    });
  });

  it("skips when the configured ONNX model file is absent", () => {
    expect(
      buildPersonDetectionSmokePlan(configured, {
        pathExists: () => false
      })
    ).toEqual({
      status: "skip",
      reason:
        "pico person detection smoke model file not found: /opt/pico/models/pinto0309/person.onnx"
    });
  });

  it("runs Tapo snapshot through the configured detector once", async () => {
    const model: PersonDetectionModel = {
      detect: () =>
        Promise.resolve([
          {
            label: "person",
            confidence: 0.92,
            box: {
              x: 64,
              y: 48,
              width: 128,
              height: 192
            }
          }
        ])
    };

    await expect(
      runPersonDetectionSmoke(configured, {
        pathExists: () => true,
        captureFrame: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: Buffer.from("jpeg-frame")
          }),
        createModel: () => Promise.resolve(model),
        now: () => "2026-06-12T09:00:00.000Z"
      })
    ).resolves.toEqual({
      status: "passed",
      provider: "tapo-rtsp+onnxruntime",
      details: {
        sourceId: "tapo-main",
        frameBytes: 10,
        detectedPeople: 1,
        capturedAt: "2026-06-12T09:00:00.000Z"
      }
    });
  });

  it("runs Tapo snapshot through the configured CoreML detector once", async () => {
    const model: PersonDetectionModel = {
      detect: () =>
        Promise.resolve([
          {
            label: "person",
            confidence: 0.92,
            box: {
              x: 64,
              y: 48,
              width: 128,
              height: 192
            }
          }
        ])
    };

    await expect(
      runPersonDetectionSmoke(configuredCoreml, {
        pathExists: () => true,
        captureFrame: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: Buffer.from("jpeg-frame")
          }),
        createModel: () => Promise.resolve(model),
        now: () => "2026-06-12T09:00:00.000Z"
      })
    ).resolves.toMatchObject({
      status: "passed",
      provider: "tapo-rtsp+coreml",
      details: {
        sourceId: "tapo-main",
        frameBytes: 10,
        detectedPeople: 1,
        capturedAt: "2026-06-12T09:00:00.000Z"
      }
    });
  });
});
