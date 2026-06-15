# Pi Agent Perception Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add actual Pi Agent extension tools for bounded Tapo snapshot, person detection, and camera-to-VLM scene description runtime field tests.

**Architecture:** Add a small production `src/runtime/perception-service.ts` layer over existing camera and vision modules, then expose three `ToolDefinition`s from `src/runtime/perception-tool.ts`. Register those tools in `src/index.ts` beside `pico_session`; keep `scripts/smoke/*` as CLI gates rather than runtime dependencies.

**Tech Stack:** TypeScript, Typebox, Pi Agent extension `ToolDefinition`, Vitest, existing Tapo RTSP camera module, existing Ollama VLM module, existing pinto0309 person detection module.

---

## File Structure

- Create: `src/runtime/perception-service.ts`
  - Runtime-safe service methods for single-shot scene snapshot, single-shot person detection, and single-shot camera-to-VLM scene description.
  - Builds stream-specific Tapo RTSP sources from `PicoConfig`.
  - Redacts RTSP URLs and credentials in all provider failure messages.
  - Does not import from `scripts/smoke/*`.
- Create: `src/runtime/perception-tool.ts`
  - Pi Agent tool definitions:
    - `createPicoCameraSnapshotTool`
    - `createPicoPersonDetectionTool`
    - `createPicoCameraSceneDescriptionTool`
  - Converts service success/failure results to JSON text `AgentToolResult`.
- Modify: `src/index.ts`
  - Register the three perception tools beside `pico_session`.
- Create: `tests/perception-service.test.ts`
  - Unit coverage for stream selection, redaction, output shape, and scene/person operations.
- Create: `tests/perception-tool.test.ts`
  - Direct tool execution tests for success/failure JSON and no image bytes in text output.
- Modify: `tests/extension.test.ts`
  - Verify extension registration includes the three perception tools.
- Create: `docs/field-tests/2026-06-15-pi-agent-perception-tools.md`
  - Field report after implementation and real Pi Agent execution.

## Task 1: Runtime Perception Service, Tapo Snapshot Path

**Files:**
- Create: `src/runtime/perception-service.ts`
- Test: `tests/perception-service.test.ts`

- [ ] **Step 1: Write failing tests for scene snapshot stream selection and metadata-only output**

Add `tests/perception-service.test.ts`:

```ts
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
    expect(observedUrls).toEqual(["rtsp://<camera-user>:<camera-password>@192.168.10.25:554/stream1"]);
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

    expect(observedUrls).toEqual(["rtsp://<camera-user>:<camera-password>@192.168.10.25:554/stream7"]);
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: FAIL because `src/runtime/perception-service.ts` does not exist.

- [ ] **Step 3: Implement the minimal scene snapshot service**

Create `src/runtime/perception-service.ts` with this initial shape:

```ts
import { existsSync } from "node:fs";

import type { PicoConfig } from "../config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotResult,
  type RtspSnapshotSource
} from "../modules/camera/index.js";
import {
  createCoremlPersonDetectionModel,
  createOnnxPersonDetectionModel,
  createSharpRgbTensorPreprocessor,
  normalizePersonDetectionFrame,
  type PersonDetection,
  type PersonDetectionModel
} from "../modules/vision/person-detection.js";
import {
  createOllamaSceneDescriptionClient,
  type SceneDescription,
  type SceneDescriptionRequest
} from "../modules/vision/index.js";

const defaultTapoSceneStream = "stream1";
const defaultTapoDetectionStream = "stream2";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;

export type PicoCameraSnapshotResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly mimeType: "image/jpeg";
      readonly frameBytes: number;
      readonly capturedAt: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoPersonDetectionResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "detection";
      readonly frameBytes: number;
      readonly capturedAt: string;
      readonly detectedPeople: number;
      readonly detections: readonly PersonDetection[];
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoCameraSceneDescriptionResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly frameBytes: number;
      readonly vlmFrameBytes: number;
      readonly mimeType: "image/jpeg";
      readonly capturedAt: string;
      readonly scene: SceneDescription;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoPerceptionService = {
  readonly captureSceneSnapshot: () => Promise<PicoCameraSnapshotResult>;
  readonly detectPeople: () => Promise<PicoPersonDetectionResult>;
  readonly describeCameraScene: () => Promise<PicoCameraSceneDescriptionResult>;
};

export type PicoPerceptionServiceDependencies = {
  readonly captureSnapshot?: (
    source: RtspSnapshotSource,
    timeoutMs: number,
    maxFrameBytes: number
  ) => Promise<RtspSnapshotResult>;
  readonly pathExists?: (path: string) => boolean;
  readonly createPersonDetectionModel?: (config: PicoConfig) => Promise<PersonDetectionModel>;
  readonly prepareFrameForVlm?: (frame: Uint8Array, maxImageEdgePixels: number) => Promise<Uint8Array>;
  readonly describeFrame?: (request: SceneDescriptionRequest) => Promise<SceneDescription>;
  readonly now?: () => string;
};

export function createPicoPerceptionService(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies = {}
): PicoPerceptionService {
  const now = dependencies.now ?? (() => new Date().toISOString());

  return {
    async captureSceneSnapshot() {
      const source = buildTapoSnapshotSource(config, "scene");
      const snapshot = await captureSnapshotSafely(config, source, dependencies);

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico camera snapshot failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      return {
        status: "passed",
        sourceId: snapshot.sourceId,
        streamPurpose: "scene",
        mimeType: snapshot.mimeType,
        frameBytes: snapshot.frame.byteLength,
        capturedAt: now()
      };
    },
    async detectPeople() {
      return {
        status: "failed",
        reason: "pico_person_detection is not implemented yet"
      };
    },
    async describeCameraScene() {
      return {
        status: "failed",
        reason: "pico_camera_scene_description is not implemented yet"
      };
    }
  };
}

function buildTapoSnapshotSource(
  config: PicoConfig,
  purpose: "scene" | "detection"
): RtspSnapshotSource {
  const tapo = requireTapoConfig(config);
  const stream =
    purpose === "scene"
      ? tapo.streams?.scene ?? defaultTapoSceneStream
      : tapo.streams?.detection ?? defaultTapoDetectionStream;

  return defineRtspSnapshotSource({
    id: tapo.sourceId ?? "tapo-rtsp",
    host: tapo.host,
    username: tapo.user,
    password: tapo.password,
    stream,
    port: tapo.port ?? defaultTapoPort
  });
}

async function captureSnapshotSafely(
  config: PicoConfig,
  source: RtspSnapshotSource,
  dependencies: PicoPerceptionServiceDependencies
): Promise<RtspSnapshotResult> {
  const tapo = requireTapoConfig(config);
  const captureSnapshot = dependencies.captureSnapshot ?? captureSnapshotWithRtsp;

  try {
    return await captureSnapshot(
      source,
      tapo.timeoutMs ?? defaultTimeoutMs,
      tapo.maxFrameBytes ?? defaultMaxFrameBytes
    );
  } catch (error) {
    return {
      ok: false,
      sourceId: source.id,
      reason: "capture_failed",
      message: errorMessage(error)
    };
  }
}

async function captureSnapshotWithRtsp(
  source: RtspSnapshotSource,
  timeoutMs: number,
  maxFrameBytes: number
): Promise<RtspSnapshotResult> {
  const client = createRtspSnapshotClient(
    source,
    createFfmpegRtspSnapshotTransport({
      timeoutMs,
      maxFrameBytes
    })
  );

  return client.captureSnapshot();
}

function requireTapoConfig(config: PicoConfig): NonNullable<PicoConfig["camera"]["tapo"]> {
  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    throw new Error("camera.tapo is required to use pico perception tools");
  }

  return tapo;
}

function sanitizeRtspMessage(message: string, config: PicoConfig, source: RtspSnapshotSource): string {
  const tapo = requireTapoConfig(config);
  const sensitiveValues = [source.url, tapo.user, tapo.password, encodeURIComponent(tapo.user), encodeURIComponent(tapo.password)];
  let sanitized = message.replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]");

  for (const value of sensitiveValues) {
    if (value.trim() !== "") {
      sanitized = sanitized.replaceAll(value, "[redacted]");
    }
  }

  return sanitized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the new test and verify it passes**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: PASS for the two snapshot tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/runtime/perception-service.ts tests/perception-service.test.ts
git commit -m "feat: add perception snapshot service"
```

## Task 2: Person Detection Service

**Files:**
- Modify: `src/runtime/perception-service.ts`
- Test: `tests/perception-service.test.ts`

- [ ] **Step 1: Add failing tests for detection stream and bounded detection output**

Append these tests inside the existing `describe("pico perception service", ...)` block:

```ts
  it("detects people from the high-frame-rate detection stream", async () => {
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

    await expect(service.detectPeople()).resolves.toMatchObject({
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
            xMin: 32,
            yMin: 64,
            xMax: 128,
            yMax: 192
          }
        }
      ]
    });
    expect(observedUrls).toEqual(["rtsp://<camera-user>:<camera-password>@192.168.10.25:554/stream2"]);
  });

  it("redacts RTSP credentials from person detection capture failures", async () => {
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
            modelPath: "/opt/pico/models/pinto0309/person.onnx",
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
            message: `${source.url} camera-password Unauthorized`
          })
      }
    );

    const result = await service.detectPeople();
    const text = JSON.stringify(result);

    expect(result.status).toBe("failed");
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
  });
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: FAIL because `detectPeople()` still returns the initial not-implemented failure.

- [ ] **Step 3: Implement person detection in the service**

Replace the initial `detectPeople()` implementation with:

```ts
    async detectPeople() {
      const detector = requireEnabledPersonDetectionConfig(config);
      const pathExists = dependencies.pathExists ?? existsSync;

      if (!pathExists(detector.modelPath)) {
        return {
          status: "failed",
          reason: "vision.personDetection model file is required to use pico_person_detection"
        };
      }

      const source = buildTapoSnapshotSource(config, "detection");
      const snapshot = await captureSnapshotSafely(config, source, dependencies);

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico person detection failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      const capturedAt = now();
      const model =
        dependencies.createPersonDetectionModel === undefined
          ? await createConfiguredPersonDetectionModel(config)
          : await dependencies.createPersonDetectionModel(config);
      const detections = await model.detect(snapshot.frame);
      const normalized = normalizePersonDetectionFrame({
        sourceId: snapshot.sourceId,
        capturedAt,
        frameSize: {
          width: detector.inputWidth,
          height: detector.inputHeight
        },
        confidenceThreshold: detector.confidenceThreshold,
        detections
      });

      return {
        status: "passed",
        sourceId: normalized.sourceId,
        streamPurpose: "detection",
        frameBytes: snapshot.frame.byteLength,
        capturedAt: normalized.capturedAt,
        detectedPeople: normalized.detections.length,
        detections: normalized.detections
      };
    },
```

Add helper functions to the same file:

```ts
type EnabledPersonDetectionConfig = {
  readonly enabled: true;
  readonly sourceCameraId: string;
  readonly modelFamily: "pinto0309";
  readonly provider: "onnxruntime" | "coreml";
  readonly modelPath: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly outputLayout?: "xyxy_score_class" | "cxcywh_score_class" | "yolox_coco_raw";
  readonly coordinateScale?: "pixel" | "normalized";
  readonly frameIntervalMs: number;
  readonly confidenceThreshold: number;
  readonly coremlFlags?: number;
  readonly nmsIouThreshold?: number;
};

function requireEnabledPersonDetectionConfig(config: PicoConfig): EnabledPersonDetectionConfig {
  const detector = config.vision.personDetection;

  if (
    !detector.enabled ||
    detector.modelFamily !== "pinto0309" ||
    (detector.provider !== "onnxruntime" && detector.provider !== "coreml")
  ) {
    throw new Error("vision.personDetection.enabled=true is required to use pico_person_detection");
  }

  return {
    enabled: true,
    sourceCameraId: requireString(detector.sourceCameraId, "vision.personDetection.sourceCameraId is required"),
    modelFamily: "pinto0309",
    provider: detector.provider,
    modelPath: requireString(detector.modelPath, "vision.personDetection.modelPath is required"),
    inputWidth: requireNumber(detector.inputWidth, "vision.personDetection.inputWidth is required"),
    inputHeight: requireNumber(detector.inputHeight, "vision.personDetection.inputHeight is required"),
    frameIntervalMs: requireNumber(detector.frameIntervalMs, "vision.personDetection.frameIntervalMs is required"),
    confidenceThreshold: requireNumber(
      detector.confidenceThreshold,
      "vision.personDetection.confidenceThreshold is required"
    ),
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined ? {} : { coordinateScale: detector.coordinateScale }),
    ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags }),
    ...(detector.nmsIouThreshold === undefined ? {} : { nmsIouThreshold: detector.nmsIouThreshold })
  };
}

function createConfiguredPersonDetectionModel(config: PicoConfig): Promise<PersonDetectionModel> {
  const detector = requireEnabledPersonDetectionConfig(config);
  const commonOptions = {
    modelPath: detector.modelPath,
    frameSize: {
      width: detector.inputWidth,
      height: detector.inputHeight
    },
    confidenceThreshold: detector.confidenceThreshold,
    ...(detector.coordinateScale === undefined ? {} : { coordinateScale: detector.coordinateScale }),
    ...(detector.nmsIouThreshold === undefined ? {} : { nmsIouThreshold: detector.nmsIouThreshold }),
    preprocessFrame: createSharpRgbTensorPreprocessor({
      inputWidth: detector.inputWidth,
      inputHeight: detector.inputHeight
    })
  };

  if (detector.provider === "coreml") {
    return createCoremlPersonDetectionModel({
      ...commonOptions,
      ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags })
    });
  }

  return createOnnxPersonDetectionModel({
    ...commonOptions,
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout })
  });
}

function requireString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function requireNumber(value: number | undefined, message: string): number {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/runtime/perception-service.ts tests/perception-service.test.ts
git commit -m "feat: add perception person detection service"
```

## Task 3: Camera-to-VLM Scene Description Service

**Files:**
- Modify: `src/runtime/perception-service.ts`
- Test: `tests/perception-service.test.ts`

- [ ] **Step 1: Add failing tests for scene description and redaction**

Append:

```ts
  it("describes camera scenes from the scene stream through the configured VLM", async () => {
    const observedUrls: string[] = [];
    const describedFrames: Uint8Array[] = [];
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
            timeoutMs: 120000
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
        prepareFrameForVlm: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9])),
        describeFrame: (request) => {
          describedFrames.push(request.image);

          return Promise.resolve({
            summary: "A desk is visible.",
            observedPeople: [],
            environment: ["desk"],
            humanAttention: [],
            uncertainty: ["single snapshot"],
            source: {
              endpointId: "windows-ollama-qwen3-5",
              model: "qwen3.5:9b",
              purpose: request.purpose
            }
          });
        }
      }
    );

    await expect(service.describeCameraScene()).resolves.toMatchObject({
      status: "passed",
      sourceId: "tapo-main",
      streamPurpose: "scene",
      frameBytes: 4,
      vlmFrameBytes: 5,
      mimeType: "image/jpeg",
      capturedAt: "2026-06-15T09:02:00.000Z",
      scene: {
        summary: "A desk is visible.",
        source: {
          endpointId: "windows-ollama-qwen3-5",
          model: "qwen3.5:9b",
          purpose: "staff_requested_snapshot"
        }
      }
    });
    expect(observedUrls).toEqual(["rtsp://<camera-user>:<camera-password>@192.168.10.25:554/stream1"]);
    expect(describedFrames).toHaveLength(1);
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
          Promise.reject(new Error(`${source.url} camera-password Unauthorized`))
      }
    );

    const result = await service.describeCameraScene();
    const text = JSON.stringify(result);

    expect(result.status).toBe("failed");
    expect(text).not.toContain("rtsp://");
    expect(text).not.toContain("camera-user");
    expect(text).not.toContain("camera-password");
  });
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: FAIL because `describeCameraScene()` still returns the initial not-implemented failure.

- [ ] **Step 3: Implement scene description**

Add `sharp` import:

```ts
import sharp from "sharp";
```

Replace the initial `describeCameraScene()` implementation with:

```ts
    async describeCameraScene() {
      const endpoint = requireOllamaEndpoint(config);
      const source = buildTapoSnapshotSource(config, "scene");
      const snapshot = await captureSnapshotSafely(config, source, dependencies);

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico camera scene description failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      try {
        const maxImageEdgePixels = config.vision.ollama?.maxImageEdgePixels ?? 512;
        const prepareFrame = dependencies.prepareFrameForVlm ?? resizeJpegForVlm;
        const describeFrame =
          dependencies.describeFrame ?? createOllamaSceneDescriptionClient().describeScene;
        const preparedFrame = await prepareFrame(snapshot.frame, maxImageEdgePixels);
        const scene = await describeFrame({
          endpoint,
          image: preparedFrame,
          mimeType: "image/jpeg",
          purpose: "staff_requested_snapshot",
          timeoutMs: config.vision.ollama?.timeoutMs
        });

        return {
          status: "passed",
          sourceId: snapshot.sourceId,
          streamPurpose: "scene",
          frameBytes: snapshot.frame.byteLength,
          vlmFrameBytes: preparedFrame.byteLength,
          mimeType: snapshot.mimeType,
          capturedAt: now(),
          scene
        };
      } catch (error) {
        return {
          status: "failed",
          reason: `pico camera scene description failed: ${sanitizeRtspMessage(
            errorMessage(error),
            config,
            source
          )}`
        };
      }
    }
```

Add helpers:

```ts
async function resizeJpegForVlm(
  frame: Uint8Array,
  maxImageEdgePixels: number
): Promise<Uint8Array> {
  return await sharp(frame)
    .rotate()
    .resize({
      width: maxImageEdgePixels,
      height: maxImageEdgePixels,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function requireOllamaEndpoint(config: PicoConfig): SceneDescriptionRequest["endpoint"] {
  const endpoint = config.vision.ollama?.endpoint;

  if (endpoint === undefined) {
    throw new Error("vision.ollama is required to use pico_camera_scene_description");
  }

  return endpoint;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npm test -- --run tests/perception-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/runtime/perception-service.ts tests/perception-service.test.ts
git commit -m "feat: add perception scene description service"
```

## Task 4: Pi Agent Perception Tools and Extension Registration

**Files:**
- Create: `src/runtime/perception-tool.ts`
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`
- Test: `tests/perception-tool.test.ts`

- [ ] **Step 1: Write failing tool execution tests**

Create `tests/perception-tool.test.ts`:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "../src/runtime/perception-tool.js";

function extractToolJson(result: unknown): unknown {
  const content = (result as { content?: readonly { type: string; text?: string }[] }).content;
  const text = content?.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("pico perception tool did not return text content");
  }

  return JSON.parse(text) as unknown;
}

describe("pico perception tools", () => {
  it("returns camera snapshot metadata without image content", async () => {
    const tool = createPicoCameraSnapshotTool({
      service: {
        captureSceneSnapshot: () =>
          Promise.resolve({
            status: "passed",
            sourceId: "tapo-main",
            streamPurpose: "scene",
            mimeType: "image/jpeg",
            frameBytes: 4,
            capturedAt: "2026-06-15T09:00:00.000Z"
          }),
        detectPeople: () => Promise.reject(new Error("unused")),
        describeCameraScene: () => Promise.reject(new Error("unused"))
      }
    });

    const result = await tool.execute("tool-call-1", {}, undefined, undefined, {} as ExtensionContext);
    const json = extractToolJson(result);

    expect(json).toEqual({
      tool: "pico_camera_snapshot",
      result: {
        status: "passed",
        sourceId: "tapo-main",
        streamPurpose: "scene",
        mimeType: "image/jpeg",
        frameBytes: 4,
        capturedAt: "2026-06-15T09:00:00.000Z"
      }
    });
    expect(JSON.stringify(json)).not.toContain("data:image");
    expect(JSON.stringify(json)).not.toContain("base64");
  });

  it("returns person detection results", async () => {
    const tool = createPicoPersonDetectionTool({
      service: {
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        detectPeople: () =>
          Promise.resolve({
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
                  xMin: 32,
                  yMin: 64,
                  xMax: 128,
                  yMax: 192
                }
              }
            ]
          }),
        describeCameraScene: () => Promise.reject(new Error("unused"))
      }
    });

    await expect(
      tool.execute("tool-call-2", {}, undefined, undefined, {} as ExtensionContext).then(extractToolJson)
    ).resolves.toMatchObject({
      tool: "pico_person_detection",
      result: {
        status: "passed",
        detectedPeople: 1
      }
    });
  });

  it("returns camera scene descriptions", async () => {
    const tool = createPicoCameraSceneDescriptionTool({
      service: {
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        detectPeople: () => Promise.reject(new Error("unused")),
        describeCameraScene: () =>
          Promise.resolve({
            status: "passed",
            sourceId: "tapo-main",
            streamPurpose: "scene",
            frameBytes: 4,
            vlmFrameBytes: 4,
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
          })
      }
    });

    await expect(
      tool.execute("tool-call-3", {}, undefined, undefined, {} as ExtensionContext).then(extractToolJson)
    ).resolves.toMatchObject({
      tool: "pico_camera_scene_description",
      result: {
        status: "passed",
        scene: {
          summary: "A desk is visible."
        }
      }
    });
  });
});
```

- [ ] **Step 2: Extend extension registration test**

In `tests/extension.test.ts`, update the registration test to assert all tools:

```ts
    expect(capture.tools.map((tool) => tool.name).sort()).toEqual([
      "pico_camera_scene_description",
      "pico_camera_snapshot",
      "pico_person_detection",
      "pico_session"
    ]);
```

Keep the existing `pico_session` execution assertions below it.

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- --run tests/perception-tool.test.ts tests/extension.test.ts
```

Expected: FAIL because `src/runtime/perception-tool.ts` does not exist and `src/index.ts` registers only `pico_session`.

- [ ] **Step 4: Implement perception tools**

Create `src/runtime/perception-tool.ts`:

```ts
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../config/index.js";
import {
  createPicoPerceptionService,
  type PicoPerceptionService
} from "./perception-service.js";

const emptyParameters = Type.Object({});

export type PicoPerceptionToolOptions = {
  readonly service?: PicoPerceptionService;
  readonly loadConfig?: () => PicoConfig;
};

export function createPicoCameraSnapshotTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters> {
  const service = resolveService(options);

  return {
    name: "pico_camera_snapshot",
    label: "Pico Camera Snapshot",
    description: "Capture one metadata-only Tapo scene snapshot without returning room imagery.",
    promptSnippet: "Capture one metadata-only Tapo camera snapshot from the scene stream.",
    promptGuidelines: [
      "Use pico_camera_snapshot only when staff asks for camera capture metadata.",
      "Do not use pico_camera_snapshot for visual understanding; use pico_camera_scene_description instead."
    ],
    parameters: emptyParameters,
    executionMode: "sequential",
    async execute() {
      return textResult({
        tool: "pico_camera_snapshot",
        result: await service.captureSceneSnapshot()
      });
    }
  };
}

export function createPicoPersonDetectionTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters> {
  const service = resolveService(options);

  return {
    name: "pico_person_detection",
    label: "Pico Person Detection",
    description: "Run one bounded Tapo person-detection pass without identifying people.",
    promptSnippet: "Run one bounded person detection pass from the detection stream.",
    promptGuidelines: [
      "Use pico_person_detection only to count visible people and report bounding boxes.",
      "Do not use pico_person_detection to identify, track, score, diagnose, or profile children."
    ],
    parameters: emptyParameters,
    executionMode: "sequential",
    async execute() {
      return textResult({
        tool: "pico_person_detection",
        result: await service.detectPeople()
      });
    }
  };
}

export function createPicoCameraSceneDescriptionTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters> {
  const service = resolveService(options);

  return {
    name: "pico_camera_scene_description",
    label: "Pico Camera Scene",
    description: "Describe one Tapo camera scene through the configured bounded VLM path.",
    promptSnippet: "Describe one Tapo camera scene through the bounded VLM path.",
    promptGuidelines: [
      "Use pico_camera_scene_description when staff asks what the camera can currently see.",
      "Do not use pico_camera_scene_description to identify children, infer private traits, score behavior, diagnose, or make final safety decisions."
    ],
    parameters: emptyParameters,
    executionMode: "sequential",
    async execute() {
      return textResult({
        tool: "pico_camera_scene_description",
        result: await service.describeCameraScene()
      });
    }
  };
}

function resolveService(options: PicoPerceptionToolOptions): PicoPerceptionService {
  if (options.service !== undefined) {
    return options.service;
  }

  return createPicoPerceptionService(options.loadConfig?.() ?? loadPicoConfigFromEnvironment());
}

function textResult(value: unknown): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: {}
  };
}
```

- [ ] **Step 5: Register the tools**

Modify `src/index.ts` imports:

```ts
import {
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "./runtime/perception-tool.js";
```

Modify `registerPicoExtension`:

```ts
export default function registerPicoExtension(pi: ExtensionAPI): void {
  pi.registerTool(createPicoSessionTool());
  pi.registerTool(createPicoCameraSnapshotTool());
  pi.registerTool(createPicoPersonDetectionTool());
  pi.registerTool(createPicoCameraSceneDescriptionTool());
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: buildPicoExtensionSystemPrompt(event.systemPrompt)
  }));
}
```

- [ ] **Step 6: Run tests and verify they pass**

Run:

```bash
npm test -- --run tests/perception-tool.test.ts tests/extension.test.ts tests/perception-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/runtime/perception-tool.ts src/index.ts tests/perception-tool.test.ts tests/extension.test.ts
git commit -m "feat: expose perception tools to Pi Agent"
```

## Task 5: Full Verification, Field Report, and Issue Closure Prep

**Files:**
- Create: `docs/field-tests/2026-06-15-pi-agent-perception-tools.md`
- Modify: no source files unless verification finds defects.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- --run tests/perception-service.test.ts tests/perception-tool.test.ts tests/extension.test.ts tests/camera-smoke.test.ts tests/person-detection-smoke.test.ts tests/camera-vlm-scene-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full project gate**

Run:

```bash
just check
```

Expected: PASS.

- [ ] **Step 3: Run provider readiness smokes**

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-tapo
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:person-detection
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-vlm-scene
```

Expected:

- `camera-tapo`: `status: "passed"`.
- `person-detection`: `status: "passed"`.
- `camera-vlm-scene`: `status: "passed"`.

- [ ] **Step 4: Run actual Pi Agent field prompts**

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_snapshot tool を使ってください。最後の返答では sourceId, streamPurpose, frameBytes, capturedAt だけを日本語で簡潔に報告してください。'
```

Expected: the response reports `streamPurpose: scene` and a positive `frameBytes`.

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_person_detection tool を使ってください。最後の返答では sourceId, streamPurpose, detectedPeople, capturedAt だけを日本語で簡潔に報告してください。'
```

Expected: the response reports `streamPurpose: detection` and a numeric `detectedPeople`.

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_scene_description tool を使ってください。最後の返答では summary, observedPeopleの件数, environmentの件数, uncertaintyの件数だけを日本語で簡潔に報告してください。'
```

Expected: the response reports a scene summary from the configured VLM path.

- [ ] **Step 5: Write the field report**

Create `docs/field-tests/2026-06-15-pi-agent-perception-tools.md`:

```markdown
# 2026-06-15 Pi Agent Perception Tools Field Test

## Scope

Verify that the actual Pi Agent runtime can call pico's bounded perception tools:

- `pico_camera_snapshot`
- `pico_person_detection`
- `pico_camera_scene_description`

## Environment

- Repository: `/Users/monsoon/Dev/pico`
- Branch: `codex/pi-agent-perception-tools`
- Pi Agent CLI: `node_modules/.bin/pi`
- Extension: `./src/index.ts`
- Config: `config/pico.local.yaml`
- Secrets: not recorded

## Commands

```bash
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_snapshot tool を使ってください。最後の返答では sourceId, streamPurpose, frameBytes, capturedAt だけを日本語で簡潔に報告してください。'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_person_detection tool を使ってください。最後の返答では sourceId, streamPurpose, detectedPeople, capturedAt だけを日本語で簡潔に報告してください。'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_scene_description tool を使ってください。最後の返答では summary, observedPeopleの件数, environmentの件数, uncertaintyの件数だけを日本語で簡潔に報告してください。'
```

## Observed Result

- `pico_camera_snapshot`: record source id, stream purpose, frame byte count, and captured time.
- `pico_person_detection`: record source id, stream purpose, detected people count, and captured time.
- `pico_camera_scene_description`: record summary and structured array counts.

## Verdict

Passed or failed based on the observed commands above.

## Follow-Up

Create focused issues for any failed field milestone.
```

Replace the Observed Result bullets with the actual command outputs before committing.

- [ ] **Step 6: Commit Task 5**

```bash
git add docs/field-tests/2026-06-15-pi-agent-perception-tools.md
git commit -m "docs: record Pi Agent perception field test"
```

## Task 6: PR Convergence

**Files:**
- No new files unless review or CI requires changes.

- [ ] **Step 1: Run final verification**

Run:

```bash
git status --short
just check
```

Expected: clean or only intended committed changes, and `just check` passes.

- [ ] **Step 2: Push branch**

```bash
git push origin codex/pi-agent-perception-tools
```

- [ ] **Step 3: Create ready PR**

```bash
gh pr create \
  --base main \
  --head codex/pi-agent-perception-tools \
  --title "Expose Pi Agent perception tools" \
  --body-file -
```

Use this PR body:

```markdown
## Summary

- Adds actual Pi Agent tools for Tapo scene snapshot, person detection, and camera-to-VLM scene description.
- Keeps scene/VLM on `stream1` and person detection on `stream2`.
- Records field validation through the real Pi Agent extension path.

Closes #61

## Verification

- [ ] `just check`
- [ ] `PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-tapo`
- [ ] `PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:person-detection`
- [ ] `PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-vlm-scene`
- [ ] Pi Agent field test for `pico_camera_snapshot`
- [ ] Pi Agent field test for `pico_person_detection`
- [ ] Pi Agent field test for `pico_camera_scene_description`
```

- [ ] **Step 4: Run CodeRabbit/CI convergence**

Follow `post-pr-convergence`:

- Wait for required checks.
- If CI fails, inspect logs, fix, push.
- If CodeRabbit requests changes, verify each finding against current code, fix valid findings, push.
- Merge only after CodeRabbit approval and required checks are green.
