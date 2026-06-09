import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const channelsModuleMetadata = {
  kind: "channels",
  status: "planned",
  summary: "External communication surfaces such as LINE after local sinks are stable.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;
