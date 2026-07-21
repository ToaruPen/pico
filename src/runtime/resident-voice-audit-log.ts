import {
  type AuditAttributeValue,
  type AuditEvent,
  createStructuredAuditLog,
  type StructuredAuditLog
} from "../modules/audit/index.js";
import { voiceRuntimeStagePolicy } from "./voice-stage-probe.js";

export type ResidentVoiceAuditLogOptions = {
  readonly stdoutEnabled: boolean;
  readonly stdoutMode?: ResidentVoiceAuditLogStdoutMode;
  readonly writeStdout?: (line: string) => void;
  readonly writeEvent?: (event: AuditEvent) => void;
};

export type ResidentVoiceAuditLogStdoutMode = "summary" | "verbose";

export function createAuditEventFanout(
  writers: readonly ((event: AuditEvent) => void)[]
): (event: AuditEvent) => void {
  return (event) => {
    for (const writer of writers) {
      try {
        writer(event);
      } catch {
        // Audit sinks are independent; one failure must not suppress the others.
      }
    }
  };
}

const voiceStageAttributeNames = {
  stage: "pico.voice.stage",
  status: "pico.voice.stage_status",
  durationMs: "pico.voice.stage_duration_ms",
  frameCount: "pico.voice.frame_count",
  utteranceDurationMs: "pico.voice.utterance_duration_ms",
  chunkCount: "pico.voice.chunk_count",
  errorCode: "pico.voice.error_code"
} as const;

export function createResidentVoiceAuditLog(
  options: ResidentVoiceAuditLogOptions
): StructuredAuditLog {
  const log = createStructuredAuditLog({ retainEntries: false });
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(line));

  return {
    record(input) {
      const event = log.record(input);

      if (options.stdoutEnabled) {
        const line = formatResidentVoiceAuditEventLine(event, options.stdoutMode ?? "summary");

        if (line !== undefined) {
          writeStdout(line);
        }
      }

      options.writeEvent?.(event);

      return event;
    },
    entries() {
      return log.entries();
    }
  };
}

function formatResidentVoiceAuditEventLine(
  event: AuditEvent,
  mode: ResidentVoiceAuditLogStdoutMode
): string | undefined {
  if (event.name !== "voice.runtime.stage") {
    return undefined;
  }

  if (!shouldMirrorResidentVoiceEvent(event, mode)) {
    return undefined;
  }

  return `${[
    `[pico voice] ${event.occurredAt}`,
    `stage=${formatAttribute(event.attributes[voiceStageAttributeNames.stage])}`,
    `status=${formatAttribute(event.attributes[voiceStageAttributeNames.status])}`,
    `duration_ms=${formatAttribute(event.attributes[voiceStageAttributeNames.durationMs])}`,
    optionalAttribute("frame_count", event.attributes[voiceStageAttributeNames.frameCount]),
    optionalAttribute(
      "utterance_ms",
      event.attributes[voiceStageAttributeNames.utteranceDurationMs]
    ),
    optionalAttribute("chunk_count", event.attributes[voiceStageAttributeNames.chunkCount]),
    optionalAttribute("error", event.attributes[voiceStageAttributeNames.errorCode])
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ")}\n`;
}

function shouldMirrorResidentVoiceEvent(
  event: AuditEvent,
  mode: ResidentVoiceAuditLogStdoutMode
): boolean {
  if (mode === "verbose") {
    return true;
  }

  const stage = event.attributes[voiceStageAttributeNames.stage];

  return voiceRuntimeStagePolicy(stage)?.summary === true;
}

function optionalAttribute(
  name: string,
  value: AuditAttributeValue | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return `${name}=${formatAttribute(value)}`;
}

function formatAttribute(value: AuditAttributeValue | undefined): string {
  return value === undefined ? "unknown" : String(value);
}
