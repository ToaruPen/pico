import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../config/index.js";
import { AGENT_SCENE_IMAGE_INSTRUCTION } from "../modules/vision/index.js";
import type {
  DeferredToolCoordinator,
  DeferredToolEnqueueResult,
  DeferredToolExecutionResult
} from "./deferred-tool-coordinator.js";
import {
  createPicoPerceptionService,
  PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON,
  type PicoPerceptionService
} from "./perception-service.js";
import type { VoiceStageProbe } from "./voice-stage-probe.js";

const emptyParameters = Type.Object({});

export type PicoPerceptionToolOptions = {
  readonly service?: PicoPerceptionService;
  readonly loadConfig?: () => PicoConfig;
  readonly probe?: VoiceStageProbe;
};

export type PicoDeferredPerceptionToolOptions = PicoPerceptionToolOptions & {
  readonly coordinator: Pick<DeferredToolCoordinator, "enqueue">;
  readonly sessionId: string;
};

export type PicoSceneToolDetails = {
  readonly provider?: "agent";
  readonly sourceId?: string;
  readonly frameBytes?: number;
  readonly vlmFrameBytes?: number;
  readonly capturedAt?: string;
};

export function createPicoCameraSnapshotTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters> {
  const getService = createLazyServiceResolver(options);

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
      return executeWithResolvedService("pico_camera_snapshot", getService, (service) =>
        service.captureSceneSnapshot()
      );
    }
  };
}

export function createPicoPersonDetectionTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters> {
  const getService = createLazyServiceResolver(options);

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
      return executeWithResolvedService("pico_person_detection", getService, (service) =>
        service.detectPeople()
      );
    }
  };
}

export function createPicoCameraSceneDescriptionTool(
  options: PicoPerceptionToolOptions = {}
): ToolDefinition<typeof emptyParameters, PicoSceneToolDetails> {
  const getService = createLazyServiceResolver(options);

  return {
    name: "pico_camera_scene_description",
    label: "Pico Camera Scene",
    description: "Describe one configured camera scene through the selected bounded VLM path.",
    promptSnippet: "Describe one configured camera scene through the bounded VLM path.",
    promptGuidelines: [
      "Use pico_camera_scene_description when the user asks what the camera can currently see.",
      "Do not ask for a second confirmation before capturing one image.",
      "Do not use pico_camera_scene_description to identify children, infer private traits, score behavior, diagnose, or make final safety decisions."
    ],
    parameters: emptyParameters,
    executionMode: "sequential",
    async execute() {
      return executeSceneDescription(getService);
    }
  };
}

export function createPicoCameraSceneDescriptionDeferredTool(
  options: PicoDeferredPerceptionToolOptions
): ToolDefinition<typeof emptyParameters> {
  const getService = createLazyServiceResolver(options);

  return {
    name: "pico_camera_scene_description_deferred",
    label: "Pico Camera Scene Deferred",
    description:
      "Queue one bounded configured camera scene description for resident voice without blocking the current voice turn.",
    promptSnippet:
      "Queue a camera scene check when the user asks what the camera can currently see; continue the voice conversation while it runs.",
    promptGuidelines: [
      "Use pico_camera_scene_description_deferred only for explicit user camera/scene requests in resident voice.",
      "Tell the user briefly that you will check and report back; do not wait for the camera result in the same turn.",
      "Do not identify children, infer private traits, score behavior, diagnose, or make final safety decisions."
    ],
    parameters: emptyParameters,
    executionMode: "sequential",
    execute(toolCallId) {
      const result = options.coordinator.enqueue({
        kind: "camera_scene_description",
        toolCallId,
        sessionId: options.sessionId,
        execute: () => executeDeferredSceneDescription(getService)
      });

      return Promise.resolve(
        textResult({
          tool: "pico_camera_scene_description_deferred",
          result: formatDeferredToolEnqueueResult(result)
        })
      );
    }
  };
}

function createLazyServiceResolver(
  options: PicoPerceptionToolOptions
): () => PicoPerceptionService {
  let service: PicoPerceptionService | undefined;

  return () => {
    service ??= resolveService(options);

    return service;
  };
}

function resolveService(options: PicoPerceptionToolOptions): PicoPerceptionService {
  if (options.service !== undefined) {
    return options.service;
  }

  return createPicoPerceptionService(options.loadConfig?.() ?? loadPicoConfigFromEnvironment(), {
    ...(options.probe === undefined ? {} : { probe: options.probe })
  });
}

async function executeWithResolvedService(
  tool: string,
  getService: () => PicoPerceptionService,
  execute: (service: PicoPerceptionService) => Promise<unknown>
): Promise<AgentToolResult<Record<string, never>>> {
  let service: PicoPerceptionService;

  try {
    service = getService();
  } catch {
    return textResult({
      tool,
      result: {
        status: "failed",
        reason: "pico perception service configuration failed"
      }
    });
  }

  return textResult({
    tool,
    result: await execute(service)
  });
}

function textResult(value: unknown): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: {}
  };
}

async function executeSceneDescription(
  getService: () => PicoPerceptionService
): Promise<AgentToolResult<PicoSceneToolDetails>> {
  let service: PicoPerceptionService;

  try {
    service = getService();
  } catch {
    return sceneTextResult({
      status: "failed",
      reason: "pico perception service configuration failed"
    });
  }

  if (service.sceneRoute === undefined) {
    return sceneTextResult({
      status: "failed",
      reason: PICO_SCENE_ROUTE_NOT_CONFIGURED_REASON
    });
  }

  if (service.sceneRoute.provider === "ollama") {
    return sceneTextResult(await service.describeCameraScene());
  }

  const frame = await service.captureSceneFrame();
  if (frame.status === "failed") {
    return sceneTextResult(frame);
  }

  return {
    content: [
      {
        type: "text",
        text: AGENT_SCENE_IMAGE_INSTRUCTION
      },
      {
        type: "image",
        data: Buffer.from(frame.image).toString("base64"),
        mimeType: frame.mimeType
      }
    ],
    details: {
      provider: "agent",
      sourceId: frame.sourceId,
      frameBytes: frame.frameBytes,
      vlmFrameBytes: frame.vlmFrameBytes,
      capturedAt: frame.capturedAt
    }
  };
}

function sceneTextResult(result: unknown): AgentToolResult<PicoSceneToolDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tool: "pico_camera_scene_description",
          result
        })
      }
    ],
    details: {}
  };
}

async function executeDeferredSceneDescription(
  getService: () => PicoPerceptionService
): Promise<DeferredToolExecutionResult> {
  let service: PicoPerceptionService;

  try {
    service = getService();
  } catch {
    return {
      status: "failed",
      summary: "pico perception service configuration failed"
    };
  }

  const result = await service.describeCameraScene();

  if (result.status === "failed") {
    return {
      status: "failed",
      summary: result.reason
    };
  }

  return {
    status: "completed",
    capturedAt: result.capturedAt,
    summary: result.scene.summary
  };
}

function formatDeferredToolEnqueueResult(
  result: DeferredToolEnqueueResult
): DeferredToolEnqueueResult {
  return result;
}
