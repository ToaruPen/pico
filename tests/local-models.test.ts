import { describe, expect, it } from "vitest";

import { defineSelectedModelEndpoint } from "../src/modules/local-models/index.js";

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

  it("selects exactly one protected Windows Ollama endpoint", () => {
    const endpoint = defineSelectedModelEndpoint(protectedEndpoint);

    expect(endpoint).toEqual(protectedEndpoint);
  });
});
