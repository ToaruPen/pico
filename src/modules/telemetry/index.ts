import type { Attributes, Context } from "@opentelemetry/api";
import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics
} from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { AuditEvent } from "../audit/index.js";
import { toOpenTelemetryLogRecord } from "../audit/index.js";

export type TelemetrySignalHealth = {
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
};

export type TelemetryHealthSnapshot = {
  readonly logs: TelemetrySignalHealth;
  readonly metrics: TelemetrySignalHealth;
};

export type TelemetryDiagnostic = {
  readonly code: "force_flush_failed" | "shutdown_failed";
  readonly phase: "force_flush" | "shutdown";
};

export type OpenTelemetryProviderOptions = {
  readonly baseUrl?: string;
  readonly serviceName: string;
  readonly timeoutMs: number;
  readonly metricExportIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly logExporter?: LogRecordExporter;
  readonly metricExporter?: PushMetricExporter;
  readonly onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void;
  readonly now?: () => string;
};

export type PicoTelemetry = {
  readonly record: (event: AuditEvent) => void;
  readonly forceFlush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly health: () => TelemetryHealthSnapshot;
};

type MutableSignalHealth = {
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
};

const voiceStageEventName = "voice.runtime.stage";
const voiceStageAttribute = "pico.voice.stage";
const voiceStageStatusAttribute = "pico.voice.stage_status";
const voiceStageDurationAttribute = "pico.voice.stage_duration_ms";
const telemetryPrivateAttributeNames = new Set([
  "picogenerationid",
  "picophysicalkey",
  "picosessionid",
  "picotoolcallid"
]);

export function createOpenTelemetryProvider(options: OpenTelemetryProviderOptions): PicoTelemetry {
  const now = options.now ?? (() => new Date().toISOString());
  const health = createExportHealth(now);
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName });
  const logExporter = new HealthReportingLogExporter(
    options.logExporter ?? createOtlpLogExporter(options),
    health.recordLogs
  );
  const metricExporter = new HealthReportingMetricExporter(
    options.metricExporter ?? createOtlpMetricExporter(options),
    health.recordMetrics
  );
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: Math.min(5_000, options.metricExportIntervalMs),
        exportTimeoutMillis: options.timeoutMs
      })
    ]
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs,
    exportTimeoutMillis: options.timeoutMs,
    cardinalityLimits: {
      counter: 128,
      histogram: 128,
      default: 128
    }
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  const logger = loggerProvider.getLogger("pico.audit");
  const meter = meterProvider.getMeter("pico.voice");
  const stageDuration = meter.createHistogram("pico.voice.stage.duration", {
    description: "Resident voice runtime stage wall-clock duration.",
    unit: "ms"
  });
  const stageCompletions = meter.createCounter("pico.voice.stage.completions", {
    description: "Completed resident voice runtime stages."
  });
  let acceptingRecords = true;
  let shutdownOperation: Promise<void> | undefined;

  const forceFlushProviders = async (): Promise<void> => {
    const results = await Promise.allSettled([
      loggerProvider.forceFlush(),
      meterProvider.forceFlush()
    ]);

    if (results.some((result) => result.status === "rejected")) {
      options.onDiagnostic?.({ code: "force_flush_failed", phase: "force_flush" });
    }
  };

  return {
    record(event) {
      if (!acceptingRecords) {
        return;
      }

      emitAuditLog(logger, event);
      recordVoiceMetrics(stageDuration, stageCompletions, event);
    },
    async forceFlush() {
      if (!acceptingRecords) {
        return;
      }

      await runBounded(forceFlushProviders(), options.shutdownTimeoutMs, () =>
        options.onDiagnostic?.({ code: "force_flush_failed", phase: "force_flush" })
      );
    },
    shutdown() {
      if (shutdownOperation !== undefined) {
        return shutdownOperation;
      }

      acceptingRecords = false;
      shutdownOperation = (async () => {
        await runBounded(forceFlushProviders(), options.shutdownTimeoutMs, () =>
          options.onDiagnostic?.({ code: "force_flush_failed", phase: "force_flush" })
        );
        await runBounded(
          Promise.allSettled([loggerProvider.shutdown(), meterProvider.shutdown()]).then(
            (results) => {
              if (results.some((result) => result.status === "rejected")) {
                options.onDiagnostic?.({ code: "shutdown_failed", phase: "shutdown" });
              }
            }
          ),
          options.shutdownTimeoutMs,
          () => options.onDiagnostic?.({ code: "shutdown_failed", phase: "shutdown" })
        );
      })();

      return shutdownOperation;
    },
    health: health.snapshot
  };
}

function createOtlpLogExporter(options: OpenTelemetryProviderOptions): LogRecordExporter {
  return new OTLPLogExporter({
    url: `${requireBaseUrl(options.baseUrl)}/v1/logs`,
    timeoutMillis: options.timeoutMs,
    concurrencyLimit: 1
  });
}

function createOtlpMetricExporter(options: OpenTelemetryProviderOptions): PushMetricExporter {
  return new OTLPMetricExporter({
    url: `${requireBaseUrl(options.baseUrl)}/v1/metrics`,
    timeoutMillis: options.timeoutMs,
    concurrencyLimit: 1
  });
}

function requireBaseUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("pico telemetry OTel baseUrl is required");
  }

  return value.replace(/\/$/u, "");
}

function emitAuditLog(logger: ReturnType<LoggerProvider["getLogger"]>, event: AuditEvent): void {
  const telemetryEvent = stripTelemetryPrivateAttributes(event);
  const record = toOpenTelemetryLogRecord(telemetryEvent);

  logger.emit({
    eventName: telemetryEvent.name,
    timestamp: new Date(record.timestamp),
    observedTimestamp: new Date(record.observedTimestamp),
    severityNumber: toOtelSeverityNumber(record.severityNumber),
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
    ...optionalLogContext(telemetryEvent)
  });
}

function stripTelemetryPrivateAttributes(event: AuditEvent): AuditEvent {
  const attributes = Object.fromEntries(
    Object.entries(event.attributes).filter(
      ([key]) =>
        !telemetryPrivateAttributeNames.has(key.toLowerCase().replaceAll(/[^a-z0-9]/gu, ""))
    )
  );

  if (Object.keys(attributes).length === Object.keys(event.attributes).length) {
    return event;
  }

  return Object.freeze({
    ...event,
    attributes: Object.freeze(attributes)
  });
}

function recordVoiceMetrics(
  stageDuration: ReturnType<ReturnType<MeterProvider["getMeter"]>["createHistogram"]>,
  stageCompletions: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>,
  event: AuditEvent
): void {
  if (event.name !== voiceStageEventName) {
    return;
  }

  const stage = event.attributes[voiceStageAttribute];
  const status = event.attributes[voiceStageStatusAttribute];
  const durationMs = event.attributes[voiceStageDurationAttribute];

  if (typeof stage !== "string" || typeof status !== "string" || typeof durationMs !== "number") {
    return;
  }

  const attributes: Attributes = {
    [voiceStageAttribute]: stage,
    [voiceStageStatusAttribute]: status
  };
  stageDuration.record(durationMs, attributes);
  stageCompletions.add(1, attributes);
}

function optionalLogContext(event: AuditEvent): Record<"context", Context> | Record<string, never> {
  if (event.traceId === undefined || event.spanId === undefined) {
    return {};
  }

  return {
    context: trace.setSpanContext(ROOT_CONTEXT, {
      traceId: event.traceId,
      spanId: event.spanId,
      traceFlags: TraceFlags.SAMPLED
    })
  };
}

function toOtelSeverityNumber(severityNumber: 9 | 13 | 17): SeverityNumber {
  switch (severityNumber) {
    case 9:
      return SeverityNumber.INFO;
    case 13:
      return SeverityNumber.WARN;
    case 17:
      return SeverityNumber.ERROR;
  }
}

function createExportHealth(now: () => string): {
  readonly recordLogs: (result: ExportResult) => void;
  readonly recordMetrics: (result: ExportResult) => void;
  readonly snapshot: () => TelemetryHealthSnapshot;
} {
  const logs: MutableSignalHealth = { consecutiveFailures: 0 };
  const metrics: MutableSignalHealth = { consecutiveFailures: 0 };

  return {
    recordLogs: (result) => recordExportResult(logs, result, now),
    recordMetrics: (result) => recordExportResult(metrics, result, now),
    snapshot: () => ({
      logs: freezeSignalHealth(logs),
      metrics: freezeSignalHealth(metrics)
    })
  };
}

function recordExportResult(
  state: MutableSignalHealth,
  result: ExportResult,
  now: () => string
): void {
  if (result.code === ExportResultCode.SUCCESS) {
    state.consecutiveFailures = 0;
    state.lastSuccessAt = now();
    return;
  }

  state.consecutiveFailures += 1;
  state.lastFailureAt = now();
}

function freezeSignalHealth(state: MutableSignalHealth): TelemetrySignalHealth {
  return Object.freeze({
    consecutiveFailures: state.consecutiveFailures,
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastFailureAt === undefined ? {} : { lastFailureAt: state.lastFailureAt })
  });
}

class HealthReportingLogExporter implements LogRecordExporter {
  constructor(
    private readonly delegate: LogRecordExporter,
    private readonly recordResult: (result: ExportResult) => void
  ) {}

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(records, (result) => {
      this.recordResult(result);
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

class HealthReportingMetricExporter implements PushMetricExporter {
  constructor(
    private readonly delegate: PushMetricExporter,
    private readonly recordResult: (result: ExportResult) => void
  ) {}

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(metrics, (result) => {
      this.recordResult(result);
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

async function runBounded(
  operation: Promise<unknown>,
  timeoutMs: number,
  onFailure: () => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("pico telemetry operation timed out")),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } catch {
    onFailure();
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
