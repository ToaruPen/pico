import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import { createPicoPerceptionService } from "../src/runtime/perception-service.js";

const jpegFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("pico perception service", () => {
  it("captures scene snapshots from the high-quality stream without returning image bytes", async () => {
    const observedUrls: string[] = [];
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password"
          }
        }
      }),
      {
        now: () => "2026-06-15T09:00:00.000Z",
        captureSnapshot: (source) => {
          observedUrls.push(source.url);

          return Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          });
        }
      }
    );

    await expect(service.captureSceneSnapshot()).resolves.toEqual({
      status: "passed",
      sourceId: "tapo-main",
      streamPurpose: "scene",
      mimeType: "image/jpeg",
      frameBytes: 4,
      capturedAt: "2026-06-15T09:00:00.000Z"
    });
    expect(observedUrls).toEqual(["rtsp://camera-user:camera-password@192.168.10.25:554/stream1"]);
    expect(JSON.stringify(await service.captureSceneSnapshot())).not.toContain("base64");
  });

  it("honors an explicit scene stream for scene snapshots", async () => {
    const observedUrls: string[] = [];
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password",
            streams: {
              scene: "stream7"
            }
          }
        }
      }),
      {
        captureSnapshot: (source) => {
          observedUrls.push(source.url);

          return Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          });
        }
      }
    );

    await service.captureSceneSnapshot();

    expect(observedUrls).toEqual(["rtsp://camera-user:camera-password@192.168.10.25:554/stream7"]);
  });

  it("redacts RTSP URLs and credentials from scene snapshot capture failures", async () => {
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password"
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: false,
            sourceId: "tapo-main",
            reason: "capture_failed",
            message:
              "rtsp://camera-user:camera-password@192.168.10.25:554/stream1 rejected camera-user camera-password"
          })
      }
    );

    const result = await service.captureSceneSnapshot();

    expect(result).toEqual({
      status: "failed",
      reason:
        "pico camera snapshot failed: capture_failed: [redacted-rtsp-url] rejected [redacted] [redacted]"
    });
    expect(JSON.stringify(result)).not.toContain("rtsp://");
    expect(JSON.stringify(result)).not.toContain("camera-user");
    expect(JSON.stringify(result)).not.toContain("camera-password");
  });

  it("preserves the camera in-flight guard across concurrent scene snapshot requests", async () => {
    let captureCalls = 0;
    const releaseCaptures: (() => void)[] = [];
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password"
          }
        }
      }),
      {
        captureSnapshot: () => {
          captureCalls += 1;

          return new Promise((resolve) => {
            releaseCaptures.push(() => {
              resolve({
                ok: true,
                sourceId: "tapo-main",
                mimeType: "image/jpeg",
                frame: jpegFrame
              });
            });
          });
        }
      }
    );

    const first = service.captureSceneSnapshot();
    const second = service.captureSceneSnapshot();
    for (const releaseCapture of releaseCaptures) {
      releaseCapture();
    }

    await expect(first).resolves.toMatchObject({
      status: "passed",
      sourceId: "tapo-main"
    });
    await expect(second).resolves.toEqual({
      status: "failed",
      reason:
        "pico camera snapshot failed: in_flight: previous RTSP snapshot capture is still in flight"
    });
    expect(captureCalls).toBe(1);
  });

  it("returns explicit failed results for non-Task-1 perception operations", async () => {
    const service = createPicoPerceptionService(definePicoConfig({}));

    await expect(service.detectPeople()).resolves.toEqual({
      status: "failed",
      reason: "pico person detection is not implemented in Task 1"
    });
    await expect(service.describeCameraScene()).resolves.toEqual({
      status: "failed",
      reason: "pico camera scene description is not implemented in Task 1"
    });
  });
});
