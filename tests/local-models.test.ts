import { describe, expect, it } from "vitest";

import { defineSelectedModelEndpoint } from "../src/modules/local-models/index.js";
import { buildCredentialedUrl } from "./support/url-fixtures.js";

const protectedEndpoint = {
  id: "windows-ollama-qwen3-5",
  provider: "ollama",
  model: "qwen3.5:9b",
  host: {
    platform: "windows",
    tunnel: {
      kind: "tailscale_ssh",
      localBaseUrl: "http://127.0.0.1:11434",
      sshTarget: "pico-vision-host"
    }
  }
} as const;

describe("selected local model endpoint config", () => {
  it("requires an explicit endpoint config", () => {
    expect(() => defineSelectedModelEndpoint(undefined)).toThrow(
      "pico local model endpoint config is required"
    );
  });

  it("rejects endpoint lists instead of selecting from alternatives", () => {
    expect(() => defineSelectedModelEndpoint([protectedEndpoint])).toThrow(
      "pico local model endpoint must be one config object"
    );
  });

  it("rejects direct or public model endpoint shapes", () => {
    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          platform: "windows",
          tunnel: {
            kind: "direct",
            localBaseUrl: "http://192.168.1.20:11434",
            sshTarget: "pico-vision-host"
          }
        }
      })
    ).toThrow("pico local model endpoint must use a protected SSH tunnel");
  });

  it("rejects non-HTTP local tunnel endpoint URLs", () => {
    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          platform: "windows",
          tunnel: {
            kind: "tailscale_ssh",
            localBaseUrl: "ftp://localhost:21",
            sshTarget: "pico-vision-host"
          }
        }
      })
    ).toThrow("pico local model endpoint localBaseUrl must use HTTP");
  });

  it("rejects local tunnel endpoint URLs with paths or query strings", () => {
    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          platform: "windows",
          tunnel: {
            kind: "tailscale_ssh",
            localBaseUrl: "http://127.0.0.1:11434/api/chat?model=qwen3.5:9b",
            sshTarget: "pico-vision-host"
          }
        }
      })
    ).toThrow("pico local model endpoint localBaseUrl must be an origin URL");
  });

  it("rejects non-loopback local tunnel endpoint URLs", () => {
    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          platform: "windows",
          tunnel: {
            kind: "tailscale_ssh",
            localBaseUrl: "http://192.168.0.5:11434",
            sshTarget: "pico-vision-host"
          }
        }
      })
    ).toThrow("pico local model endpoint must use a local SSH tunnel URL");
  });

  it("rejects credentialed local tunnel endpoint URLs", () => {
    const credentialedTunnelUrl = buildCredentialedUrl(protectedEndpoint.host.tunnel.localBaseUrl, {
      username: "fixture-user",
      password: "fixture-password"
    });

    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          platform: "windows",
          tunnel: {
            kind: "tailscale_ssh",
            localBaseUrl: credentialedTunnelUrl,
            sshTarget: "pico-vision-host"
          }
        }
      })
    ).toThrow("pico local model endpoint localBaseUrl must be an origin URL");
  });

  it("selects exactly one protected Windows Ollama endpoint", () => {
    const endpoint = defineSelectedModelEndpoint(protectedEndpoint);

    expect(endpoint).toEqual(protectedEndpoint);
  });

  it("accepts an optional auth header for protected Ollama proxies", () => {
    const endpoint = defineSelectedModelEndpoint({
      ...protectedEndpoint,
      host: {
        ...protectedEndpoint.host,
        auth: {
          headerName: "x-api-key",
          apiKey: "local-dev-key"
        }
      }
    });

    expect(endpoint.host.auth).toEqual({
      headerName: "x-api-key",
      apiKey: "local-dev-key"
    });
  });

  it("rejects invalid protected Ollama auth header names", () => {
    expect(() =>
      defineSelectedModelEndpoint({
        ...protectedEndpoint,
        host: {
          ...protectedEndpoint.host,
          auth: {
            headerName: "x api key",
            apiKey: "local-dev-key"
          }
        }
      })
    ).toThrow("pico local model endpoint auth headerName must be a valid HTTP header name");
  });
});
