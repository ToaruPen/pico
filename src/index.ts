import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { PicoConfig } from "./config/index.js";
import { picoIdentity } from "./identity/profile.js";
import { buildSystemPrompt } from "./identity/system-prompt.js";
import { createAuditModule } from "./modules/audit/index.js";
import { createContextModule } from "./modules/context/index.js";
import { futurePicoModules } from "./modules/future.js";
import { createHandoffModule } from "./modules/handoff/index.js";
import { createIdentityRegistryModule } from "./modules/identity-registry/index.js";
import { createLocalModelsModule } from "./modules/local-models/index.js";
import { createSessionModule } from "./modules/session/index.js";
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
import { registerPicoStartup } from "./runtime/pico-startup.js";
import { createResidentVoiceService } from "./runtime/resident-voice-service.js";
import type { VoiceStageProbe } from "./runtime/voice-stage-probe.js";

export function createPicoRegistry(): PicoModuleRegistry {
  const registry = new PicoModuleRegistry();

  registry.register(createContextModule());
  registry.register(createSessionModule());
  registry.register(createLocalModelsModule());
  registry.register(createHandoffModule());
  registry.register(createAuditModule());
  registry.register(createIdentityRegistryModule());
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
  readonly loadConfig?: () => PicoConfig;
  readonly voiceProbe?: VoiceStageProbe;
  readonly perceptionMode?: "standard" | "resident_deferred";
  readonly deferredTools?: {
    readonly sessionId: string;
    readonly coordinator: Pick<DeferredToolCoordinator, "enqueue">;
  };
};

export function registerPicoExtensionWithRuntime(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions = {}
): void {
  registerPerceptionRuntimeTools(pi, options);
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: buildPicoExtensionSystemPrompt(event.systemPrompt)
  }));
}

function registerPerceptionRuntimeTools(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions
): void {
  const perceptionMode = options.perceptionMode ?? "standard";
  const perceptionToolOptions = {
    ...(options.voiceProbe === undefined ? {} : { probe: options.voiceProbe }),
    ...(options.loadConfig === undefined ? {} : { loadConfig: options.loadConfig })
  };

  if (perceptionMode === "resident_deferred" && options.deferredTools !== undefined) {
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

  registerPicoStartup(pi, {
    createController: (context) =>
      createResidentVoiceService({
        piAgent,
        onError: (error) => {
          context.ui.notify(error.message, "error");
          context.shutdown();
        }
      })
  });
}
