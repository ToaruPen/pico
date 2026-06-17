import { describe, expect, it, vi } from "vitest";

import {
  embeddingSidecarSmokeExitCode,
  runEmbeddingSidecarSmoke
} from "../scripts/smoke/embedding-sidecar.js";
import { definePicoConfig } from "../src/config/index.js";

function configWithSidecarEmbedder(embeddingDims = 3) {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory"
        },
        llm: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        },
        embedder: {
          provider: "sidecar",
          localBaseUrl: "http://127.0.0.1:18081",
          model: "jinaai/jina-embeddings-v5-text-small",
          embeddingDims,
          timeoutMs: 1000
        }
      }
    }
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof input === "string") {
    return input;
  }

  return input.url;
}

describe("embedding sidecar smoke", () => {
  it("skips when Mem0 is disabled", async () => {
    await expect(runEmbeddingSidecarSmoke(definePicoConfig({}))).resolves.toEqual({
      status: "skipped",
      provider: "embedding-sidecar",
      reason:
        "Set memory.mem0.enabled=true and memory.mem0.embedder.provider=sidecar to run the embedding sidecar smoke."
    });
  });

  it("skips when the configured Mem0 embedder is not a sidecar", async () => {
    const config = definePicoConfig({
      memory: {
        mem0: {
          enabled: true,
          historyDbPath: "/var/lib/pico/mem0-history.sqlite",
          vectorStore: {
            provider: "qdrant",
            localBaseUrl: "http://127.0.0.1:6333",
            collectionName: "pico_long_memory"
          },
          llm: {
            provider: "ollama",
            localBaseUrl: "http://127.0.0.1:11434",
            model: "qwen3.5:9b"
          },
          embedder: {
            provider: "ollama",
            localBaseUrl: "http://127.0.0.1:11434",
            model: "embeddinggemma:latest",
            embeddingDims: 768
          }
        }
      }
    });

    await expect(runEmbeddingSidecarSmoke(config)).resolves.toEqual({
      status: "skipped",
      provider: "embedding-sidecar",
      reason:
        "Set memory.mem0.enabled=true and memory.mem0.embedder.provider=sidecar to run the embedding sidecar smoke."
    });
  });

  it("posts Japanese and mixed-language probes to the configured sidecar", async () => {
    const requests: unknown[] = [];
    const report = await runEmbeddingSidecarSmoke(configWithSidecarEmbedder(), {
      fetchEmbeddingSidecar: (url, init) => {
        requests.push({
          url: requestUrl(url),
          body: init?.body
        });

        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        );
      }
    });

    expect(report).toEqual({
      status: "passed",
      provider: "embedding-sidecar",
      details: {
        model: "jinaai/jina-embeddings-v5-text-small",
        embeddingCount: 2,
        embeddingDims: 3
      }
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18081/v1/embeddings",
        body: JSON.stringify({
          model: "jinaai/jina-embeddings-v5-text-small",
          input: ["雨の日は工作セットを早めに準備する。", "sports event after school"]
        })
      }
    ]);
    expect(embeddingSidecarSmokeExitCode(report)).toBe(0);
  });

  it("fails when the sidecar returns the wrong embedding dimension", async () => {
    const report = await runEmbeddingSidecarSmoke(configWithSidecarEmbedder(1024), {
      fetchEmbeddingSidecar: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        )
    });

    expect(report).toEqual({
      status: "failed",
      provider: "embedding-sidecar",
      reason:
        "pico embedding sidecar smoke failed: embedding 0 dimension 3 does not match configured embeddingDims 1024"
    });
    expect(embeddingSidecarSmokeExitCode(report)).toBe(1);
  });

  it("times out stalled sidecar response bodies", async () => {
    vi.useFakeTimers();

    try {
      const reportPromise = runEmbeddingSidecarSmoke(configWithSidecarEmbedder(), {
        fetchEmbeddingSidecar: () =>
          Promise.resolve({
            ok: true,
            json: () => new Promise<unknown>(() => undefined)
          } as Response)
      });
      const expectedReport = expect(reportPromise).resolves.toEqual({
        status: "failed",
        provider: "embedding-sidecar",
        reason:
          "pico embedding sidecar smoke failed: embedding sidecar request timed out after 1000 ms"
      });

      await vi.advanceTimersByTimeAsync(1000);
      await expectedReport;
    } finally {
      vi.useRealTimers();
    }
  });
});
