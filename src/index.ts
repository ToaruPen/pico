import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { PicoConfig } from "./config/index.js";
import { picoIdentity } from "./identity/profile.js";
import { buildSystemPrompt } from "./identity/system-prompt.js";
import { createAuditModule } from "./modules/audit/index.js";
import { createContextModule } from "./modules/context/index.js";
import { futurePicoModules } from "./modules/future.js";
import { createHandoffModule } from "./modules/handoff/index.js";
import { createLocalModelsModule } from "./modules/local-models/index.js";
import { createMemoryModule } from "./modules/memory/index.js";
import { createSessionModule, type SessionLifecycle } from "./modules/session/index.js";
import { createTransportModule } from "./modules/transport/index.js";
import { PicoModuleRegistry } from "./orchestrator/registry.js";
import type { DeferredToolCoordinator } from "./runtime/deferred-tool-coordinator.js";
import {
  createPicoCameraSceneDescriptionDeferredTool,
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "./runtime/perception-tool.js";
import { createPiHostTurnClient } from "./runtime/pi-host-turn.js";
import { registerPicoRuntimeProfile } from "./runtime/pico-runtime-profile.js";
import { createResidentVoiceService } from "./runtime/resident-voice-service.js";
import { createPicoSessionTool } from "./runtime/session-tool.js";
import type { VoiceStageProbe } from "./runtime/voice-stage-probe.js";

export function createPicoRegistry(): PicoModuleRegistry {
  const registry = new PicoModuleRegistry();

  registry.register(createContextModule());
  registry.register(createMemoryModule());
  registry.register(createSessionModule());
  registry.register(createLocalModelsModule());
  registry.register(createHandoffModule());
  registry.register(createAuditModule());
  registry.register(createTransportModule());

  return registry;
}

export const picoExtensionMetadata = {
  id: "pico",
  identity: picoIdentity,
  systemPrompt: buildSystemPrompt(picoIdentity),
  modules: createPicoRegistry().listMetadata(),
  futureModules: futurePicoModules
};

function formatModuleMetadata(
  modules: typeof picoExtensionMetadata.modules | typeof picoExtensionMetadata.futureModules
): string {
  return modules
    .map((module) => {
      const capabilities =
        module.capabilities.length === 0
          ? "no runtime capabilities yet"
          : module.capabilities
              .map((capability) => `${capability.id} (${capability.description})`)
              .join("; ");

      return `- ${module.kind}: ${module.summary} Capabilities: ${capabilities}.`;
    })
    .join("\n");
}

export function buildPicoExtensionSystemPrompt(baseSystemPrompt: string): string {
  return [
    baseSystemPrompt,
    "",
    "## pico Domain Extension",
    picoExtensionMetadata.systemPrompt,
    "",
    "Available pico modules:",
    formatModuleMetadata(picoExtensionMetadata.modules),
    "",
    "Planned pico modules:",
    formatModuleMetadata(picoExtensionMetadata.futureModules)
  ].join("\n");
}

export type PicoExtensionRuntimeOptions = {
  readonly sessionLifecycle?: SessionLifecycle;
  readonly loadConfig?: () => PicoConfig;
  readonly voiceProbe?: VoiceStageProbe;
  readonly toolProfile?: "default" | "voice_resident";
  readonly deferredTools?: {
    readonly sessionId: string;
    readonly coordinator: Pick<DeferredToolCoordinator, "enqueue">;
  };
  readonly sessionTool?: {
    readonly allowCutoff?: boolean;
  };
};

export function registerPicoExtensionWithRuntime(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions = {}
): void {
  registerSessionRuntimeTool(pi, options);
  registerPerceptionRuntimeTools(pi, options);
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: buildPicoExtensionSystemPrompt(event.systemPrompt)
  }));
}

function registerSessionRuntimeTool(pi: ExtensionAPI, options: PicoExtensionRuntimeOptions): void {
  pi.registerTool(
    createPicoSessionTool({
      ...(options.sessionLifecycle === undefined ? {} : { lifecycle: options.sessionLifecycle }),
      ...(options.loadConfig === undefined ? {} : { loadConfig: options.loadConfig }),
      ...(options.sessionTool?.allowCutoff === undefined
        ? {}
        : { allowCutoff: options.sessionTool.allowCutoff })
    })
  );
}

function registerPerceptionRuntimeTools(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions
): void {
  const toolProfile = options.toolProfile ?? "default";
  const perceptionToolOptions = {
    ...(options.voiceProbe === undefined ? {} : { probe: options.voiceProbe }),
    ...(options.loadConfig === undefined ? {} : { loadConfig: options.loadConfig })
  };

  if (toolProfile === "voice_resident" && options.deferredTools !== undefined) {
    pi.registerTool(
      createPicoCameraSceneDescriptionDeferredTool({
        ...perceptionToolOptions,
        sessionId: options.deferredTools.sessionId,
        coordinator: options.deferredTools.coordinator
      })
    );
  } else {
    pi.registerTool(createPicoCameraSnapshotTool(perceptionToolOptions));
    pi.registerTool(createPicoPersonDetectionTool(perceptionToolOptions));
    pi.registerTool(createPicoCameraSceneDescriptionTool(perceptionToolOptions));
  }
}

export default function registerPicoExtension(pi: ExtensionAPI): void {
  registerPicoExtensionWithRuntime(pi);
  const piAgent = createPiHostTurnClient(pi);

  registerPicoRuntimeProfile(pi, {
    createResidentController: (context) =>
      createResidentVoiceService({
        piAgent,
        onError: (error) => {
          context.ui.notify(error.message, "error");
          context.shutdown();
        }
      })
  });
}
