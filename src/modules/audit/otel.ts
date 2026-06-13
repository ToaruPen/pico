import type { Context } from "@opentelemetry/api";
import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
  SimpleLogRecordProcessor
} from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { AuditEvent } from "./index.js";
import { toOpenTelemetryLogRecord } from "./index.js";

export type OpenTelemetryAuditExporterOptions = {
  readonly endpoint?: string;
  readonly serviceName: string;
  readonly timeoutMs?: number;
  readonly exporter?: LogRecordExporter;
};

export type OpenTelemetryAuditExporter = {
  readonly export: (event: AuditEvent) => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

export function createOpenTelemetryAuditExporter(
  options: OpenTelemetryAuditExporterOptions
): OpenTelemetryAuditExporter {
  const reportingExporter = new ReportingLogExporter(
    options.exporter ?? createOtlpHttpLogExporter(options)
  );
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName
    }),
    processors: [new SimpleLogRecordProcessor(reportingExporter)]
  });
  const logger = provider.getLogger("pico.audit");

  return {
    async export(event) {
      const record = toOpenTelemetryLogRecord(event);
      const exportResult = reportingExporter.nextExportResult();

      logger.emit({
        eventName: event.name,
        timestamp: new Date(record.timestamp),
        observedTimestamp: new Date(record.observedTimestamp),
        severityNumber: toOtelSeverityNumber(record.severityNumber),
        severityText: record.severityText,
        body: record.body,
        attributes: record.attributes,
        ...optionalLogContext(event)
      });

      const result = await exportResult;

      if (result.code !== ExportResultCode.SUCCESS) {
        throw new Error("pico audit OTel export failed", { cause: result.error });
      }
    },
    shutdown() {
      return provider.shutdown();
    }
  };
}

function createOtlpHttpLogExporter(options: OpenTelemetryAuditExporterOptions): LogRecordExporter {
  return new OTLPLogExporter({
    ...(options.endpoint === undefined ? {} : { url: options.endpoint }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMillis: options.timeoutMs })
  });
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

class ReportingLogExporter implements LogRecordExporter {
  private readonly pendingResults: ((result: ExportResult) => void)[] = [];

  constructor(private readonly delegate: LogRecordExporter) {}

  nextExportResult(): Promise<ExportResult> {
    return new Promise<ExportResult>((resolve) => {
      this.pendingResults.push(resolve);
    });
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    const resolvePending = this.pendingResults.shift();

    this.delegate.export(records, (result) => {
      resolvePending?.(result);
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
