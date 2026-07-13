import { describe, expect, it, vi } from "vitest";

import {
  type Mem0RuntimeSmokeDependencies,
  mem0RuntimeSmokeExitCode,
  runMem0RuntimeSmoke
} from "../scripts/smoke/mem0-runtime.js";
import { definePicoConfig } from "../src/config/index.js";
import type { FacilityMemoryExtractor } from "../src/modules/long-memory/extractor.js";
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
        worker: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "arbitrary-smoke-worker",
          thinkingLevel: "high",
          timeoutMs: 60_000
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

function createSmokeExtractor(): FacilityMemoryExtractor {
  return {
    extract: (cutoff) =>
      Promise.resolve([
        {
          title: "雨の日の工作準備",
          body: cutoff.entries[0]?.content ?? "missing smoke entry",
          category: "facility_knowledge",
          tags: ["smoke"],
          sourceEntryIds: [cutoff.sourceEntryIds[0] ?? "missing"],
          confidence: 1
        }
      ])
  };
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
        expect(request.metadata.source_session_id).toBe("mem0-smoke-session-test-run");
        expect(request.messages.every((message) => message.content.includes("test-run"))).toBe(
          true
        );

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
      createExtractor: createSmokeExtractor,
      createClient: () => client,
      createRunId: () => "test-run"
    });

    expect(report).toEqual({
      status: "passed",
      provider: "mem0-oss",
      details: {
        scopeId: "pico-smoke-test-run",
        memoryCount: 1,
        searchResultCount: 1,
        auditEventCount: 3,
        otelRecordCount: 3
      }
    });
    expect(calls).toEqual([
      "add:pico-smoke-test-run:1",
      "search:pico-smoke-test-run:test-run",
      "delete:mem0-smoke-1"
    ]);
    expect(JSON.stringify(report)).not.toContain("雨の日は工作セット");
    expect(mem0RuntimeSmokeExitCode(report)).toBe(0);
  });

  it("runs the configured extraction worker before writing the smoke memory", async () => {
    let observedModel: string | undefined;
    const dependencies: Mem0RuntimeSmokeDependencies = {
      createRunId: () => "worker-run",
      createExtractor: (worker): FacilityMemoryExtractor => {
        observedModel = worker.model;

        return {
          extract: (cutoff) =>
            Promise.resolve([
              {
                title: "抽出された施設知識",
                body: `抽出workerを通った。 run:worker-run`,
                category: "facility_knowledge",
                tags: ["smoke"],
                sourceEntryIds: [cutoff.sourceEntryIds[0] ?? "missing"],
                confidence: 0.9
              }
            ])
        };
      },
      createClient: (): Mem0Client => ({
        add: (request) => {
          expect(request.messages[0]?.content).toContain("抽出workerを通った");

          return Promise.resolve({ memories: [{ id: "worker-memory" }] });
        },
        search: () =>
          Promise.resolve({
            memories: [{ id: "worker-memory", content: "抽出workerを通った。" }]
          }),
        delete: () => Promise.resolve()
      })
    };

    await expect(runMem0RuntimeSmoke(enabledConfig(), dependencies)).resolves.toMatchObject({
      status: "passed"
    });
    expect(observedModel).toBe("arbitrary-smoke-worker");
  });

  it("fails when the runtime add/search/delete path fails", async () => {
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createExtractor: createSmokeExtractor,
      createClient: () => ({
        add: () => Promise.reject(new Error("qdrant unavailable")),
        search: () => Promise.resolve({ memories: [] }),
        delete: () => Promise.resolve()
      }),
      createRunId: () => "test-run"
    });

    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason: "pico Mem0 runtime smoke failed: qdrant unavailable"
    });
    expect(mem0RuntimeSmokeExitCode(report)).toBe(1);
  });

  it("fails when search does not return a memory created by this run", async () => {
    const calls: string[] = [];
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createExtractor: createSmokeExtractor,
      createClient: () => ({
        add: () =>
          Promise.resolve({
            memories: [{ id: "mem0-smoke-1" }]
          }),
        search: () =>
          Promise.resolve({
            memories: [
              {
                id: "stale-memory",
                content: "stale memory",
                score: 0.9
              }
            ]
          }),
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return Promise.resolve();
        }
      }),
      createRunId: () => "test-run"
    });

    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason:
        "pico Mem0 runtime smoke failed: Mem0 search did not return a memory created by this smoke run"
    });
    expect(calls).toEqual(["delete:mem0-smoke-1"]);
  });

  it("preserves the primary search failure when cleanup also fails", async () => {
    const calls: string[] = [];
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createExtractor: createSmokeExtractor,
      createClient: () => ({
        add: () =>
          Promise.resolve({
            memories: [{ id: "mem0-smoke-1" }]
          }),
        search: () =>
          Promise.resolve({
            memories: [
              {
                id: "stale-memory",
                content: "stale memory",
                score: 0.9
              }
            ]
          }),
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return Promise.reject(new Error("delete failed"));
        }
      }),
      createRunId: () => "test-run"
    });

    expect(calls).toEqual(["delete:mem0-smoke-1"]);
    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason:
        "pico Mem0 runtime smoke failed: Mem0 search did not return a memory created by this smoke run; cleanup also failed: Mem0 cleanup failed for 1 memory id(s): mem0-smoke-1: delete failed"
    });
  });

  it("attempts to delete every memory created by a failed smoke run", async () => {
    const calls: string[] = [];
    const report = await runMem0RuntimeSmoke(enabledConfig(), {
      createExtractor: createSmokeExtractor,
      createClient: () => ({
        add: () =>
          Promise.resolve({
            memories: [{ id: "mem0-smoke-1" }, { id: "mem0-smoke-2" }]
          }),
        search: () =>
          Promise.resolve({
            memories: [
              {
                id: "mem0-smoke-1",
                content: "first memory",
                score: 0.9
              }
            ]
          }),
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return memoryId === "mem0-smoke-1"
            ? Promise.reject(new Error("delete failed"))
            : Promise.resolve();
        }
      }),
      createRunId: () => "test-run"
    });

    expect(calls).toEqual(["delete:mem0-smoke-1", "delete:mem0-smoke-2"]);
    expect(report).toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason:
        "pico Mem0 runtime smoke failed: Mem0 cleanup failed for 1 memory id(s): mem0-smoke-1: delete failed"
    });
  });

  it("fails instead of hanging when Mem0 operations do not settle", async () => {
    vi.useFakeTimers();

    try {
      const report = runMem0RuntimeSmoke(enabledConfig(), {
        createExtractor: createSmokeExtractor,
        createClient: () => ({
          add: () => new Promise<Mem0AddResponse>(() => undefined),
          search: () => Promise.resolve({ memories: [] }),
          delete: () => Promise.resolve()
        }),
        createRunId: () => "test-run",
        timeoutMs: 25
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25);

      await expect(report).resolves.toEqual({
        status: "failed",
        provider: "mem0-oss",
        reason: "pico Mem0 runtime smoke failed: Mem0 add timed out after 25 ms"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails instead of hanging when Mem0 client startup does not settle", async () => {
    vi.useFakeTimers();

    try {
      const report = runMem0RuntimeSmoke(enabledConfig(), {
        createExtractor: createSmokeExtractor,
        createClient: () => new Promise<Mem0Client>(() => undefined),
        createRunId: () => "test-run",
        timeoutMs: 25
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(report).resolves.toEqual({
        status: "failed",
        provider: "mem0-oss",
        reason: "pico Mem0 runtime smoke failed: Mem0 client startup timed out after 25 ms"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up memories when Mem0 add resolves after the smoke timeout", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let resolveAdd: ((response: Mem0AddResponse) => void) | undefined;

    try {
      const report = runMem0RuntimeSmoke(enabledConfig(), {
        createExtractor: createSmokeExtractor,
        createClient: () => ({
          add: () =>
            new Promise<Mem0AddResponse>((resolve) => {
              resolveAdd = resolve;
            }),
          search: () => Promise.resolve({ memories: [] }),
          delete: (memoryId) => {
            calls.push(`delete:${memoryId}`);

            return Promise.resolve();
          }
        }),
        createRunId: () => "test-run",
        timeoutMs: 25
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolveAdd).toBeTypeOf("function");
      await vi.advanceTimersByTimeAsync(25);

      await expect(report).resolves.toEqual({
        status: "failed",
        provider: "mem0-oss",
        reason: "pico Mem0 runtime smoke failed: Mem0 add timed out after 25 ms"
      });

      resolveAdd?.({
        memories: [{ id: "mem0-late-1" }, { id: "mem0-late-2" }]
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual(["delete:mem0-late-1", "delete:mem0-late-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports config load failures as smoke failures", async () => {
    await expect(
      runMem0RuntimeSmoke(undefined, {
        loadConfig: () => {
          throw new Error("invalid local config");
        }
      })
    ).resolves.toEqual({
      status: "failed",
      provider: "mem0-oss",
      reason: "pico Mem0 runtime smoke failed: invalid local config"
    });
  });
});
