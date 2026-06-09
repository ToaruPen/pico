import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const longMemoryModuleMetadata = {
  kind: "long_memory",
  status: "planned",
  summary: "Durable facility memory based on reviewed care-continuity knowledge.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;
