import type { PicoModule } from "../../orchestrator/contracts.js";

export function createAuditModule(): PicoModule {
  return {
    metadata: {
      kind: "audit",
      status: "available",
      summary: "Records operationally important tool, memory, transport, and module events.",
      capabilities: [
        {
          id: "audit.describe_events",
          description:
            "Describe audit event categories without storing full transcripts by default."
        }
      ]
    }
  };
}
