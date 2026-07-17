import type {
  AuditAttributeValue,
  AuditEvent,
  StructuredAuditLog
} from "../modules/audit/index.js";

export const voiceRuntimeStagePolicies = Object.freeze({
  mic_capture: { persisted: false, summary: false },
  echo_control: { persisted: false, summary: false },
  speech_gate: { persisted: true, summary: false },
  stt: { persisted: true, summary: true },
  session_start: { persisted: true, summary: true },
  pi_turn: { persisted: true, summary: true },
  tts_request_wall: { persisted: true, summary: true },
  tts_playback: { persisted: true, summary: true },
  camera_capture: { persisted: true, summary: true },
  vlm_scene_description: { persisted: true, summary: true }
} as const);

export type VoiceRuntimeStage = keyof typeof voiceRuntimeStagePolicies;
export type VoiceRuntimeStagePolicy = (typeof voiceRuntimeStagePolicies)[VoiceRuntimeStage];

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

export function voiceRuntimeStagePolicy(value: unknown): VoiceRuntimeStagePolicy | undefined {
  return isVoiceRuntimeStage(value) ? voiceRuntimeStagePolicies[value] : undefined;
}

function requireVoiceRuntimeStage(value: unknown): VoiceRuntimeStage {
  if (isVoiceRuntimeStage(value)) {
    return value;
  }

  throw new Error("pico voice runtime stage is invalid");
}

function isVoiceRuntimeStage(value: unknown): value is VoiceRuntimeStage {
  return typeof value === "string" && Object.hasOwn(voiceRuntimeStagePolicies, value);
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
