import { describe, expect, it } from "vitest";

import {
  cameraVlmSceneSmokeExitCode,
  formatCameraVlmSceneSmokeFatalError,
  runCameraVlmSceneSmoke
} from "../scripts/smoke/camera-vlm-scene.js";
import { definePicoConfig, type PicoConfig } from "../src/config/index.js";
import type { SceneDescription } from "../src/modules/vision/index.js";
import { buildCredentialedUrl } from "./support/url-fixtures.js";

const jpegFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const configuredRtspUrl = buildCredentialedUrl("rtsp://192.168.10.25:554/stream2", {
  username: "camera-user",
  password: "camera-passphrase"
});
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
        streams: {
          scene: "stream1"
        }
      }
    },
    vision: {
      sceneDescription: {
        provider: "ollama",
        source: "tapo",
        timeoutMs: 45_000,
        maxImageEdgePixels: 512
      },
      ollama: {
        localBaseUrl: "http://127.0.0.1:11434",
        timeoutMs: 45_000
      }
    }
  });
}

const passThroughFrame = (frame: Uint8Array): Promise<Uint8Array> => Promise.resolve(frame);

describe("camera to VLM scene smoke", () => {
  it("fails closed before dependencies when legacy camera and Ollama settings omit the route", async () => {
    let captureCalls = 0;
    let preparationCalls = 0;
    let descriptionCalls = 0;
    let agentCaptureCalls = 0;
    let stackChanCaptureCalls = 0;
    const config = definePicoConfig({
      camera: {
        tapo: {
          host: "192.168.10.25",
          user: "camera-user",
          password: "camera-passphrase"
        }
      },
      vision: {
        ollama: {
          localBaseUrl: "http://127.0.0.1:11434"
        }
      }
    });

    const report = await runCameraVlmSceneSmoke(config, {
      captureFrame: () => {
        captureCalls += 1;
        return Promise.reject(new Error("must not capture Tapo"));
      },
      prepareFrame: () => {
        preparationCalls += 1;
        return Promise.reject(new Error("must not prepare"));
      },
      describeFrame: () => {
        descriptionCalls += 1;
        return Promise.reject(new Error("must not describe"));
      },
      captureAgentSceneFrame: () => {
        agentCaptureCalls += 1;
        return Promise.reject(new Error("must not capture for agent"));
      },
      captureStackChanFrame: () => {
        stackChanCaptureCalls += 1;
        return Promise.reject(new Error("must not capture StackChan"));
      }
    });

    expect(report).toEqual({
      status: "failed",
      reason: "pico camera scene description route is not configured"
    });
    expect({
      captureCalls,
      preparationCalls,
      descriptionCalls,
      agentCaptureCalls,
      stackChanCaptureCalls
    }).toEqual({
      captureCalls: 0,
      preparationCalls: 0,
      descriptionCalls: 0,
      agentCaptureCalls: 0,
      stackChanCaptureCalls: 0
    });
  });

  it("prepares an agent-routed StackChan frame without invoking Ollama", async () => {
    const report = await runCameraVlmSceneSmoke(
      definePicoConfig({
        camera: {
          stackchan: {
            sourceId: "stackchan-core-s3",
            mcpUrl: "http://127.0.0.1:18767/mcp",
            bearerTokenEnv: "STACKCHAN_TOKEN"
          }
        },
        vision: {
          sceneDescription: {
            provider: "agent",
            source: "stackchan",
            timeoutMs: 30_000,
            maxImageEdgePixels: 512
          }
        }
      }),
      {
        captureAgentSceneFrame: () =>
          Promise.resolve({
            status: "passed",
            provider: "agent",
            sourceId: "stackchan-core-s3",
            streamPurpose: "scene",
            frameBytes: 20,
            vlmFrameBytes: 10,
            mimeType: "image/jpeg",
            capturedAt: "2026-07-26T10:00:00.000Z",
            image: jpegFrame
          })
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "agent",
      source: "stackchan",
      details: {
        sourceId: "stackchan-core-s3",
        frameBytes: 20,
        vlmFrameBytes: 10,
        mimeType: "image/jpeg",
        timeoutMs: 30_000,
        preparedForActiveAgent: true
      }
    });
    expect(JSON.stringify(report)).not.toContain(Buffer.from(jpegFrame).toString("base64"));
  });

  it("prepares an agent-routed Tapo frame without invoking Ollama", async () => {
    const report = await runCameraVlmSceneSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase"
          }
        },
        vision: {
          sceneDescription: {
            provider: "agent",
            source: "tapo",
            timeoutMs: 30_000,
            maxImageEdgePixels: 512
          }
        }
      }),
      {
        captureAgentSceneFrame: () =>
          Promise.resolve({
            status: "passed",
            provider: "agent",
            sourceId: "tapo-rtsp",
            streamPurpose: "scene",
            frameBytes: 20,
            vlmFrameBytes: 10,
            mimeType: "image/jpeg",
            capturedAt: "2026-07-26T10:00:00.000Z",
            image: jpegFrame
          }),
        describeFrame: () => Promise.reject(new Error("must not invoke Ollama"))
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "agent",
      source: "tapo",
      details: {
        sourceId: "tapo-rtsp",
        frameBytes: 20,
        vlmFrameBytes: 10,
        mimeType: "image/jpeg",
        timeoutMs: 30_000,
        preparedForActiveAgent: true
      }
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

  it("captures StackChan for an Ollama route without requiring Tapo", async () => {
    let stackChanCaptureCalls = 0;
    const describedImages: Uint8Array[] = [];
    const report = await runCameraVlmSceneSmoke(
      definePicoConfig({
        camera: {
          stackchan: {
            sourceId: "stackchan-core-s3",
            mcpUrl: "http://127.0.0.1:18767/mcp",
            bearerTokenEnv: "STACKCHAN_TOKEN"
          }
        },
        vision: {
          sceneDescription: {
            provider: "ollama",
            source: "stackchan",
            timeoutMs: 45_000,
            maxImageEdgePixels: 512
          },
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureStackChanFrame: () => {
          stackChanCaptureCalls += 1;
          return Promise.resolve({
            bytes: jpegFrame,
            mimeType: "image/jpeg"
          });
        },
        prepareFrame: passThroughFrame,
        describeFrame: (request) => {
          describedImages.push(request.image);
          return Promise.resolve(scene);
        }
      }
    );

    expect(stackChanCaptureCalls).toBe(1);
    expect(describedImages).toEqual([jpegFrame]);
    expect(report).toEqual({
      status: "passed",
      provider: "stackchan+ollama",
      source: "stackchan",
      details: {
        sourceId: "stackchan-core-s3",
        frameBytes: 4,
        vlmFrameBytes: 4,
        mimeType: "image/jpeg",
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        timeoutMs: 45_000,
        scene
      }
    });
  });

  it("honors StackChan as the Ollama source when Tapo is also configured", async () => {
    let tapoCaptureCalls = 0;
    let stackChanCaptureCalls = 0;
    const report = await runCameraVlmSceneSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase"
          },
          stackchan: {
            sourceId: "stackchan-core-s3",
            mcpUrl: "http://127.0.0.1:18767/mcp",
            bearerTokenEnv: "STACKCHAN_TOKEN"
          }
        },
        vision: {
          sceneDescription: {
            provider: "ollama",
            source: "stackchan",
            timeoutMs: 45_000,
            maxImageEdgePixels: 512
          },
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      {
        captureFrame: () => {
          tapoCaptureCalls += 1;
          return Promise.reject(new Error("must not capture Tapo"));
        },
        captureStackChanFrame: () => {
          stackChanCaptureCalls += 1;
          return Promise.resolve({
            bytes: jpegFrame,
            mimeType: "image/jpeg"
          });
        },
        prepareFrame: passThroughFrame,
        describeFrame: () => Promise.resolve(scene)
      }
    );

    expect(report.status).toBe("passed");
    expect({ tapoCaptureCalls, stackChanCaptureCalls }).toEqual({
      tapoCaptureCalls: 0,
      stackChanCaptureCalls: 1
    });
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
            streams: {
              scene: "stream1"
            }
          }
        },
        vision: {
          sceneDescription: {
            provider: "ollama",
            source: "tapo",
            maxImageEdgePixels: 512
          },
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

  it("fails clearly when VLM frame preparation fails", async () => {
    const report = await runCameraVlmSceneSmoke(configuredPicoConfig(), {
      captureFrame: () =>
        Promise.resolve({
          sourceId: "tapo-rtsp",
          mimeType: "image/jpeg",
          frame: jpegFrame
        }),
      prepareFrame: () => Promise.reject(new Error("prepareFrame failed")),
      describeFrame: () => Promise.resolve(scene)
    });

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+ollama",
      reason: "pico camera to VLM scene smoke frame preparation failed: prepareFrame failed"
    });
    expect(cameraVlmSceneSmokeExitCode(report)).toBe(1);
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
      captureFrame: () => Promise.reject(new Error(`${configuredRtspUrl} camera-passphrase`)),
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
      new Error(`${configuredRtspUrl} camera-passphrase`),
      configuredPicoConfig()
    );

    expect(message).not.toContain("rtsp://");
    expect(message).not.toContain("camera-user");
    expect(message).not.toContain("camera-passphrase");
  });
});
