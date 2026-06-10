import { describe, expect, it } from "vitest";

import {
  cameraVlmSceneSmokeExitCode,
  formatCameraVlmSceneSmokeFatalError,
  runCameraVlmSceneSmoke
} from "../scripts/smoke/camera-vlm-scene.js";
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

describe("camera to VLM scene smoke", () => {
  it("skips when camera and VLM configuration are absent", async () => {
    await expect(runCameraVlmSceneSmoke({})).resolves.toEqual({
      status: "skipped",
      provider: "tapo-rtsp+ollama",
      reason:
        "Set PICO_TAPO_HOST and PICO_VISION_LOCAL_BASE_URL to run the camera to VLM scene smoke."
    });
  });

  it("captures one camera frame and sends it to the selected VLM endpoint", async () => {
    const describedImages: Uint8Array[] = [];
    const report = await runCameraVlmSceneSmoke(
      {
        PICO_TAPO_HOST: "192.168.10.25",
        PICO_TAPO_USER: "camera-user",
        PICO_TAPO_PASSWORD: "camera-passphrase",
        PICO_TAPO_STREAM: "stream2",
        PICO_VISION_LOCAL_BASE_URL: "http://127.0.0.1:11434"
      },
      {
        captureFrame: () =>
          Promise.resolve({
            sourceId: "tapo-rtsp",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        describeFrame: (request) => {
          describedImages.push(request.image);

          return Promise.resolve(scene);
        }
      }
    );

    expect(describedImages).toEqual([jpegFrame]);
    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+ollama",
      details: {
        sourceId: "tapo-rtsp",
        frameBytes: 4,
        mimeType: "image/jpeg",
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        scene
      }
    });
    expect(JSON.stringify(report)).not.toContain(Buffer.from(jpegFrame).toString("base64"));
  });

  it("fails clearly when camera capture fails", async () => {
    const report = await runCameraVlmSceneSmoke(
      {
        PICO_TAPO_HOST: "192.168.10.25",
        PICO_TAPO_USER: "camera-user",
        PICO_TAPO_PASSWORD: "camera-passphrase",
        PICO_VISION_LOCAL_BASE_URL: "http://127.0.0.1:11434"
      },
      {
        captureFrame: () => Promise.reject(new Error("camera capture failed")),
        describeFrame: () => Promise.resolve(scene)
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+ollama",
      reason: "pico camera to VLM scene smoke capture failed: camera capture failed"
    });
    expect(cameraVlmSceneSmokeExitCode(report)).toBe(1);
  });

  it("redacts RTSP URLs and camera credentials from capture failure reports", async () => {
    const report = await runCameraVlmSceneSmoke(
      {
        PICO_TAPO_HOST: "192.168.10.25",
        PICO_TAPO_USER: "camera-user",
        PICO_TAPO_PASSWORD: "camera-passphrase",
        PICO_VISION_LOCAL_BASE_URL: "http://127.0.0.1:11434"
      },
      {
        captureFrame: () =>
          Promise.reject(
            new Error(
              "rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream2 camera-passphrase"
            )
          ),
        describeFrame: () => Promise.resolve(scene)
      }
    );
    const reportText = JSON.stringify(report);

    expect(report.status).toBe("failed");
    expect(reportText).not.toContain("rtsp://");
    expect(reportText).not.toContain("camera-user");
    expect(reportText).not.toContain("camera-passphrase");
  });

  it("fails clearly when VLM scene description fails", async () => {
    const report = await runCameraVlmSceneSmoke(
      {
        PICO_TAPO_HOST: "192.168.10.25",
        PICO_TAPO_USER: "camera-user",
        PICO_TAPO_PASSWORD: "camera-passphrase",
        PICO_VISION_LOCAL_BASE_URL: "http://127.0.0.1:11434"
      },
      {
        captureFrame: () =>
          Promise.resolve({
            sourceId: "tapo-rtsp",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        describeFrame: () => Promise.reject(new Error("VLM request failed"))
      }
    );

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
      {
        PICO_TAPO_USER: "camera-user",
        PICO_TAPO_PASSWORD: "camera-passphrase"
      }
    );

    expect(message).not.toContain("rtsp://");
    expect(message).not.toContain("camera-user");
    expect(message).not.toContain("camera-passphrase");
  });
});
