import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import { AGENT_SCENE_IMAGE_INSTRUCTION } from "../src/modules/vision/index.js";
import type { DeferredToolCoordinator } from "../src/runtime/deferred-tool-coordinator.js";
import {
  createPicoCameraSceneDescriptionDeferredTool,
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "../src/runtime/perception-tool.js";

const ollamaSceneRoute = {
  provider: "ollama" as const,
  source: "tapo" as const,
  timeoutMs: 30_000,
  maxImageEdgePixels: 512
};

function extractToolJson(result: unknown): unknown {
  const content = (result as { content?: readonly { type: string; text?: string }[] }).content;
  const text = content?.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("pico perception tool did not return text content");
  }

  return JSON.parse(text) as unknown;
}

describe("pico perception tools", () => {
  it("invites one natural scene check for an explicit user question without a second confirmation", () => {
    const tool = createPicoCameraSceneDescriptionTool();
    const deferredTool = createPicoCameraSceneDescriptionDeferredTool({
      sessionId: "session-1",
      coordinator: {
        enqueue: () => ({
          status: "queued",
          kind: "camera_scene_description",
          jobId: "deferred-job-1",
          sessionId: "session-1"
        })
      }
    });
    const guidance = tool.promptGuidelines?.join("\n") ?? "";

    expect(guidance).toContain(
      "Use pico_camera_scene_description when the user asks what the camera can currently see."
    );
    expect(guidance).toContain("Do not ask for a second confirmation before capturing one image.");
    expect(guidance).not.toContain("when staff asks");
    expect(deferredTool.description).toContain("configured camera scene");
    expect(deferredTool.description).not.toContain("Tapo");
  });

  it("fails a scene request with a bounded reason when no route is configured", async () => {
    let sceneOperationCalls = 0;
    const service = {
      captureSceneSnapshot: () =>
        Promise.resolve({
          status: "failed" as const,
          reason: "snapshot remains independently available"
        }),
      captureSceneFrame: () => {
        sceneOperationCalls += 1;
        return Promise.reject(new Error("must not capture"));
      },
      detectPeople: () =>
        Promise.resolve({
          status: "failed" as const,
          reason: "person detection remains independently available"
        }),
      describeCameraScene: () => {
        sceneOperationCalls += 1;
        return Promise.reject(new Error("must not describe"));
      }
    };
    const sceneTool = createPicoCameraSceneDescriptionTool({ service });
    const snapshotTool = createPicoCameraSnapshotTool({ service });
    const personTool = createPicoPersonDetectionTool({ service });

    await expect(
      sceneTool
        .execute("tool-call-scene", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
    ).resolves.toEqual({
      tool: "pico_camera_scene_description",
      result: {
        status: "failed",
        reason: "pico camera scene description route is not configured"
      }
    });
    await expect(
      snapshotTool
        .execute("tool-call-snapshot", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
    ).resolves.toMatchObject({
      tool: "pico_camera_snapshot",
      result: { reason: "snapshot remains independently available" }
    });
    await expect(
      personTool
        .execute("tool-call-person", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
    ).resolves.toMatchObject({
      tool: "pico_person_detection",
      result: { reason: "person detection remains independently available" }
    });
    expect(sceneOperationCalls).toBe(0);
  });

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

  it("reports sanitized config loading failures during tool execution", async () => {
    const tool = createPicoCameraSnapshotTool({
      loadConfig: () => {
        throw new Error("config load failed at /private/pico/config/pico.local.yaml");
      }
    });

    await expect(
      tool
        .execute("tool-call-1", {}, undefined, undefined, {} as ExtensionContext)
        .then(extractToolJson)
    ).resolves.toEqual({
      tool: "pico_camera_snapshot",
      result: {
        status: "failed",
        reason: "pico perception service configuration failed"
      }
    });
  });

  it("returns camera snapshot metadata without image content", async () => {
    const tool = createPicoCameraSnapshotTool({
      service: {
        sceneRoute: ollamaSceneRoute,
        captureSceneSnapshot: () =>
          Promise.resolve({
            status: "passed",
            sourceId: "tapo-main",
            streamPurpose: "scene",
            mimeType: "image/jpeg",
            frameBytes: 4,
            capturedAt: "2026-06-15T09:00:00.000Z"
          }),
        captureSceneFrame: () => Promise.reject(new Error("unused")),
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
        sceneRoute: ollamaSceneRoute,
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        captureSceneFrame: () => Promise.reject(new Error("unused")),
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
        sceneRoute: ollamaSceneRoute,
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        captureSceneFrame: () => Promise.reject(new Error("unused")),
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

  it("returns one bounded image to the active agent without putting it in details", async () => {
    const image = Uint8Array.of(0xff, 0xd8, 1, 2, 0xff, 0xd9);
    const tool = createPicoCameraSceneDescriptionTool({
      service: {
        sceneRoute: {
          provider: "agent",
          source: "stackchan",
          timeoutMs: 30_000,
          maxImageEdgePixels: 512
        },
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        captureSceneFrame: () =>
          Promise.resolve({
            status: "passed",
            provider: "agent",
            sourceId: "stackchan-core-s3",
            streamPurpose: "scene",
            frameBytes: 10,
            vlmFrameBytes: image.byteLength,
            mimeType: "image/jpeg",
            capturedAt: "2026-07-26T09:02:00.000Z",
            image
          }),
        detectPeople: () => Promise.reject(new Error("unused")),
        describeCameraScene: () => Promise.reject(new Error("unused"))
      }
    });

    const result = await tool.execute(
      "tool-call-agent-scene",
      {},
      undefined,
      undefined,
      {} as ExtensionContext
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: AGENT_SCENE_IMAGE_INSTRUCTION
      },
      {
        type: "image",
        data: Buffer.from(image).toString("base64"),
        mimeType: "image/jpeg"
      }
    ]);
    expect(result.details).toEqual({
      provider: "agent",
      sourceId: "stackchan-core-s3",
      frameBytes: 10,
      vlmFrameBytes: image.byteLength,
      capturedAt: "2026-07-26T09:02:00.000Z"
    });
    expect(JSON.stringify(result.details)).not.toContain(Buffer.from(image).toString("base64"));
  });

  it("queues deferred camera scene descriptions without waiting for VLM completion", async () => {
    let serviceCalls = 0;
    const coordinator: Pick<DeferredToolCoordinator, "enqueue"> = {
      enqueue: (input) => {
        void input.execute().catch(() => undefined);

        return {
          status: "queued",
          kind: "camera_scene_description",
          jobId: "deferred-job-1",
          sessionId: input.sessionId
        };
      }
    };
    const tool = createPicoCameraSceneDescriptionDeferredTool({
      sessionId: "session-1",
      coordinator,
      service: {
        sceneRoute: ollamaSceneRoute,
        captureSceneSnapshot: () => Promise.reject(new Error("unused")),
        captureSceneFrame: () => Promise.reject(new Error("unused")),
        detectPeople: () => Promise.reject(new Error("unused")),
        describeCameraScene: () => {
          serviceCalls += 1;
          return new Promise(() => undefined);
        }
      }
    });

    const result = await tool.execute(
      "tool-call-1",
      {},
      undefined,
      undefined,
      {} as ExtensionContext
    );

    expect(extractToolJson(result)).toEqual({
      tool: "pico_camera_scene_description_deferred",
      result: {
        status: "queued",
        kind: "camera_scene_description",
        jobId: "deferred-job-1",
        sessionId: "session-1"
      }
    });
    expect(serviceCalls).toBe(1);
  });
});
