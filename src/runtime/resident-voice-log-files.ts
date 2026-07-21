import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { AuditAttributeValue, AuditEvent } from "../modules/audit/index.js";
import type { VoiceResidentLogEvent, VoiceResidentLogSink } from "./voice-resident.js";

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
  readonly sessionJsonlPath?: string;
};

export type ResidentVoiceFileLogSinkOptions = {
  readonly homeDirectory: string;
  readonly runMode: ResidentVoiceLogRunMode;
  readonly runId?: string;
  readonly now?: () => string;
  readonly onDiagnostic?: (diagnostic: ResidentVoiceLogDiagnostic) => void;
};

export type ResidentVoiceLogDiagnostic = {
  readonly code:
    | "queue_capacity_exceeded"
    | "mode_capacity_exceeded"
    | "legacy_resident_logs_detected"
    | "write_failed";
  readonly droppedRecordCount: number;
};

export type ResidentVoiceFileLogSink = VoiceResidentLogSink & {
  readonly writeProcessLine: (line: string) => void;
  readonly writeAuditEvent: (event: ResidentVoiceLogAuditEvent) => void;
  readonly ready: Promise<void>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly droppedRecordCount: () => number;
};

type QueuedLogRecord = {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
};

type ManagedLogFile = {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
};

const maximumQueuedBytes = 1_048_576;
const maximumManagedModeBytes = 128 * 1024 * 1024;

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
  "pico.voice.chunk_count",
  "pico.voice.frame_bytes",
  "pico.voice.vlm_frame_bytes",
  "pico.voice.queue_depth",
  "pico.voice.error_code",
  "pico.voice.trailing_silence_ms"
]);

export function createResidentVoiceFileLogSink(
  options: ResidentVoiceFileLogSinkOptions
): ResidentVoiceFileLogSink {
  const runStartedAt = options.now?.() ?? new Date().toISOString();
  const runId = options.runId ?? defineResidentVoiceRunId(runStartedAt, process.pid);
  const modeDirectory = resolveResidentVoiceLogPaths({
    homeDirectory: options.homeDirectory,
    runMode: options.runMode,
    runId,
    occurredAt: runStartedAt
  }).modeDirectory;
  const queue: QueuedLogRecord[] = [];
  const activePaths = new Set<string>();
  const managedFiles = new Map<string, ManagedLogFile>();
  const emittedDiagnostics = new Set<ResidentVoiceLogDiagnostic["code"]>();
  let queuedBytes = 0;
  let managedBytes = 0;
  let droppedRecords = 0;
  let closed = false;
  let disabled = false;
  let drainOperation: Promise<void> | undefined;
  const emitDiagnostic = (code: ResidentVoiceLogDiagnostic["code"]): void => {
    if (emittedDiagnostics.has(code)) return;
    emittedDiagnostics.add(code);
    try {
      options.onDiagnostic?.({ code, droppedRecordCount: droppedRecords });
    } catch {
      // Diagnostics remain outside the managed writer failure boundary.
    }
  };
  const ready = initializeManagedLogDirectory(options.homeDirectory, modeDirectory).then(
    (files) => {
      for (const file of files) {
        managedFiles.set(file.path, file);
        managedBytes += file.size;
      }
      return legacyResidentLogsExist(options.homeDirectory, options.runMode).then((exists) => {
        if (exists) emitDiagnostic("legacy_resident_logs_detected");
      });
    }
  );
  void ready.catch(() => undefined);

  const scheduleDrain = (): void => {
    if (drainOperation !== undefined || queue.length === 0) return;
    drainOperation = ready
      .then(async () => {
        for (let record = queue.shift(); record !== undefined; record = queue.shift()) {
          if (!(await reserveManagedCapacity(record))) {
            droppedRecords += 1;
            queuedBytes -= record.byteLength;
            emitDiagnostic("mode_capacity_exceeded");
            continue;
          }
          try {
            await appendPrivateFile(modeDirectory, record.path, record.content);
            const previous = managedFiles.get(record.path);
            const file = {
              path: record.path,
              size: (previous?.size ?? 0) + record.byteLength,
              mtimeMs: Date.now()
            };
            managedFiles.set(record.path, file);
            managedBytes += record.byteLength;
          } catch {
            disabled = true;
            droppedRecords += 1 + queue.length;
            queue.splice(0);
            emitDiagnostic("write_failed");
          } finally {
            queuedBytes -= record.byteLength;
          }
          if (disabled) {
            queuedBytes = 0;
            return;
          }
        }
      })
      .finally(() => {
        drainOperation = undefined;
        scheduleDrain();
      });
    void drainOperation.catch(() => undefined);
  };

  const reserveManagedCapacity = async (record: QueuedLogRecord): Promise<boolean> => {
    if (managedBytes + record.byteLength <= maximumManagedModeBytes) return true;

    const closedFiles = [...managedFiles.values()]
      .filter((file) => !activePaths.has(file.path))
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    for (const file of closedFiles) {
      try {
        await unlink(file.path);
      } catch {
        continue;
      }
      managedFiles.delete(file.path);
      managedBytes -= file.size;
      if (managedBytes + record.byteLength <= maximumManagedModeBytes) return true;
    }
    return false;
  };

  const enqueue = (path: string, content: string): void => {
    activePaths.add(path);
    const byteLength = Buffer.byteLength(content, "utf8");
    if (closed || disabled || queuedBytes + byteLength > maximumQueuedBytes) {
      droppedRecords += 1;
      if (!closed && !disabled) emitDiagnostic("queue_capacity_exceeded");
      return;
    }
    queue.push({ path, content, byteLength });
    queuedBytes += byteLength;
    scheduleDrain();
  };

  const flush = async (): Promise<void> => {
    await ready;
    while (queue.length > 0 || drainOperation !== undefined) {
      scheduleDrain();
      await drainOperation;
    }
  };

  return {
    record(event) {
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: event.occurredAt,
        sessionId: event.sessionId
      });
      const payload = normalizeResidentVoiceEvent({
        schemaVersion: 1,
        runMode: options.runMode,
        runId,
        ...event
      });

      enqueue(paths.dailyEventsJsonlPath, `${JSON.stringify(payload)}\n`);

      if (paths.sessionJsonlPath !== undefined) {
        enqueue(paths.sessionJsonlPath, `${JSON.stringify(payload)}\n`);
      }
    },
    writeProcessLine(line) {
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: options.now?.() ?? new Date().toISOString()
      });

      enqueue(paths.processLogPath, line);
    },
    writeAuditEvent(event) {
      const normalized = normalizeResidentVoiceMetricEvent(event);
      const paths = resolveResidentVoiceLogPaths({
        homeDirectory: options.homeDirectory,
        runMode: options.runMode,
        runId,
        occurredAt: normalized.occurredAt
      });

      enqueue(
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
    },
    ready,
    flush,
    async close() {
      closed = true;
      await flush();
    },
    droppedRecordCount: () => droppedRecords
  };
}

export function createResidentVoiceCompositeLogSink(
  sinks: readonly VoiceResidentLogSink[]
): VoiceResidentLogSink {
  return {
    record(event) {
      for (const sink of sinks) {
        try {
          sink.record(event);
        } catch {
          // One log sink failure must not prevent the remaining sinks.
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
  const modeDirectory = join(picoDirectory, "resident-voice", "managed", input.runMode);
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
          sessionJsonlPath: join(sessionsDirectory, `${input.sessionId}.jsonl`)
        })
  };
}

function normalizeResidentVoiceEvent(
  event: VoiceResidentLogEvent & {
    readonly schemaVersion: number;
    readonly runMode: ResidentVoiceLogRunMode;
    readonly runId: string;
  }
): Readonly<Record<string, number | string>> {
  return Object.freeze({
    schemaVersion: event.schemaVersion,
    runMode: event.runMode,
    runId: event.runId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    sessionId: event.sessionId,
    ...(event.kind === "pi_agent_response" ? { durationMs: event.durationMs } : {})
  });
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

async function appendPrivateFile(
  modeDirectory: string,
  path: string,
  content: string
): Promise<void> {
  await ensureManagedChildDirectory(modeDirectory, dirname(path));
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function initializeManagedLogDirectory(
  homeDirectory: string,
  modeDirectory: string
): Promise<readonly ManagedLogFile[]> {
  const residentDirectory = join(homeDirectory, ".pico", "resident-voice");
  const managedDirectory = join(residentDirectory, "managed");
  await ensureDirectorySequence([
    join(homeDirectory, ".pico"),
    residentDirectory,
    managedDirectory,
    modeDirectory
  ]);
  return inventoryManagedLogFiles(modeDirectory, modeDirectory);
}

async function ensureManagedChildDirectory(
  modeDirectory: string,
  directory: string
): Promise<void> {
  const relativeDirectory = relative(modeDirectory, directory);
  if (
    relativeDirectory === "" ||
    relativeDirectory === "." ||
    (!relativeDirectory.startsWith(`..${sep}`) && relativeDirectory !== "..")
  ) {
    const directories = [modeDirectory];
    if (relativeDirectory !== "" && relativeDirectory !== ".") {
      let current = modeDirectory;
      for (const part of relativeDirectory.split(sep)) {
        current = join(current, part);
        directories.push(current);
      }
    }
    await ensureDirectorySequence(directories);
    return;
  }
  throw new Error("resident voice log path must stay within its managed mode directory");
}

async function ensureDirectorySequence(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!hasFileSystemCode(error, "ENOENT")) throw error;
      await mkdir(directory, { mode: 0o700 });
      metadata = await lstat(directory);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("resident voice managed log path must not be symlinked");
    }
    if (!metadata.isDirectory()) {
      throw new Error("resident voice managed log path must be a directory");
    }
    await chmod(directory, 0o700);
  }
}

async function inventoryManagedLogFiles(
  modeDirectory: string,
  directory: string
): Promise<readonly ManagedLogFile[]> {
  const files: ManagedLogFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await inventoryManagedLogFiles(modeDirectory, path)));
      continue;
    }
    if (!entry.isFile() || !isRecognizedManagedLogPath(modeDirectory, path)) continue;
    const metadata = await lstat(path);
    if (metadata.isFile()) {
      files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }
  }
  return files;
}

function isRecognizedManagedLogPath(modeDirectory: string, path: string): boolean {
  const localPath = relative(modeDirectory, path).split(sep).join("/");
  const day = String.raw`\d{4}-\d{2}-\d{2}`;
  const identifier = String.raw`[\dA-Za-z][\dA-Za-z._-]{0,127}`;
  return [
    new RegExp(`^processes/${day}/${identifier}\\.log$`, "u"),
    new RegExp(`^events/${day}\\.jsonl$`, "u"),
    new RegExp(`^metrics/${day}/${identifier}\\.jsonl$`, "u"),
    new RegExp(`^sessions/${day}/${identifier}/${identifier}\\.jsonl$`, "u")
  ].some((pattern) => pattern.test(localPath));
}

async function legacyResidentLogsExist(
  homeDirectory: string,
  runMode: ResidentVoiceLogRunMode
): Promise<boolean> {
  try {
    await lstat(join(homeDirectory, ".pico", "resident-voice", runMode));
    return true;
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function datePart(timestamp: string): string {
  const parsed = new Date(Date.parse(timestamp));

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("resident voice log timestamp must be a valid ISO timestamp");
  }

  return parsed.toISOString().slice(0, 10);
}
