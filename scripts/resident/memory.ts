#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { type AuditEvent, createStructuredAuditLog } from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporterOptions
} from "../../src/modules/audit/otel.js";
import type { FacilityMemoryExtractor } from "../../src/modules/long-memory/extractor.js";
import { createPiModelFacilityMemoryExtractor } from "../../src/modules/long-memory/pi-extractor.js";
import {
  createResidentMemoryDrainWorker,
  type ResidentMemoryDrainWorker
} from "../../src/runtime/resident-memory-worker.js";

const defaultPollIntervalMs = 1_000;
const defaultRecoverProcessingOlderThanMs = 10 * 60_000;
const positiveIntegerPattern = /^[1-9]\d*$/u;

export type ResidentMemoryRuntimeDependencies = {
  readonly createExtractor?: (
    config: Extract<PicoConfig["memory"]["longMemory"], { readonly enabled: true }>["extraction"]
  ) => FacilityMemoryExtractor;
  readonly createAuditExporter?: (
    options: OpenTelemetryAuditExporterOptions
  ) => OpenTelemetryAuditExporter;
  readonly writeLine?: (line: string) => void;
  readonly writeErrorLine?: (line: string) => void;
};

export type ResidentMemoryRuntimeOptions = {
  readonly once: boolean;
  readonly signal: AbortSignal;
  readonly pollIntervalMs: number;
  readonly recoverProcessingOlderThanMs?: number;
};

export async function runResidentMemory(
  config: PicoConfig,
  options: ResidentMemoryRuntimeOptions,
  dependencies: ResidentMemoryRuntimeDependencies = {}
): Promise<void> {
  const runtime = createResidentMemoryRuntime(config, options, dependencies);

  try {
    runtime.worker.purgeExpiredDeadLetterPayloads();
    await drainResidentMemory(runtime, options, dependencies);
  } finally {
    runtime.worker.close();
    await shutdownAuditExporter(runtime.exporter, dependencies);
  }
}

type ResidentMemoryRuntime = {
  readonly worker: ResidentMemoryDrainWorker;
  readonly audit: ReturnType<typeof createStructuredAuditLog>;
  readonly exporter: OpenTelemetryAuditExporter | undefined;
};

function createResidentMemoryRuntime(
  config: PicoConfig,
  options: ResidentMemoryRuntimeOptions,
  dependencies: ResidentMemoryRuntimeDependencies
): ResidentMemoryRuntime {
  const longMemory = requireEnabledLongMemory(config);
  const audit = createStructuredAuditLog();
  const extractor =
    dependencies.createExtractor?.(longMemory.extraction) ??
    createPiModelFacilityMemoryExtractor(longMemory.extraction);

  return {
    worker: createResidentMemoryDrainWorker({
      databasePath: longMemory.databasePath,
      extractor,
      audit,
      recoverProcessingOlderThanMs:
        options.recoverProcessingOlderThanMs ?? defaultRecoverProcessingOlderThanMs,
      signal: options.signal
    }),
    audit,
    exporter: createConfiguredOtelExporter(config, dependencies)
  };
}

async function drainResidentMemory(
  runtime: ResidentMemoryRuntime,
  options: ResidentMemoryRuntimeOptions,
  dependencies: ResidentMemoryRuntimeDependencies
): Promise<void> {
  while (!options.signal.aborted) {
    const report = await runtime.worker.drainUntilIdle();

    await exportAuditEvents(runtime.exporter, runtime.audit.drain(), dependencies);
    writeDrainReport(report, dependencies);

    if (options.once) {
      return;
    }

    if (report.idle || report.processedCount === 0) {
      await delay(options.pollIntervalMs, options.signal);
    }
  }
}

function writeDrainReport(
  report: Awaited<ReturnType<ResidentMemoryDrainWorker["drainUntilIdle"]>>,
  dependencies: ResidentMemoryRuntimeDependencies
): void {
  const status = report.lastErrorCode === undefined && report.idle ? "drained" : "degraded";
  const line = `${JSON.stringify({ status, ...report })}\n`;

  if (dependencies.writeLine === undefined) {
    process.stdout.write(line);
    return;
  }

  dependencies.writeLine(line);
}

function requireEnabledLongMemory(
  config: PicoConfig
): Extract<PicoConfig["memory"]["longMemory"], { readonly enabled: true }> {
  if (!config.memory.longMemory.enabled) {
    throw new Error("pico resident memory requires memory.longMemory.enabled=true");
  }

  return config.memory.longMemory;
}

function createConfiguredOtelExporter(
  config: PicoConfig,
  dependencies: Pick<ResidentMemoryRuntimeDependencies, "createAuditExporter">
): OpenTelemetryAuditExporter | undefined {
  const otel = config.audit.otel;

  if (!otel.enabled) {
    return undefined;
  }

  const exporterOptions = {
    serviceName: otel.serviceName ?? "pico",
    ...(otel.endpoint === undefined ? {} : { endpoint: otel.endpoint }),
    timeoutMs: otel.timeoutMs ?? 10_000
  } satisfies OpenTelemetryAuditExporterOptions;

  return (
    dependencies.createAuditExporter?.(exporterOptions) ??
    createOpenTelemetryAuditExporter(exporterOptions)
  );
}

async function exportAuditEvents(
  exporter: OpenTelemetryAuditExporter | undefined,
  events: readonly AuditEvent[],
  dependencies: Pick<ResidentMemoryRuntimeDependencies, "writeErrorLine">
): Promise<void> {
  if (exporter === undefined) {
    return;
  }

  for (const event of events) {
    try {
      await exporter.export(event);
    } catch {
      writeErrorReport("otel_export_failed", dependencies);
      return;
    }
  }
}

function writeErrorReport(
  errorCode: "otel_export_failed" | "otel_shutdown_failed",
  dependencies: Pick<ResidentMemoryRuntimeDependencies, "writeErrorLine">
): void {
  const line = `${JSON.stringify({ status: "degraded", errorCode })}\n`;

  if (dependencies.writeErrorLine === undefined) {
    process.stderr.write(line);
    return;
  }

  dependencies.writeErrorLine(line);
}

async function shutdownAuditExporter(
  exporter: OpenTelemetryAuditExporter | undefined,
  dependencies: Pick<ResidentMemoryRuntimeDependencies, "writeErrorLine">
): Promise<void> {
  if (exporter === undefined) {
    return;
  }

  try {
    await exporter.shutdown();
  } catch {
    writeErrorReport("otel_shutdown_failed", dependencies);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = (): void => {
      finish();
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

function readPollInterval(value: string | undefined): number {
  if (value === undefined) {
    return defaultPollIntervalMs;
  }

  const parsed = readPositiveInteger(value);

  if (parsed === undefined) {
    throw new Error("PICO_RESIDENT_MEMORY_POLL_MS must be a positive integer");
  }

  return parsed;
}

function readRecoverProcessingOlderThan(value: string | undefined): number {
  if (value === undefined) {
    return defaultRecoverProcessingOlderThanMs;
  }

  const parsed = readPositiveInteger(value);

  if (parsed === undefined) {
    throw new Error(
      "PICO_RESIDENT_MEMORY_RECOVER_PROCESSING_OLDER_THAN_MS must be a positive integer"
    );
  }

  return parsed;
}

function readPositiveInteger(value: string): number | undefined {
  if (!positiveIntegerPattern.test(value)) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return undefined;
  }

  return parsed;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const config = loadPicoConfigFromEnvironment();
  const once = process.argv.includes("--once");
  const abortController = new AbortController();

  process.once("SIGINT", () => abortController.abort());
  process.once("SIGTERM", () => abortController.abort());

  await runResidentMemory(config, {
    once,
    signal: abortController.signal,
    pollIntervalMs: readPollInterval(process.env.PICO_RESIDENT_MEMORY_POLL_MS),
    recoverProcessingOlderThanMs: readRecoverProcessingOlderThan(
      process.env.PICO_RESIDENT_MEMORY_RECOVER_PROCESSING_OLDER_THAN_MS
    )
  });
}
