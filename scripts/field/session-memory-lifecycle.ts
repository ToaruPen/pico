#!/usr/bin/env jiti
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { type AuditEvent, createStructuredAuditLog } from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporter
} from "../../src/modules/audit/otel.js";
import type { FacilityMemoryExtractor } from "../../src/modules/long-memory/extractor.js";
import {
  openLongMemoryStore,
  type SessionMemoryCutoffInput
} from "../../src/modules/long-memory/index.js";
import { createPiModelFacilityMemoryExtractor } from "../../src/modules/long-memory/pi-extractor.js";
import { createSessionLifecycle } from "../../src/modules/session/index.js";
import {
  createResidentMemoryDrainWorker,
  type ResidentMemoryDrainWorker
} from "../../src/runtime/resident-memory-worker.js";
import { createPicoSessionTool } from "../../src/runtime/session-tool.js";

export type SessionMemoryLifecycleFieldReport =
  | {
      readonly status: "passed";
      readonly provider: "session+sqlite+otel";
      readonly details: {
        readonly runId: string;
        readonly sessionId: string;
        readonly sourceEntryCount: number;
        readonly candidateJobId: number;
        readonly workerProcessedCount: number;
        readonly workerRecoveredCount: number;
        readonly workerIdle: boolean;
        readonly memoryWrittenCount: number;
        readonly activeMemoryCount: number;
        readonly provenanceKind: "session_cutoff_automation";
        readonly auditEventCount: number;
        readonly exportedOtelRecordCount: number;
        readonly databasePath: string;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "session+sqlite+otel";
      readonly reason: string;
    };

export type SessionMemoryLifecycleFieldDependencies = {
  readonly createRunId?: () => string;
  readonly databasePath?: string;
  readonly createExtractor?: (
    config: Extract<PicoConfig["memory"]["longMemory"], { readonly enabled: true }>["extraction"]
  ) => FacilityMemoryExtractor;
  readonly createAuditExporter?: (
    config: Required<PicoConfig["audit"]["otel"]>
  ) => OpenTelemetryAuditExporter;
  readonly appendEntries?: boolean;
};

const provider = "session+sqlite+otel" as const;
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
  } catch {
    return failed("pico session memory lifecycle field failed");
  }
}

async function executeSessionMemoryLifecycleField(
  config: PicoConfig,
  dependencies: SessionMemoryLifecycleFieldDependencies
): Promise<SessionMemoryLifecycleFieldReport> {
  const runId = createFieldRunId(dependencies);
  const audit = createStructuredAuditLog();
  const cutoff = await createFieldCutoff(config, dependencies, runId, audit);

  if (cutoff.sourceEntryIds.length === 0) {
    return failed("pico session memory lifecycle field requires an entry-bearing cutoff");
  }

  const databasePath = resolveDatabasePath(dependencies.databasePath);
  const databaseReportPath = resolveDatabaseReportPath(dependencies.databasePath);
  await mkdir(dirname(databasePath), { recursive: true });

  const longMemory = requireEnabledLongMemoryConfig(config);
  const extractor = createFieldExtractor(longMemory.extraction, dependencies);
  const worker = createResidentMemoryDrainWorker({
    databasePath,
    extractor,
    audit,
    recoverProcessingOlderThanMs: 10 * 60_000
  });

  try {
    return await collectSessionMemoryEvidence({
      config,
      dependencies,
      runId,
      cutoff,
      databasePath,
      databaseReportPath,
      audit,
      worker
    });
  } finally {
    worker.close();
  }
}

async function createFieldCutoff(
  config: PicoConfig,
  dependencies: SessionMemoryLifecycleFieldDependencies,
  runId: string,
  audit: ReturnType<typeof createStructuredAuditLog>
): Promise<SessionMemoryCutoffInput> {
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
      content: `施設共通の継続手順として、雨の日は工作セットを早めに準備する。 run:${runId}`
    });
    await executeSessionTool(sessionTool, {
      action: "append",
      sessionId: session.id,
      role: "assistant",
      content: `今後も同じ継続手順を次回以降へ引き継ぐ。 run:${runId}`
    });
  }

  await waitForSessionEnding(config.session.ending.durationMs);
  const cutoff = readSessionToolCutoff(
    await executeSessionTool(sessionTool, {
      action: "cutoff",
      sessionId: session.id
    })
  );

  return cutoff;
}

type EnabledLongMemoryConfig = Extract<
  PicoConfig["memory"]["longMemory"],
  { readonly enabled: true }
>;

function createFieldRunId(dependencies: SessionMemoryLifecycleFieldDependencies): string {
  return dependencies.createRunId?.() ?? randomUUID();
}

function requireEnabledLongMemoryConfig(config: PicoConfig): EnabledLongMemoryConfig {
  if (!config.memory.longMemory.enabled) {
    throw new Error("pico session memory lifecycle field requires memory.longMemory.enabled=true");
  }

  return config.memory.longMemory;
}

function createFieldExtractor(
  config: EnabledLongMemoryConfig["extraction"],
  dependencies: SessionMemoryLifecycleFieldDependencies
): FacilityMemoryExtractor {
  return dependencies.createExtractor?.(config) ?? createPiModelFacilityMemoryExtractor(config);
}

async function collectSessionMemoryEvidence(input: {
  readonly config: PicoConfig;
  readonly dependencies: SessionMemoryLifecycleFieldDependencies;
  readonly runId: string;
  readonly cutoff: SessionMemoryCutoffInput;
  readonly databasePath: string;
  readonly databaseReportPath: string;
  readonly audit: ReturnType<typeof createStructuredAuditLog>;
  readonly worker: ResidentMemoryDrainWorker;
}): Promise<SessionMemoryLifecycleFieldReport> {
  const candidateJob = input.worker.enqueueCutoff(input.cutoff);
  const workerReport = await input.worker.drainUntilIdle();
  const activeMemories = readWrittenMemories(
    input.databasePath,
    workerReport.writtenMemoryIds ?? []
  );
  const exportedOtelRecordCount = await exportAuditEvents(
    input.config.audit.otel,
    input.dependencies,
    input.audit.entries()
  );
  const evidenceFailure = validateSessionMemoryLifecycleEvidence({
    workerProcessedCount: workerReport.processedCount,
    workerRecoveredCount: workerReport.recoveredCount,
    workerIdle: workerReport.idle,
    activeMemoryCount: activeMemories.length,
    provenanceKind: activeMemories[0]?.provenance.kind,
    exportedOtelRecordCount
  });

  if (evidenceFailure !== undefined) {
    return evidenceFailure;
  }

  return {
    status: "passed",
    provider,
    details: {
      runId: input.runId,
      sessionId: input.cutoff.sessionId,
      sourceEntryCount: input.cutoff.sourceEntryIds.length,
      candidateJobId: candidateJob.id,
      workerProcessedCount: workerReport.processedCount,
      workerRecoveredCount: workerReport.recoveredCount,
      workerIdle: workerReport.idle,
      memoryWrittenCount: workerReport.memoryWrittenCount,
      activeMemoryCount: activeMemories.length,
      provenanceKind: "session_cutoff_automation",
      auditEventCount: input.audit.entries().length,
      exportedOtelRecordCount,
      databasePath: input.databaseReportPath
    }
  };
}

function readWrittenMemories(databasePath: string, memoryIds: readonly number[]) {
  const memories = openLongMemoryStore(databasePath);

  try {
    return memoryIds.map((id) => memories.read(id)).filter((memory) => memory !== undefined);
  } finally {
    memories.close();
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

  if (!config.memory.longMemory.enabled) {
    return skipped(
      "Set memory.longMemory.enabled=true to run the session memory lifecycle field test."
    );
  }

  if (!config.audit.otel.enabled) {
    return skipped("Set audit.otel.enabled=true to run the session memory lifecycle field test.");
  }

  return undefined;
}

function validateSessionMemoryLifecycleEvidence(evidence: {
  readonly workerProcessedCount: number;
  readonly workerRecoveredCount: number;
  readonly workerIdle: boolean;
  readonly activeMemoryCount: number;
  readonly provenanceKind: "staff_review" | "session_cutoff_automation" | undefined;
  readonly exportedOtelRecordCount: number;
}): SessionMemoryLifecycleFieldReport | undefined {
  if (!evidence.workerIdle) {
    return failed("pico session memory lifecycle field requires the memory worker to become idle");
  }

  if (evidence.workerProcessedCount === 0) {
    return failed(
      "pico session memory lifecycle field requires the memory worker to process a job"
    );
  }

  if (evidence.activeMemoryCount === 0) {
    return failed("pico session memory lifecycle field requires at least one active SQLite memory");
  }

  if (evidence.provenanceKind !== "session_cutoff_automation") {
    return failed("pico session memory lifecycle field requires automated memory provenance");
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

function resolveDatabaseReportPath(value: string | undefined): string {
  const path = value?.trim() === "" || value === undefined ? defaultDatabasePath : value;

  return isAbsolute(path) ? "<injected-database-path>" : path;
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
