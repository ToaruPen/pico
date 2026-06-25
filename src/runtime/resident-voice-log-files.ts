import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AuditAttributeValue, AuditEvent } from "../modules/audit/index.js";
import { formatResidentVoiceConsoleEvent } from "./resident-voice-console-log.js";
import type { VoiceResidentConsoleSink } from "./voice-resident.js";

export type ResidentVoiceLogRunMode = "development" | "normal";

export type ResidentVoiceLogPathInput = {
  readonly homeDirectory: string;
  readonly runMode: ResidentVoiceLogRunMode;
  readonly occurredAt: string;
  readonly runId?: string;
  readonly sessionId?: string;
};

export type ResidentVoiceLogPaths = {
  readonly picoDirectory: string;
  readonly modeDirectory: string;
  readonly dayDirectory: string;
  readonly processLogPath: string;
  readonly dailyEventsJsonlPath: string;
  readonly metricsJsonlPath: string;
  readonly sessionTextLogPath?: string;
  readonly sessionJsonlPath?: string;
};

export type ResidentVoiceFileLogSinkOptions = {
  readonly homeDirectory: string;
  readonly runMode: ResidentVoiceLogRunMode;
  readonly runId?: string;
  readonly now?: () => string;
  readonly maxTextLength?: number;
};

const defaultMaxTextLength = 240;
const voiceMetricAttributeKeys = new Set([
  "pico.voice.stage",
  "pico.voice.stage_status",
  "pico.voice.stage_duration_ms",
  "pico.voice.frame_count",
  "pico.voice.utterance_duration_ms",
  "pico.voice.sample_rate_hz",
  "pico.voice.channels",
  "pico.voice.suppressed_frame_count",
  "pico.voice.speech_detected",
  "pico.voice.speech_probability",
  "pico.voice.rms_db",
  "pico.voice.entry_count",
  "pico.voice.chunk_count",
  "pico.voice.frame_bytes",
  "pico.voice.vlm_frame_bytes",
  "pico.voice.triggered",
  "pico.voice.queue_depth",
  "pico.voice.error_code"
]);

export function createResidentVoiceFileLogSink(
  options: ResidentVoiceFileLogSinkOptions
): VoiceResidentConsoleSink & {
  readonly writeProcessLine: (line: string) => void;
  readonly writeAuditEvent: (event: ResidentVoiceLogAuditEvent) => void;
} {
  const runStartedAt = options.now?.() ?? new Date().toISOString();
  const runId = options.runId ?? defineResidentVoiceRunId(runStartedAt, process.pid);
  const maxTextLength = options.maxTextLength ?? defaultMaxTextLength;

  return {
    record(event) {
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: event.occurredAt,
        sessionId: event.sessionId
      });
      const payload = {
        schemaVersion: 1,
        runMode: options.runMode,
        runId,
        ...event
      };

      appendPrivateFile(paths.dailyEventsJsonlPath, `${JSON.stringify(payload)}\n`);

      if (paths.sessionTextLogPath !== undefined && paths.sessionJsonlPath !== undefined) {
        appendPrivateFile(
          paths.sessionTextLogPath,
          formatResidentVoiceConsoleEvent(event, maxTextLength)
        );
        appendPrivateFile(paths.sessionJsonlPath, `${JSON.stringify(payload)}\n`);
      }
    },
    writeProcessLine(line) {
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: runStartedAt
      });

      appendPrivateFile(paths.processLogPath, line);
    },
    writeAuditEvent(event) {
      const normalized = normalizeResidentVoiceMetricEvent(event);
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: runStartedAt
      });

      appendPrivateFile(
        paths.metricsJsonlPath,
        `${JSON.stringify({
          schemaVersion: 1,
          runMode: options.runMode,
          runId,
          name: normalized.name,
          occurredAt: normalized.occurredAt,
          attributes: normalized.attributes
        })}\n`
      );
    }
  };
}

export function createResidentVoiceCompositeConsoleSink(
  sinks: readonly VoiceResidentConsoleSink[]
): VoiceResidentConsoleSink {
  return {
    record(event) {
      for (const sink of sinks) {
        try {
          sink.record(event);
        } catch {
          // One console sink failure must not prevent the remaining sinks.
        }
      }
    }
  };
}

export function resolveResidentVoiceLogPaths(
  input: ResidentVoiceLogPathInput
): ResidentVoiceLogPaths {
  const day = datePart(input.occurredAt);
  const runId = requireResidentVoiceRunId(input.runId ?? "process");
  const picoDirectory = join(input.homeDirectory, ".pico");
  const modeDirectory = join(picoDirectory, "resident-voice", input.runMode);
  const dayDirectory = join(modeDirectory, "processes", day);
  const sessionsDirectory = join(modeDirectory, "sessions", day, runId);
  const metricsDirectory = join(modeDirectory, "metrics", day);

  return {
    picoDirectory,
    modeDirectory,
    dayDirectory,
    processLogPath: join(dayDirectory, `${runId}.log`),
    dailyEventsJsonlPath: join(modeDirectory, "events", `${day}.jsonl`),
    metricsJsonlPath: join(metricsDirectory, `${runId}.jsonl`),
    ...(input.sessionId === undefined
      ? {}
      : {
          sessionTextLogPath: join(sessionsDirectory, `${input.sessionId}.log`),
          sessionJsonlPath: join(sessionsDirectory, `${input.sessionId}.jsonl`)
        })
  };
}

export function defineResidentVoiceRunId(timestamp: string, processId: number): string {
  const parsed = new Date(Date.parse(timestamp));

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("resident voice run id timestamp must be a valid ISO timestamp");
  }

  if (!Number.isInteger(processId) || processId < 1) {
    throw new Error("resident voice run id processId must be a positive integer");
  }

  return requireResidentVoiceRunId(`${timestamp.replaceAll(/[:.]/g, "-")}-${processId}`);
}

export function requireResidentVoiceRunId(value: string): string {
  if (!/^[\dA-Za-z][\dA-Za-z._-]{0,127}$/u.test(value)) {
    throw new Error("resident voice runId must be a path-safe identifier");
  }

  return value;
}

export type ResidentVoiceLogAuditEvent = Omit<AuditEvent, "traceId" | "spanId"> & {
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
};

function normalizeResidentVoiceMetricEvent(event: ResidentVoiceLogAuditEvent): {
  readonly name: string;
  readonly occurredAt: string;
  readonly attributes: Readonly<Record<string, AuditAttributeValue>>;
} {
  return {
    name: event.name,
    occurredAt: event.occurredAt,
    attributes: normalizeMetricAttributes(event.attributes)
  };
}

function normalizeMetricAttributes(
  attributes: Readonly<Record<string, AuditAttributeValue>>
): Readonly<Record<string, AuditAttributeValue>> {
  const normalized: Record<string, AuditAttributeValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (voiceMetricAttributeKeys.has(key)) {
      normalized[key] = value;
    }
  }

  return Object.freeze(normalized);
}

function appendPrivateFile(path: string, content: string): void {
  ensurePrivateDirectoryTree(path);
  appendFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function ensurePrivateDirectoryTree(path: string): void {
  const marker = "/.pico/";
  const markerIndex = path.indexOf(marker);

  if (markerIndex === -1) {
    throw new Error("resident voice log path must be under ~/.pico");
  }

  const picoDirectory = path.slice(0, markerIndex + marker.length - 1);
  const parent = path.slice(0, path.lastIndexOf("/"));

  mkdirSync(picoDirectory, { recursive: true, mode: 0o700 });
  chmodSync(picoDirectory, 0o700);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
}

function datePart(timestamp: string): string {
  const parsed = new Date(Date.parse(timestamp));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("resident voice log timestamp must be a valid ISO timestamp");
  }

  return parsed.toISOString().slice(0, 10);
}
