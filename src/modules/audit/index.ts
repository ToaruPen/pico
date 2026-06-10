import type { PicoModule } from "../../orchestrator/contracts.js";

export type AuditEventCategory =
  | "tool_call"
  | "external_send"
  | "memory_write"
  | "transport_event"
  | "module_error";

export type AuditSeverity = "info" | "warn" | "error";

export type AuditAttributeValue = string | number | boolean;

export type AuditEvent = {
  readonly category: AuditEventCategory;
  readonly name: string;
  readonly severity: AuditSeverity;
  readonly occurredAt: string;
  readonly summary: string;
  readonly attributes: Readonly<Record<string, AuditAttributeValue>>;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
};

export type OpenTelemetryAuditLogRecord = {
  readonly timestamp: string;
  readonly observedTimestamp: string;
  readonly severityText: "INFO" | "WARN" | "ERROR";
  readonly severityNumber: 9 | 13 | 17;
  readonly body: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly attributes: Readonly<Record<string, AuditAttributeValue>>;
};

export type StructuredAuditLog = {
  readonly record: (input: Record<string, unknown>) => AuditEvent;
  readonly entries: () => readonly AuditEvent[];
};

const auditEventCategories = new Set<AuditEventCategory>([
  "tool_call",
  "external_send",
  "memory_write",
  "transport_event",
  "module_error"
]);
const auditSeverities = new Set<AuditSeverity>(["info", "warn", "error"]);
const auditEventInputKeys = new Set([
  "category",
  "name",
  "severity",
  "occurredAt",
  "summary",
  "attributes",
  "traceId",
  "spanId"
]);
const rawPayloadKeyMarkers = [
  "raw",
  "transcript",
  "conversation",
  "messages",
  "prompt",
  "completion",
  "payload",
  "requestbody",
  "responsebody",
  "messagebody",
  "fullcontent",
  "base64",
  "secret",
  "token",
  "password",
  "credential"
];
const rawPayloadExactKeys = new Set(["body", "content"]);
const reservedAttributeKeys = new Set(["eventname", "picoauditcategory"]);
const profileKeyMarkers = ["childprofile", "childtracking", "childscore", "childevaluation"];
const maximumEventNameLength = 80;
const maximumSummaryLength = 512;
const maximumAttributeCount = 16;
const maximumAttributeKeyLength = 80;
const maximumAttributeStringLength = 256;
const traceIdPattern = /^[\da-f]{32}$/u;
const spanIdPattern = /^[\da-f]{16}$/u;

export function createAuditModule(): PicoModule {
  return {
    metadata: {
      kind: "audit",
      status: "available",
      summary: "Records operationally important tool, memory, transport, and module events.",
      capabilities: [
        {
          id: "audit.describe_events",
          description:
            "Describe audit event categories without storing full transcripts by default."
        },
        {
          id: "audit.record_events",
          description: "Record validated operational audit events to structured local logs."
        }
      ]
    }
  };
}

export function createStructuredAuditLog(): StructuredAuditLog {
  const entries: AuditEvent[] = [];

  return {
    record(input) {
      const event = normalizeAuditEvent(input);
      entries.push(event);

      return event;
    },
    entries() {
      return Object.freeze([...entries]);
    }
  };
}

export function toOpenTelemetryLogRecord(event: AuditEvent): OpenTelemetryAuditLogRecord {
  const logRecord: OpenTelemetryAuditLogRecord = {
    timestamp: event.occurredAt,
    observedTimestamp: event.occurredAt,
    severityText: toOpenTelemetrySeverityText(event.severity),
    severityNumber: toOpenTelemetrySeverityNumber(event.severity),
    body: event.summary,
    attributes: Object.freeze({
      ...event.attributes,
      "event.name": event.name,
      "pico.audit.category": event.category
    }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.spanId === undefined ? {} : { spanId: event.spanId })
  };

  return Object.freeze(logRecord);
}

function normalizeAuditEvent(input: Record<string, unknown>): AuditEvent {
  validateAuditEventInputKeys(input);

  return Object.freeze({
    category: requireAuditEventCategory(input.category),
    name: requireAuditEventName(input.name),
    severity: requireAuditSeverity(input.severity),
    occurredAt: requireAuditTimestamp(input.occurredAt),
    summary: requireAuditSummary(input.summary),
    attributes: normalizeAuditAttributes(input.attributes),
    traceId: normalizeTraceId(input.traceId),
    spanId: normalizeSpanId(input.spanId)
  });
}

function validateAuditEventInputKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (isRawPayloadKey(key)) {
      throw new Error("pico audit event must not include raw or transcript payload fields");
    }

    if (isProfileKey(key)) {
      throw new Error("pico audit event must not include child profile or scoring fields");
    }

    if (!auditEventInputKeys.has(key)) {
      throw new Error("pico audit event input is malformed");
    }
  }
}

function requireAuditEventCategory(value: unknown): AuditEventCategory {
  if (typeof value === "string" && auditEventCategories.has(value as AuditEventCategory)) {
    return value as AuditEventCategory;
  }

  throw new Error("pico audit event category is invalid");
}

function requireAuditSeverity(value: unknown): AuditSeverity {
  if (typeof value === "string" && auditSeverities.has(value as AuditSeverity)) {
    return value as AuditSeverity;
  }

  throw new Error("pico audit event severity is invalid");
}

function requireAuditEventName(value: unknown): string {
  const name = requireAuditText(value, "pico audit event name is required");

  if (name.length > maximumEventNameLength) {
    throw new Error("pico audit event name is too large");
  }

  return name;
}

function requireAuditSummary(value: unknown): string {
  const summary = requireAuditText(value, "pico audit event summary is required");

  if (summary.length > maximumSummaryLength) {
    throw new Error("pico audit event summary is too large");
  }

  return summary;
}

function requireAuditTimestamp(value: unknown): string {
  const timestamp = requireAuditText(value, "pico audit event timestamp is required");

  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new Error("pico audit event timestamp is invalid");
  }

  return timestamp;
}

function requireAuditText(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(message);
  }

  return trimmed;
}

function normalizeAuditAttributes(value: unknown): Readonly<Record<string, AuditAttributeValue>> {
  if (value === undefined) {
    return Object.freeze({});
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pico audit event attributes are malformed");
  }

  const entries = Object.entries(value);

  if (entries.length > maximumAttributeCount) {
    throw new Error("pico audit event attributes are too large");
  }

  const attributes: Record<string, AuditAttributeValue> = {};

  for (const [key, attributeValue] of entries) {
    validateAuditAttributeKey(key);
    attributes[key] = normalizeAuditAttributeValue(attributeValue);
  }

  return Object.freeze(attributes);
}

function validateAuditAttributeKey(key: string): void {
  const normalized = key.trim();

  if (normalized === "" || normalized.length > maximumAttributeKeyLength) {
    throw new Error("pico audit event attribute key is invalid");
  }

  if (reservedAttributeKeys.has(normalizeKey(normalized))) {
    throw new Error("pico audit event attribute key is reserved");
  }

  if (isRawPayloadKey(normalized)) {
    throw new Error("pico audit event must not include raw or transcript payload fields");
  }

  if (isProfileKey(normalized)) {
    throw new Error("pico audit event must not include child profile or scoring fields");
  }
}

function normalizeAuditAttributeValue(value: unknown): AuditAttributeValue {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("pico audit event attributes must be primitive values");
    }

    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (trimmed.length > maximumAttributeStringLength) {
      throw new Error("pico audit event attributes are too large");
    }

    return trimmed;
  }

  throw new Error("pico audit event attributes must be primitive values");
}

function normalizeTraceId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const traceId = requireAuditText(value, "pico audit trace id is invalid");

  if (!traceIdPattern.test(traceId)) {
    throw new Error("pico audit trace id is invalid");
  }

  return traceId;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const spanId = requireAuditText(value, "pico audit span id is invalid");

  if (!spanIdPattern.test(spanId)) {
    throw new Error("pico audit span id is invalid");
  }

  return spanId;
}

function isRawPayloadKey(key: string): boolean {
  const normalized = normalizeKey(key);

  return (
    rawPayloadExactKeys.has(normalized) ||
    normalized.endsWith("body") ||
    normalized.endsWith("content") ||
    rawPayloadKeyMarkers.some((marker) => normalized.includes(marker))
  );
}

function isProfileKey(key: string): boolean {
  const normalized = normalizeKey(key);

  return profileKeyMarkers.some((marker) => normalized.includes(marker));
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/\s|\.|_|-/gu, "");
}

function toOpenTelemetrySeverityText(severity: AuditSeverity): "INFO" | "WARN" | "ERROR" {
  switch (severity) {
    case "error":
      return "ERROR";
    case "warn":
      return "WARN";
    case "info":
      return "INFO";
  }
}

function toOpenTelemetrySeverityNumber(severity: AuditSeverity): 9 | 13 | 17 {
  switch (severity) {
    case "error":
      return 17;
    case "warn":
      return 13;
    case "info":
      return 9;
  }
}
