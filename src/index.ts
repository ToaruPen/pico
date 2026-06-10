import { picoIdentity } from "./identity/profile.js";
import { buildSystemPrompt } from "./identity/system-prompt.js";
import { createAuditModule } from "./modules/audit/index.js";
import { createContextModule } from "./modules/context/index.js";
import { futurePicoModules } from "./modules/future.js";
import { createHandoffModule } from "./modules/handoff/index.js";
import { createLocalModelsModule } from "./modules/local-models/index.js";
import { createMemoryModule } from "./modules/memory/index.js";
import { createTransportModule } from "./modules/transport/index.js";
import { PicoModuleRegistry } from "./orchestrator/registry.js";

export function createPicoRegistry(): PicoModuleRegistry {
  const registry = new PicoModuleRegistry();

  registry.register(createContextModule());
  registry.register(createMemoryModule());
  registry.register(createLocalModelsModule());
  registry.register(createHandoffModule());
  registry.register(createAuditModule());
  registry.register(createTransportModule());

  return registry;
}

export const picoExtension = {
  id: "pico",
  identity: picoIdentity,
  systemPrompt: buildSystemPrompt(picoIdentity),
  modules: createPicoRegistry().listMetadata(),
  futureModules: futurePicoModules
};

export default picoExtension;
