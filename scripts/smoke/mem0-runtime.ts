#!/usr/bin/env jiti
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStructuredAuditLog,
  toOpenTelemetryLogRecord
} from "../../src/modules/audit/index.js";
import type { SessionMemoryCutoffInput } from "../../src/modules/long-memory/index.js";
import { createMem0MemoryProvider, type Mem0Client } from "../../src/modules/long-memory/mem0.js";
import { createMem0OssClient } from "../../src/modules/long-memory/mem0-runtime.js";

export type Mem0RuntimeSmokeReport =
  | {
      readonly status: "passed";
      readonly provider: "mem0-oss";
      readonly details: {
        readonly scopeId: string;
        readonly memoryCount: number;
        readonly searchResultCount: number;
        readonly auditEventCount: number;
        readonly otelRecordCount: number;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "mem0-oss";
      readonly reason: string;
    };

export type Mem0RuntimeSmokeDependencies = {
  readonly createClient?: (config: PicoConfig["memory"]["mem0"]) => Mem0Client;
  readonly createRunId?: () => string;
};

export async function runMem0RuntimeSmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  dependencies: Mem0RuntimeSmokeDependencies = {}
): Promise<Mem0RuntimeSmokeReport> {
  const mem0 = config.memory.mem0;

  if (!mem0.enabled) {
    return {
      status: "skipped",
      provider: "mem0-oss",
      reason: "Set memory.mem0.enabled=true to run the Mem0 runtime smoke."
    };
  }

  try {
    return await executeMem0RuntimeSmoke(mem0, dependencies);
  } catch (error) {
    return {
      status: "failed",
      provider: "mem0-oss",
      reason: `pico Mem0 runtime smoke failed: ${errorMessage(error)}`
    };
  }

  async function executeMem0RuntimeSmoke(
    mem0: PicoConfig["memory"]["mem0"],
    dependencies: Mem0RuntimeSmokeDependencies
  ): Promise<Mem0RuntimeSmokeReport> {
    const audit = createStructuredAuditLog();
    const client = dependencies.createClient?.(mem0) ?? createMem0OssClient(mem0);
    const runId = (dependencies.createRunId ?? randomUUID)();
    const scopeId = `pico-smoke-${runId}`;
    const smokeSession = createSmokeSession(runId);
    const provider = createMem0MemoryProvider({
      client,
      scopeId,
      audit
    });
    const added = await provider.addSessionCutoff(smokeSession);
    let searchResultCount: number;

    try {
      const searchResults = await provider.search(runId);
      searchResultCount = searchResults.length;

      requireMem0SmokeResults(
        added.memoryIds,
        searchResults.map((memory) => memory.id)
      );
    } finally {
      for (const memoryId of added.memoryIds) {
        await provider.delete(memoryId);
      }
    }

    const auditEvents = audit.entries();

    return {
      status: "passed",
      provider: "mem0-oss",
      details: {
        scopeId,
        memoryCount: added.memoryIds.length,
        searchResultCount,
        auditEventCount: auditEvents.length,
        otelRecordCount: auditEvents.map(toOpenTelemetryLogRecord).length
      }
    };
  }

  function requireMem0SmokeResults(
    addedMemoryIds: readonly string[],
    searchedMemoryIds: readonly string[]
  ): void {
    if (addedMemoryIds.length === 0) {
      throw new Error("Mem0 did not return any memory ids");
    }

    if (!searchedMemoryIds.some((id) => addedMemoryIds.includes(id))) {
      throw new Error("Mem0 search did not return a memory created by this smoke run");
    }
  }
}

function createSmokeSession(runId: string): SessionMemoryCutoffInput {
  return {
    sessionId: `mem0-smoke-session-${runId}`,
    cutoffAt: "2026-06-13T09:00:00.000Z",
    sourceEntryIds: [`mem0-smoke-entry-1-${runId}`, `mem0-smoke-entry-2-${runId}`],
    entries: [
      {
        id: `mem0-smoke-entry-1-${runId}`,
        role: "staff",
        content: `雨の日は工作セットを早めに準備すると活動へ入りやすい。 run:${runId}`
      },
      {
        id: `mem0-smoke-entry-2-${runId}`,
        role: "assistant",
        content: `次の雨の日も工作セットを先に準備する候補として扱う。 run:${runId}`
      }
    ],
    requestedBy: "pico"
  };
}

export function mem0RuntimeSmokeExitCode(report: Mem0RuntimeSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runMem0RuntimeSmoke();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = mem0RuntimeSmokeExitCode(report);
}
