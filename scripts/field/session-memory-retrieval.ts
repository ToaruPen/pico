#!/usr/bin/env jiti
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager
} from "@earendil-works/pi-coding-agent";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { registerPicoExtensionWithRuntime } from "../../src/index.js";
import {
  createStructuredAuditLog,
  type StructuredAuditLog
} from "../../src/modules/audit/index.js";
import {
  runSessionMemoryLifecycleField,
  type SessionMemoryLifecycleFieldDependencies
} from "./session-memory-lifecycle.js";

export type SessionMemoryRetrievalFieldReport =
  | {
      readonly status: "passed";
      readonly provider: "session+sqlite+pi-extension";
      readonly details: {
        readonly runId: string;
        readonly sessionId: string;
        readonly sourceEntryCount: number;
        readonly workerProcessedCount: number;
        readonly activeMemoryCount: number;
        readonly retrievalCount: number;
        readonly matchingProvenanceCount: number;
        readonly searchAuditEventCount: number;
        readonly durationMs: number;
        readonly databasePath: string;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "session+sqlite+pi-extension";
      readonly reason: string;
    };

export type SessionMemoryRetrievalFieldDependencies = SessionMemoryLifecycleFieldDependencies & {
  readonly searchQuery?: string;
  readonly createSearchAudit?: () => StructuredAuditLog;
  readonly nowMs?: () => number;
};

const provider = "session+sqlite+pi-extension" as const;
const liveGate = "PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL";
const defaultDatabasePath = ".pico-local/session-memory-retrieval-field.sqlite";

export async function runSessionMemoryRetrievalField(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: SessionMemoryRetrievalFieldDependencies = {}
): Promise<SessionMemoryRetrievalFieldReport> {
  if (environment[liveGate] !== "1") {
    return skipped(`Set ${liveGate}=1 to run the live field test.`);
  }

  try {
    return await executeSessionMemoryRetrievalField(config, environment, dependencies);
  } catch {
    return failed("pico session memory retrieval field failed");
  }
}

async function executeSessionMemoryRetrievalField(
  config: PicoConfig,
  environment: NodeJS.ProcessEnv,
  dependencies: SessionMemoryRetrievalFieldDependencies
): Promise<SessionMemoryRetrievalFieldReport> {
  const nowMs = dependencies.nowMs ?? Date.now;
  const startedAt = nowMs();
  const databasePath = dependencies.databasePath ?? defaultDatabasePath;
  const fieldConfig = withLongMemoryDatabasePath(config, databasePath);
  const lifecycleReport = await runSessionMemoryLifecycleField(fieldConfig, environment, {
    ...dependencies,
    databasePath
  });

  if (lifecycleReport.status !== "passed") {
    return {
      status: lifecycleReport.status,
      provider,
      reason: lifecycleReport.reason
    };
  }

  return completeSessionMemoryRetrievalField({
    fieldConfig,
    dependencies,
    lifecycleDetails: lifecycleReport.details,
    startedAt,
    nowMs,
    databasePath
  });
}

async function completeSessionMemoryRetrievalField(input: {
  readonly fieldConfig: PicoConfig;
  readonly dependencies: SessionMemoryRetrievalFieldDependencies;
  readonly lifecycleDetails: Extract<
    Awaited<ReturnType<typeof runSessionMemoryLifecycleField>>,
    { readonly status: "passed" }
  >["details"];
  readonly startedAt: number;
  readonly nowMs: () => number;
  readonly databasePath: string;
}): Promise<SessionMemoryRetrievalFieldReport> {
  const audit = input.dependencies.createSearchAudit?.() ?? createStructuredAuditLog();
  const search = await executeExtensionMemorySearch(
    input.fieldConfig,
    input.dependencies.searchQuery ?? "雨",
    audit
  );
  const matchingProvenanceCount = countMatchingProvenance(
    search.memories,
    input.lifecycleDetails.sessionId
  );

  if (matchingProvenanceCount === 0) {
    return failed("pico session memory retrieval field requires a matching automated memory");
  }

  return {
    status: "passed",
    provider,
    details: {
      runId: input.lifecycleDetails.runId,
      sessionId: input.lifecycleDetails.sessionId,
      sourceEntryCount: input.lifecycleDetails.sourceEntryCount,
      workerProcessedCount: input.lifecycleDetails.workerProcessedCount,
      activeMemoryCount: input.lifecycleDetails.activeMemoryCount,
      retrievalCount: search.memories.length,
      matchingProvenanceCount,
      searchAuditEventCount: audit.entries().length,
      durationMs: Math.max(0, input.nowMs() - input.startedAt),
      databasePath: isAbsolute(input.databasePath) ? "<injected-database-path>" : input.databasePath
    }
  };
}

function countMatchingProvenance(memories: readonly RetrievedMemory[], sessionId: string): number {
  return memories.filter(
    (memory) =>
      memory.provenance.kind === "session_cutoff_automation" &&
      memory.provenance.sourceSessionId === sessionId
  ).length;
}

function withLongMemoryDatabasePath(config: PicoConfig, databasePath: string): PicoConfig {
  if (!config.memory.longMemory.enabled) {
    return config;
  }

  return {
    ...config,
    memory: {
      ...config.memory,
      longMemory: {
        ...config.memory.longMemory,
        databasePath
      }
    }
  };
}

type RetrievedMemory = {
  readonly provenance: {
    readonly kind: string;
    readonly sourceSessionId?: string;
  };
};

async function executeExtensionMemorySearch(
  config: PicoConfig,
  query: string,
  audit: StructuredAuditLog
): Promise<{ readonly memories: readonly RetrievedMemory[] }> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [
      (pi) =>
        registerPicoExtensionWithRuntime(pi, {
          loadConfig: () => config,
          memorySearch: { audit }
        })
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    noTools: "builtin",
    tools: ["pico_memory_search"]
  });

  try {
    await session.bindExtensions({ mode: "print" });
    const tool = session.getToolDefinition("pico_memory_search");

    if (tool === undefined || !session.getActiveToolNames().includes("pico_memory_search")) {
      throw new Error("pico memory retrieval field did not register pico_memory_search");
    }

    const result = await tool.execute(
      "field-session-memory-retrieval",
      { query },
      undefined,
      undefined,
      {} as never
    );
    const content = result.content[0];

    if (content === undefined || content.type !== "text") {
      throw new Error("pico memory retrieval field received malformed tool output");
    }

    return readCompletedSearch(JSON.parse(content.text) as unknown);
  } finally {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
    session.dispose();
  }
}

function readCompletedSearch(value: unknown): { readonly memories: readonly RetrievedMemory[] } {
  const root = readObject(value);
  const result = readObject(root.result);

  if (result.status !== "completed" || !Array.isArray(result.memories)) {
    throw new Error("pico memory retrieval field search was unavailable");
  }

  const memories = result.memories.map((value) => {
    const memory = readObject(value);
    const provenance = readObject(memory.provenance);

    return {
      provenance: {
        kind: requireString(provenance.kind),
        ...(typeof provenance.sourceSessionId === "string"
          ? { sourceSessionId: provenance.sourceSessionId }
          : {})
      }
    };
  });

  return { memories };
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico memory retrieval field received malformed data");
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("pico memory retrieval field received malformed data");
  }

  return value;
}

function skipped(reason: string): SessionMemoryRetrievalFieldReport {
  return { status: "skipped", provider, reason };
}

function failed(reason: string): SessionMemoryRetrievalFieldReport {
  return { status: "failed", provider, reason };
}

export function sessionMemoryRetrievalFieldExitCode(
  report: SessionMemoryRetrievalFieldReport
): number {
  return report.status === "failed" ? 1 : 0;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runSessionMemoryRetrievalField();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = sessionMemoryRetrievalFieldExitCode(report);
}
