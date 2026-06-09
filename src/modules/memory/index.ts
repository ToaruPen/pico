import type { PicoModule } from "../../orchestrator/contracts.js";

export function createMemoryModule(): PicoModule {
  return {
    metadata: {
      kind: "memory",
      status: "available",
      summary: "Holds short-term interaction continuity without durable child profiling.",
      capabilities: [
        {
          id: "memory.describe_boundary",
          description: "Describe short-term memory boundaries and non-durable behavior."
        }
      ]
    }
  };
}
