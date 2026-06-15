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

  it("detects people from the high-frame-rate detection stream with bounded output", async () => {
    const observedUrls: string[] = [];
    const modelPath = "/opt/pico/models/pinto0309/yolox.onnx";
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
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
            modelPath,
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
      }),
      {
        pathExists: () => true,
        now: () => "2026-06-15T09:01:00.000Z",
        captureSnapshot: (source) => {
          observedUrls.push(source.url);

          return Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          });
        },
        createPersonDetectionModel: () =>
          Promise.resolve({
            detect: () =>
              Promise.resolve([
                {
                  label: "person",
                  confidence: 0.91,
                  box: {
                    x: 32,
                    y: 64,
                    width: 96,
                    height: 128
                  }
                }
              ])
          })
      }
    );

    const result = await service.detectPeople();
    const text = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "passed",
      sourceId: "tapo-main",
      streamPurpose: "detection",
      frameBytes: 4,
      capturedAt: "2026-06-15T09:01:00.000Z",
      detectedPeople: 1,
      detections: [
        {
          label: "person",
          confidence: 0.91,
          boundingBox: {
            xMin: 0.1,
            yMin: 0.2,
            xMax: 0.4,
            yMax: 0.6
          }
        }
      ]
    });
    expect(observedUrls).toEqual(["rtsp://camera-user:camera-password@192.168.10.25:554/stream2"]);
    expect(text).not.toContain("base64");
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
    expect(text).not.toContain(modelPath);
  });

  it("uses the configured person detection source camera id in detection results", async () => {
    const observedSourceIds: string[] = [];
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-physical",
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password"
          }
        },
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-detection",
            modelFamily: "pinto0309",
            provider: "coreml",
            modelPath: "/opt/pico/models/pinto0309/yolox.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "yolox_coco_raw",
            coordinateScale: "pixel",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      }),
      {
        pathExists: () => true,
        captureSnapshot: (source) => {
          observedSourceIds.push(source.id);

          return Promise.resolve({
            ok: true,
            sourceId: source.id,
            mimeType: "image/jpeg",
            frame: jpegFrame
          });
        },
        createPersonDetectionModel: () =>
          Promise.resolve({
            detect: () => Promise.resolve([])
          })
      }
    );

    await expect(service.detectPeople()).resolves.toMatchObject({
      status: "passed",
      sourceId: "tapo-detection"
    });
    expect(observedSourceIds).toEqual(["tapo-detection"]);
  });

  it("returns person-detection-specific setup failures", async () => {
    const missingCameraService = createPicoPerceptionService(
      definePicoConfig({
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
            coordinateScale: "pixel",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    );

    await expect(missingCameraService.detectPeople()).resolves.toEqual({
      status: "failed",
      reason: "camera.tapo is required to use pico_person_detection"
    });

    const unsupportedProviderService = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-password"
          }
        },
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "tflite",
            modelPath: "/opt/pico/models/pinto0309/person.tflite",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "xyxy_score_class",
            coordinateScale: "pixel",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    );

    await expect(unsupportedProviderService.detectPeople()).resolves.toEqual({
      status: "failed",
      reason:
        "vision.personDetection.provider must be onnxruntime or coreml to use pico_person_detection"
    });
  });

  it("redacts RTSP credentials and model paths from person detection capture failures", async () => {
    const modelPath = "/opt/pico/models/pinto0309/person.onnx";
    const service = createPicoPerceptionService(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
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
            modelPath,
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "xyxy_score_class",
            coordinateScale: "pixel",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      }),
      {
        pathExists: () => true,
        captureSnapshot: (source) =>
          Promise.resolve({
            ok: false,
            sourceId: "tapo-main",
            reason: "capture_failed",
            message: `${source.url} camera-user camera-password ${modelPath} Unauthorized`
          })
      }
    );

    const result = await service.detectPeople();
    const text = JSON.stringify(result);

    expect(result.status).toBe("failed");
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
    expect(text).not.toContain(modelPath);
  });

  it("returns explicit failed results for non-Task-2 perception operations", async () => {
    const service = createPicoPerceptionService(definePicoConfig({}));

    await expect(service.describeCameraScene()).resolves.toEqual({
      status: "failed",
      reason: "pico camera scene description is not implemented yet"
    });
  });
});
