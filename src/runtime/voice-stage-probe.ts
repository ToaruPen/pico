import type {
  AuditAttributeValue,
  AuditEvent,
  StructuredAuditLog
} from "../modules/audit/index.js";

export type VoiceRuntimeStage =
  | "startup_warmup"
  | "mic_capture"
  | "echo_control"
  | "speech_gate"
  | "utterance_window"
  | "stt"
  | "trigger_match"
  | "session_start"
  | "pi_turn"
  | "tts_request_wall"
  | "tts_audio_duration"
  | "tts_synthesize"
  | "tts_playback"
  | "camera_capture"
  | "vlm_scene_description";

export type VoiceStageStatus = "ok" | "error" | "skipped" | "suppressed";

export type VoiceStageProbe = {
  readonly audit?: StructuredAuditLog;
};

export type VoiceStageProbeInput = {
  readonly stage: VoiceRuntimeStage;
  readonly status: VoiceStageStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly attributes?: Readonly<Record<string, AuditAttributeValue>>;
};

const voiceRuntimeStages = new Set<VoiceRuntimeStage>([
  "startup_warmup",
  "mic_capture",
  "echo_control",
  "speech_gate",
  "utterance_window",
  "stt",
  "trigger_match",
  "session_start",
  "pi_turn",
  "tts_request_wall",
  "tts_audio_duration",
  "tts_synthesize",
  "tts_playback",
  "camera_capture",
  "vlm_scene_description"
]);
const voiceStageStatuses = new Set<VoiceStageStatus>(["ok", "error", "skipped", "suppressed"]);
const voiceStageAttributeKeys = new Set([
  "pico.voice.frame_count",
  "pico.voice.utterance_duration_ms",
  "pico.voice.sample_rate_hz",
  "pico.voice.channels",
  "pico.voice.suppressed_frame_count",
  "pico.voice.speech_detected",
  "pico.voice.speech_probability",
  "pico.voice.rms_db",
  "pico.voice.triggered",
  "pico.voice.chunk_count",
  "pico.voice.frame_bytes",
  "pico.voice.vlm_frame_bytes",
  "pico.voice.queue_depth",
  "pico.voice.error_code"
]);
const maxNodeTimeoutMs = 2_147_483_647;

export function recordVoiceStageProbe(
  probe: VoiceStageProbe,
  input: VoiceStageProbeInput
): AuditEvent | undefined {
  const stage = requireVoiceRuntimeStage(input.stage);
  const status = requireVoiceStageStatus(input.status);
  const startedAt = requireIsoTimestamp(input.startedAt, "pico voice stage probe startedAt");
  const durationMs = requireNonNegativeNumber(
    input.durationMs,
    "pico voice stage probe durationMs"
  );
  const attributes = normalizeVoiceStageAttributes(input.attributes);
  const occurredAt = new Date(Date.parse(startedAt) + durationMs).toISOString();

  try {
    return probe.audit?.record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: status === "error" ? "warn" : "info",
      occurredAt,
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": stage,
        "pico.voice.stage_status": status,
        "pico.voice.stage_duration_ms": durationMs,
        ...attributes
      }
    });
  } catch {
    return undefined;
  }
}

function requireVoiceRuntimeStage(value: unknown): VoiceRuntimeStage {
  if (typeof value === "string" && voiceRuntimeStages.has(value as VoiceRuntimeStage)) {
    return value as VoiceRuntimeStage;
  }

  throw new Error("pico voice runtime stage is invalid");
}

function requireVoiceStageStatus(value: unknown): VoiceStageStatus {
  if (typeof value === "string" && voiceStageStatuses.has(value as VoiceStageStatus)) {
    return value as VoiceStageStatus;
  }

  throw new Error("pico voice stage status is invalid");
}

function requireIsoTimestamp(value: string, label: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }

  return value;
}

function requireNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > maxNodeTimeoutMs) {
    throw new Error(`${label} must be a non-negative number <= ${maxNodeTimeoutMs}`);
  }

  return value;
}

function normalizeVoiceStageAttributes(
  attributes: Readonly<Record<string, AuditAttributeValue>> | undefined
): Readonly<Record<string, AuditAttributeValue>> {
  if (attributes === undefined) {
    return Object.freeze({});
  }

  const normalized: Record<string, AuditAttributeValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!voiceStageAttributeKeys.has(key)) {
      throw new Error("pico voice stage probe attribute is not allowed");
    }

    if (typeof value === "number" && !Number.isFinite(value)) {
      continue;
    }

    normalized[key] = value;
  }

  return Object.freeze(normalized);
}
