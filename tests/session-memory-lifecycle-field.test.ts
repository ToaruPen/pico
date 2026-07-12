import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSessionMemoryLifecycleField,
  sessionMemoryLifecycleFieldExitCode
} from "../scripts/field/session-memory-lifecycle.js";
import { definePicoConfig } from "../src/config/index.js";

describe("session memory lifecycle field harness", () => {
  it("creates an entry-bearing cutoff, automated SQLite memory, and OTel audit exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-field-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const exportedEvents: string[] = [];
    let extractedCutoffText = "";

    try {
      const report = await runSessionMemoryLifecycleField(
        enabledSessionMemoryConfig(directory),
        {},
        {
          createRunId: () => "field-run-1",
          databasePath,
          createExtractor: () => ({
            extract: (cutoff) => {
              extractedCutoffText = cutoff.entries.map((entry) => entry.content).join("\n");

              return Promise.resolve([
                {
                  title: "Rainy day supplies",
                  body: "Prepare the reusable activity kit before arrival.",
                  category: "facility_knowledge",
                  tags: ["雨", "工作"],
                  sourceEntryIds: cutoff.sourceEntryIds,
                  confidence: 0.9
                }
              ]);
            }
          }),
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
        provider: "session+sqlite+otel",
        details: {
          runId: "field-run-1",
          sessionId: "session-1",
          sourceEntryCount: 2,
          candidateJobId: 1,
          workerProcessedCount: 1,
          workerRecoveredCount: 0,
          workerIdle: true,
          memoryWrittenCount: 1,
          activeMemoryCount: 1,
          provenanceKind: "session_cutoff_automation",
          auditEventCount: 6,
          exportedOtelRecordCount: 6,
          databasePath: "<injected-database-path>"
        }
      });
      expect(exportedEvents).toEqual([
        "session.started",
        "session.ended",
        "long_memory.candidate_job.enqueued",
        "long_memory.worker.cutoff_enqueued",
        "long_memory.candidate_job.processed",
        "long_memory.worker.drain_once"
      ]);
      expect(extractedCutoffText).toContain("施設共通");
      expect(extractedCutoffText).toContain("継続手順");
      expect(sessionMemoryLifecycleFieldExitCode(report)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails when extraction creates no active SQLite memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-field-"));

    try {
      const report = await runSessionMemoryLifecycleField(
        enabledSessionMemoryConfig(directory),
        {},
        {
          createRunId: () => "field-run-empty-memory",
          databasePath: join(directory, "long-memory.sqlite"),
          createExtractor: () => ({ extract: () => Promise.resolve([]) }),
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
        provider: "session+sqlite+otel",
        reason: "pico session memory lifecycle field requires at least one active SQLite memory"
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
          createExtractor: () => ({
            extract: (cutoff) =>
              Promise.resolve([
                {
                  title: "Rainy day preparation",
                  body: "Prepare craft supplies before the activity.",
                  category: "facility_knowledge",
                  tags: ["rain"],
                  sourceEntryIds: cutoff.sourceEntryIds,
                  confidence: 0.9
                }
              ])
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
        provider: "session+sqlite+otel",
        reason: "pico session memory lifecycle field failed"
      });
      expect(JSON.stringify(report)).not.toContain("collector unavailable");
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
      provider: "session+sqlite+otel",
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
        createExtractor: () => ({ extract: () => Promise.resolve([]) }),
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
      provider: "session+sqlite+otel",
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
      longMemory: {
        enabled: true,
        databasePath: join(directory, "long-memory.sqlite"),
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
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
