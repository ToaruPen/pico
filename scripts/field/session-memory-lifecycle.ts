#!/usr/bin/env jiti
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { type AuditEvent, createStructuredAuditLog } from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporter
} from "../../src/modules/audit/otel.js";
import {
  type LongMemoryCandidateDraft,
  openSessionMemoryCandidateStore,
  type SessionMemoryCutoffEntry,
  type SessionMemoryCutoffInput
} from "../../src/modules/long-memory/index.js";
import { createMem0MemoryProvider, type Mem0Client } from "../../src/modules/long-memory/mem0.js";
import { createMem0OssClient } from "../../src/modules/long-memory/mem0-runtime.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import { createPicoSessionTool } from "../../src/runtime/session-tool.js";

export type SessionMemoryLifecycleFieldReport =
  | {
      readonly status: "passed";
      readonly provider: "session+sqlite+mem0+otel";
      readonly details: {
        readonly runId: string;
        readonly sessionId: string;
        readonly sourceEntryCount: number;
        readonly candidateJobId: number;
        readonly candidateCount: number;
        readonly mem0MemoryCount: number;
        readonly auditEventCount: number;
        readonly exportedOtelRecordCount: number;
        readonly databasePath: string;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "session+sqlite+mem0+otel";
      readonly reason: string;
    };

export type SessionMemoryLifecycleFieldDependencies = {
  readonly createRunId?: () => string;
  readonly databasePath?: string;
  readonly createClient?: (
    config: PicoConfig["memory"]["mem0"]
  ) => Mem0Client | Promise<Mem0Client>;
  readonly createAuditExporter?: (
    config: Required<PicoConfig["audit"]["otel"]>
  ) => OpenTelemetryAuditExporter;
  readonly appendEntries?: boolean;
};

const provider = "session+sqlite+mem0+otel" as const;
const databasePathEnvironment = "PICO_FIELD_SESSION_MEMORY_DB_PATH";
const defaultDatabasePath = ".pico-local/session-memory-field.sqlite";
const defaultEndedRetentionMs = 10_000;

export async function runSessionMemoryLifecycleField(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: SessionMemoryLifecycleFieldDependencies = {}
): Promise<SessionMemoryLifecycleFieldReport> {
  try {
    const readiness = validateSessionMemoryLifecycleFieldReadiness(config, environment);
    if (readiness !== undefined) {
      return readiness;
    }

    return await executeSessionMemoryLifecycleField(config, dependencies);
  } catch (error) {
    return failed(`pico session memory lifecycle field failed: ${errorMessage(error)}`);
  }
}

async function executeSessionMemoryLifecycleField(
  config: PicoConfig,
  dependencies: SessionMemoryLifecycleFieldDependencies
): Promise<SessionMemoryLifecycleFieldReport> {
  const runId = dependencies.createRunId?.() ?? randomUUID();
  const audit = createStructuredAuditLog();
  const lifecycle = createSessionLifecycle({
    ending: config.session.ending,
    endedSessionRetentionMs: defaultEndedRetentionMs,
    audit
  });
  const sessionTool = createPicoSessionTool({
    lifecycle,
    loadConfig: () => config
  });
  const session = readSessionToolSession(
    await executeSessionTool(sessionTool, {
      action: "start",
      triggerKind: "greeting",
      label: firstConfiguredGreeting(config),
      source: "field-session-memory-lifecycle"
    })
  );

  if (dependencies.appendEntries !== false) {
    await executeSessionTool(sessionTool, {
      action: "append",
      sessionId: session.id,
      role: "staff",
      content: `雨の日は工作セットを早めに準備すると活動へ入りやすい。 run:${runId}`
    });
    await executeSessionTool(sessionTool, {
      action: "append",
      sessionId: session.id,
      role: "assistant",
      content: `次の雨の日も工作セットを先に準備する候補として扱う。 run:${runId}`
    });
  }

  await waitForSessionEnding(config.session.ending.durationMs);
  const cutoff = readSessionToolCutoff(
    await executeSessionTool(sessionTool, {
      action: "cutoff",
      sessionId: session.id
    })
  );

  if (cutoff.sourceEntryIds.length === 0) {
    return failed("pico session memory lifecycle field requires an entry-bearing cutoff");
  }

  const databasePath = resolveDatabasePath(dependencies.databasePath);
  await mkdir(dirname(databasePath), { recursive: true });

  const candidates = openSessionMemoryCandidateStore(databasePath, {
    audit,
    processSession: (input) => Promise.resolve(createFieldMemoryDrafts(input.entries))
  });

  try {
    const candidateJob = candidates.enqueueSessionCutoff(cutoff);
    await candidates.processNextJob();
    const pendingCandidates = candidates.listPending();
    const mem0Client =
      dependencies.createClient === undefined
        ? await createMem0OssClient(config.memory.mem0)
        : await dependencies.createClient(config.memory.mem0);
    const mem0Provider = createMem0MemoryProvider({
      client: mem0Client,
      scopeId: `pico-field-${runId}`,
      audit
    });
    const mem0Result = await mem0Provider.addSessionCutoff(cutoff);
    const exportedOtelRecordCount = await exportAuditEvents(
      config.audit.otel,
      dependencies,
      audit.entries()
    );
    const candidateCount = pendingCandidates.length;
    const mem0MemoryCount = mem0Result.memoryIds.length;
    const evidenceFailure = validateSessionMemoryLifecycleEvidence({
      candidateCount,
      mem0MemoryCount,
      exportedOtelRecordCount
    });

    if (evidenceFailure !== undefined) {
      return evidenceFailure;
    }

    return {
      status: "passed",
      provider,
      details: {
        runId,
        sessionId: cutoff.sessionId,
        sourceEntryCount: cutoff.sourceEntryIds.length,
        candidateJobId: candidateJob.id,
        candidateCount,
        mem0MemoryCount,
        auditEventCount: audit.entries().length,
        exportedOtelRecordCount,
        databasePath
      }
    };
  } finally {
    candidates.close();
  }
}

function validateSessionMemoryLifecycleFieldReadiness(
  config: PicoConfig,
  environment: NodeJS.ProcessEnv
): SessionMemoryLifecycleFieldReport | undefined {
  if (environment[databasePathEnvironment] !== undefined) {
    return failed(
      `${databasePathEnvironment} is not supported; field memory evidence stays under the repo-local .pico-local directory.`
    );
  }

  if (!config.session.enabled) {
    return skipped("Set session.enabled=true to run the session memory lifecycle field test.");
  }

  if (!config.memory.mem0.enabled) {
    return skipped("Set memory.mem0.enabled=true to run the session memory lifecycle field test.");
  }

  if (!config.audit.otel.enabled) {
    return skipped("Set audit.otel.enabled=true to run the session memory lifecycle field test.");
  }

  return undefined;
}

function validateSessionMemoryLifecycleEvidence(evidence: {
  readonly candidateCount: number;
  readonly mem0MemoryCount: number;
  readonly exportedOtelRecordCount: number;
}): SessionMemoryLifecycleFieldReport | undefined {
  if (evidence.candidateCount === 0) {
    return failed("pico session memory lifecycle field requires at least one memory candidate");
  }

  if (evidence.mem0MemoryCount === 0) {
    return failed("pico session memory lifecycle field requires at least one Mem0 memory");
  }

  if (evidence.exportedOtelRecordCount === 0) {
    return failed("pico session memory lifecycle field requires at least one exported OTel record");
  }

  return undefined;
}

type PicoSessionTool = ReturnType<typeof createPicoSessionTool>;

async function executeSessionTool(
  tool: PicoSessionTool,
  parameters: Record<string, unknown>
): Promise<unknown> {
  const result = await tool.execute(
    "field-session-memory-lifecycle",
    parameters as Parameters<PicoSessionTool["execute"]>[1],
    undefined,
    undefined,
    {} as Parameters<PicoSessionTool["execute"]>[4]
  );
  const content = result.content[0];

  if (content === undefined || content.type !== "text") {
    throw new Error("pico session memory lifecycle field received malformed session tool output");
  }

  return JSON.parse(content.text) as unknown;
}

function readSessionToolSession(value: unknown): { readonly id: string } {
  const session = readObject(value).session;
  const id = readObject(session).id;

  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("pico session memory lifecycle field received malformed session id");
  }

  return { id };
}

function readSessionToolCutoff(value: unknown): SessionMemoryCutoffInput {
  return readObject(value).cutoff as SessionMemoryCutoffInput;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico session memory lifecycle field received malformed session tool output");
  }

  return value as Record<string, unknown>;
}

function createFieldMemoryDrafts(
  entries: readonly SessionMemoryCutoffEntry[]
): readonly LongMemoryCandidateDraft[] {
  return [
    {
      title: "Field session continuity note",
      body: entries.map((entry) => `${entry.role}: ${entry.content}`).join("\n"),
      category: "care_continuity",
      tags: ["field-test"]
    }
  ];
}

async function exportAuditEvents(
  config: PicoConfig["audit"]["otel"],
  dependencies: Pick<SessionMemoryLifecycleFieldDependencies, "createAuditExporter">,
  auditEvents: readonly AuditEvent[]
): Promise<number> {
  const exporter = createFieldAuditExporter(config, dependencies);
  const exportResult = await exportAuditEventBatch(exporter, auditEvents);
  const shutdownError = await shutdownExporterSafely(exporter);

  throwAuditExportError(exportResult.error, shutdownError);

  return exportResult.exported;
}

function createFieldAuditExporter(
  config: PicoConfig["audit"]["otel"],
  dependencies: Pick<SessionMemoryLifecycleFieldDependencies, "createAuditExporter">
): OpenTelemetryAuditExporter {
  const exporterConfig = {
    enabled: true,
    endpoint: requireOtelEndpoint(config.endpoint),
    serviceName: config.serviceName ?? "pico",
    timeoutMs: config.timeoutMs ?? 10_000
  } as const;

  return (
    dependencies.createAuditExporter?.(exporterConfig) ??
    createOpenTelemetryAuditExporter({
      endpoint: exporterConfig.endpoint,
      serviceName: exporterConfig.serviceName,
      timeoutMs: exporterConfig.timeoutMs
    })
  );
}

async function exportAuditEventBatch(
  exporter: OpenTelemetryAuditExporter,
  auditEvents: readonly AuditEvent[]
): Promise<{ readonly exported: number; readonly error?: Error }> {
  let exported = 0;

  try {
    for (const event of auditEvents) {
      await exporter.export(event);
      exported += 1;
    }
  } catch (error) {
    return { exported, error: toError(error) };
  }

  return { exported };
}

function throwAuditExportError(primary: Error | undefined, shutdown: Error | undefined): void {
  if (primary !== undefined && shutdown !== undefined) {
    throw new Error(`${primary.message}; shutdown also failed: ${shutdown.message}`);
  }

  if (primary !== undefined) {
    throw primary;
  }

  if (shutdown !== undefined) {
    throw shutdown;
  }
}

async function shutdownExporterSafely(
  exporter: OpenTelemetryAuditExporter
): Promise<Error | undefined> {
  try {
    await exporter.shutdown();

    return undefined;
  } catch (error) {
    return toError(error);
  }
}

function firstConfiguredGreeting(config: PicoConfig): string {
  return config.session.startTriggers.greetings[0] ?? "おはよう";
}

function resolveDatabasePath(value: string | undefined): string {
  return resolve(value?.trim() === "" || value === undefined ? defaultDatabasePath : value);
}

function requireOtelEndpoint(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("pico session memory lifecycle field requires audit.otel.endpoint");
  }

  return value;
}

function waitForSessionEnding(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs + 1);
  });
}

function skipped(reason: string): SessionMemoryLifecycleFieldReport {
  return {
    status: "skipped",
    provider,
    reason
  };
}

function failed(reason: string): SessionMemoryLifecycleFieldReport {
  return {
    status: "failed",
    provider,
    reason
  };
}

export function sessionMemoryLifecycleFieldExitCode(
  report: SessionMemoryLifecycleFieldReport
): number {
  return report.status === "failed" ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runSessionMemoryLifecycleField();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = sessionMemoryLifecycleFieldExitCode(report);
}
