import { describe, expect, it } from "vitest";

import { mem0RuntimeSmokeExitCode, runMem0RuntimeSmoke } from "../scripts/smoke/mem0-runtime.js";
import { definePicoConfig } from "../src/config/index.js";
import type {
  Mem0AddRequest,
  Mem0AddResponse,
  Mem0Client,
  Mem0SearchRequest,
  Mem0SearchResponse
} from "../src/modules/long-memory/mem0.js";

function enabledConfig() {
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
          model: "embeddinggemma:latest",
          embeddingDims: 768
        }
      }
    }
  });
}

describe("Mem0 runtime smoke", () => {
  it("skips when Mem0 is disabled", async () => {
    await expect(runMem0RuntimeSmoke(definePicoConfig({}))).resolves.toEqual({
      status: "skipped",
      provider: "mem0-oss",
      reason: "Set memory.mem0.enabled=true to run the Mem0 runtime smoke."
    });
  });

  it("adds, searches, deletes, and reports lifecycle audit evidence", async () => {
    const calls: string[] = [];
    const client: Mem0Client = {
      add: (request: Mem0AddRequest): Promise<Mem0AddResponse> => {
        calls.push(`add:${request.scopeId}:${request.messages.length}`);

        return Promise.resolve({
          memories: [{ id: "mem0-smoke-1" }]
        });
      },
      search: (request: Mem0SearchRequest): Promise<Mem0SearchResponse> => {
        calls.push(`search:${request.scopeId}:${request.query}`);

        return Promise.resolve({
          memories: [
            {
              id: "mem0-smoke-1",
              content: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
              score: 0.9
            }
          ]
        });
      },
      delete: (memoryId: string): Promise<void> => {
        calls.push(`delete:${memoryId}`);

        return Promise.resolve();
      }
    };

    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createClient: () => client
    });

    expect(report).toEqual({
      status: "passed",
      provider: "mem0-oss",
      details: {
        scopeId: "pico-smoke",
        memoryCount: 1,
        searchResultCount: 1,
        auditEventCount: 3,
        otelRecordCount: 3
      }
    });
    expect(calls).toEqual([
      "add:pico-smoke:2",
      "search:pico-smoke:工作セット",
      "delete:mem0-smoke-1"
    ]);
    expect(JSON.stringify(report)).not.toContain("雨の日は工作セット");
    expect(mem0RuntimeSmokeExitCode(report)).toBe(0);
  });

  it("fails when the runtime add/search/delete path fails", async () => {
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createClient: () => ({
        add: () => Promise.reject(new Error("qdrant unavailable")),
        search: () => Promise.resolve({ memories: [] }),
        delete: () => Promise.resolve()
      })
    });

    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason: "pico Mem0 runtime smoke failed: qdrant unavailable"
    });
    expect(mem0RuntimeSmokeExitCode(report)).toBe(1);
  });

  it("deletes added smoke memories when search validation fails", async () => {
    const calls: string[] = [];
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createClient: () => ({
        add: () =>
          Promise.resolve({
            memories: [{ id: "mem0-smoke-1" }]
          }),
        search: () => Promise.resolve({ memories: [] }),
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return Promise.resolve();
        }
      })
    });

    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason: "pico Mem0 runtime smoke failed: Mem0 search returned no memories"
    });
    expect(calls).toEqual(["delete:mem0-smoke-1"]);
  });
});
