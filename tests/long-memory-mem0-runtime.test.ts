import { describe, expect, it } from "vitest";

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

describe("Mem0 OSS runtime client", () => {
  it("builds a local-only Mem0 OSS configuration from pico config", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    const client = createMem0OssClient(mem0EnabledConfig(), {
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
    const client = createMem0OssClient(mem0EnabledConfig(), {
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

  it("rejects disabled Mem0 config before constructing a runtime client", () => {
    expect(() =>
      createMem0OssClient(definePicoConfig({}).memory.mem0, {
        createMemory: () => {
          throw new Error("should not construct Mem0");
        }
      })
    ).toThrow("pico Mem0 runtime requires memory.mem0.enabled=true");
  });
});
