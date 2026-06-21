import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

export function createResidentVoiceFileLogSink(
  options: ResidentVoiceFileLogSinkOptions
): VoiceResidentConsoleSink & {
  readonly writeProcessLine: (line: string) => void;
} {
  const runId =
    options.runId ?? defaultResidentVoiceRunId(options.now?.() ?? new Date().toISOString());
  const now = options.now ?? (() => new Date().toISOString());
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
        occurredAt: now()
      });

      appendPrivateFile(paths.processLogPath, line);
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
  const runId = input.runId ?? "process";
  const picoDirectory = join(input.homeDirectory, ".pico");
  const modeDirectory = join(picoDirectory, "resident-voice", input.runMode);
  const dayDirectory = join(modeDirectory, "processes", day);
  const sessionsDirectory = join(modeDirectory, "sessions", day, runId);

  return {
    picoDirectory,
    modeDirectory,
    dayDirectory,
    processLogPath: join(dayDirectory, `${runId}.log`),
    dailyEventsJsonlPath: join(modeDirectory, "events", `${day}.jsonl`),
    ...(input.sessionId === undefined
      ? {}
      : {
          sessionTextLogPath: join(sessionsDirectory, `${input.sessionId}.log`),
          sessionJsonlPath: join(sessionsDirectory, `${input.sessionId}.jsonl`)
        })
  };
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

function defaultResidentVoiceRunId(timestamp: string): string {
  return `${timestamp.replaceAll(/[:.]/g, "-")}-${process.pid}`;
}

function datePart(timestamp: string): string {
  const parsed = new Date(Date.parse(timestamp));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("resident voice log timestamp must be a valid ISO timestamp");
  }

  return parsed.toISOString().slice(0, 10);
}
