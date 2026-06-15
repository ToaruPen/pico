import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { picoIdentity } from "./identity/profile.js";
import { buildSystemPrompt } from "./identity/system-prompt.js";
import { createAuditModule } from "./modules/audit/index.js";
import { createContextModule } from "./modules/context/index.js";
import { futurePicoModules } from "./modules/future.js";
import { createHandoffModule } from "./modules/handoff/index.js";
import { createLocalModelsModule } from "./modules/local-models/index.js";
import { createMemoryModule } from "./modules/memory/index.js";
import { createSessionModule } from "./modules/session/index.js";
import { createTransportModule } from "./modules/transport/index.js";
import { PicoModuleRegistry } from "./orchestrator/registry.js";
import {
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "./runtime/perception-tool.js";
import { createPicoSessionTool } from "./runtime/session-tool.js";

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

export default function registerPicoExtension(pi: ExtensionAPI): void {
  pi.registerTool(createPicoSessionTool());
  pi.registerTool(createPicoCameraSnapshotTool());
  pi.registerTool(createPicoPersonDetectionTool());
  pi.registerTool(createPicoCameraSceneDescriptionTool());
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: buildPicoExtensionSystemPrompt(event.systemPrompt)
  }));
}
