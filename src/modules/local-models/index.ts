import type { PicoModule } from "../../orchestrator/contracts.js";

export function createLocalModelsModule(): PicoModule {
  return {
    metadata: {
      kind: "local_models",
      status: "available",
      summary:
        "Defines selected local-first provider boundaries, including protected remote GPU hosts.",
      capabilities: [
        {
          id: "local_models.describe_providers",
          description:
            "Describe selected provider boundaries without automatic switching between hosts."
        }
      ]
    }
  };
}
