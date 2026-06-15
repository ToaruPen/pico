import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
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
  it("defers config loading until first tool execution and reuses the service", async () => {
    let loadCalls = 0;
    const tool = createPicoCameraSnapshotTool({
      loadConfig: () => {
        loadCalls += 1;

        return definePicoConfig({});
      }
    });

    expect(loadCalls).toBe(0);

    await expect(
      tool
        .execute("tool-call-1", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
    ).resolves.toEqual({
      tool: "pico_camera_snapshot",
      result: {
        status: "failed",
        reason: "camera.tapo is required to use pico_camera_snapshot"
      }
    });
    await tool.execute("tool-call-2", {}, undefined, undefined, {} as ExtensionContext);

    expect(loadCalls).toBe(1);
  });

  it("reports config loading failures during tool execution instead of construction", async () => {
    const tool = createPicoCameraSnapshotTool({
      loadConfig: () => {
        throw new Error("config load failed");
      }
    });

    await expect(
      tool.execute("tool-call-1", {}, undefined, undefined, {} as ExtensionContext)
    ).rejects.toThrow("config load failed");
  });

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

    const result = await tool.execute(
      "tool-call-1",
      {},
      undefined,
      undefined,
      {} as ExtensionContext
    );
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
                  xMin: 0.1,
                  yMin: 0.2,
                  xMax: 0.4,
                  yMax: 0.6
                }
              }
            ]
          }),
        describeCameraScene: () => Promise.reject(new Error("unused"))
      }
    });

    await expect(
      tool
        .execute("tool-call-2", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
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
      tool
        .execute("tool-call-3", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
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
