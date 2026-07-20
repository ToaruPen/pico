import type { AuditAttributeValue } from "../modules/audit/index.js";
import type { VoiceRuntimeStage, VoiceStageStatus } from "./voice-stage-probe.js";

export type ResidentVoiceTurnPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "processing"
  | "synthesizing"
  | "speaking";

export type ResidentVoiceOperatorEvent =
  | {
      readonly kind: "turn_started";
    }
  | {
      readonly kind: "turn_phase";
      readonly phase: ResidentVoiceTurnPhase;
    }
  | {
      readonly kind: "staff_transcript";
      readonly text: string;
    }
  | {
      readonly kind: "pi_response";
      readonly text: string;
    }
  | {
      readonly kind: "assistant_settled";
      readonly stopReason: string;
    }
  | {
      readonly kind: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly kind: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: VoiceStageStatus;
      readonly durationMs: number;
      readonly result?: unknown;
      readonly errorCode?: string;
    }
  | {
      readonly kind: "stage";
      readonly stage: VoiceRuntimeStage;
      readonly status: VoiceStageStatus;
      readonly durationMs: number;
      readonly attributes: Readonly<Record<string, AuditAttributeValue>>;
    };

export type ResidentVoiceOperatorSink = {
  readonly record: (event: ResidentVoiceOperatorEvent) => void;
};

export function recordResidentVoiceOperatorEvent(
  sink: ResidentVoiceOperatorSink | undefined,
  event: ResidentVoiceOperatorEvent
): void {
  try {
    sink?.record(event);
  } catch {
    // Operator visibility is best-effort and cannot own runtime success.
  }
}
