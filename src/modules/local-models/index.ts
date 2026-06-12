import type { PicoModule } from "../../orchestrator/contracts.js";

export type ProtectedSshTunnelKind = "tailscale_ssh" | "cloudflare_access_ssh";

export type SelectedModelEndpointConfig = {
  readonly id: string;
  readonly provider: "ollama";
  readonly model: "qwen3.5:9b";
  readonly host: {
    readonly platform: "windows";
    readonly tunnel: {
      readonly kind: ProtectedSshTunnelKind;
      readonly localBaseUrl: string;
      readonly sshTarget: string;
    };
    readonly auth?: {
      readonly headerName?: string;
      readonly apiKey: string;
    };
  };
};

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

export function buildSelectedModelEndpointAuthHeaders(
  endpoint: SelectedModelEndpointConfig
): Record<string, string> {
  const auth = endpoint.host.auth;

  if (auth === undefined) {
    return {};
  }

  return {
    [auth.headerName ?? "x-api-key"]: auth.apiKey
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }

  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function requireProtectedTunnelKind(value: unknown): ProtectedSshTunnelKind {
  if (value === "tailscale_ssh" || value === "cloudflare_access_ssh") {
    return value;
  }

  throw new Error("pico local model endpoint must use a protected SSH tunnel");
}

function requireHttpUrl(parsedUrl: URL): void {
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("pico local model endpoint localBaseUrl must use HTTP");
  }
}

function requireOriginUrl(parsedUrl: URL): void {
  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw new Error("pico local model endpoint localBaseUrl must be an origin URL");
  }
}

function requireLocalTunnelUrl(parsedUrl: URL): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(parsedUrl.hostname)) {
    throw new Error("pico local model endpoint must use a local SSH tunnel URL");
  }
}

function requireLocalTunnelBaseUrl(value: unknown): string {
  const localBaseUrl = requireString(value, "pico local model endpoint localBaseUrl is required");

  if (!URL.canParse(localBaseUrl)) {
    throw new Error("pico local model endpoint localBaseUrl must be a valid URL");
  }

  const parsedUrl = new URL(localBaseUrl);

  requireHttpUrl(parsedUrl);
  requireOriginUrl(parsedUrl);
  requireLocalTunnelUrl(parsedUrl);

  return localBaseUrl;
}

export function defineSelectedModelEndpoint(input: unknown): SelectedModelEndpointConfig {
  if (input === undefined) {
    throw new Error("pico local model endpoint config is required");
  }

  const endpoint = requireRecord(input, "pico local model endpoint must be one config object");
  const host = requireRecord(endpoint.host, "pico local model endpoint host is required");
  const tunnel = requireRecord(host.tunnel, "pico local model endpoint tunnel is required");
  const auth = readOptionalRecord(host.auth, "pico local model endpoint auth");

  return {
    id: requireString(endpoint.id, "pico local model endpoint id is required"),
    provider: requireOllamaProvider(endpoint.provider),
    model: requireQwenModel(endpoint.model),
    host: {
      platform: requireWindowsHost(host.platform),
      tunnel: {
        kind: requireProtectedTunnelKind(tunnel.kind),
        localBaseUrl: requireLocalTunnelBaseUrl(tunnel.localBaseUrl),
        sshTarget: requireString(
          tunnel.sshTarget,
          "pico local model endpoint sshTarget is required"
        )
      },
      ...(auth === undefined
        ? {}
        : {
            auth: {
              ...optionalHeaderName(auth.headerName),
              apiKey: requireString(
                auth.apiKey,
                "pico local model endpoint auth apiKey is required"
              )
            }
          })
    }
  };
}

function readOptionalRecord(value: unknown, message: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireRecord(value, message);
}

function optionalHeaderName(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  const headerName = requireString(value, "pico local model endpoint auth headerName is required");

  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(headerName)) {
    throw new Error("pico local model endpoint auth headerName must be a valid HTTP header name");
  }

  return { headerName };
}

function requireOllamaProvider(value: unknown): "ollama" {
  if (value === "ollama") {
    return value;
  }

  throw new Error("pico local model endpoint provider must be ollama");
}

function requireQwenModel(value: unknown): "qwen3.5:9b" {
  if (value === "qwen3.5:9b") {
    return value;
  }

  throw new Error("pico local model endpoint model must be qwen3.5:9b");
}

function requireWindowsHost(value: unknown): "windows" {
  if (value === "windows") {
    return value;
  }

  throw new Error("pico local model endpoint host platform must be windows");
}
