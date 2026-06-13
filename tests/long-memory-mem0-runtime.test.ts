import { describe, expect, it, vi } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import type { buildMem0OssConfig } from "../src/modules/long-memory/mem0-runtime.js";
import { createMem0OssClient } from "../src/modules/long-memory/mem0-runtime.js";

type CapturedMem0Config = ReturnType<typeof buildMem0OssConfig>;

function mem0EnabledConfig() {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        infer: false,
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
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    }
  }).memory.mem0;
}

function mem0EnabledConfigWithoutInfer() {
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
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    }
  }).memory.mem0;
}

describe("Mem0 OSS runtime client", () => {
  it("disables Mem0 OSS telemetry before constructing the runtime", async () => {
    const previousTelemetry = process.env.MEM0_TELEMETRY;
    delete process.env.MEM0_TELEMETRY;

    try {
      await createMem0OssClient(mem0EnabledConfig(), {
        createMemory: () => {
          expect(process.env.MEM0_TELEMETRY).toBe("false");

          return {
            add: () => Promise.resolve({ results: [] }),
            search: () => Promise.resolve({ results: [] }),
            delete: () => Promise.resolve({ message: "deleted" })
          };
        }
      });
    } finally {
      if (previousTelemetry === undefined) {
        delete process.env.MEM0_TELEMETRY;
      } else {
        process.env.MEM0_TELEMETRY = previousTelemetry;
      }
    }
  });

  it("builds a local-only Mem0 OSS configuration from pico config", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    const client = await createMem0OssClient(mem0EnabledConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      }
    });

    await client.add({
      messages: [{ role: "user", content: "雨の日は工作セットを早めに出す。" }],
      scopeId: "pico-facility",
      metadata: {
        source_session_id: "session-1",
        source_entry_ids: ["entry-1"],
        cutoff_at: "2026-06-10T18:30:00.000Z",
        requested_by: "pico"
      }
    });

    expect(capturedConfig).toMatchObject({
      historyDbPath: "/var/lib/pico/mem0-history.sqlite",
      vectorStore: {
        provider: "qdrant",
        config: {
          url: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory",
          dimension: 768
        }
      },
      llm: {
        provider: "ollama",
        config: {
          url: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        }
      },
      embedder: {
        provider: "ollama",
        config: {
          url: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    });
    expect(JSON.stringify(capturedConfig)).not.toContain("openai");
  });

  it("adapts add, search, and delete to the existing Mem0 client contract", async () => {
    const calls: string[] = [];
    const client = await createMem0OssClient(mem0EnabledConfig(), {
      createMemory: () => ({
        add: (messages, options) => {
          const sourceSessionId = options.metadata?.source_session_id;

          if (typeof sourceSessionId !== "string") {
            throw new Error("expected source session id metadata");
          }
          calls.push(`add:${options.userId}:${sourceSessionId}:${String(options.infer)}`);
          expect(messages).toEqual([{ role: "user", content: "工作セットを準備する。" }]);

          return Promise.resolve({
            results: [
              {
                id: "mem0-1",
                memory: "工作セットを準備する。"
              }
            ]
          });
        },
        search: (query, options) => {
          const userId = options.filters?.user_id;

          if (typeof userId !== "string") {
            throw new Error("expected Mem0 search user_id filter");
          }
          calls.push(`search:${query}:${userId}`);

          return Promise.resolve({
            results: [
              {
                id: "mem0-1",
                memory: "工作セットを準備する。",
                score: 0.92
              }
            ]
          });
        },
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return Promise.resolve({ message: "deleted" });
        }
      })
    });

    await expect(
      client.add({
        messages: [{ role: "user", content: "工作セットを準備する。" }],
        scopeId: "pico-facility",
        metadata: {
          source_session_id: "session-1",
          source_entry_ids: ["entry-1"],
          cutoff_at: "2026-06-10T18:30:00.000Z",
          requested_by: "pico"
        }
      })
    ).resolves.toEqual({
      memories: [
        {
          id: "mem0-1",
          content: "工作セットを準備する。"
        }
      ]
    });
    await expect(
      client.search({
        query: "工作",
        scopeId: "pico-facility"
      })
    ).resolves.toEqual({
      memories: [
        {
          id: "mem0-1",
          content: "工作セットを準備する。",
          score: 0.92
        }
      ]
    });
    await client.delete("mem0-1");

    expect(calls).toEqual([
      "add:pico-facility:session-1:false",
      "search:工作:pico-facility",
      "delete:mem0-1"
    ]);
  });

  it("defaults Mem0 inference to false when config does not opt in", async () => {
    const calls: string[] = [];
    const client = await createMem0OssClient(mem0EnabledConfigWithoutInfer(), {
      createMemory: () => ({
        add: (_messages, options) => {
          calls.push(`infer:${String(options.infer)}`);

          return Promise.resolve({
            results: [{ id: "mem0-1", memory: "工作セットを準備する。" }]
          });
        },
        search: () => Promise.resolve({ results: [] }),
        delete: () => Promise.resolve({ message: "deleted" })
      })
    });

    await client.add({
      messages: [{ role: "user", content: "工作セットを準備する。" }],
      scopeId: "pico-facility",
      metadata: {
        source_session_id: "session-1",
        source_entry_ids: ["entry-1"],
        cutoff_at: "2026-06-10T18:30:00.000Z",
        requested_by: "pico"
      }
    });

    expect(calls).toEqual(["infer:false"]);
  });

  it("rejects missing local Ollama models before constructing the default runtime", async () => {
    await expect(
      createMem0OssClient(mem0EnabledConfig(), {
        fetchOllamaTags: () =>
          Promise.resolve({
            models: [{ name: "qwen3.5:9b" }]
          })
      })
    ).rejects.toThrow(
      "pico Mem0 runtime requires local Ollama model nomic-embed-text to be available before Mem0 startup"
    );
  });

  it("times out local Ollama model preflight when the model endpoint does not settle", async () => {
    vi.useFakeTimers();

    try {
      const client = createMem0OssClient(mem0EnabledConfig(), {
        fetchOllamaTags: () => new Promise<unknown>(() => undefined),
        modelPreflightTimeoutMs: 25
      });
      const expectedRejection = expect(client).rejects.toThrow(
        "pico Mem0 runtime Ollama model list for qwen3.5:9b timed out after 25 ms"
      );

      await vi.advanceTimersByTimeAsync(25);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects disabled Mem0 config before constructing a runtime client", async () => {
    await expect(
      createMem0OssClient(definePicoConfig({}).memory.mem0, {
        createMemory: () => {
          throw new Error("should not construct Mem0");
        }
      })
    ).rejects.toThrow("pico Mem0 runtime requires memory.mem0.enabled=true");
  });
});
