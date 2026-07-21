const headerByteLength = 16;
const protocolVersion = 1;
const maximumMetadataByteLength = 16_384;
const maximumPayloadByteLength = 1_048_576;
const magic = Buffer.from("PICO", "ascii");

const messageKindCodes = {
  ready: 1,
  control_event: 2,
  control_result: 3,
  pcm_frame: 4,
  tail_complete: 5,
  suppress_capture: 6,
  resume_capture: 7,
  cancel_generation: 8,
  health_event: 9,
  fatal: 10,
  shutdown: 11,
  timing_event: 12
} as const;

type ResidentIoMessageKind = keyof typeof messageKindCodes;
type ResidentIoControlKind = "talk_pressed" | "talk_released" | "cancel_pressed";
type ResidentIoHealthState = "running" | "recovering" | "suspended";
type ResidentIoHealthCode =
  | "engine_started"
  | "engine_restarted"
  | "health_sample"
  | "sleep"
  | "wake"
  | "configuration_changed"
  | "engine_stopped"
  | "audio_timeline_discontinuity"
  | "audio_callback_overrun"
  | "admission_timeout";
type ResidentIoFatalCode =
  | "audio_callback_failed"
  | "event_tap_disabled"
  | "protocol_decode_failed"
  | "protocol_eof"
  | "audio_timeline_invalid"
  | "control_timeline_invalid"
  | "protocol_command_invalid"
  | "recovery_exhausted"
  | "control_backlog"
  | "admission_timeout_backlog"
  | "admission_timeout_failed";
export type ResidentIoTimingStage =
  | "key_to_admission"
  | "cancel_key_to_admission"
  | "admission_to_gate"
  | "gate_to_first_sample"
  | "first_sample_to_dispatch"
  | "release_to_tail_complete"
  | "engine_start"
  | "engine_restart";
export type ResidentIoControlResult = "accepted" | "ignored_busy" | "ignored_stale" | "noop";

export type ResidentIoMessage =
  | {
      readonly kind: "ready";
      readonly engineGeneration: number;
      readonly sampleRateHz: number;
      readonly channels: number;
    }
  | {
      readonly kind: "control_event";
      readonly sequence: number;
      readonly controlKind: ResidentIoControlKind;
      readonly eventTimestampNanoseconds: string;
    }
  | {
      readonly kind: "control_result";
      readonly sequence: number;
      readonly result: ResidentIoControlResult;
      readonly generation?: number;
    }
  | {
      readonly kind: "pcm_frame";
      readonly generation: number;
      readonly sampleHostTimeNanoseconds: string;
      readonly sampleRateHz: number;
      readonly channels: number;
      readonly frameCount: number;
      readonly audio: Buffer;
    }
  | {
      readonly kind: "tail_complete";
      readonly generation: number;
      readonly releaseEventTimestampNanoseconds: string;
    }
  | { readonly kind: "suppress_capture"; readonly commandId: number }
  | { readonly kind: "resume_capture"; readonly commandId: number }
  | { readonly kind: "cancel_generation"; readonly generation: number }
  | {
      readonly kind: "health_event";
      readonly state: ResidentIoHealthState;
      readonly code: ResidentIoHealthCode;
      readonly restartCount: number;
      readonly droppedFrameCount: number;
      readonly bufferCadenceMs: number;
      readonly outsidePttDroppedFrameCount: number;
      readonly suppressedDroppedFrameCount: number;
    }
  | { readonly kind: "fatal"; readonly code: ResidentIoFatalCode }
  | { readonly kind: "shutdown" }
  | {
      readonly kind: "timing_event";
      readonly stage: ResidentIoTimingStage;
      readonly durationMs: number;
      readonly controlResult?: ResidentIoControlResult;
    };

export function encodeResidentIoMessage(message: ResidentIoMessage): Buffer {
  const metadata = encodeMetadata(message);
  const payload = message.kind === "pcm_frame" ? message.audio : Buffer.alloc(0);

  if (metadata.byteLength > maximumMetadataByteLength) {
    throw new Error(
      `resident I/O metadata length ${String(metadata.byteLength)} exceeds ${String(maximumMetadataByteLength)}`
    );
  }
  if (payload.byteLength > maximumPayloadByteLength) {
    throw new Error(
      `resident I/O payload length ${String(payload.byteLength)} exceeds ${String(maximumPayloadByteLength)}`
    );
  }
  if (
    message.kind === "pcm_frame" &&
    payload.byteLength !== message.frameCount * message.channels * 2
  ) {
    throw new Error("resident I/O PCM byte length does not match frame metadata");
  }

  const header = Buffer.alloc(headerByteLength);
  magic.copy(header, 0);
  header[4] = protocolVersion;
  header[5] = messageKindCodes[message.kind];
  header.writeUInt32BE(metadata.byteLength, 8);
  header.writeUInt32BE(payload.byteLength, 12);
  return Buffer.concat([header, metadata, payload]);
}

export class ResidentIoDecoder {
  #buffer = Buffer.alloc(0);

  append(bytes: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    this.#validateHeader();
  }

  next(): ResidentIoMessage | undefined {
    if (this.#buffer.byteLength < headerByteLength) {
      return undefined;
    }

    const header = decodeHeader(this.#buffer);
    const totalByteLength = headerByteLength + header.metadataByteLength + header.payloadByteLength;

    if (this.#buffer.byteLength < totalByteLength) {
      return undefined;
    }

    const payloadOffset = headerByteLength + header.metadataByteLength;
    const metadata = this.#buffer.subarray(headerByteLength, payloadOffset);
    const payload = this.#buffer.subarray(payloadOffset, totalByteLength);
    this.#buffer = this.#buffer.subarray(totalByteLength);
    return decodeMessage(header.kind, metadata, payload);
  }

  #validateHeader(): void {
    if (this.#buffer.byteLength >= headerByteLength) {
      decodeHeader(this.#buffer);
    }
  }
}

// Every protocol variant is explicit here so fields cannot leak through object spreading.
// eslint-disable-next-line complexity
function encodeMetadata(message: ResidentIoMessage): Buffer {
  let metadata: Record<string, unknown> | undefined;

  switch (message.kind) {
    case "ready":
      metadata = {
        channels: message.channels,
        engine_generation: message.engineGeneration,
        sample_rate_hz: message.sampleRateHz
      };
      break;
    case "control_event":
      metadata = {
        event_timestamp_nanoseconds: message.eventTimestampNanoseconds,
        kind: message.controlKind,
        sequence: message.sequence
      };
      break;
    case "control_result":
      metadata = {
        ...(message.generation === undefined ? {} : { generation: message.generation }),
        result: message.result,
        sequence: message.sequence
      };
      break;
    case "pcm_frame":
      metadata = {
        channels: message.channels,
        frame_count: message.frameCount,
        generation: message.generation,
        sample_host_time_nanoseconds: message.sampleHostTimeNanoseconds,
        sample_rate_hz: message.sampleRateHz
      };
      break;
    case "tail_complete":
      metadata = {
        generation: message.generation,
        release_event_timestamp_nanoseconds: message.releaseEventTimestampNanoseconds
      };
      break;
    case "suppress_capture":
    case "resume_capture":
      metadata = { command_id: message.commandId };
      break;
    case "cancel_generation":
      metadata = { generation: message.generation };
      break;
    case "health_event":
      metadata = {
        buffer_cadence_ms: message.bufferCadenceMs,
        code: message.code,
        dropped_frame_count: message.droppedFrameCount,
        outside_ptt_dropped_frame_count: message.outsidePttDroppedFrameCount,
        restart_count: message.restartCount,
        state: message.state,
        suppressed_dropped_frame_count: message.suppressedDroppedFrameCount
      };
      break;
    case "fatal":
      metadata = { code: message.code };
      break;
    case "shutdown":
      return Buffer.alloc(0);
    case "timing_event":
      metadata = {
        ...(message.controlResult === undefined ? {} : { control_result: message.controlResult }),
        duration_ms: message.durationMs,
        stage: message.stage
      };
      break;
  }

  return Buffer.from(JSON.stringify(metadata), "utf8");
}

function decodeHeader(bytes: Buffer): {
  readonly kind: ResidentIoMessageKind;
  readonly metadataByteLength: number;
  readonly payloadByteLength: number;
} {
  requireProtocolMagic(bytes);
  requireProtocolVersion(bytes[4]);
  const kind = requireMessageKind(bytes[5]);
  const metadataByteLength = bytes.readUInt32BE(8);
  const payloadByteLength = bytes.readUInt32BE(12);
  requireBoundedLength("metadata", metadataByteLength, maximumMetadataByteLength);
  requireBoundedLength("payload", payloadByteLength, maximumPayloadByteLength);
  if (kind !== "pcm_frame" && payloadByteLength !== 0) {
    throw new Error(`resident I/O ${kind} message must not contain PCM payload`);
  }
  return { kind, metadataByteLength, payloadByteLength };
}

function requireProtocolMagic(bytes: Buffer): void {
  if (!bytes.subarray(0, 4).equals(magic)) {
    throw new Error("resident I/O protocol magic is invalid");
  }
}

function requireProtocolVersion(version: number | undefined): void {
  if (version !== protocolVersion) {
    throw new Error(`unsupported resident I/O protocol version ${String(version)}`);
  }
}

function requireMessageKind(kindCode: number | undefined): ResidentIoMessageKind {
  const kind = Object.entries(messageKindCodes).find(([, code]) => code === kindCode)?.[0] as
    | ResidentIoMessageKind
    | undefined;
  if (kind === undefined) {
    throw new Error(`unknown resident I/O message kind ${String(kindCode)}`);
  }
  return kind;
}

function requireBoundedLength(label: string, value: number, maximum: number): void {
  if (value > maximum) {
    throw new Error(`resident I/O ${label} length ${String(value)} exceeds ${String(maximum)}`);
  }
}

// Decoding remains exhaustive and validates each variant's exact field set at one boundary.
// eslint-disable-next-line complexity
function decodeMessage(
  kind: ResidentIoMessageKind,
  metadataBytes: Buffer,
  payload: Buffer
): ResidentIoMessage {
  if (kind !== "pcm_frame" && payload.byteLength !== 0) {
    throw new Error(`resident I/O ${kind} message must not contain PCM payload`);
  }
  const metadata = parseMetadata(kind, metadataBytes);

  switch (kind) {
    case "ready":
      requireExactKeys(metadata, kind, ["channels", "engine_generation", "sample_rate_hz"]);
      return {
        kind,
        channels: requirePositiveInteger(metadata.channels, kind),
        engineGeneration: requireNonNegativeInteger(metadata.engine_generation, kind),
        sampleRateHz: requirePositiveInteger(metadata.sample_rate_hz, kind)
      };
    case "control_event":
      requireExactKeys(metadata, kind, ["event_timestamp_nanoseconds", "kind", "sequence"]);
      return {
        kind,
        sequence: requireNonNegativeInteger(metadata.sequence, kind),
        controlKind: requireControlKind(metadata.kind, kind),
        eventTimestampNanoseconds: requireUint64DecimalString(
          metadata.event_timestamp_nanoseconds,
          kind
        )
      };
    case "control_result": {
      requireExactKeys(metadata, kind, ["result", "sequence"], ["generation"]);
      const generation = optionalNonNegativeInteger(metadata.generation, kind);
      return {
        kind,
        sequence: requireNonNegativeInteger(metadata.sequence, kind),
        result: requireControlResult(metadata.result, kind),
        ...(generation === undefined ? {} : { generation })
      };
    }
    case "pcm_frame": {
      requireExactKeys(metadata, kind, [
        "channels",
        "frame_count",
        "generation",
        "sample_host_time_nanoseconds",
        "sample_rate_hz"
      ]);
      const channels = requirePositiveInteger(metadata.channels, kind);
      const frameCount = requirePositiveInteger(metadata.frame_count, kind);
      if (payload.byteLength !== frameCount * channels * 2) {
        throw new Error("resident I/O PCM byte length does not match frame metadata");
      }
      return {
        kind,
        generation: requireNonNegativeInteger(metadata.generation, kind),
        sampleHostTimeNanoseconds: requireUint64DecimalString(
          metadata.sample_host_time_nanoseconds,
          kind
        ),
        sampleRateHz: requirePositiveInteger(metadata.sample_rate_hz, kind),
        channels,
        frameCount,
        audio: Buffer.from(payload)
      };
    }
    case "tail_complete":
      requireExactKeys(metadata, kind, ["generation", "release_event_timestamp_nanoseconds"]);
      return {
        kind,
        generation: requireNonNegativeInteger(metadata.generation, kind),
        releaseEventTimestampNanoseconds: requireUint64DecimalString(
          metadata.release_event_timestamp_nanoseconds,
          kind
        )
      };
    case "suppress_capture":
    case "resume_capture":
      requireExactKeys(metadata, kind, ["command_id"]);
      return { kind, commandId: requireNonNegativeInteger(metadata.command_id, kind) };
    case "cancel_generation":
      requireExactKeys(metadata, kind, ["generation"]);
      return { kind, generation: requireNonNegativeInteger(metadata.generation, kind) };
    case "health_event":
      requireExactKeys(metadata, kind, [
        "buffer_cadence_ms",
        "code",
        "dropped_frame_count",
        "outside_ptt_dropped_frame_count",
        "restart_count",
        "state",
        "suppressed_dropped_frame_count"
      ]);
      return {
        kind,
        state: requireHealthState(metadata.state, kind),
        code: requireHealthCode(metadata.code, kind),
        restartCount: requireNonNegativeInteger(metadata.restart_count, kind),
        droppedFrameCount: requireNonNegativeInteger(metadata.dropped_frame_count, kind),
        bufferCadenceMs: requireNonNegativeFiniteNumber(metadata.buffer_cadence_ms, kind),
        outsidePttDroppedFrameCount: requireNonNegativeInteger(
          metadata.outside_ptt_dropped_frame_count,
          kind
        ),
        suppressedDroppedFrameCount: requireNonNegativeInteger(
          metadata.suppressed_dropped_frame_count,
          kind
        )
      };
    case "fatal":
      requireExactKeys(metadata, kind, ["code"]);
      return { kind, code: requireFatalCode(metadata.code, kind) };
    case "shutdown":
      requireExactKeys(metadata, kind, []);
      return { kind };
    case "timing_event":
      requireExactKeys(
        metadata,
        kind,
        Object.hasOwn(metadata, "control_result")
          ? ["control_result", "duration_ms", "stage"]
          : ["duration_ms", "stage"]
      );
      return {
        kind,
        stage: requireTimingStage(metadata.stage, kind),
        durationMs: requireNonNegativeFiniteNumber(metadata.duration_ms, kind),
        ...(Object.hasOwn(metadata, "control_result")
          ? { controlResult: requireControlResult(metadata.control_result, kind) }
          : {})
      };
  }
}

function parseMetadata(kind: ResidentIoMessageKind, bytes: Buffer): Record<string, unknown> {
  if (kind === "shutdown" && bytes.byteLength === 0) {
    return {};
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`resident I/O ${kind} metadata is invalid`, { cause: error });
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  kind: ResidentIoMessageKind,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const expected = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error(`resident I/O ${kind} metadata is invalid`);
  }
}

function requireControlKind(value: unknown, kind: ResidentIoMessageKind): ResidentIoControlKind {
  if (value === "talk_pressed" || value === "talk_released" || value === "cancel_pressed") {
    return value;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

function requireControlResult(
  value: unknown,
  kind: ResidentIoMessageKind
): ResidentIoControlResult {
  if (
    value === "accepted" ||
    value === "ignored_busy" ||
    value === "ignored_stale" ||
    value === "noop"
  ) {
    return value;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

const healthStates = new Set<ResidentIoHealthState>(["running", "recovering", "suspended"]);
const healthCodes = new Set<ResidentIoHealthCode>([
  "engine_started",
  "engine_restarted",
  "health_sample",
  "sleep",
  "wake",
  "configuration_changed",
  "engine_stopped",
  "audio_timeline_discontinuity",
  "audio_callback_overrun",
  "admission_timeout"
]);
const fatalCodes = new Set<ResidentIoFatalCode>([
  "audio_callback_failed",
  "event_tap_disabled",
  "protocol_decode_failed",
  "protocol_eof",
  "audio_timeline_invalid",
  "control_timeline_invalid",
  "protocol_command_invalid",
  "recovery_exhausted",
  "control_backlog",
  "admission_timeout_backlog",
  "admission_timeout_failed"
]);

function requireHealthState(value: unknown, kind: ResidentIoMessageKind): ResidentIoHealthState {
  if (typeof value === "string" && healthStates.has(value as ResidentIoHealthState)) {
    return value as ResidentIoHealthState;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

function requireHealthCode(value: unknown, kind: ResidentIoMessageKind): ResidentIoHealthCode {
  if (typeof value === "string" && healthCodes.has(value as ResidentIoHealthCode)) {
    return value as ResidentIoHealthCode;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

function requireFatalCode(value: unknown, kind: ResidentIoMessageKind): ResidentIoFatalCode {
  if (typeof value === "string" && fatalCodes.has(value as ResidentIoFatalCode)) {
    return value as ResidentIoFatalCode;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

function requireTimingStage(value: unknown, kind: ResidentIoMessageKind): ResidentIoTimingStage {
  if (
    value === "key_to_admission" ||
    value === "cancel_key_to_admission" ||
    value === "admission_to_gate" ||
    value === "gate_to_first_sample" ||
    value === "first_sample_to_dispatch" ||
    value === "release_to_tail_complete" ||
    value === "engine_start" ||
    value === "engine_restart"
  ) {
    return value;
  }
  throw new Error(`resident I/O ${kind} metadata is invalid`);
}

function requireNonNegativeFiniteNumber(value: unknown, kind: ResidentIoMessageKind): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`resident I/O ${kind} metadata is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, kind: ResidentIoMessageKind): number {
  const number = requireNonNegativeInteger(value, kind);
  if (number === 0) {
    throw new Error(`resident I/O ${kind} metadata is invalid`);
  }
  return number;
}

function optionalNonNegativeInteger(
  value: unknown,
  kind: ResidentIoMessageKind
): number | undefined {
  return value === undefined ? undefined : requireNonNegativeInteger(value, kind);
}

function requireNonNegativeInteger(value: unknown, kind: ResidentIoMessageKind): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`resident I/O ${kind} metadata is invalid`);
  }
  return value as number;
}

const maximumUint64 = 18_446_744_073_709_551_615n;
const uint64DecimalPattern = /^(?:0|[1-9]\d{0,19})$/u;

function requireUint64DecimalString(value: unknown, kind: ResidentIoMessageKind): string {
  if (
    typeof value !== "string" ||
    !uint64DecimalPattern.test(value) ||
    BigInt(value) > maximumUint64
  ) {
    throw new Error(`resident I/O ${kind} metadata is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
