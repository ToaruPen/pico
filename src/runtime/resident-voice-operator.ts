import type { AuditAttributeValue } from "../modules/audit/index.js";
import type { ResidentControlResult } from "./resident-control.js";
import type { ResidentControlState } from "./resident-control-controller.js";
import type { VoiceRuntimeStage, VoiceStageStatus } from "./voice-stage-probe.js";

export type ResidentVoiceTurnPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "processing"
  | "waiting_for_previous_turn"
  | "synthesizing"
  | "speaking"
  | "cancelling";

export type ResidentVoiceOperatorEvent =
  | {
      readonly kind: "turn_started";
    }
  | {
      readonly kind: "turn_phase";
      readonly phase: ResidentVoiceTurnPhase;
    }
  | {
      readonly kind: "turn_cancelled";
    }
  | {
      readonly kind: "control_decision";
      readonly control: "talk";
      readonly result: ResidentControlResult;
      readonly state: ResidentControlState | "interaction_ending";
    }
  | {
      readonly kind: "interaction_ending_started";
    }
  | {
      readonly kind: "interaction_ending_finished";
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

export type ResidentVoiceOperatorStageEvent = Extract<
  ResidentVoiceOperatorEvent,
  { readonly kind: "stage" }
>;

export type ResidentVoiceOperatorStageSink = {
  readonly record: (event: ResidentVoiceOperatorStageEvent) => void;
};

export type ResidentVoiceOperatorSink = {
  readonly record: (event: ResidentVoiceOperatorEvent) => void;
  readonly scopeStagesToCurrentTurn?: () => ResidentVoiceOperatorStageSink;
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

export function scopeResidentVoiceOperatorStagesToCurrentTurn(
  sink: ResidentVoiceOperatorSink | undefined
): ResidentVoiceOperatorStageSink | undefined {
  try {
    return sink?.scopeStagesToCurrentTurn?.();
  } catch {
    return undefined;
  }
}

export function recordResidentVoiceOperatorStageEvent(
  sink: ResidentVoiceOperatorStageSink | undefined,
  event: ResidentVoiceOperatorStageEvent
): void {
  try {
    sink?.record(event);
  } catch {
    // Operator visibility is best-effort and cannot own runtime success.
  }
}
