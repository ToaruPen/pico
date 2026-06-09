import type { PicoModule } from "../../orchestrator/contracts.js";

export function createContextModule(): PicoModule {
  return {
    metadata: {
      kind: "context",
      status: "available",
      summary: "Provides structured facility context for schedules, rules, rooms, and notes.",
      capabilities: [
        {
          id: "context.describe_scope",
          description: "Describe the facility context categories pico is allowed to use."
        }
      ]
    }
  };
}
