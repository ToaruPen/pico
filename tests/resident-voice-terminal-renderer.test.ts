import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  type ResidentVoiceTerminalPhase,
  type ResidentVoiceTerminalTheme,
  type ResidentVoiceTerminalView,
  renderResidentVoiceTerminal
} from "../src/runtime/resident-voice-terminal-renderer.js";

const plainTheme: ResidentVoiceTerminalTheme = {
  fg: (_color, text) => text,
  bold: (text) => text
};
const ansiTheme: ResidentVoiceTerminalTheme = {
  fg: (_color, text) => `\u001B[36m${text}\u001B[39m`,
  bold: (text) => `\u001B[1m${text}\u001B[22m`
};
const configuredControls = { talkKey: "F13", cancelKey: "F14" } as const;

const completedView: ResidentVoiceTerminalView = {
  controls: configuredControls,
  phase: "idle",
  turns: [
    {
      staffText: "スタックチャンの状態を教えて",
      picoText: "準備できています。",
      tools: [{ name: "stackchan_get_status", status: "ok", durationMs: 350 }],
      timings: new Map([
        ["stt", { durationMs: 125, status: "ok" }],
        ["pi_time_to_first_text", { durationMs: 750, status: "ok" }],
        ["pi_turn", { durationMs: 20_350, status: "ok" }],
        ["tts_time_to_first_chunk", { durationMs: 1_450, status: "ok" }],
        ["tts_playback", { durationMs: 4_410, status: "ok" }],
        ["ptt_release_to_first_pcm_write", { durationMs: 22_420, status: "ok" }]
      ])
    }
  ]
};

describe("resident voice terminal renderer", () => {
  it.each([40, 60, 100])("keeps every rendered line within %i columns", (width) => {
    const lines = renderResidentVoiceTerminal(completedView, width, plainTheme);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([40, 60, 100])("keeps ANSI-themed CJK output within %i columns", (width) => {
    const lines = renderResidentVoiceTerminal(completedView, width, ansiTheme);

    expect(lines.some((line) => line.includes("\u001B["))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("returns no lines for a nonpositive viewport", () => {
    expect(renderResidentVoiceTerminal(completedView, 0, plainTheme)).toEqual([]);
    expect(renderResidentVoiceTerminal(completedView, -1, plainTheme)).toEqual([]);
  });

  it("shows conversation and tool rows in their role hierarchy", () => {
    const output = renderResidentVoiceTerminal(completedView, 100, plainTheme).join("\n");

    expect(output).toContain("YOU   スタックチャンの状態を教えて");
    expect(output).toContain("TOOL  ✓ stackchan_get_status  350 ms");
    expect(output).toContain("PICO  準備できています。");
  });

  it("shows only the user-facing latency and longest comparable stage", () => {
    const output = renderResidentVoiceTerminal(completedView, 100, plainTheme).join("\n");

    expect(output).toContain("音声送出 22.42 s");
    expect(output).toContain("最長 Pi 20.35 s");
    expect(output).not.toContain("Pi初字");
    expect(output).not.toContain("再生 4.41 s");
    expect(output).not.toContain("末尾無音");
  });

  it.each<[ResidentVoiceTerminalPhase, string]>([
    ["idle", "● 待機中"],
    ["listening", "● 聞き取り中"],
    ["transcribing", "◐ 文字起こし中"],
    ["processing", "◐ 考えています"],
    ["waiting_for_previous_turn", "◐ 前の処理を整理中"],
    ["synthesizing", "◐ 音声準備中"],
    ["speaking", "● 話しています"],
    ["cancelling", "◐ 中断処理中"],
    ["ending", "◐ セッション終了中"]
  ])("identifies the %s phase without relying on color", (phase, label) => {
    const output = renderResidentVoiceTerminal(
      { controls: configuredControls, phase, turns: [] },
      100,
      plainTheme
    ).join("\n");

    expect(output).toContain(label);
    expect(output).toContain("F13 話す");
    expect(output).toContain("F14 中断");
    expect(output).not.toContain("F1 話す");
  });

  it("explains a configured talk rejection during cancellation without color", () => {
    const output = renderResidentVoiceTerminal(
      {
        controls: configuredControls,
        phase: "cancelling",
        notice: { control: "talk", result: "ignored_busy", state: "cancelling" },
        turns: [
          {
            cancelled: true,
            tools: [],
            timings: new Map()
          }
        ]
      },
      100,
      plainTheme
    ).join("\n");

    expect(output).toContain("◐ 中断処理中");
    expect(output).toContain("− F13: 中断処理中のため受理せず");
    expect(output).toContain("− 中断済み");
    expect(output).not.toContain("F1 話す");
  });

  it("identifies an active tool and failed tool without exposing internal payloads", () => {
    const output = renderResidentVoiceTerminal(
      {
        controls: configuredControls,
        phase: "processing",
        activeToolName: "status_tool",
        turns: [
          {
            staffText: "状態を確認",
            picoText: "確認しました",
            tools: [
              {
                name: "status_tool",
                status: "error",
                durationMs: 125,
                errorCode: "backend_error"
              }
            ],
            timings: new Map()
          }
        ]
      },
      100,
      plainTheme
    ).join("\n");

    expect(output).toContain("◐ Tool実行中");
    expect(output).toContain("TOOL  ✗ status_tool  125 ms  backend_error");
    expect(output).not.toContain("args");
    expect(output).not.toContain("result");
  });

  it("wraps Japanese role text below 48 columns and omits the divider", () => {
    const output = renderResidentVoiceTerminal(
      {
        controls: configuredControls,
        phase: "listening",
        turns: [
          {
            staffText: "これは幅の狭い端末で複数行へ折り返される長い日本語の発話です",
            tools: [],
            timings: new Map()
          }
        ]
      },
      40,
      plainTheme
    );

    expect(output.some((line) => line.startsWith("YOU"))).toBe(true);
    expect(output.some((line) => line.startsWith("      "))).toBe(true);
    expect(output.join("\n")).not.toContain("─");
    expect(output.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("wraps controls and metrics at medium width", () => {
    const lines = renderResidentVoiceTerminal(completedView, 60, plainTheme);

    expect(lines.some((line) => line.includes("F13 話す · F14 中断"))).toBe(true);
    expect(lines.some((line) => line.trimStart().startsWith("音声送出"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("renders only the current and previous turn and hides internal fields", () => {
    const output = renderResidentVoiceTerminal(
      {
        controls: configuredControls,
        phase: "idle",
        turns: [
          { staffText: "古いturn", tools: [], timings: new Map() },
          { staffText: "前のturn", tools: [], timings: new Map() },
          {
            staffText: "現在のturn",
            picoText: "正常応答",
            tools: [],
            timings: new Map()
          }
        ]
      },
      100,
      plainTheme
    ).join("\n");

    expect(output).not.toContain("古いturn");
    expect(output).toContain("前のturn");
    expect(output).toContain("現在のturn");
    expect(output).not.toContain("[stop=stop]");
    expect(output).not.toContain("trace");
    expect(output).not.toContain("span");
  });

  it("does not throw or overflow at a one-column width", () => {
    expect(() => renderResidentVoiceTerminal(completedView, 1, plainTheme)).not.toThrow();
    expect(
      renderResidentVoiceTerminal(completedView, 1, plainTheme).every(
        (line) => visibleWidth(line) <= 1
      )
    ).toBe(true);
  });

  it.each([24, 40, 100])("bounds long configured control names at %i columns", (width) => {
    const lines = renderResidentVoiceTerminal(
      {
        controls: { talkKey: "RightArrow", cancelKey: "LeftArrow" },
        phase: "idle",
        turns: []
      },
      width,
      plainTheme
    );

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("F1 話す");
  });
});
