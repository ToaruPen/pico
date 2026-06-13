#!/usr/bin/env jiti
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
};

const scopeId = "pico-smoke";
const smokeSession = {
  sessionId: "mem0-smoke-session-2026-06-13",
  cutoffAt: "2026-06-13T09:00:00.000Z",
  sourceEntryIds: ["mem0-smoke-entry-1", "mem0-smoke-entry-2"],
  entries: [
    {
      id: "mem0-smoke-entry-1",
      role: "staff",
      content: "雨の日は工作セットを早めに準備すると活動へ入りやすい。"
    },
    {
      id: "mem0-smoke-entry-2",
      role: "assistant",
      content: "次の雨の日も工作セットを先に準備する候補として扱う。"
    }
  ],
  requestedBy: "pico"
} as const satisfies SessionMemoryCutoffInput;

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
    const provider = createMem0MemoryProvider({
      client,
      scopeId,
      audit
    });
    const added = await provider.addSessionCutoff(smokeSession);
    let searchResultCount: number;

    try {
      const searchResults = await provider.search("工作セット");
      searchResultCount = searchResults.length;

      requireMem0SmokeResults(added.memoryIds.length, searchResultCount);
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

  function requireMem0SmokeResults(memoryCount: number, searchResultCount: number): void {
    if (memoryCount === 0) {
      throw new Error("Mem0 did not return any memory ids");
    }

    if (searchResultCount === 0) {
      throw new Error("Mem0 search returned no memories");
    }
  }
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
