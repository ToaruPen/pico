import type {
  ResidentVoiceOperatorEvent,
  ResidentVoiceOperatorSink,
  ResidentVoiceTurnPhase
} from "./resident-voice-operator.js";
import {
  type ResidentVoiceTerminalControls,
  type ResidentVoiceTerminalTheme,
  type ResidentVoiceTerminalToolView,
  type ResidentVoiceTerminalTurnView,
  type ResidentVoiceTerminalView,
  renderResidentVoiceTerminal,
  type StageTimingView
} from "./resident-voice-terminal-renderer.js";
import {
  type VoiceRuntimeStage,
  type VoiceStageStatus,
  voiceRuntimeStagePolicies
} from "./voice-stage-probe.js";

export type ResidentVoiceTerminalDisplayOptions = {
  readonly controls: ResidentVoiceTerminalControls;
  readonly onChange?: () => void;
  readonly maximumTextBytes?: number;
};

export type ResidentVoiceTerminalDisplay = ResidentVoiceOperatorSink & {
  readonly render: (width: number, theme: ResidentVoiceTerminalTheme) => string[];
};

type ResidentVoiceTerminalTui = {
  readonly requestRender: () => void;
};

type ResidentVoiceTerminalComponent = {
  readonly render: (width: number) => string[];
  readonly invalidate: () => void;
};

type ResidentVoiceTerminalWidgetFactory = (
  tui: ResidentVoiceTerminalTui,
  theme: ResidentVoiceTerminalTheme
) => ResidentVoiceTerminalComponent;

type MutableTurn = {
  staffText?: string;
  picoText?: string;
  failure?: string;
  readonly tools: ResidentVoiceTerminalToolView[];
  readonly timings: Map<VoiceRuntimeStage, StageTimingView>;
};

type PendingTool = {
  readonly toolName: string;
};

type DisplayTurnLifecycle = {
  active: boolean;
  phase: ResidentVoiceTurnPhase;
};

type TextBudget = {
  readonly maximumBytes: number;
  readonly parts: string[];
  byteLength: number;
  truncated: boolean;
  replacingUnsafeRun: boolean;
};

const defaultMaximumTextBytes = 4_096;
const maximumToolNameBytes = 256;
const maximumStopReasonBytes = 128;
const maximumPendingTools = 32;
const maximumCompletedToolsPerTurn = 32;
const maximumTurns = 2;
const residentVoiceWidgetKey = "pico-resident-voice";
const phases = new Set<ResidentVoiceTurnPhase>([
  "idle",
  "listening",
  "transcribing",
  "processing",
  "synthesizing",
  "speaking"
]);
const statuses = new Set<VoiceStageStatus>(["ok", "error", "skipped", "suppressed"]);
const terminalAssistantFailures = new Set(["error", "aborted"]);
const stageFailureLabels: Partial<Readonly<Record<VoiceRuntimeStage, string>>> = {
  stt: "文字起こし失敗",
  pi_turn: "応答生成失敗",
  tts_request_wall: "音声準備失敗",
  tts_time_to_first_chunk: "音声準備失敗",
  tts_playback: "再生失敗"
};

export function createResidentVoiceTerminalOperator(input: {
  readonly controls: ResidentVoiceTerminalControls;
  readonly mode: string;
  readonly setWidget: (
    key: string,
    factory: ResidentVoiceTerminalWidgetFactory,
    options: { readonly placement: "aboveEditor" }
  ) => void;
}): ResidentVoiceOperatorSink | undefined {
  if (input.mode !== "tui") return undefined;

  let activeTui: ResidentVoiceTerminalTui | undefined;
  const display = createResidentVoiceTerminalDisplay({
    controls: input.controls,
    onChange: () => {
      try {
        activeTui?.requestRender();
      } catch {
        // A TUI refresh failure must not alter the resident voice turn.
      }
    }
  });

  try {
    input.setWidget(
      residentVoiceWidgetKey,
      (tui, theme) => {
        activeTui = tui;
        return {
          invalidate() {},
          render(width) {
            return display.render(width, theme);
          }
        };
      },
      { placement: "aboveEditor" }
    );
  } catch {
    // Widget registration is best-effort and cannot own runtime success.
  }

  return display;
}

export function createResidentVoiceTerminalDisplay(
  options: ResidentVoiceTerminalDisplayOptions
): ResidentVoiceTerminalDisplay {
  const maximumTextBytes = requireBoundedInteger(
    options.maximumTextBytes ?? defaultMaximumTextBytes,
    32,
    64 * 1024,
    "resident voice terminal maximumTextBytes"
  );
  const turns: MutableTurn[] = [];
  const pendingTools = new Map<string, PendingTool>();
  const lifecycle: DisplayTurnLifecycle = { active: false, phase: "idle" };

  const notifyChange = (): void => {
    try {
      options.onChange?.();
    } catch {
      // Display updates remain best-effort.
    }
  };

  return {
    record(event) {
      try {
        if (applyEvent(event, turns, pendingTools, lifecycle, maximumTextBytes)) {
          notifyChange();
        }
      } catch {
        // Malformed display events cannot alter the voice runtime.
      }
    },
    render(width, theme) {
      try {
        return renderResidentVoiceTerminal(
          createView(options.controls, lifecycle.phase, turns, pendingTools),
          width,
          theme
        );
      } catch {
        return [];
      }
    }
  };
}

// The event reducer is intentionally the single mutation boundary for display-only state.
// eslint-disable-next-line complexity
function applyEvent(
  event: ResidentVoiceOperatorEvent,
  turns: MutableTurn[],
  pendingTools: Map<string, PendingTool>,
  lifecycle: DisplayTurnLifecycle,
  maximumTextBytes: number
): boolean {
  if (event.kind === "turn_started") {
    appendTurn(turns);
    pendingTools.clear();
    lifecycle.active = true;
    return true;
  }

  if (event.kind === "turn_phase") {
    if (!isPhase(event.phase) || (event.phase !== "idle" && !lifecycle.active)) return false;
    lifecycle.phase = event.phase;
    if (event.phase === "idle") {
      pendingTools.clear();
      lifecycle.active = false;
    }
    return true;
  }

  if (!lifecycle.active) return false;

  switch (event.kind) {
    case "staff_transcript":
      if (typeof event.text !== "string") return false;
      currentTurn(turns).staffText = formatOperatorText(event.text, maximumTextBytes);
      return true;
    case "pi_response": {
      if (typeof event.text !== "string") return false;
      const turn = currentTurn(turns);
      turn.picoText = formatOperatorText(event.text, maximumTextBytes);
      delete turn.failure;
      return true;
    }
    case "assistant_settled": {
      if (typeof event.stopReason !== "string") return false;
      const turn = currentTurn(turns);
      if (turn.picoText === undefined && terminalAssistantFailures.has(event.stopReason)) {
        turn.failure = formatOperatorText(event.stopReason, maximumStopReasonBytes);
      }
      return true;
    }
    case "tool_execution_start":
      if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return false;
      evictOldestPendingTool(pendingTools);
      pendingTools.set(event.toolCallId, {
        toolName: formatOperatorText(event.toolName, maximumToolNameBytes).trim()
      });
      return true;
    case "tool_execution_end": {
      if (
        typeof event.toolCallId !== "string" ||
        typeof event.toolName !== "string" ||
        !isStatus(event.status) ||
        !isDuration(event.durationMs) ||
        (event.errorCode !== undefined && typeof event.errorCode !== "string")
      ) {
        return false;
      }
      const pending = pendingTools.get(event.toolCallId);
      pendingTools.delete(event.toolCallId);
      const tool: ResidentVoiceTerminalToolView = {
        name: formatOperatorText(pending?.toolName ?? event.toolName, maximumToolNameBytes).trim(),
        status: event.errorCode === "cancelled" ? "cancelled" : event.status,
        durationMs: event.durationMs,
        ...(event.errorCode === undefined
          ? {}
          : { errorCode: formatOperatorText(event.errorCode, maximumStopReasonBytes) })
      };
      const tools = currentTurn(turns).tools;
      tools.push(tool);
      if (tools.length > maximumCompletedToolsPerTurn) {
        tools.splice(0, tools.length - maximumCompletedToolsPerTurn);
      }
      return true;
    }
    case "stage": {
      if (
        !isRuntimeStage(event.stage) ||
        !isStatus(event.status) ||
        !isDuration(event.durationMs)
      ) {
        return false;
      }
      const turn = currentTurn(turns);
      const errorCode = readStageErrorCode(event.attributes);
      turn.timings.set(event.stage, {
        durationMs: event.durationMs,
        status: event.status
      });
      const failureLabel = stageFailureLabels[event.stage];
      if (event.status === "error" && failureLabel !== undefined) {
        turn.failure = errorCode === undefined ? failureLabel : `${failureLabel}: ${errorCode}`;
      }
      return true;
    }
  }
}

function createView(
  controls: ResidentVoiceTerminalControls,
  phase: ResidentVoiceTurnPhase,
  turns: readonly MutableTurn[],
  pendingTools: ReadonlyMap<string, PendingTool>
): ResidentVoiceTerminalView {
  const activeToolName = Array.from(pendingTools.values()).at(-1)?.toolName;
  return {
    controls,
    phase,
    ...(activeToolName === undefined ? {} : { activeToolName }),
    turns: turns.map(toTurnView)
  };
}

function toTurnView(turn: MutableTurn): ResidentVoiceTerminalTurnView {
  return {
    ...(turn.staffText === undefined ? {} : { staffText: turn.staffText }),
    ...(turn.picoText === undefined ? {} : { picoText: turn.picoText }),
    ...(turn.failure === undefined ? {} : { failure: turn.failure }),
    tools: turn.tools,
    timings: turn.timings
  };
}

function appendTurn(turns: MutableTurn[]): MutableTurn {
  const turn: MutableTurn = { tools: [], timings: new Map() };
  turns.push(turn);
  if (turns.length > maximumTurns) turns.splice(0, turns.length - maximumTurns);
  return turn;
}

function currentTurn(turns: MutableTurn[]): MutableTurn {
  return turns.at(-1) ?? appendTurn(turns);
}

function evictOldestPendingTool(pendingTools: Map<string, PendingTool>): void {
  if (pendingTools.size < maximumPendingTools) return;
  const oldest = pendingTools.keys().next();
  if (!oldest.done) pendingTools.delete(oldest.value);
}

function readStageErrorCode(attributes: Readonly<Record<string, unknown>>): string | undefined {
  const value = attributes["pico.voice.error_code"];
  return typeof value === "string" ? formatOperatorText(value, maximumStopReasonBytes) : undefined;
}

function isPhase(value: unknown): value is ResidentVoiceTurnPhase {
  return typeof value === "string" && phases.has(value as ResidentVoiceTurnPhase);
}

function isRuntimeStage(value: unknown): value is VoiceRuntimeStage {
  return typeof value === "string" && Object.hasOwn(voiceRuntimeStagePolicies, value);
}

function isStatus(value: unknown): value is VoiceStageStatus {
  return typeof value === "string" && statuses.has(value as VoiceStageStatus);
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatOperatorText(value: string, maximumBytes: number): string {
  const output = createTextBudget(maximumBytes);
  appendTerminalText(output, value);
  return finishTextBudget(output);
}

function createTextBudget(maximumBytes: number): TextBudget {
  return {
    maximumBytes,
    parts: [],
    byteLength: 0,
    truncated: false,
    replacingUnsafeRun: false
  };
}

function appendTerminalText(output: TextBudget, value: string): void {
  for (const character of value) {
    if (output.truncated) return;
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnsafeTerminalCodePoint(codePoint)) {
      if (!output.replacingUnsafeRun) appendTerminalCharacter(output, " ");
      output.replacingUnsafeRun = true;
      continue;
    }
    output.replacingUnsafeRun = false;
    appendTerminalCharacter(output, character);
  }
}

function appendTerminalCharacter(output: TextBudget, character: string): void {
  const characterBytes = Buffer.byteLength(character, "utf8");
  if (output.byteLength + characterBytes > output.maximumBytes) {
    output.truncated = true;
    return;
  }
  output.parts.push(character);
  output.byteLength += characterBytes;
}

function finishTextBudget(output: TextBudget): string {
  if (!output.truncated) return output.parts.join("");
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");

  while (output.byteLength + ellipsisBytes > output.maximumBytes) {
    const removed = output.parts.pop();
    if (removed === undefined) break;
    output.byteLength -= Buffer.byteLength(removed, "utf8");
  }
  return `${output.parts.join("")}${ellipsis}`;
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}
