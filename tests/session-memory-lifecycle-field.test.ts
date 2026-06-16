import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSessionMemoryLifecycleField,
  sessionMemoryLifecycleFieldExitCode
} from "../scripts/field/session-memory-lifecycle.js";
import { definePicoConfig } from "../src/config/index.js";
import type { Mem0Client } from "../src/modules/long-memory/mem0.js";

describe("session memory lifecycle field harness", () => {
  it("creates an entry-bearing cutoff, memory candidates, Mem0 memories, and OTel audit exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-field-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const exportedEvents: string[] = [];
    const addedRequests: unknown[] = [];
    const client = {
      add(request) {
        addedRequests.push(request);

        return Promise.resolve({
          memories: [
            {
              id: "mem0-field-1",
              content: "雨の日の工作準備"
            }
          ]
        });
      },
      search() {
        return Promise.resolve({ memories: [] });
      },
      delete() {
        return Promise.resolve();
      }
    } satisfies Mem0Client;

    try {
      const report = await runSessionMemoryLifecycleField(
        enabledSessionMemoryConfig(directory),
        {},
        {
          createRunId: () => "field-run-1",
          databasePath,
          createClient: () => Promise.resolve(client),
          createAuditExporter: () => ({
            export(event) {
              exportedEvents.push(event.name);

              return Promise.resolve();
            },
            shutdown() {
              return Promise.resolve();
            }
          })
        }
      );

      expect(report).toEqual({
        status: "passed",
        provider: "session+sqlite+mem0+otel",
        details: {
          runId: "field-run-1",
          sessionId: "session-1",
          sourceEntryCount: 2,
          candidateJobId: 1,
          candidateCount: 1,
          mem0MemoryCount: 1,
          auditEventCount: 6,
          exportedOtelRecordCount: 6,
          databasePath: "<injected-database-path>"
        }
      });
      expect(addedRequests).toHaveLength(1);
      expect(exportedEvents).toEqual([
        "session.started",
        "session.ended",
        "long_memory.candidate_job.enqueued",
        "long_memory.candidate.created",
        "long_memory.candidate_job.processed",
        "long_memory.mem0.added"
      ]);
      expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when Mem0 creates no memories from the cutoff payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-field-"));

    try {
      const report = await runSessionMemoryLifecycleField(
        enabledSessionMemoryConfig(directory),
        {},
        {
          createRunId: () => "field-run-empty-mem0",
          databasePath: join(directory, "long-memory.sqlite"),
          createClient: () =>
            Promise.resolve({
              add() {
                return Promise.resolve({ memories: [] });
              },
              search() {
                return Promise.resolve({ memories: [] });
              },
              delete() {
                return Promise.resolve();
              }
            }),
          createAuditExporter: () => ({
            export() {
              return Promise.resolve();
            },
            shutdown() {
              return Promise.resolve();
            }
          })
        }
      );

      expect(report).toEqual({
        status: "failed",
        provider: "session+sqlite+mem0+otel",
        reason: "pico session memory lifecycle field requires at least one Mem0 memory"
      });
      expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when OTel audit export fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-field-"));

    try {
      const report = await runSessionMemoryLifecycleField(
        enabledSessionMemoryConfig(directory),
        {},
        {
          createRunId: () => "field-run-otel-fail",
          databasePath: join(directory, "long-memory.sqlite"),
          createClient: () =>
            Promise.resolve({
              add() {
                return Promise.resolve({
                  memories: [
                    {
                      id: "mem0-field-1",
                      content: "rainy day preparation"
                    }
                  ]
                });
              },
              search() {
                return Promise.resolve({ memories: [] });
              },
              delete() {
                return Promise.resolve();
              }
            }),
          createAuditExporter: () => ({
            export() {
              return Promise.reject(new Error("collector unavailable"));
            },
            shutdown() {
              return Promise.resolve();
            }
          })
        }
      );

      expect(report).toEqual({
        status: "failed",
        provider: "session+sqlite+mem0+otel",
        reason: "pico session memory lifecycle field failed: collector unavailable"
      });
      expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects environment database path overrides for field evidence", async () => {
    const report = await runSessionMemoryLifecycleField(
      enabledSessionMemoryConfig(".pico-local/test-session-memory-field"),
      {
        PICO_FIELD_SESSION_MEMORY_DB_PATH: "/tmp/pico-field.sqlite"
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "session+sqlite+mem0+otel",
      reason:
        "PICO_FIELD_SESSION_MEMORY_DB_PATH is not supported; field memory evidence stays under the repo-local .pico-local directory."
    });
    expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(1);
  });

  it("fails when the cutoff payload contains no entries", async () => {
    const report = await runSessionMemoryLifecycleField(
      enabledSessionMemoryConfig(".pico-local/test-session-memory-field"),
      {},
      {
        appendEntries: false,
        createClient: () =>
          Promise.resolve({
            add() {
              return Promise.resolve({ memories: [] });
            },
            search() {
              return Promise.resolve({ memories: [] });
            },
            delete() {
              return Promise.resolve();
            }
          }),
        createAuditExporter: () => ({
          export() {
            return Promise.resolve();
          },
          shutdown() {
            return Promise.resolve();
          }
        })
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "session+sqlite+mem0+otel",
      reason: "pico session memory lifecycle field requires an entry-bearing cutoff"
    });
    expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(1);
  });
});

function enabledSessionMemoryConfig(directory: string) {
  return definePicoConfig({
    session: {
      ending: {
        mode: "timed",
        durationMs: 1
      }
    },
    memory: {
      mem0: {
        enabled: true,
        historyDbPath: join(directory, "mem0-history.sqlite"),
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico-field-test"
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
    },
    audit: {
      otel: {
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/logs",
        serviceName: "pico-test",
        timeoutMs: 1_000
      }
    }
  });
}
