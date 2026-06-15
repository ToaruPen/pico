import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../config/index.js";
import { createPicoPerceptionService, type PicoPerceptionService } from "./perception-service.js";

const emptyParameters = Type.Object({});

export type PicoPerceptionToolOptions = {
  readonly service?: PicoPerceptionService;
  readonly loadConfig?: () => PicoConfig;
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
      const service = getService();

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
      const service = getService();

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
  const getService = createLazyServiceResolver(options);

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
      const service = getService();

      return textResult({
        tool: "pico_camera_scene_description",
        result: await service.describeCameraScene()
      });
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

  return createPicoPerceptionService(options.loadConfig?.() ?? loadPicoConfigFromEnvironment());
}

function textResult(value: unknown): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: {}
  };
}
