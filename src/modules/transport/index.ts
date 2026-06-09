import type { PicoModule } from "../../orchestrator/contracts.js";

export function createTransportModule(): PicoModule {
  return {
    metadata: {
      kind: "transport",
      status: "available",
      summary:
        "Owns protected communication boundaries for Tailscale or Cloudflare-routed model access.",
      capabilities: [
        {
          id: "transport.describe_boundary",
          description: "Describe protected SSH tunnel boundaries without a custom policy engine."
        }
      ]
    }
  };
}
