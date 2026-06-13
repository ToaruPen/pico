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
  validateOtelEndpointOption(options);
  const reportingExporter = new ReportingLogExporter(
    options.exporter ?? createOtlpHttpLogExporter(options),
    options.timeoutMs
  );
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName
    }),
    processors: [new SimpleLogRecordProcessor(reportingExporter)]
  });
  const logger = provider.getLogger("pico.audit");
  let shutdown = false;

  return {
    async export(event) {
      if (shutdown) {
        throw new Error("pico audit OTel exporter is shut down");
      }

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
    async shutdown() {
      shutdown = true;
      reportingExporter.rejectPending(new Error("pico audit OTel exporter is shut down"));
      await provider.shutdown();
    }
  };
}

function createOtlpHttpLogExporter(options: OpenTelemetryAuditExporterOptions): LogRecordExporter {
  if (options.endpoint === undefined) {
    throw new Error("pico audit OTel endpoint is required");
  }

  return new OTLPLogExporter({
    url: options.endpoint,
    ...(options.timeoutMs === undefined ? {} : { timeoutMillis: options.timeoutMs })
  });
}

function validateOtelEndpointOption(options: OpenTelemetryAuditExporterOptions): void {
  if (options.endpoint === undefined) {
    return;
  }

  if (!URL.canParse(options.endpoint)) {
    throw new Error("pico audit OTel endpoint must be a valid URL");
  }

  const parsedUrl = new URL(options.endpoint);

  requireOtelEndpointShape(parsedUrl);
  requireLocalOtelEndpoint(parsedUrl);
}

function requireOtelEndpointShape(parsedUrl: URL): void {
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("pico audit OTel endpoint must use HTTP");
  }

  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new Error("pico audit OTel endpoint must not include credentials");
  }

  if (parsedUrl.pathname !== "/v1/logs") {
    throw new Error("pico audit OTel endpoint must end with /v1/logs");
  }

  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new Error("pico audit OTel endpoint must not include query or fragment");
  }
}

function requireLocalOtelEndpoint(parsedUrl: URL): void {
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsedUrl.hostname)) {
    throw new Error("pico audit OTel endpoint must use a local Collector URL");
  }
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

type PendingExportResult = {
  readonly resolve: (result: ExportResult) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
};

class ReportingLogExporter implements LogRecordExporter {
  private readonly pendingResults: PendingExportResult[] = [];

  constructor(
    private readonly delegate: LogRecordExporter,
    private readonly timeoutMs: number | undefined
  ) {}

  nextExportResult(): Promise<ExportResult> {
    return new Promise<ExportResult>((resolve, reject) => {
      const pending: PendingExportResult = {
        resolve,
        reject,
        timer: undefined,
        settled: false
      };

      const timeoutMs = this.timeoutMs;

      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.rejectPendingResult(
            pending,
            new Error(`pico audit OTel export timed out after ${timeoutMs} ms`)
          );
        }, timeoutMs);
      }

      this.pendingResults.push(pending);
    });
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    const pending = this.pendingResults.shift();

    this.delegate.export(records, (result) => {
      if (pending !== undefined && !pending.settled) {
        pending.settled = true;
        this.clearPendingTimer(pending);
        pending.resolve(result);
      }
      resultCallback(result);
    });
  }

  rejectPending(error: Error): void {
    const pendingResults = this.pendingResults.splice(0);

    for (const pending of pendingResults) {
      this.rejectPendingResult(pending, error);
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  private rejectPendingResult(pending: PendingExportResult, error: Error): void {
    if (pending.settled) {
      return;
    }

    pending.settled = true;
    this.clearPendingTimer(pending);
    const index = this.pendingResults.indexOf(pending);

    if (index !== -1) {
      this.pendingResults.splice(index, 1);
    }

    pending.reject(error);
  }

  private clearPendingTimer(pending: PendingExportResult): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }
}
