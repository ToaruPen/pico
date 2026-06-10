import { describe, expect, it } from "vitest";

import {
  buildOllamaVlmSmokePlan,
  ollamaVlmSmokeExitCode,
  runOllamaVlmConnectivitySmoke
} from "../scripts/smoke/ollama-vlm-connectivity.js";
import { definePicoConfig } from "../src/config/index.js";

function tagsResponse(models: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      models: models.map((name) => ({ name }))
    }),
    { status: 200 }
  );
}

describe("Ollama VLM connectivity smoke configuration", () => {
  it("skips when the protected local Ollama endpoint is not configured", async () => {
    await expect(
      runOllamaVlmConnectivitySmoke(definePicoConfig({}), () =>
        Promise.reject(new Error("should not fetch"))
      )
    ).resolves.toEqual({
      status: "skipped",
      provider: "ollama",
      reason: "Set vision.ollama in pico config to run the Ollama VLM connectivity smoke."
    });
  });

  it("builds the selected protected Windows Ollama endpoint from YAML config", () => {
    const plan = buildOllamaVlmSmokePlan(
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: " http://127.0.0.1:11434 ",
            tunnel: {
              kind: "cloudflare_access_ssh",
              sshTarget: "vision-host"
            },
            timeoutMs: 15_000
          }
        }
      })
    );

    expect(plan).toEqual({
      status: "run",
      timeoutMs: 15_000,
      endpoint: {
        id: "windows-ollama-qwen3-5",
        provider: "ollama",
        model: "qwen3.5:9b",
        host: {
          platform: "windows",
          tunnel: {
            kind: "cloudflare_access_ssh",
            localBaseUrl: "http://127.0.0.1:11434",
            sshTarget: "vision-host"
          }
        }
      }
    });
  });

  it("rejects direct non-loopback Ollama endpoints", () => {
    expect(() =>
      buildOllamaVlmSmokePlan(
        definePicoConfig({
          vision: {
            ollama: {
              localBaseUrl: "http://192.168.0.10:11434"
            }
          }
        })
      )
    ).toThrow("pico config vision.ollama.localBaseUrl must use a local SSH tunnel URL");
  });

  it("rejects invalid timeout configuration", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            timeoutMs: 0
          }
        }
      })
    ).toThrow("pico config vision.ollama.timeoutMs must be a positive integer");
  });

  it("accepts the maximum Node timer timeout value", () => {
    const plan = buildOllamaVlmSmokePlan(
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            timeoutMs: 2_147_483_647
          }
        }
      })
    );

    expect(plan.status).toBe("run");
    if (plan.status !== "run") {
      throw new Error("Expected the boundary timeout to produce a run plan.");
    }
    expect(plan.timeoutMs).toBe(2_147_483_647);
  });

  it("rejects timeout values that exceed Node timer limits", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            timeoutMs: 2_147_483_648
          }
        }
      })
    ).toThrow("pico config vision.ollama.timeoutMs must be a positive integer <= 2147483647");
  });

  it("passes when qwen3.5:9b is listed in Ollama tags", async () => {
    const requestedUrls: string[] = [];
    const report = await runOllamaVlmConnectivitySmoke(
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      (input) => {
        requestedUrls.push(requestUrl(input));

        return Promise.resolve(tagsResponse(["llama3.2:latest", "qwen3.5:9b"]));
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "ollama",
      details: {
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        checkedUrl: "http://127.0.0.1:11434/api/tags",
        modelCount: 2
      }
    });
    expect(requestedUrls).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });

  it("fails when the selected qwen3.5:9b model is absent", async () => {
    const report = await runOllamaVlmConnectivitySmoke(
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434"
          }
        }
      }),
      () => Promise.resolve(tagsResponse(["llama3.2:latest"]))
    );

    expect(report).toEqual({
      status: "failed",
      provider: "ollama",
      reason: "pico Ollama VLM smoke could not find qwen3.5:9b in /api/tags"
    });
    expect(ollamaVlmSmokeExitCode(report)).toBe(1);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}
