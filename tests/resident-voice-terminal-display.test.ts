import { describe, expect, it, vi } from "vitest";

import type { ResidentVoiceOperatorEvent } from "../src/runtime/resident-voice-operator.js";
import {
  createResidentVoiceTerminalDisplay,
  createResidentVoiceTerminalOperator
} from "../src/runtime/resident-voice-terminal-display.js";
import type { ResidentVoiceTerminalTheme } from "../src/runtime/resident-voice-terminal-renderer.js";

const plainTheme: ResidentVoiceTerminalTheme = {
  fg: (_color, text) => text,
  bold: (text) => text
};
const configuredControls = { talkKey: "F13", cancelKey: "F14" } as const;

describe("resident voice terminal display", () => {
  it("registers one custom component only in TUI mode and refreshes accepted events", () => {
    const setWidget = vi.fn();

    expect(
      createResidentVoiceTerminalOperator({
        controls: configuredControls,
        mode: "print",
        setWidget
      })
    ).toBeUndefined();
    const operator = createResidentVoiceTerminalOperator({
      controls: configuredControls,
      mode: "tui",
      setWidget
    });

    expect(setWidget).toHaveBeenCalledOnce();
    const factory = setWidget.mock.calls[0]?.[1] as
      | ((
          tui: { requestRender: () => void },
          theme: ResidentVoiceTerminalTheme
        ) => { render: (width: number) => string[]; invalidate: () => void })
      | undefined;
    const requestRender = vi.fn();
    const component = factory?.({ requestRender }, plainTheme);

    operator?.record({ kind: "turn_started" });
    operator?.record({ kind: "turn_phase", phase: "listening" });
    operator?.record({ kind: "staff_transcript", text: "表示する" });

    expect(requestRender).toHaveBeenCalledTimes(3);
    expect(component?.render(100).join("\n")).toContain("F13 話す · F14 中断");
    expect(component?.render(100).join("\n")).toContain("YOU   表示する");
    expect(setWidget).toHaveBeenCalledWith("pico-resident-voice", expect.any(Function), {
      placement: "aboveEditor"
    });
  });

  it("renders structured conversation, safe tool evidence, and priority timings", () => {
    const onChange = vi.fn();
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls, onChange });

    display.record({ kind: "turn_started" });
    display.record({ kind: "turn_phase", phase: "processing" });
    display.record({ kind: "staff_transcript", text: "スタックチャンの状態を教えて" });
    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "stackchan_get_status",
      args: { detail: true }
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "stackchan_get_status",
      result: { status: "ready" },
      status: "ok",
      durationMs: 350
    });
    display.record({ kind: "assistant_settled", stopReason: "stop" });
    display.record({ kind: "pi_response", text: "準備できています" });
    for (const [stage, durationMs] of [
      ["stt", 125],
      ["pi_time_to_first_text", 750],
      ["pi_final_response_ready", 800],
      ["pi_turn", 1_075],
      ["tts_time_to_first_chunk", 240],
      ["tts_playback", 600],
      ["ptt_release_to_first_pcm_write", 1_400]
    ] as const) {
      display.record({
        kind: "stage",
        stage,
        status: "ok",
        durationMs,
        attributes: stage === "tts_playback" ? { "pico.voice.trailing_silence_ms": 100 } : {}
      });
    }

    const output = display.render(100, plainTheme).join("\n");
    expect(output).toContain("YOU   スタックチャンの状態を教えて");
    expect(output).toContain("TOOL  ✓ stackchan_get_status  350 ms");
    expect(output).toContain("PICO  準備できています");
    expect(output).toContain(
      "応答開始 1.40 s · STT 125 ms → Pi確定 800 ms → TTS 240 ms · Pi後処理 275 ms"
    );
    expect(output).not.toContain("detail");
    expect(output).not.toContain("ready");
    expect(output).not.toContain("[stop=stop]");
    expect(output).not.toContain("末尾無音");
    expect(onChange).toHaveBeenCalledTimes(14);
  });

  it("shows farewell telemetry in a bounded interaction-ending lifecycle", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    display.record({ kind: "turn_phase", phase: "processing" });
    display.record({ kind: "staff_transcript", text: "今日の予定を教えて" });
    display.record({
      kind: "stage",
      stage: "ptt_release_to_first_pcm_write",
      status: "ok",
      durationMs: 1_400,
      attributes: {}
    });
    display.record({
      kind: "stage",
      stage: "pi_turn",
      status: "ok",
      durationMs: 1_075,
      attributes: {}
    });
    display.record({
      kind: "control_decision",
      control: "talk",
      result: "ignored_busy",
      state: "cancelling"
    });
    display.record({ kind: "turn_phase", phase: "idle" });
    display.record({ kind: "interaction_ending_started" });
    display.record({ kind: "pi_response", text: "またお手伝いします" });
    display.record({
      kind: "stage",
      stage: "pi_turn",
      status: "ok",
      durationMs: 9_000,
      attributes: {}
    });
    const duringFarewell = display.render(100, plainTheme).join("\n");
    expect(duringFarewell).toContain("◐ セッション終了中");
    expect(duringFarewell).toContain("PICO  またお手伝いします");
    expect(duringFarewell).not.toContain("中断処理中のため受理せず");

    display.record({
      kind: "control_decision",
      control: "talk",
      result: "ignored_busy",
      state: "interaction_ending"
    });
    expect(display.render(100, plainTheme).join("\n")).toContain(
      "F13: セッション終了中のため受理せず"
    );

    display.record({ kind: "interaction_ending_finished" });
    const afterFarewell = display.render(100, plainTheme).join("\n");
    expect(afterFarewell).toContain("● 待機中");
    expect(afterFarewell).toContain("PICO  またお手伝いします");
    expect(afterFarewell).not.toContain("セッション終了中のため受理せず");
  });

  it("retains one configured busy notice until the next accepted turn", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    display.record({ kind: "turn_phase", phase: "speaking" });
    display.record({ kind: "turn_cancelled" });
    display.record({ kind: "turn_phase", phase: "cancelling" });
    display.record({
      kind: "control_decision",
      control: "talk",
      result: "ignored_busy",
      state: "cancelling"
    });

    const cancelled = display.render(100, plainTheme).join("\n");
    expect(cancelled).toContain("◐ 中断処理中");
    expect(cancelled).toContain("− F13: 中断処理中のため受理せず");
    expect(cancelled).toContain("− 中断済み");

    display.record({ kind: "turn_phase", phase: "idle" });
    expect(display.render(100, plainTheme).join("\n")).toContain("− F13: 中断処理中のため受理せず");

    display.record({ kind: "turn_started" });
    display.record({ kind: "turn_phase", phase: "listening" });
    const nextTurn = display.render(100, plainTheme).join("\n");
    expect(nextTurn).not.toContain("中断処理中のため受理せず");
  });

  it("shows a post-response audio failure while preserving the response", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    display.record({ kind: "turn_phase", phase: "synthesizing" });
    display.record({ kind: "pi_response", text: "準備できました" });
    display.record({
      kind: "stage",
      stage: "tts_time_to_first_chunk",
      status: "error",
      durationMs: 500,
      attributes: { "pico.voice.error_code": "backend_error" }
    });

    const output = display.render(100, plainTheme).join("\n");
    expect(output).toContain("✗ 音声準備失敗: backend_error");
    expect(output).toContain("PICO  準備できました");
  });

  it("never reads tool args or results, including hostile accessors and proxies", () => {
    const sideEffect = vi.fn();
    const arguments_ = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(arguments_, "secret", { enumerable: true, get: sideEffect });
    Object.defineProperty(arguments_, "toJSON", { value: sideEffect });
    Object.defineProperty(arguments_, "inspect", { value: sideEffect });
    const result = new Proxy(Object.create(null) as Record<string, unknown>, {
      get() {
        sideEffect();
        return undefined;
      },
      getOwnPropertyDescriptor() {
        sideEffect();
        return undefined;
      },
      getPrototypeOf() {
        sideEffect();
        return Object.prototype;
      },
      ownKeys() {
        sideEffect();
        return [];
      }
    });
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "safe_tool",
      args: arguments_
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "safe_tool",
      status: "ok",
      result,
      durationMs: 1
    });

    expect(sideEffect).not.toHaveBeenCalled();
    expect(display.render(100, plainTheme).join("\n")).toContain("TOOL  ✓ safe_tool  1 ms");
  });

  it("sanitizes terminal controls and truncates text at UTF-8 character boundaries", () => {
    const display = createResidentVoiceTerminalDisplay({
      controls: configuredControls,
      maximumTextBytes: 32
    });

    display.record({ kind: "turn_started" });
    display.record({ kind: "staff_transcript", text: `${"あ".repeat(11)}\n偽装\u001B[31m` });
    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "unsafe\r\nname\u001B",
      args: undefined
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ignored",
      status: "ok",
      durationMs: 1
    });

    const output = display.render(100, plainTheme).join("\n");
    expect(output).toContain(`YOU   ${"あ".repeat(9)}…`);
    expect(output).toContain("TOOL  ✓ unsafe name  1 ms");
    expect(output).not.toContain(String.fromCodePoint(27));
  });

  it("shows only response-less terminal failures", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    display.record({ kind: "assistant_settled", stopReason: "stop" });
    expect(display.render(100, plainTheme).join("\n")).not.toContain("stop");

    display.record({ kind: "assistant_settled", stopReason: "error" });
    expect(display.render(100, plainTheme).join("\n")).toContain("✗ error");

    display.record({ kind: "pi_response", text: "回復した応答" });
    const output = display.render(100, plainTheme).join("\n");
    expect(output).toContain("PICO  回復した応答");
    expect(output).not.toContain("✗ error");
  });

  it("keeps only the current and previous turn", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    for (const text of ["最初", "前", "現在"] as const) {
      display.record({ kind: "turn_started" });
      display.record({ kind: "staff_transcript", text });
    }

    const output = display.render(100, plainTheme).join("\n");
    expect(output).not.toContain("最初");
    expect(output).toContain("前");
    expect(output).toContain("現在");
  });

  it("caps pending tools at 32 safe names", () => {
    const display = createResidentVoiceTerminalDisplay({ controls: configuredControls });

    display.record({ kind: "turn_started" });
    for (let index = 0; index < 33; index += 1) {
      display.record({
        kind: "tool_execution_start",
        toolCallId: `call-${String(index)}`,
        toolName: `original-${String(index)}`,
        args: undefined
      });
    }
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-0",
      toolName: "evicted-name",
      status: "ok",
      durationMs: 1
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "wrong-name",
      status: "ok",
      durationMs: 1
    });

    const output = display.render(100, plainTheme).join("\n");
    expect(output).toContain("evicted-name");
    expect(output).toContain("original-1");
    expect(output).not.toContain("wrong-name");
  });

  it("contains change, refresh, registration, render, theme, and malformed-event failures", () => {
    const display = createResidentVoiceTerminalDisplay({
      controls: configuredControls,
      onChange: vi.fn(() => {
        throw new Error("change unavailable");
      })
    });
    const brokenTheme: ResidentVoiceTerminalTheme = {
      fg: () => {
        throw new Error("theme unavailable");
      },
      bold: (text) => text
    };
    const malformed = {
      kind: "staff_transcript",
      text: undefined
    } as unknown as ResidentVoiceOperatorEvent;

    expect(() => display.record({ kind: "turn_started" })).not.toThrow();
    expect(() => display.record({ kind: "staff_transcript", text: "続行する" })).not.toThrow();
    expect(() => display.record(malformed)).not.toThrow();
    expect(() => display.render(100, brokenTheme)).not.toThrow();
    expect(display.render(100, brokenTheme)).toEqual([]);
    expect(() =>
      createResidentVoiceTerminalOperator({
        controls: configuredControls,
        mode: "tui",
        setWidget: () => {
          throw new Error("registration unavailable");
        }
      })
    ).not.toThrow();

    const setWidget = vi.fn();
    const operator = createResidentVoiceTerminalOperator({
      controls: configuredControls,
      mode: "tui",
      setWidget
    });
    const factory = setWidget.mock.calls[0]?.[1] as (
      tui: { requestRender: () => void },
      theme: ResidentVoiceTerminalTheme
    ) => { render: (width: number) => string[] };
    const component = factory(
      {
        requestRender: () => {
          throw new Error("refresh unavailable");
        }
      },
      brokenTheme
    );

    expect(() => operator?.record({ kind: "turn_phase", phase: "speaking" })).not.toThrow();
    expect(component.render(100)).toEqual([]);
  });
});
