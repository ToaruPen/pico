import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";

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
});
