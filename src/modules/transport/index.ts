import type { PicoModule } from "../../orchestrator/contracts.js";
import {
  buildSelectedModelEndpointAuthHeaders,
  type SelectedModelEndpointConfig
} from "../local-models/index.js";

export type ProtectedModelEndpointConnectivityProbe = {
  readonly canReach: (localBaseUrl: string) => Promise<boolean>;
};

export type ProtectedModelEndpointConnectivityResult = {
  readonly endpointId: string;
  readonly reachable: boolean;
  readonly checkedUrl: string;
};

export type ProtectedOllamaEndpointPreflightProbe = {
  readonly timeoutMs: number;
  readonly fetchTags?: (
    url: string,
    signal: AbortSignal,
    headers: Record<string, string>
  ) => Promise<Response>;
};

export type ProtectedOllamaEndpointPreflightResult =
  | {
      readonly status: "passed";
      readonly endpointId: string;
      readonly checkedUrl: string;
      readonly model: SelectedModelEndpointConfig["model"];
      readonly modelCount: number;
    }
  | {
      readonly status: "failed";
      readonly endpointId: string;
      readonly checkedUrl: string;
      readonly model: SelectedModelEndpointConfig["model"];
      readonly reason: string;
    };

type OllamaTagsResponse = {
  readonly models: readonly {
    readonly name: string;
  }[];
};

const malformedOllamaTagsMessage = "pico protected Ollama endpoint /api/tags response is malformed";
const protectedOllamaTunnelFailureMessage =
  "pico protected Ollama endpoint failed through the protected tunnel; verify the Tailscale SSH local forward and Windows loopback Ollama service";

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

export async function preflightProtectedOllamaEndpoint(
  endpoint: SelectedModelEndpointConfig,
  probe: ProtectedOllamaEndpointPreflightProbe
): Promise<ProtectedOllamaEndpointPreflightResult> {
  let checkedUrl = "unavailable";
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    checkedUrl = new URL("/api/tags", endpoint.host.tunnel.localBaseUrl).toString();
    const abortController = new AbortController();
    timeout = setTimeout(() => {
      abortController.abort();
    }, probe.timeoutMs);

    const response = await (probe.fetchTags ?? fetchProtectedOllamaTags)(
      checkedUrl,
      abortController.signal,
      buildSelectedModelEndpointAuthHeaders(endpoint)
    );

    if (!response.ok) {
      return failedPreflight(endpoint, checkedUrl, failedHttpPreflightReason(response.status));
    }

    const tags = parseOllamaTagsResponse((await response.json()) as unknown);
    const hasSelectedModel = tags.models.some((model) => model.name === endpoint.model);

    if (!hasSelectedModel) {
      return failedPreflight(
        endpoint,
        checkedUrl,
        `pico protected Ollama endpoint could not find ${endpoint.model} in /api/tags`
      );
    }

    return {
      status: "passed",
      endpointId: endpoint.id,
      checkedUrl,
      model: endpoint.model,
      modelCount: tags.models.length
    };
  } catch (error) {
    if (isAbortError(error)) {
      return failedPreflight(
        endpoint,
        checkedUrl,
        `pico protected Ollama endpoint timed out after ${probe.timeoutMs} ms; verify the Tailscale SSH local forward and Windows loopback Ollama service`
      );
    }

    return failedPreflight(endpoint, checkedUrl, protectedOllamaTunnelFailureMessage);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function failedPreflight(
  endpoint: SelectedModelEndpointConfig,
  checkedUrl: string,
  reason: string
): ProtectedOllamaEndpointPreflightResult {
  return {
    status: "failed",
    endpointId: endpoint.id,
    checkedUrl,
    model: endpoint.model,
    reason
  };
}

function failedHttpPreflightReason(status: number): string {
  if (status === 401 || status === 403) {
    return "pico protected Ollama endpoint requires unexpected auth; verify the SSH tunnel points to the Windows Ollama loopback port";
  }

  return `pico protected Ollama endpoint /api/tags failed with status ${status}`;
}

function fetchProtectedOllamaTags(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers,
    signal
  });
}

function parseOllamaTagsResponse(value: unknown): OllamaTagsResponse {
  const response = requireRecord(value, malformedOllamaTagsMessage);

  if (!Array.isArray(response.models)) {
    throw new Error(malformedOllamaTagsMessage);
  }

  return {
    models: response.models.map(requireOllamaModelTag)
  };
}

function requireOllamaModelTag(value: unknown): { readonly name: string } {
  const model = requireRecord(value, malformedOllamaTagsMessage);

  if (typeof model.name !== "string" || model.name.trim() === "") {
    throw new Error(malformedOllamaTagsMessage);
  }

  return {
    name: model.name
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
