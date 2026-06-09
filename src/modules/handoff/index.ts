import type { PicoModule } from "../../orchestrator/contracts.js";

export function createHandoffModule(): PicoModule {
  return {
    metadata: {
      kind: "handoff",
      status: "available",
      summary:
        "Prepares staff-facing summaries and follow-up text while preserving human judgment.",
      capabilities: [
        {
          id: "handoff.describe_boundary",
          description: "Describe how pico prepares handoff material for human staff."
        }
      ]
    }
  };
}
