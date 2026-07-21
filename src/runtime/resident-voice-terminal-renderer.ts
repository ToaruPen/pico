import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { PicoMacKey } from "../config/index.js";
import type { ResidentControlResult } from "./resident-control.js";
import type { ResidentControlState } from "./resident-control-controller.js";
import type { ResidentVoiceTurnPhase } from "./resident-voice-operator.js";
import type { VoiceRuntimeStage, VoiceStageStatus } from "./voice-stage-probe.js";

export type ResidentVoiceTerminalPhase = ResidentVoiceTurnPhase | "ending";

export type ResidentVoiceTerminalTheme = {
  readonly fg: (
    color: "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text",
    text: string
  ) => string;
  readonly bold: (text: string) => string;
};

export type StageTimingView = {
  readonly durationMs: number;
  readonly status: VoiceStageStatus;
};

export type ResidentVoiceTerminalToolView = {
  readonly name: string;
  readonly status: VoiceStageStatus | "cancelled";
  readonly durationMs?: number;
  readonly errorCode?: string;
};

export type ResidentVoiceTerminalTurnView = {
  readonly staffText?: string;
  readonly picoText?: string;
  readonly failure?: string;
  readonly cancelled?: boolean;
  readonly tools: readonly ResidentVoiceTerminalToolView[];
  readonly timings: ReadonlyMap<VoiceRuntimeStage, StageTimingView>;
};

export type ResidentVoiceTerminalControlNotice = {
  readonly control: "talk";
  readonly result: ResidentControlResult;
  readonly state: ResidentControlState | "interaction_ending";
};

export type ResidentVoiceTerminalView = {
  readonly controls: ResidentVoiceTerminalControls;
  readonly phase: ResidentVoiceTerminalPhase;
  readonly activeToolName?: string;
  readonly notice?: ResidentVoiceTerminalControlNotice;
  readonly turns: readonly ResidentVoiceTerminalTurnView[];
};

export type ResidentVoiceTerminalControls = {
  readonly talkKey: PicoMacKey;
  readonly cancelKey: PicoMacKey;
};

type PhasePresentation = {
  readonly symbol: "●" | "◐" | "✗";
  readonly label: string;
  readonly color: "accent" | "success" | "error" | "warning";
};

const phasePresentations: Readonly<Record<ResidentVoiceTerminalPhase, PhasePresentation>> = {
  idle: { symbol: "●", label: "待機中", color: "success" },
  listening: { symbol: "●", label: "聞き取り中", color: "accent" },
  transcribing: { symbol: "◐", label: "文字起こし中", color: "warning" },
  processing: { symbol: "◐", label: "考えています", color: "warning" },
  waiting_for_previous_turn: { symbol: "◐", label: "前の処理を整理中", color: "warning" },
  synthesizing: { symbol: "◐", label: "音声準備中", color: "warning" },
  speaking: { symbol: "●", label: "話しています", color: "accent" },
  cancelling: { symbol: "◐", label: "中断処理中", color: "warning" },
  ending: { symbol: "◐", label: "セッション終了中", color: "warning" }
};

const rolePrefixWidth = 6;

export function renderResidentVoiceTerminal(
  view: ResidentVoiceTerminalView,
  width: number,
  theme: ResidentVoiceTerminalTheme
): string[] {
  if (width <= 0) return [];

  const turns = view.turns.slice(-2);
  const currentTurn = turns.at(-1);
  const lines = renderHeader(view, currentTurn, width, theme);
  const notice = formatControlNotice(view);
  if (notice !== undefined) {
    lines.push(theme.fg("muted", notice));
  }

  if (width >= 48) {
    lines.push(theme.fg("dim", "─".repeat(width)));
  }

  for (const [index, turn] of turns.entries()) {
    if (index > 0 && lines.at(-1) !== "") lines.push("");
    renderTurn(lines, turn, width, theme);
  }

  return lines.map((line) => guardLineWidth(line, width));
}

function renderHeader(
  view: ResidentVoiceTerminalView,
  currentTurn: ResidentVoiceTerminalTurnView | undefined,
  width: number,
  theme: ResidentVoiceTerminalTheme
): string[] {
  const phase = resolvePhasePresentation(view, currentTurn);
  const status = theme.fg(phase.color, `${phase.symbol} ${phase.label}`);
  const title = theme.bold("Pico voice");
  const controls = theme.fg(
    "muted",
    `${view.controls.talkKey} 話す · ${view.controls.cancelKey} 中断`
  );

  if (width < 72) {
    return [`${status}  ${title}`, controls];
  }

  const left = `${status}  ${title}`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(controls));
  return [`${left}${" ".repeat(gap)}${controls}`];
}

function resolvePhasePresentation(
  view: ResidentVoiceTerminalView,
  currentTurn: ResidentVoiceTerminalTurnView | undefined
): PhasePresentation {
  if (view.activeToolName !== undefined) {
    return { symbol: "◐", label: "Tool実行中", color: "warning" };
  }
  if (currentTurn?.failure !== undefined) {
    return { symbol: "✗", label: currentTurn.failure, color: "error" };
  }
  return phasePresentations[view.phase];
}

function renderTurn(
  lines: string[],
  turn: ResidentVoiceTerminalTurnView,
  width: number,
  theme: ResidentVoiceTerminalTheme
): void {
  if (turn.staffText !== undefined) {
    renderRoleText(lines, "YOU", turn.staffText, width, theme);
  }

  for (const tool of turn.tools) {
    renderRoleText(lines, "TOOL", formatTool(tool, theme), width, theme);
  }

  if (turn.picoText !== undefined) {
    renderRoleText(lines, "PICO", turn.picoText, width, theme);
  } else if (turn.failure !== undefined) {
    renderRoleText(lines, "PICO", theme.fg("error", `✗ ${turn.failure}`), width, theme);
  }

  if (turn.cancelled === true) {
    lines.push(`${" ".repeat(rolePrefixWidth)}${theme.fg("muted", "− 中断済み")}`);
  }

  const metrics = formatMetrics(turn.timings);
  if (metrics !== undefined) {
    const styled = theme.fg("muted", metrics);
    if (width < 72) {
      lines.push(...indentWrappedText(styled, width, rolePrefixWidth));
    } else {
      lines.push(`${" ".repeat(rolePrefixWidth)}${styled}`);
    }
  }
}

function formatControlNotice(view: ResidentVoiceTerminalView): string | undefined {
  const notice = view.notice;
  if (notice === undefined || notice.control !== "talk") return undefined;

  if (notice.result === "noop" && notice.state === "listening") {
    return `− ${view.controls.talkKey}: 既に聞き取り中`;
  }

  const reason =
    notice.state === "cancelling"
      ? "中断処理中"
      : notice.state === "interaction_ending"
        ? "セッション終了中"
        : "現在の処理中";
  return `− ${view.controls.talkKey}: ${reason}のため受理せず`;
}

function renderRoleText(
  lines: string[],
  role: "YOU" | "PICO" | "TOOL",
  text: string,
  width: number,
  theme: ResidentVoiceTerminalTheme
): void {
  const prefix = `${theme.bold(role.padEnd(4))}  `;
  const contentWidth = Math.max(1, width - rolePrefixWidth);
  const wrapped = wrapTextWithAnsi(text, contentWidth);
  const contentLines = wrapped.length === 0 ? [""] : wrapped;

  for (const [index, line] of contentLines.entries()) {
    lines.push(`${index === 0 ? prefix : " ".repeat(rolePrefixWidth)}${line}`);
  }
}

function indentWrappedText(text: string, width: number, indentation: number): string[] {
  const contentWidth = Math.max(1, width - indentation);
  return wrapTextWithAnsi(text, contentWidth).map((line) => `${" ".repeat(indentation)}${line}`);
}

function formatTool(
  tool: ResidentVoiceTerminalToolView,
  theme: ResidentVoiceTerminalTheme
): string {
  const failed = tool.status === "error" || tool.status === "cancelled";
  const symbol = theme.fg(
    failed ? "error" : tool.status === "ok" ? "success" : "warning",
    failed ? "✗" : tool.status === "ok" ? "✓" : "−"
  );
  const duration = tool.durationMs === undefined ? "" : `  ${formatDuration(tool.durationMs)}`;
  const error = tool.errorCode === undefined ? "" : `  ${tool.errorCode}`;
  return `${symbol} ${tool.name}${duration}${error}`;
}

function formatMetrics(
  timings: ReadonlyMap<VoiceRuntimeStage, StageTimingView>
): string | undefined {
  const values: string[] = [];
  const responseStart = timings.get("ptt_release_to_first_pcm_write");

  if (responseStart?.status === "ok") {
    values.push(`応答開始 ${formatDuration(responseStart.durationMs)}`);
  }

  const criticalPath = formatCriticalPath(timings);
  if (criticalPath !== undefined) {
    values.push(criticalPath);
  }

  const piSettlementTail = piSettlementTailDuration(timings);
  if (piSettlementTail > 0) {
    values.push(`Pi後処理 ${formatDuration(piSettlementTail)}`);
  }

  return values.length === 0 ? undefined : values.join(" · ");
}

function formatCriticalPath(
  timings: ReadonlyMap<VoiceRuntimeStage, StageTimingView>
): string | undefined {
  const stages = [
    ["stt", "STT"],
    ["pi_final_response_ready", "Pi確定"],
    ["tts_time_to_first_chunk", "TTS"]
  ] as const satisfies readonly (readonly [VoiceRuntimeStage, string])[];
  const parts: string[] = [];

  for (const [stage, label] of stages) {
    const timing = timings.get(stage);
    if (timing?.status === "ok") {
      parts.push(`${label} ${formatDuration(timing.durationMs)}`);
    }
  }

  return parts.length === 0 ? undefined : parts.join(" → ");
}

function piSettlementTailDuration(
  timings: ReadonlyMap<VoiceRuntimeStage, StageTimingView>
): number {
  const turn = timings.get("pi_turn");
  const response = timings.get("pi_final_response_ready");

  if (turn?.status !== "ok" || response?.status !== "ok") {
    return 0;
  }
  return Math.max(0, turn.durationMs - response.durationMs);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(Math.round(durationMs))} ms`;
  return `${(Math.round(durationMs / 10) / 100).toFixed(2)} s`;
}

function guardLineWidth(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
}
