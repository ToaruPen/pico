import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";

import {
  createOpenTelemetryProvider,
  type PicoTelemetry
} from "../../src/modules/telemetry/index.js";

export type InProcessTelemetryInspection = {
  readonly logRecordCount: number;
  readonly metricDataPointCount: number;
};

export type InProcessTelemetryCapture = {
  readonly telemetry: PicoTelemetry;
  readonly inspection: () => InProcessTelemetryInspection;
};

export function createInProcessTelemetryCapture(): InProcessTelemetryCapture {
  const logExporter = new CountingLogExporter();
  const metricExporter = new CountingMetricExporter();
  const telemetry = createOpenTelemetryProvider({
    serviceName: "pico-field-validation",
    timeoutMs: 1_000,
    metricExportIntervalMs: 60_000,
    shutdownTimeoutMs: 2_000,
    logExporter,
    metricExporter
  });

  return {
    telemetry,
    inspection: () => ({
      logRecordCount: logExporter.recordCount,
      metricDataPointCount: metricExporter.dataPointCount
    })
  };
}

class CountingLogExporter implements LogRecordExporter {
  recordCount = 0;

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.recordCount += records.length;
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class CountingMetricExporter implements PushMetricExporter {
  dataPointCount = 0;

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.dataPointCount += metrics.scopeMetrics.reduce(
      (scopeTotal, scope) =>
        scopeTotal +
        scope.metrics.reduce((metricTotal, metric) => metricTotal + metric.dataPoints.length, 0),
      0
    );
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
