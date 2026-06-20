#!/usr/bin/env jiti
import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { type AuditEvent, createStructuredAuditLog } from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporter
} from "../../src/modules/audit/otel.js";
import { createMem0MemoryProvider } from "../../src/modules/long-memory/mem0.js";
import { createMem0OssClient } from "../../src/modules/long-memory/mem0-runtime.js";
import { createResidentMemoryDrainWorker } from "../../src/runtime/resident-memory-worker.js";

const defaultPollIntervalMs = 1_000;
const defaultRecoverProcessingOlderThanMs = 10 * 60_000;
const positiveIntegerPattern = /^[1-9]\d*$/u;

const config = loadPicoConfigFromEnvironment();
const once = process.argv.includes("--once");
const abortController = new AbortController();

process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

await runResidentMemory(config, {
  once,
  signal: abortController.signal,
  pollIntervalMs: readPollInterval(process.env.PICO_RESIDENT_MEMORY_POLL_MS)
});

async function runResidentMemory(
  config: PicoConfig,
  options: {
    readonly once: boolean;
    readonly signal: AbortSignal;
    readonly pollIntervalMs: number;
  }
): Promise<void> {
  const mem0 = config.memory.mem0;

  if (!mem0.enabled || mem0.historyDbPath === undefined) {
    throw new Error("pico resident memory requires memory.mem0.enabled=true and historyDbPath");
  }

  const audit = createStructuredAuditLog();
  const exporter = createConfiguredOtelExporter(config);
  const mem0Client = await createMem0OssClient(mem0);
  const worker = createResidentMemoryDrainWorker({
    databasePath: mem0.historyDbPath,
    mem0Provider: createMem0MemoryProvider({
      client: mem0Client,
      scopeId: "pico-resident",
      audit
    }),
    audit,
    recoverProcessingOlderThanMs: readRecoverProcessingOlderThan(
      process.env.PICO_RESIDENT_MEMORY_RECOVER_PROCESSING_OLDER_THAN_MS
    )
  });
  let exportedAuditCount = 0;

  try {
    while (!options.signal.aborted) {
      const report = await worker.drainUntilIdle();

      exportedAuditCount = await exportNewAuditEvents(
        exporter,
        audit.entries(),
        exportedAuditCount
      );
      process.stdout.write(`${JSON.stringify({ status: "drained", ...report })}\n`);

      if (options.once) {
        return;
      }

      if (report.idle || report.processedCount === 0) {
        await delay(options.pollIntervalMs, options.signal);
      }
    }
  } finally {
    worker.close();
    await exporter?.shutdown();
  }
}

function createConfiguredOtelExporter(config: PicoConfig): OpenTelemetryAuditExporter | undefined {
  const otel = config.audit.otel;

  if (!otel.enabled) {
    return undefined;
  }

  return createOpenTelemetryAuditExporter({
    serviceName: otel.serviceName ?? "pico",
    ...(otel.endpoint === undefined ? {} : { endpoint: otel.endpoint }),
    ...(otel.timeoutMs === undefined ? {} : { timeoutMs: otel.timeoutMs })
  });
}

async function exportNewAuditEvents(
  exporter: OpenTelemetryAuditExporter | undefined,
  events: readonly AuditEvent[],
  exportedCount: number
): Promise<number> {
  if (exporter === undefined) {
    return events.length;
  }

  let nextExportedCount = exportedCount;

  for (const event of events.slice(exportedCount)) {
    try {
      await exporter.export(event);
      nextExportedCount += 1;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ status: "otel_export_failed", error: String(error) })}\n`
      );
      break;
    }
  }

  return nextExportedCount;
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
