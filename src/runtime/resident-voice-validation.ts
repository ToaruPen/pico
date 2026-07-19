import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

export type ResidentVoiceValidationEvent =
  | {
      readonly kind: "staff_transcript" | "pi_response";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool_execution_start";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly kind: "tool_execution_end";
      readonly occurredAt: string;
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
      readonly durationMs: number;
    };

export type ResidentVoiceValidationSink = {
  readonly record: (event: ResidentVoiceValidationEvent) => void;
};

export type PrivateResidentVoiceValidationSinkOptions = {
  readonly path: string;
  readonly maximumPayloadBytes?: number;
};

export type PrivateResidentVoiceValidationSink = ResidentVoiceValidationSink & {
  readonly close: () => void;
};

export type PrivateResidentVoiceArtifact = {
  readonly write: (content: string) => void;
  readonly close: () => void;
};

type PrivateResidentVoiceArtifactWrite = (
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number
) => number;

const defaultMaximumPayloadBytes = 256 * 1024;

export function createPrivateResidentVoiceArtifact(options: {
  readonly path: string;
}): PrivateResidentVoiceArtifact {
  return createPrivateArtifact(options.path, "private artifact");
}

export function createPrivateResidentVoiceValidationSink(
  options: PrivateResidentVoiceValidationSinkOptions
): PrivateResidentVoiceValidationSink {
  const maximumPayloadBytes = requireMaximumPayloadBytes(
    options.maximumPayloadBytes ?? defaultMaximumPayloadBytes
  );
  const artifact = createPrivateArtifact(options.path, "validation output");

  return {
    record(event) {
      const normalized = normalizeValidationEvent(event, maximumPayloadBytes);
      artifact.write(`${JSON.stringify(normalized)}\n`);
    },
    close: artifact.close
  };
}

function createPrivateArtifact(path: string, label: string): PrivateResidentVoiceArtifact {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requirePrivateArtifactDirectory(directory, label);
  const descriptor = openNewPrivateArtifact(path, label);
  let closed = false;

  return {
    write(content) {
      if (closed) {
        throw new Error(`pico resident voice ${label} is closed`);
      }
      writePrivateResidentVoiceArtifactContent(descriptor, content);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(descriptor);
    }
  };
}

// Exported only as a deterministic seam for short-write handling.
export function writePrivateResidentVoiceArtifactContent(
  descriptor: number,
  content: string,
  write: PrivateResidentVoiceArtifactWrite = writePrivateArtifactBytes
): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;

  while (offset < buffer.byteLength) {
    const remaining = buffer.byteLength - offset;
    const written = write(descriptor, buffer, offset, remaining);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error("pico resident voice private artifact write made no progress");
    }
    offset += written;
  }
}

function writePrivateArtifactBytes(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number
): number {
  return writeSync(descriptor, buffer, offset, length);
}

function requirePrivateArtifactDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`pico resident voice ${label} directory must be a real directory`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`pico resident voice ${label} directory must have 0700 permissions`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`pico resident voice ${label} directory must be owned by this user`);
  }
}

function openNewPrivateArtifact(path: string, label: string): number {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`pico resident voice ${label} must not already exist`, {
        cause: error
      });
    }
    throw error;
  }
}

function normalizeValidationEvent(
  event: ResidentVoiceValidationEvent,
  maximumPayloadBytes: number
): ResidentVoiceValidationEvent | Readonly<Record<string, unknown>> {
  if (event.kind === "tool_execution_start") {
    return Object.freeze({
      ...event,
      args: normalizeToolPayload(event.args, maximumPayloadBytes)
    });
  }

  if (event.kind === "tool_execution_end") {
    return Object.freeze({
      ...event,
      result: normalizeToolPayload(event.result, maximumPayloadBytes)
    });
  }

  return event;
}

function normalizeToolPayload(value: unknown, maximumPayloadBytes: number): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= maximumPayloadBytes) {
      return value;
    }
  } catch {
    // Fall through to a bounded inspection for cyclic or non-JSON values.
  }

  const inspected = inspect(value, {
    depth: 8,
    maxArrayLength: 100,
    maxStringLength: maximumPayloadBytes,
    breakLength: Number.POSITIVE_INFINITY,
    compact: true
  });
  const bounded = truncateUtf8(inspected, maximumPayloadBytes);

  return Object.freeze({
    payloadEncoding: "bounded_inspection",
    value: bounded.value,
    truncated: bounded.truncated
  });
}

function truncateUtf8(
  value: string,
  maximumBytes: number
): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) {
    return { value, truncated: false };
  }

  return {
    value: encoded.subarray(0, maximumBytes).toString("utf8"),
    truncated: true
  };
}

function requireMaximumPayloadBytes(value: number): number {
  if (!Number.isInteger(value) || value < 64 || value > 16 * 1024 * 1024) {
    throw new Error(
      "pico resident voice validation maximumPayloadBytes must be an integer from 64 to 16777216"
    );
  }

  return value;
}
