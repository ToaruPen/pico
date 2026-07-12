import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runResidentMemory } from "../scripts/resident/memory.js";
import { definePicoConfig } from "../src/config/index.js";
import {
  openLongMemoryStore,
  openSessionMemoryCandidateQueue
} from "../src/modules/long-memory/index.js";

describe("resident memory script", () => {
  it("rejects disabled long memory before opening the database", async () => {
    await expect(
      runResidentMemory(definePicoConfig({}), {
        once: true,
        signal: new AbortController().signal,
        pollIntervalMs: 1
      })
    ).rejects.toThrow("pico resident memory requires memory.longMemory.enabled=true");
  });

  it("drains configured SQLite memory with the injected extractor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-script-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const queue = openSessionMemoryCandidateQueue(databasePath);
    const output: string[] = [];

    try {
      queue.enqueueSessionCutoff({
        sessionId: "script-session",
        cutoffAt: "2026-07-12T00:00:00.000Z",
        sourceEntryIds: ["entry-1"],
        entries: [{ id: "entry-1", role: "staff", content: "雨の日の工作準備" }],
        requestedBy: "session_lifecycle"
      });
    } finally {
      queue.close();
    }

    try {
      await runResidentMemory(
        enabledLongMemoryConfig(databasePath),
        {
          once: true,
          signal: new AbortController().signal,
          pollIntervalMs: 1,
          recoverProcessingOlderThanMs: 600_000
        },
        {
          createExtractor: () => ({
            extract: (cutoff) =>
              Promise.resolve([
                {
                  title: "雨の日の工作準備",
                  body: "雨の日は工作セットを早めに準備する。",
                  category: "facility_knowledge",
                  tags: ["雨"],
                  sourceEntryIds: cutoff.sourceEntryIds,
                  confidence: 0.9
                }
              ])
          }),
          writeLine: (line) => output.push(line)
        }
      );

      const memories = openLongMemoryStore(databasePath);

      try {
        expect(memories.searchActive({ query: "工作準備", limit: 5 })).toHaveLength(1);
      } finally {
        memories.close();
      }
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0] as string)).toMatchObject({
        status: "drained",
        processedCount: 1,
        memoryWrittenCount: 1,
        deadLetterCount: 0
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a retry as degraded without exposing the provider error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-script-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const queue = openSessionMemoryCandidateQueue(databasePath);
    const output: string[] = [];

    try {
      queue.enqueueSessionCutoff({
        sessionId: "script-retry-session",
        cutoffAt: "2026-07-12T00:00:00.000Z",
        sourceEntryIds: ["entry-1"],
        entries: [{ id: "entry-1", role: "staff", content: "retry source" }],
        requestedBy: "session_lifecycle"
      });
    } finally {
      queue.close();
    }

    try {
      await runResidentMemory(
        enabledLongMemoryConfig(databasePath),
        {
          once: true,
          signal: new AbortController().signal,
          pollIntervalMs: 1
        },
        {
          createExtractor: () => ({
            extract: () => Promise.reject(new Error("SECRET_PROVIDER_DETAIL"))
          }),
          writeLine: (line) => output.push(line)
        }
      );

      expect(JSON.parse(output[0] as string)).toMatchObject({
        status: "degraded",
        retryScheduledCount: 1,
        lastErrorCode: "extraction_failed"
      });
      expect(output.join("\n")).not.toContain("SECRET_PROVIDER_DETAIL");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a scheduled retry degraded while it is not yet eligible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-script-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const queue = openSessionMemoryCandidateQueue(databasePath);
    const abortController = new AbortController();
    const output: string[] = [];

    try {
      queue.enqueueSessionCutoff({
        sessionId: "script-pending-retry-session",
        cutoffAt: "2026-07-12T00:00:00.000Z",
        sourceEntryIds: ["entry-1"],
        entries: [{ id: "entry-1", role: "staff", content: "retry source" }],
        requestedBy: "session_lifecycle"
      });
    } finally {
      queue.close();
    }

    try {
      await runResidentMemory(
        enabledLongMemoryConfig(databasePath),
        {
          once: false,
          signal: abortController.signal,
          pollIntervalMs: 1
        },
        {
          createExtractor: () => ({
            extract: () => Promise.reject(new Error("provider remains unavailable"))
          }),
          writeLine: (line) => {
            output.push(line);
            if (output.length === 2) {
              abortController.abort();
            }
          }
        }
      );

      expect(
        output.map((line) => (JSON.parse(line) as { readonly status: string }).status)
      ).toEqual(["degraded", "degraded"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports OTel failures with a fixed code and no raw exporter detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-script-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const errorOutput: string[] = [];

    try {
      await runResidentMemory(
        enabledLongMemoryWithAuditConfig(databasePath),
        {
          once: true,
          signal: new AbortController().signal,
          pollIntervalMs: 1
        },
        {
          createExtractor: () => ({ extract: () => Promise.resolve([]) }),
          createAuditExporter: () => ({
            export: () => Promise.reject(new Error("SECRET_COLLECTOR_DETAIL")),
            shutdown: () => Promise.resolve()
          }),
          writeLine: () => undefined,
          writeErrorLine: (line) => errorOutput.push(line)
        }
      );

      expect(errorOutput).toEqual([
        `${JSON.stringify({ status: "degraded", errorCode: "otel_export_failed" })}\n`
      ]);
      expect(errorOutput.join("\n")).not.toContain("SECRET_COLLECTOR_DETAIL");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports OTel shutdown failures with a fixed code and no raw exporter detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-script-"));
    const databasePath = join(directory, "long-memory.sqlite");
    const errorOutput: string[] = [];

    try {
      await expect(
        runResidentMemory(
          enabledLongMemoryWithAuditConfig(databasePath),
          {
            once: true,
            signal: new AbortController().signal,
            pollIntervalMs: 1
          },
          {
            createExtractor: () => ({ extract: () => Promise.resolve([]) }),
            createAuditExporter: () => ({
              export: () => Promise.resolve(),
              shutdown: () => Promise.reject(new Error("SECRET_SHUTDOWN_DETAIL"))
            }),
            writeLine: () => undefined,
            writeErrorLine: (line) => errorOutput.push(line)
          }
        )
      ).resolves.toBeUndefined();

      expect(errorOutput).toEqual([
        `${JSON.stringify({ status: "degraded", errorCode: "otel_shutdown_failed" })}\n`
      ]);
      expect(errorOutput.join("\n")).not.toContain("SECRET_SHUTDOWN_DETAIL");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function enabledLongMemoryConfig(databasePath: string) {
  return definePicoConfig({
    memory: {
      longMemory: {
        enabled: true,
        databasePath,
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      }
    }
  });
}

function enabledLongMemoryWithAuditConfig(databasePath: string) {
  return definePicoConfig({
    audit: {
      otel: {
        enabled: true,
        endpoint: "http://127.0.0.1:4318/v1/logs",
        serviceName: "pico-test",
        timeoutMs: 10
      }
    },
    memory: {
      longMemory: {
        enabled: true,
        databasePath,
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      }
    }
  });
}
