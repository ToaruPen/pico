#!/usr/bin/env jiti
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createStructuredAuditLog,
  toOpenTelemetryLogRecord
} from "../../src/modules/audit/index.js";
import type { FacilityMemoryExtractor } from "../../src/modules/long-memory/extractor.js";
import type { SessionMemoryCutoffInput } from "../../src/modules/long-memory/index.js";
import {
  createMem0MemoryProvider,
  type Mem0Client,
  type Mem0SessionAddResult
} from "../../src/modules/long-memory/mem0.js";
import { createMem0OssClient } from "../../src/modules/long-memory/mem0-runtime.js";
import { createPiModelFacilityMemoryExtractor } from "../../src/modules/long-memory/pi-extractor.js";
import { createFacilityMemoryWorker } from "../../src/modules/long-memory/worker.js";

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
  readonly createClient?: (
    config: Extract<PicoConfig["memory"]["mem0"], { readonly enabled: true }>
  ) => Mem0Client | Promise<Mem0Client>;
  readonly loadConfig?: () => PicoConfig;
  readonly createRunId?: () => string;
  readonly createExtractor?: (
    config: Extract<PicoConfig["memory"]["mem0"], { readonly enabled: true }>["worker"]
  ) => FacilityMemoryExtractor;
  readonly timeoutMs?: number;
};

const defaultMem0SmokeTimeoutMs = 30_000;

export async function runMem0RuntimeSmoke(
  config?: PicoConfig,
  dependencies: Mem0RuntimeSmokeDependencies = {}
): Promise<Mem0RuntimeSmokeReport> {
  try {
    const resolvedConfig = config ?? dependencies.loadConfig?.() ?? loadPicoConfigFromEnvironment();
    const mem0 = resolvedConfig.memory.mem0;

    if (!mem0.enabled) {
      return {
        status: "skipped",
        provider: "mem0-oss",
        reason: "Set memory.mem0.enabled=true to run the Mem0 runtime smoke."
      };
    }

    return await executeMem0RuntimeSmoke(mem0, dependencies);
  } catch (error) {
    return {
      status: "failed",
      provider: "mem0-oss",
      reason: `pico Mem0 runtime smoke failed: ${errorMessage(error)}`
    };
  }

  async function executeMem0RuntimeSmoke(
    mem0: Extract<PicoConfig["memory"]["mem0"], { readonly enabled: true }>,
    dependencies: Mem0RuntimeSmokeDependencies
  ): Promise<Mem0RuntimeSmokeReport> {
    const audit = createStructuredAuditLog();
    const timeoutMs = dependencies.timeoutMs ?? defaultMem0SmokeTimeoutMs;
    const client = await withTimeout(
      Promise.resolve(
        dependencies.createClient?.(mem0) ??
          createMem0OssClient(mem0, { modelPreflightTimeoutMs: timeoutMs })
      ),
      "Mem0 client startup",
      timeoutMs
    );
    const runId = (dependencies.createRunId ?? randomUUID)();
    const scopeId = `pico-smoke-${runId}`;
    const smokeSession = createSmokeSession(runId);
    const provider = createMem0MemoryProvider({
      client,
      scopeId,
      audit
    });
    const extractor =
      dependencies.createExtractor?.(mem0.worker) ??
      createPiModelFacilityMemoryExtractor(mem0.worker);
    const worker = createFacilityMemoryWorker({ extractor, provider });
    const processingOperation = worker.processCutoff(smokeSession);
    const added = await processCutoffWithLateCleanup(processingOperation, provider, timeoutMs);
    const searchResultCount = await searchCreatedMemories(
      provider,
      runId,
      added.memoryIds,
      timeoutMs
    );

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

async function searchCreatedMemories(
  provider: ReturnType<typeof createMem0MemoryProvider>,
  runId: string,
  addedMemoryIds: readonly string[],
  timeoutMs: number
): Promise<number> {
  let searchResultCount = 0;
  let primaryError: Error | undefined;

  try {
    const searchResults = await withTimeout(provider.search(runId, 5), "Mem0 search", timeoutMs);
    searchResultCount = searchResults.length;
    requireMem0SmokeResults(
      addedMemoryIds,
      searchResults.map((memory) => memory.id)
    );
  } catch (error) {
    primaryError = toError(error);
  }

  const cleanupError = await cleanupAddedMemoriesSafely(provider, addedMemoryIds, timeoutMs);

  if (primaryError !== undefined) {
    throw cleanupError === undefined
      ? primaryError
      : errorWithSecondary(primaryError, "cleanup", cleanupError);
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  return searchResultCount;
}

async function processCutoffWithLateCleanup(
  processingOperation: Promise<Mem0SessionAddResult>,
  provider: ReturnType<typeof createMem0MemoryProvider>,
  timeoutMs: number
): Promise<Mem0SessionAddResult> {
  try {
    return await withTimeout(processingOperation, "Mem0 add", timeoutMs);
  } catch (error) {
    cleanupLateProcessedMemories(processingOperation, provider, timeoutMs).catch(() => undefined);

    throw error;
  }
}

async function cleanupLateProcessedMemories(
  processingOperation: Promise<Mem0SessionAddResult>,
  provider: ReturnType<typeof createMem0MemoryProvider>,
  timeoutMs: number
): Promise<void> {
  try {
    const added = await processingOperation;

    await cleanupAddedMemories(provider, added.memoryIds, timeoutMs);
  } catch {
    // The smoke already failed on the original add path. This guard prevents
    // late completion or cleanup failures from becoming unhandled rejections.
  }
}

async function cleanupAddedMemories(
  provider: ReturnType<typeof createMem0MemoryProvider>,
  memoryIds: readonly string[],
  timeoutMs: number
): Promise<void> {
  const results = await Promise.allSettled(
    memoryIds.map((memoryId) =>
      withTimeout(provider.delete(memoryId), `Mem0 delete ${memoryId}`, timeoutMs)
    )
  );
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return [];
    }

    return `${memoryIds[index] ?? "unknown"}: ${errorMessage(result.reason)}`;
  });

  if (failures.length > 0) {
    throw new Error(
      `Mem0 cleanup failed for ${String(failures.length)} memory id(s): ${failures.join("; ")}`
    );
  }
}

async function cleanupAddedMemoriesSafely(
  provider: ReturnType<typeof createMem0MemoryProvider>,
  memoryIds: readonly string[],
  timeoutMs: number
): Promise<Error | undefined> {
  try {
    await cleanupAddedMemories(provider, memoryIds, timeoutMs);

    return undefined;
  } catch (error) {
    return toError(error);
  }
}

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorWithSecondary(primary: Error, label: string, secondary: Error): Error {
  return new Error(`${primary.message}; ${label} also failed: ${secondary.message}`, {
    cause: primary
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runMem0RuntimeSmoke();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = mem0RuntimeSmokeExitCode(report);
}
