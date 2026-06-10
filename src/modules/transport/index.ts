import type { PicoModule } from "../../orchestrator/contracts.js";
import type { SelectedModelEndpointConfig } from "../local-models/index.js";

export type ProtectedModelEndpointConnectivityProbe = {
  readonly canReach: (localBaseUrl: string) => Promise<boolean>;
};

export type ProtectedModelEndpointConnectivityResult = {
  readonly endpointId: string;
  readonly reachable: boolean;
  readonly checkedUrl: string;
};

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

export async function checkProtectedModelEndpointConnectivity(
  endpoint: SelectedModelEndpointConfig,
  probe: ProtectedModelEndpointConnectivityProbe
): Promise<ProtectedModelEndpointConnectivityResult> {
  const checkedUrl = endpoint.host.tunnel.localBaseUrl;
  const reachable = await probe.canReach(checkedUrl);

  return {
    endpointId: endpoint.id,
    reachable,
    checkedUrl
  };
}
