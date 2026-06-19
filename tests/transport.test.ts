import { describe, expect, it } from "vitest";

import { defineSelectedModelEndpoint } from "../src/modules/local-models/index.js";
import {
  checkProtectedModelEndpointConnectivity,
  preflightProtectedOllamaEndpoint
} from "../src/modules/transport/index.js";

const selectedEndpoint = defineSelectedModelEndpoint({
  id: "windows-ollama-qwen3-5",
  provider: "ollama",
  model: "qwen3.5:9b",
  host: {
    platform: "windows",
    tunnel: {
      kind: "cloudflare_access_ssh",
      localBaseUrl: "http://127.0.0.1:11434",
      sshTarget: "pico-vision-host"
    }
  }
});

describe("protected model endpoint connectivity", () => {
  it("checks connectivity through the validated selected endpoint", async () => {
    const checkedUrls: string[] = [];

    const result = await checkProtectedModelEndpointConnectivity(selectedEndpoint, {
      canReach(localBaseUrl) {
        checkedUrls.push(localBaseUrl);
        return Promise.resolve(true);
      }
    });

    expect(result).toEqual({
      endpointId: "windows-ollama-qwen3-5",
      reachable: true,
      checkedUrl: "http://127.0.0.1:11434"
    });
    expect(checkedUrls).toEqual(["http://127.0.0.1:11434"]);
  });

  it("reports unreachable protected endpoint connectivity without changing the selected endpoint", async () => {
    const checkedUrls: string[] = [];

    const result = await checkProtectedModelEndpointConnectivity(selectedEndpoint, {
      canReach(localBaseUrl) {
        checkedUrls.push(localBaseUrl);
        return Promise.resolve(false);
      }
    });

    expect(result).toEqual({
      endpointId: "windows-ollama-qwen3-5",
      reachable: false,
      checkedUrl: "http://127.0.0.1:11434"
    });
    expect(checkedUrls).toEqual(["http://127.0.0.1:11434"]);
  });
});

describe("protected Ollama endpoint preflight", () => {
  it("passes only through the selected protected tunnel when qwen3.5:9b is present", async () => {
    const requestedUrls: string[] = [];

    const result = await preflightProtectedOllamaEndpoint(selectedEndpoint, {
      timeoutMs: 1_000,
      fetchTags(url) {
        requestedUrls.push(url);

        return Promise.resolve(tagsResponse(["llama3.2:1b", "qwen3.5:9b"]));
      }
    });

    expect(result).toEqual({
      status: "passed",
      endpointId: "windows-ollama-qwen3-5",
      checkedUrl: "http://127.0.0.1:11434/api/tags",
      model: "qwen3.5:9b",
      modelCount: 2
    });
    expect(requestedUrls).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });

  it("reports an unexpected authenticated proxy instead of treating it as Ollama", async () => {
    const result = await preflightProtectedOllamaEndpoint(selectedEndpoint, {
      timeoutMs: 1_000,
      fetchTags() {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "unauthorized - API key required" }), {
            status: 401
          })
        );
      }
    });

    expect(result).toEqual({
      status: "failed",
      endpointId: "windows-ollama-qwen3-5",
      checkedUrl: "http://127.0.0.1:11434/api/tags",
      model: "qwen3.5:9b",
      reason:
        "pico protected Ollama endpoint requires unexpected auth; verify the SSH tunnel points to the Windows Ollama loopback port"
    });
  });

  it("reports protected tunnel reachability failures without exposing low-level details", async () => {
    const result = await preflightProtectedOllamaEndpoint(selectedEndpoint, {
      timeoutMs: 25,
      fetchTags(_url, signal) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("operation aborted", "AbortError"));
            },
            { once: true }
          );
        });
      }
    });

    expect(result).toEqual({
      status: "failed",
      endpointId: "windows-ollama-qwen3-5",
      checkedUrl: "http://127.0.0.1:11434/api/tags",
      model: "qwen3.5:9b",
      reason:
        "pico protected Ollama endpoint timed out after 25 ms; verify the Tailscale SSH local forward and Windows loopback Ollama service"
    });
  });

  it("fails when the selected model is absent from the protected endpoint", async () => {
    const result = await preflightProtectedOllamaEndpoint(selectedEndpoint, {
      timeoutMs: 1_000,
      fetchTags() {
        return Promise.resolve(tagsResponse(["llama3.2:1b"]));
      }
    });

    expect(result).toEqual({
      status: "failed",
      endpointId: "windows-ollama-qwen3-5",
      checkedUrl: "http://127.0.0.1:11434/api/tags",
      model: "qwen3.5:9b",
      reason: "pico protected Ollama endpoint could not find qwen3.5:9b in /api/tags"
    });
  });

  it("does not expose endpoint auth secrets from low-level fetch failures", async () => {
    const apiKey = "local-secret-api-key";
    const authenticatedEndpoint = defineSelectedModelEndpoint({
      id: "windows-ollama-qwen3-5",
      provider: "ollama",
      model: "qwen3.5:9b",
      host: {
        platform: "windows",
        tunnel: {
          kind: "tailscale_ssh",
          localBaseUrl: "http://127.0.0.1:11434",
          sshTarget: "pico-vision-host"
        },
        auth: {
          apiKey
        }
      }
    });

    const result = await preflightProtectedOllamaEndpoint(authenticatedEndpoint, {
      timeoutMs: 1_000,
      fetchTags() {
        return Promise.reject(new Error(`upstream client included ${apiKey} in diagnostics`));
      }
    });

    if (result.status !== "failed") {
      throw new Error("expected protected Ollama preflight to fail");
    }

    expect(result.reason).toBe(
      "pico protected Ollama endpoint failed through the protected tunnel; verify the Tailscale SSH local forward and Windows loopback Ollama service"
    );
    expect(result.reason).not.toContain(apiKey);
  });

  it("returns a structured failure when the endpoint URL cannot be parsed", async () => {
    const malformedEndpoint = {
      ...selectedEndpoint,
      host: {
        ...selectedEndpoint.host,
        tunnel: {
          ...selectedEndpoint.host.tunnel,
          localBaseUrl: "not a url"
        }
      }
    };

    const result = await preflightProtectedOllamaEndpoint(malformedEndpoint, {
      timeoutMs: 1_000
    });

    expect(result).toEqual({
      status: "failed",
      endpointId: "windows-ollama-qwen3-5",
      checkedUrl: "unavailable",
      model: "qwen3.5:9b",
      reason:
        "pico protected Ollama endpoint failed through the protected tunnel; verify the Tailscale SSH local forward and Windows loopback Ollama service"
    });
  });
});

function tagsResponse(models: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      models: models.map((name) => ({ name }))
    }),
    { status: 200 }
  );
}
