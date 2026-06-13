import { describe, expect, it } from "vitest";

import {
  cameraVlmSceneSmokeExitCode,
  formatCameraVlmSceneSmokeFatalError,
  runCameraVlmSceneSmoke
} from "../scripts/smoke/camera-vlm-scene.js";
import { definePicoConfig, type PicoConfig } from "../src/config/index.js";
import type { SceneDescription } from "../src/modules/vision/index.js";

const jpegFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const scene: SceneDescription = {
  summary: "Two people are visible near a table.",
  observedPeople: ["Two people are present."],
  environment: ["Indoor room with a table."],
  humanAttention: ["Staff may want to check the table area."],
  uncertainty: ["Faces and identities are not determined."],
  source: {
    endpointId: "windows-ollama-qwen3-5",
    model: "qwen3.5:9b",
    purpose: "staff_requested_snapshot"
  }
};

function configuredPicoConfig(): PicoConfig {
  return definePicoConfig({
    camera: {
      tapo: {
        host: "192.168.10.25",
        user: "camera-user",
        password: "camera-passphrase",
        stream: "stream2"
      }
    },
    vision: {
      ollama: {
        localBaseUrl: "http://127.0.0.1:11434",
        timeoutMs: 45_000
      }
    }
  });
}

const passThroughFrame = (frame: Uint8Array): Promise<Uint8Array> => Promise.resolve(frame);

describe("camera to VLM scene smoke", () => {
  it("skips when camera and VLM configuration are absent", async () => {
    await expect(runCameraVlmSceneSmoke(definePicoConfig({}))).resolves.toEqual({
      status: "skipped",
      provider: "tapo-rtsp+ollama",
      reason:
        "Set camera.tapo and vision.ollama in pico config to run the camera to VLM scene smoke."
    });
  });

  it("captures one camera frame and sends it to the selected VLM endpoint", async () => {
    const describedImages: Uint8Array[] = [];
    const observedTimeouts: number[] = [];
    const report = await runCameraVlmSceneSmoke(configuredPicoConfig(), {
      captureFrame: () =>
        Promise.resolve({
          sourceId: "tapo-rtsp",
          mimeType: "image/jpeg",
          frame: jpegFrame
        }),
      prepareFrame: passThroughFrame,
      describeFrame: (request) => {
        describedImages.push(request.image);
        if (request.timeoutMs === undefined) {
          throw new Error("expected camera VLM smoke to pass the configured timeout");
        }
        observedTimeouts.push(request.timeoutMs);

        return Promise.resolve(scene);
      }
    });

    expect(describedImages).toEqual([jpegFrame]);
    expect(observedTimeouts).toEqual([45_000]);
    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+ollama",
      details: {
        sourceId: "tapo-rtsp",
        frameBytes: 4,
        vlmFrameBytes: 4,
        mimeType: "image/jpeg",
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        timeoutMs: 45_000,
        scene
      }
    });
    expect(JSON.stringify(report)).not.toContain(Buffer.from(jpegFrame).toString("base64"));
  });

  it("bounds captured frames before sending them to the VLM endpoint", async () => {
    const capturedFrame = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const preparedFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const describedImages: Uint8Array[] = [];

    const report = await runCameraVlmSceneSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase",
            stream: "stream2"
          }
        },
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            maxImageEdgePixels: 512
          }
        }
      }),
      {
        captureFrame: () =>
          Promise.resolve({
            sourceId: "tapo-rtsp",
            mimeType: "image/jpeg",
            frame: capturedFrame
          }),
        prepareFrame: (frame, maxImageEdgePixels) => {
          expect(frame).toBe(capturedFrame);
          expect(maxImageEdgePixels).toBe(512);

          return Promise.resolve(preparedFrame);
        },
        describeFrame: (request) => {
          describedImages.push(request.image);

          return Promise.resolve(scene);
        }
      }
    );

    expect(describedImages).toEqual([preparedFrame]);
    expect(report).toMatchObject({
      status: "passed",
      provider: "tapo-rtsp+ollama",
      details: {
        frameBytes: 5,
        vlmFrameBytes: 4
      }
    });
  });

  it("fails clearly when camera capture fails", async () => {
    const report = await runCameraVlmSceneSmoke(configuredPicoConfig(), {
      captureFrame: () => Promise.reject(new Error("camera capture failed")),
      prepareFrame: passThroughFrame,
      describeFrame: () => Promise.resolve(scene)
    });

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+ollama",
      reason: "pico camera to VLM scene smoke capture failed: camera capture failed"
    });
    expect(cameraVlmSceneSmokeExitCode(report)).toBe(1);
  });

  it("redacts RTSP URLs and camera credentials from capture failure reports", async () => {
    const report = await runCameraVlmSceneSmoke(configuredPicoConfig(), {
      captureFrame: () =>
        Promise.reject(
          new Error(
            "rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream2 camera-passphrase"
          )
        ),
      prepareFrame: passThroughFrame,
      describeFrame: () => Promise.resolve(scene)
    });
    const reportText = JSON.stringify(report);

    expect(report.status).toBe("failed");
    expect(reportText).not.toContain("rtsp://");
    expect(reportText).not.toContain("camera-user");
    expect(reportText).not.toContain("camera-passphrase");
  });

  it("fails clearly when VLM scene description fails", async () => {
    const report = await runCameraVlmSceneSmoke(configuredPicoConfig(), {
      captureFrame: () =>
        Promise.resolve({
          sourceId: "tapo-rtsp",
          mimeType: "image/jpeg",
          frame: jpegFrame
        }),
      prepareFrame: passThroughFrame,
      describeFrame: () => Promise.reject(new Error("VLM request failed"))
    });

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+ollama",
      reason: "pico camera to VLM scene smoke description failed: VLM request failed"
    });
    expect(cameraVlmSceneSmokeExitCode(report)).toBe(1);
  });

  it("redacts RTSP URLs and camera credentials from direct execution fatal errors", () => {
    const message = formatCameraVlmSceneSmokeFatalError(
      new Error("rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream2 camera-passphrase"),
      configuredPicoConfig()
    );

    expect(message).not.toContain("rtsp://");
    expect(message).not.toContain("camera-user");
    expect(message).not.toContain("camera-passphrase");
  });
});
