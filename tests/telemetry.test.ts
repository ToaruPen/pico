import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createOpenTelemetryProvider } from "../src/modules/telemetry/index.js";

class RecordingLogExporter implements LogRecordExporter {
  readonly batches: ReadableLogRecord[][] = [];
  results: ExportResult[] = [];
  shutdownCalls = 0;

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.batches.push([...records]);
    resultCallback(this.results.shift() ?? { code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }
}

class RecordingMetricExporter implements PushMetricExporter {
  readonly batches: ResourceMetrics[] = [];
  results: ExportResult[] = [];
  shutdownCalls = 0;

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.batches.push(metrics);
    resultCallback(this.results.shift() ?? { code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }
}

class NeverSettlingShutdownLogExporter extends RecordingLogExporter {
  override shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return new Promise(() => undefined);
  }
}

function stageEvent() {
  return createStructuredAuditLog().record({
    category: "transport_event",
    name: "voice.runtime.stage",
    severity: "info",
    occurredAt: "2026-07-19T02:00:00.125Z",
    summary: "Pico voice runtime stage completed.",
    attributes: {
      "pico.voice.stage": "stt",
      "pico.voice.stage_status": "ok",
      "pico.voice.stage_duration_ms": 125,
      "pico.voice.utterance_duration_ms": 900
    }
  });
}

function allMetrics(exporter: RecordingMetricExporter) {
  return exporter.batches.flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics));
}

describe("OpenTelemetry provider", () => {
  afterEach(() => vi.useRealTimers());
  // This assertion intentionally verifies both signal mappings from one shared event.
  // eslint-disable-next-line complexity
  it("exports audit logs and low-cardinality voice metrics from one event", async () => {
    const logExporter = new RecordingLogExporter();
    const metricExporter = new RecordingMetricExporter();
    const telemetry = createOpenTelemetryProvider({
      serviceName: "pico-test",
      timeoutMs: 100,
      metricExportIntervalMs: 1_000,
      shutdownTimeoutMs: 100,
      logExporter,
      metricExporter
    });

    telemetry.record(stageEvent());
    await telemetry.forceFlush();

    expect(logExporter.batches.flat()).toHaveLength(1);
    expect(logExporter.batches.flat()[0]?.attributes).toMatchObject({
      "event.name": "voice.runtime.stage",
      "pico.voice.stage": "stt",
      "pico.voice.stage_status": "ok",
      "pico.voice.stage_duration_ms": 125
    });

    const metrics = allMetrics(metricExporter);
    const duration = metrics.find(
      (metric) => metric.descriptor.name === "pico.voice.stage.duration"
    );
    const completions = metrics.find(
      (metric) => metric.descriptor.name === "pico.voice.stage.completions"
    );

    expect(duration?.descriptor.unit).toBe("ms");
    expect(duration?.dataPoints[0]?.attributes).toEqual({
      "pico.voice.stage": "stt",
      "pico.voice.stage_status": "ok"
    });
    expect(duration?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 125 });
    expect(completions?.dataPoints[0]?.attributes).toEqual({
      "pico.voice.stage": "stt",
      "pico.voice.stage_status": "ok"
    });
    expect(completions?.dataPoints[0]?.value).toBe(1);

    await telemetry.shutdown();
  });

  it("exports ordinary audit events only as logs", async () => {
    const logExporter = new RecordingLogExporter();
    const metricExporter = new RecordingMetricExporter();
    const telemetry = createOpenTelemetryProvider({
      serviceName: "pico-test",
      timeoutMs: 100,
      metricExportIntervalMs: 1_000,
      shutdownTimeoutMs: 100,
      logExporter,
      metricExporter
    });
    const event = createStructuredAuditLog().record({
      category: "module_error",
      name: "voice.provider.failed",
      severity: "error",
      occurredAt: "2026-07-19T02:00:00.000Z",
      summary: "Voice provider failed.",
      attributes: {
        "pico.module": "voice",
        "pico.session.id": "must-not-leave-the-process"
      }
    });

    telemetry.record(event);
    await telemetry.forceFlush();

    expect(logExporter.batches.flat()).toHaveLength(1);
    expect(logExporter.batches.flat()[0]?.attributes).not.toHaveProperty("pico.session.id");
    expect(allMetrics(metricExporter)).toHaveLength(0);

    await telemetry.shutdown();
  });

  it("records exporter failures without rejecting the event producer", async () => {
    const logExporter = new RecordingLogExporter();
    const metricExporter = new RecordingMetricExporter();
    logExporter.results.push({
      code: ExportResultCode.FAILED,
      error: new Error("log collector unavailable")
    });
    metricExporter.results.push({
      code: ExportResultCode.FAILED,
      error: new Error("metric collector unavailable")
    });
    const telemetry = createOpenTelemetryProvider({
      serviceName: "pico-test",
      timeoutMs: 100,
      metricExportIntervalMs: 1_000,
      shutdownTimeoutMs: 100,
      logExporter,
      metricExporter,
      now: () => "2026-07-19T02:00:01.000Z"
    });

    expect(() => telemetry.record(stageEvent())).not.toThrow();
    await telemetry.forceFlush();

    expect(telemetry.health()).toEqual({
      logs: {
        consecutiveFailures: 1,
        lastFailureAt: "2026-07-19T02:00:01.000Z"
      },
      metrics: {
        consecutiveFailures: 1,
        lastFailureAt: "2026-07-19T02:00:01.000Z"
      }
    });

    await telemetry.shutdown();
  });

  it("shuts both providers down once and ignores records after shutdown", async () => {
    const logExporter = new RecordingLogExporter();
    const metricExporter = new RecordingMetricExporter();
    const telemetry = createOpenTelemetryProvider({
      serviceName: "pico-test",
      timeoutMs: 100,
      metricExportIntervalMs: 1_000,
      shutdownTimeoutMs: 100,
      logExporter,
      metricExporter
    });

    await telemetry.shutdown();
    await telemetry.shutdown();
    expect(() => telemetry.record(stageEvent())).not.toThrow();
    await telemetry.forceFlush();

    expect(logExporter.shutdownCalls).toBe(1);
    expect(metricExporter.shutdownCalls).toBe(1);
    expect(logExporter.batches.flat()).toHaveLength(0);
    expect(allMetrics(metricExporter)).toHaveLength(0);
  });

  it("bounds provider shutdown and emits one diagnostic when an exporter never settles", async () => {
    vi.useFakeTimers();
    const logExporter = new NeverSettlingShutdownLogExporter();
    const metricExporter = new RecordingMetricExporter();
    const diagnostics: string[] = [];
    const telemetry = createOpenTelemetryProvider({
      serviceName: "pico-test",
      timeoutMs: 100,
      metricExportIntervalMs: 1_000,
      shutdownTimeoutMs: 50,
      logExporter,
      metricExporter,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code)
    });

    const shutdown = telemetry.shutdown();
    await vi.advanceTimersByTimeAsync(50);

    await expect(shutdown).resolves.toBeUndefined();
    expect(diagnostics).toEqual(["shutdown_failed"]);
  });
});
