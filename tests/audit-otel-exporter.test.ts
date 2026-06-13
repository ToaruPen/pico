import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createOpenTelemetryAuditExporter } from "../src/modules/audit/otel.js";

class RecordingLogExporter implements LogRecordExporter {
  readonly records: ReadableLogRecord[] = [];
  readonly results: ExportResult[] = [];

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.records.push(...records);
    const result = this.results.shift() ?? { code: ExportResultCode.SUCCESS };
    resultCallback(result);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class DeferredLogExporter implements LogRecordExporter {
  readonly callbacks: ((result: ExportResult) => void)[] = [];

  export(_records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.callbacks.push(resultCallback);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class ThrowingLogExporter implements LogRecordExporter {
  export(): void {
    throw new Error("delegate export crashed");
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

type PromiseOutcome =
  | {
      readonly state: "pending" | "resolved";
    }
  | {
      readonly state: "rejected";
      readonly message: string;
    };

async function promiseOutcome(promise: Promise<unknown>): Promise<PromiseOutcome> {
  let outcome: PromiseOutcome = { state: "pending" };

  void promise.then(
    () => {
      outcome = { state: "resolved" };
    },
    (error: unknown) => {
      outcome = {
        state: "rejected",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  );
  await Promise.resolve();
  await Promise.resolve();

  return outcome;
}

describe("OpenTelemetry audit exporter", () => {
  it("exports local audit events through the official logs SDK", async () => {
    const audit = createStructuredAuditLog();
    const exporter = new RecordingLogExporter();
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test"
    });
    const event = audit.record({
      category: "module_error",
      name: "vision.scene_description.failed",
      severity: "error",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Vision scene description failed.",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      attributes: {
        "pico.module": "vision"
      }
    });

    await otel.export(event);
    await otel.shutdown();

    expect(exporter.records).toHaveLength(1);
    expect(exporter.records[0]?.body).toBe("Vision scene description failed.");
    expect(exporter.records[0]?.severityText).toBe("ERROR");
    expect(exporter.records[0]?.severityNumber).toBe(17);
    expect(exporter.records[0]?.eventName).toBe("vision.scene_description.failed");
    expect(exporter.records[0]?.attributes).toMatchObject({
      "event.name": "vision.scene_description.failed",
      "pico.audit.category": "module_error",
      "pico.module": "vision"
    });
    expect(exporter.records[0]?.spanContext).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7"
    });
    expect(audit.entries()).toEqual([event]);
  });

  it("reports exporter failures without mutating the local audit log", async () => {
    const audit = createStructuredAuditLog();
    const exporter = new RecordingLogExporter();
    exporter.results.push({
      code: ExportResultCode.FAILED,
      error: new Error("collector unavailable")
    });
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test"
    });
    const event = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.added",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Session cutoff was submitted to the local Mem0 memory provider.",
      attributes: {
        "pico.memory.provider": "mem0"
      }
    });

    await expect(otel.export(event)).rejects.toThrow("pico audit OTel export failed");
    await otel.shutdown();

    expect(audit.entries()).toEqual([event]);
  });

  it("matches concurrent export results to the originating audit event", async () => {
    const audit = createStructuredAuditLog();
    const exporter = new DeferredLogExporter();
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test"
    });
    const firstEvent = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.first",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "First export.",
      attributes: {}
    });
    const secondEvent = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.second",
      severity: "info",
      occurredAt: "2026-06-10T09:00:01.000Z",
      summary: "Second export.",
      attributes: {}
    });

    const firstExport = otel.export(firstEvent);
    const secondExport = otel.export(secondEvent);

    expect(exporter.callbacks).toHaveLength(2);
    exporter.callbacks[1]?.({ code: ExportResultCode.SUCCESS });
    exporter.callbacks[0]?.({
      code: ExportResultCode.FAILED,
      error: new Error("first export failed")
    });

    await expect(firstExport).rejects.toThrow("pico audit OTel export failed");
    await expect(secondExport).resolves.toBeUndefined();
    await otel.shutdown();
  });

  it("rejects exports after shutdown instead of leaving callers pending", async () => {
    const audit = createStructuredAuditLog();
    const exporter = new DeferredLogExporter();
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test"
    });
    const event = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.after_shutdown",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Export after shutdown.",
      attributes: {}
    });

    await otel.shutdown();

    await expect(otel.export(event)).rejects.toThrow("pico audit OTel exporter is shut down");
  });

  it("rejects in-flight exports when shutdown happens before delegate callback", async () => {
    const audit = createStructuredAuditLog();
    const exporter = new DeferredLogExporter();
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test"
    });
    const event = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.in_flight_shutdown",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "In-flight export shutdown.",
      attributes: {}
    });
    const exportResult = otel.export(event);

    expect(exporter.callbacks).toHaveLength(1);

    await otel.shutdown();

    await expect(promiseOutcome(exportResult)).resolves.toEqual({
      state: "rejected",
      message: "pico audit OTel exporter is shut down"
    });
  });

  it("rejects when the underlying log exporter throws synchronously", async () => {
    const audit = createStructuredAuditLog();
    const otel = createOpenTelemetryAuditExporter({
      exporter: new ThrowingLogExporter(),
      serviceName: "pico-test"
    });
    const event = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.sync_throw",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Synchronous exporter failure.",
      attributes: {}
    });
    const exportResult = otel.export(event);

    await expect(promiseOutcome(exportResult)).resolves.toEqual({
      state: "rejected",
      message: "pico audit OTel export failed"
    });
    await otel.shutdown();
  });

  it("times out if the underlying log exporter never reports a result", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const exporter = new DeferredLogExporter();
    const otel = createOpenTelemetryAuditExporter({
      exporter,
      serviceName: "pico-test",
      timeoutMs: 25
    });
    const event = audit.record({
      category: "memory_write",
      name: "long_memory.mem0.timeout",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Export timeout.",
      attributes: {}
    });

    try {
      const result = otel.export(event);
      const expectation = expect(result).rejects.toThrow(
        "pico audit OTel export timed out after 25 ms"
      );

      await vi.advanceTimersByTimeAsync(25);

      await expectation;
    } finally {
      vi.useRealTimers();
      await otel.shutdown();
    }
  });

  it("rejects non-local OTLP log endpoints at the exporter boundary", () => {
    expect(() =>
      createOpenTelemetryAuditExporter({
        endpoint: "https://otel.example.com/v1/logs",
        serviceName: "pico-test"
      })
    ).toThrow("pico audit OTel endpoint must use a local Collector URL");
  });
});
