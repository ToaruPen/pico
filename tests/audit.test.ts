import { describe, expect, it } from "vitest";

import {
  createAuditModule,
  createStructuredAuditLog,
  toOpenTelemetryLogRecord
} from "../src/modules/audit/index.js";

describe("operational audit events", () => {
  it("records validated audit events to a local structured log", () => {
    const log = createStructuredAuditLog();

    const event = log.record({
      category: "memory_write",
      name: "long_memory.reviewed_write",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Reviewed facility memory was written.",
      attributes: {
        "pico.memory.category": "facility_knowledge",
        "pico.memory.reviewed": true
      }
    });

    expect(event).toEqual({
      category: "memory_write",
      name: "long_memory.reviewed_write",
      severity: "info",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Reviewed facility memory was written.",
      attributes: {
        "pico.memory.category": "facility_knowledge",
        "pico.memory.reviewed": true
      },
      traceId: undefined,
      spanId: undefined
    });
    expect(log.entries()).toEqual([event]);
  });

  it("rejects raw payload, transcript, and conversation fields", () => {
    const log = createStructuredAuditLog();

    expect(() =>
      log.record({
        category: "tool_call",
        name: "vision.describe_scene",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Vision tool call completed.",
        rawTranscript: "full conversation text"
      })
    ).toThrow("pico audit event must not include raw or transcript payload fields");

    expect(() =>
      log.record({
        category: "external_send",
        name: "daily_report.delivery.queued",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Daily report delivery was queued for staff review.",
        attributes: {
          "pico.delivery.channel": "line_official",
          "pico.conversation.transcript": "full chat transcript"
        }
      })
    ).toThrow("pico audit event must not include raw or transcript payload fields");
  });

  it("bounds OpenTelemetry attributes to primitive local metadata", () => {
    const log = createStructuredAuditLog();
    const tooManyAttributes = Object.fromEntries(
      Array.from({ length: 17 }, (_value, index) => [`pico.test.${index}`, index])
    );

    expect(() =>
      log.record({
        category: "transport_event",
        name: "transport.model_endpoint.checked",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Protected model endpoint connectivity was checked.",
        attributes: tooManyAttributes
      })
    ).toThrow("pico audit event attributes are too large");

    expect(() =>
      log.record({
        category: "transport_event",
        name: "transport.model_endpoint.checked",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Protected model endpoint connectivity was checked.",
        attributes: {
          "pico.transport.endpoint": { id: "windows-ollama-qwen3-5" }
        }
      })
    ).toThrow("pico audit event attributes must be primitive values");
  });

  it("maps audit events to OpenTelemetry log record compatible objects", () => {
    const log = createStructuredAuditLog();
    const event = log.record({
      category: "module_error",
      name: "vision.scene_description.failed",
      severity: "error",
      occurredAt: "2026-06-10T09:00:00.000Z",
      summary: "Vision scene description failed.",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      attributes: {
        "pico.module": "vision",
        "pico.error.code": "model_http_error"
      }
    });

    expect(toOpenTelemetryLogRecord(event)).toEqual({
      timestamp: "2026-06-10T09:00:00.000Z",
      observedTimestamp: "2026-06-10T09:00:00.000Z",
      severityText: "ERROR",
      severityNumber: 17,
      body: "Vision scene description failed.",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      attributes: {
        "event.name": "vision.scene_description.failed",
        "pico.audit.category": "module_error",
        "pico.module": "vision",
        "pico.error.code": "model_http_error"
      }
    });
  });

  it("rejects reserved OpenTelemetry audit identity attributes", () => {
    const log = createStructuredAuditLog();

    expect(() =>
      log.record({
        category: "tool_call",
        name: "vision.describe_scene",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Vision scene description tool call completed.",
        attributes: {
          "event.name": "spoofed.event",
          "pico.audit.category": "external_send"
        }
      })
    ).toThrow("pico audit event attribute key is reserved");
  });

  it("keeps OpenTelemetry identity attributes authoritative for mapped event values", () => {
    expect(
      toOpenTelemetryLogRecord({
        category: "tool_call",
        name: "vision.describe_scene",
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Vision scene description tool call completed.",
        traceId: undefined,
        spanId: undefined,
        attributes: {
          "event.name": "spoofed.event",
          "pico.audit.category": "external_send"
        }
      }).attributes
    ).toMatchObject({
      "event.name": "vision.describe_scene",
      "pico.audit.category": "tool_call"
    });
  });

  it("rejects unbounded event names before they become OpenTelemetry attributes", () => {
    const log = createStructuredAuditLog();

    expect(() =>
      log.record({
        category: "tool_call",
        name: `vision.${"describe.".repeat(20)}scene`,
        severity: "info",
        occurredAt: "2026-06-10T09:00:00.000Z",
        summary: "Vision scene description tool call completed."
      })
    ).toThrow("pico audit event name is too large");
  });

  it("represents future staff daily report delivery without a LINE integration", () => {
    const log = createStructuredAuditLog();

    const event = log.record({
      category: "external_send",
      name: "daily_report.delivery.queued",
      severity: "info",
      occurredAt: "2026-06-10T18:30:00.000Z",
      summary: "Bot-authored staff daily report was queued for future official LINE delivery.",
      attributes: {
        "pico.audit.audience": "staff",
        "pico.delivery.channel": "line_official",
        "pico.daily_report.date": "2026-06-10"
      }
    });

    expect(toOpenTelemetryLogRecord(event).attributes).toMatchObject({
      "event.name": "daily_report.delivery.queued",
      "pico.audit.category": "external_send",
      "pico.audit.audience": "staff",
      "pico.delivery.channel": "line_official",
      "pico.daily_report.date": "2026-06-10"
    });
  });

  it("describes the audit event capability without advertising transcript storage", () => {
    const module = createAuditModule();

    expect(module.metadata.capabilities.map((capability) => capability.id)).toContain(
      "audit.record_events"
    );
    expect(module.metadata.summary.toLowerCase()).not.toContain("transcript");
  });
});
