import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import { createPicoPerceptionService } from "../src/runtime/perception-service.js";

const jpegFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const cameraUser = "camera-user";
const cameraPassword = "camera-password";
const expectedTapoRtspUrl = (stream: string): string =>
  `rtsp://${cameraUser}:${cameraPassword}@192.168.10.25:554/${stream}`;

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
    expect(observedUrls).toEqual([expectedTapoRtspUrl("stream1")]);
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

    expect(observedUrls).toEqual([expectedTapoRtspUrl("stream7")]);
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
            message: `${expectedTapoRtspUrl("stream1")} rejected camera-user camera-password`
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
    expect(observedUrls).toEqual([expectedTapoRtspUrl("stream2")]);
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

  it("describes camera scenes from the scene stream through the configured VLM", async () => {
    const observedUrls: string[] = [];
    const preparedInputs: { frame: Uint8Array; maxImageEdgePixels: number }[] = [];
    const describedRequests: {
      endpointId: string;
      model: string;
      localBaseUrl: string;
      tunnelKind: string;
      sshTarget: string;
      image: Uint8Array;
      timeoutMs: number | undefined;
      purpose: string;
    }[] = [];
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            maxImageEdgePixels: 512,
            timeoutMs: 120_000
          }
        }
      }),
      {
        now: () => "2026-06-15T09:02:00.000Z",
        captureSnapshot: (source) => {
          observedUrls.push(source.url);

          return Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          });
        },
        prepareFrameForVlm: (frame, maxImageEdgePixels) => {
          preparedInputs.push({ frame, maxImageEdgePixels });

          return Promise.resolve(new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]));
        },
        describeFrame: (request) => {
          describedRequests.push({
            endpointId: request.endpoint.id,
            model: request.endpoint.model,
            localBaseUrl: request.endpoint.host.tunnel.localBaseUrl,
            tunnelKind: request.endpoint.host.tunnel.kind,
            sshTarget: request.endpoint.host.tunnel.sshTarget,
            image: request.image,
            timeoutMs: request.timeoutMs,
            purpose: request.purpose
          });

          return Promise.resolve({
            summary: "A desk is visible.",
            observedPeople: [],
            environment: ["desk"],
            humanAttention: [],
            uncertainty: ["single snapshot"],
            source: {
              endpointId: request.endpoint.id,
              model: request.endpoint.model,
              purpose: request.purpose
            }
          });
        }
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toEqual({
      status: "passed",
      sourceId: "tapo-main",
      streamPurpose: "scene",
      frameBytes: 4,
      vlmFrameBytes: 5,
      mimeType: "image/jpeg",
      capturedAt: "2026-06-15T09:02:00.000Z",
      scene: {
        summary: "A desk is visible.",
        observedPeople: [],
        environment: ["desk"],
        humanAttention: [],
        uncertainty: ["single snapshot"],
        source: {
          endpointId: "windows-ollama-qwen3-5",
          model: "qwen3.5:9b",
          purpose: "staff_requested_snapshot"
        }
      }
    });
    expect(observedUrls).toEqual([expectedTapoRtspUrl("stream1")]);
    expect(preparedInputs).toEqual([{ frame: jpegFrame, maxImageEdgePixels: 512 }]);
    expect(describedRequests).toEqual([
      {
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        localBaseUrl: "http://127.0.0.1:11434",
        tunnelKind: "tailscale_ssh",
        sshTarget: "pico-vision-host",
        image: new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]),
        timeoutMs: 120_000,
        purpose: "staff_requested_snapshot"
      }
    ]);
    expect(text).not.toContain("base64");
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
  });

  it("honors an explicit scene stream for camera scene descriptions", async () => {
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
        },
        vision: {
          ollama: {
            endpointId: "windows-qwen",
            localBaseUrl: "http://127.0.0.1:11434",
            tunnel: {
              kind: "cloudflare_access_ssh",
              sshTarget: "cloudflared-pico-vision"
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
        },
        prepareFrameForVlm: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
        describeFrame: (request) =>
          Promise.resolve({
            summary: "A room is visible.",
            observedPeople: [],
            environment: [],
            humanAttention: [],
            uncertainty: [],
            source: {
              endpointId: request.endpoint.id,
              model: request.endpoint.model,
              purpose: request.purpose
            }
          })
      }
    );

    await service.describeCameraScene();

    expect(observedUrls).toEqual([expectedTapoRtspUrl("stream7")]);
  });

  it("redacts RTSP credentials from camera scene capture failures", async () => {
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureSnapshot: (source) =>
          Promise.reject(new Error(`${source.url} camera-user camera-password Unauthorized`))
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toEqual({
      status: "failed",
      reason:
        "pico camera scene description failed: capture_failed: [redacted-rtsp-url] [redacted] [redacted] Unauthorized"
    });
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
  });

  it("redacts local auth secrets from camera scene description failures", async () => {
    const apiKey = "local-ollama-secret";
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            auth: {
              headerName: "x-pico-auth",
              apiKey
            }
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        prepareFrameForVlm: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
        describeFrame: () => Promise.reject(new Error(`Ollama rejected token ${apiKey}`))
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toEqual({
      status: "failed",
      reason: "pico camera scene description failed: Ollama rejected token [redacted]"
    });
    expect(text).not.toContain(apiKey);
  });

  it("redacts image payloads from camera scene description failures", async () => {
    const preparedFrame = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const preparedFrameBase64 = Buffer.from(preparedFrame).toString("base64");
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        prepareFrameForVlm: () => Promise.resolve(preparedFrame),
        describeFrame: () =>
          Promise.reject(new Error(`proxy echoed images: ["${preparedFrameBase64}"]`))
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toEqual({
      status: "failed",
      reason: 'pico camera scene description failed: proxy echoed images: ["[redacted-image]"]'
    });
    expect(text).not.toContain(preparedFrameBase64);
    expect(text).not.toContain("data:image");
  });

  it("redacts truncated image payloads from camera scene description failures", async () => {
    const preparedFrame = Uint8Array.from({ length: 180 }, (_, index) => index % 251);
    const preparedFrameBase64Prefix = Buffer.from(preparedFrame).toString("base64").slice(0, 120);
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        prepareFrameForVlm: () => Promise.resolve(preparedFrame),
        describeFrame: () =>
          Promise.reject(
            new Error(`proxy echoed truncated image: ["${preparedFrameBase64Prefix}..."]`)
          )
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toEqual({
      status: "failed",
      reason:
        'pico camera scene description failed: proxy echoed truncated image: ["[redacted-image]..."]'
    });
    expect(text).not.toContain(preparedFrameBase64Prefix);
  });

  it("redacts image payloads from successful camera scene descriptions", async () => {
    const preparedFrame = Uint8Array.from({ length: 180 }, (_, index) => index % 251);
    const preparedFrameBase64 = Buffer.from(preparedFrame).toString("base64");
    const preparedFrameBase64Prefix = preparedFrameBase64.slice(0, 120);
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        prepareFrameForVlm: () => Promise.resolve(preparedFrame),
        describeFrame: () =>
          Promise.resolve({
            summary: `proxy echoed data:image/jpeg;base64,${preparedFrameBase64}`,
            observedPeople: [`echoed full ${preparedFrameBase64}`],
            environment: [`echoed prefix ${preparedFrameBase64Prefix}...`],
            humanAttention: ["desk"],
            uncertainty: [`${expectedTapoRtspUrl("stream1")} echoed`],
            source: {
              endpointId: "windows-ollama-qwen3-5",
              model: "qwen3.5:9b",
              purpose: "staff_requested_snapshot"
            }
          })
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "passed",
      scene: {
        summary: "proxy echoed [redacted-image]",
        observedPeople: ["echoed full [redacted-image]"],
        environment: ["echoed prefix [redacted-image]..."],
        humanAttention: ["desk"],
        uncertainty: ["[redacted-rtsp-url] echoed"]
      }
    });
    expect(text).not.toContain(preparedFrameBase64);
    expect(text).not.toContain(preparedFrameBase64Prefix);
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("rtsp://");
  });

  it("preserves the camera scene description in-flight guard through VLM work", async () => {
    let describeCalls = 0;
    let releaseDescription: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const descriptionStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
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
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: true,
            sourceId: "tapo-main",
            mimeType: "image/jpeg",
            frame: jpegFrame
          }),
        prepareFrameForVlm: () => Promise.resolve(jpegFrame),
        describeFrame: () => {
          describeCalls += 1;
          if (describeCalls > 1) {
            return Promise.resolve({
              summary: "A duplicate VLM request ran.",
              observedPeople: [],
              environment: [],
              humanAttention: [],
              uncertainty: ["duplicate"],
              source: {
                endpointId: "windows-ollama-qwen3-5",
                model: "qwen3.5:9b",
                purpose: "staff_requested_snapshot"
              }
            });
          }

          resolveStarted?.();

          return new Promise((resolveDescription) => {
            releaseDescription = () => {
              resolveDescription({
                summary: "A desk is visible.",
                observedPeople: [],
                environment: ["desk"],
                humanAttention: [],
                uncertainty: ["single snapshot"],
                source: {
                  endpointId: "windows-ollama-qwen3-5",
                  model: "qwen3.5:9b",
                  purpose: "staff_requested_snapshot"
                }
              });
            };
          });
        }
      }
    );

    const first = service.describeCameraScene();

    await descriptionStarted;
    await expect(service.describeCameraScene()).resolves.toEqual({
      status: "failed",
      reason:
        "pico camera scene description failed: in_flight: previous camera scene description is still in flight"
    });
    expect(describeCalls).toBe(1);
    releaseDescription?.();
    await expect(first).resolves.toMatchObject({
      status: "passed",
      sourceId: "tapo-main"
    });
  });

  it("returns setup failures for camera scene descriptions without VLM config", async () => {
    const service = createPicoPerceptionService(definePicoConfig({}));

    await expect(service.describeCameraScene()).resolves.toEqual({
      status: "failed",
      reason: "vision.ollama is required to use pico_camera_scene_description"
    });
  });

  it("returns camera-scene-specific setup failures without Tapo config", async () => {
    const service = createPicoPerceptionService(
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      })
    );

    await expect(service.describeCameraScene()).resolves.toEqual({
      status: "failed",
      reason: "camera.tapo is required to use pico_camera_scene_description"
    });
  });
});
