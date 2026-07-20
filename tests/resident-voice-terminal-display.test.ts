import { describe, expect, it, vi } from "vitest";
import type { ResidentVoiceOperatorEvent } from "../src/runtime/resident-voice-operator.js";
import {
  createResidentVoiceTerminalDisplay,
  createResidentVoiceTerminalOperator
} from "../src/runtime/resident-voice-terminal-display.js";

describe("resident voice terminal display", () => {
  it("creates a non-persistent widget sink only for TUI mode", () => {
    const setWidget = vi.fn();

    expect(createResidentVoiceTerminalOperator({ mode: "print", setWidget })).toBeUndefined();
    const operator = createResidentVoiceTerminalOperator({ mode: "tui", setWidget });
    operator?.record({
      kind: "staff_transcript",
      text: "表示する"
    });

    expect(setWidget).toHaveBeenCalledOnce();
    expect(setWidget).toHaveBeenCalledWith(
      "pico-resident-voice",
      ["Pico voice", "Staff: 表示する"],
      { placement: "aboveEditor" }
    );
  });

  it("shows bounded conversation, tool evidence, stop reason, and aggregated timings", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      setLines: (lines) => renders.push([...lines])
    });

    display.record({
      kind: "turn_started"
    });
    display.record({
      kind: "stage",
      stage: "stt",
      status: "ok",
      durationMs: 125,
      attributes: { "pico.voice.utterance_duration_ms": 800 }
    });
    display.record({
      kind: "staff_transcript",
      text: "スタックチャンの状態を教えて"
    });
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
    display.record({
      kind: "assistant_settled",
      stopReason: "stop"
    });
    display.record({
      kind: "pi_response",
      text: "準備できています"
    });
    for (const [stage, durationMs] of [
      ["pi_time_to_first_text", 750],
      ["pi_turn", 1_075],
      ["tts_time_to_first_chunk", 240],
      ["tts_playback", 600],
      ["ptt_release_to_playback_start", 1_400]
    ] as const) {
      display.record({
        kind: "stage",
        stage,
        status: "ok",
        durationMs,
        attributes: stage === "tts_playback" ? { "pico.voice.trailing_silence_ms": 100 } : {}
      });
    }

    const lines = renders.at(-1) ?? [];
    expect(lines[0]).toBe("Pico voice");
    expect(lines).toContain("Staff: スタックチャンの状態を教えて");
    expect(lines).toContain(
      'Tool: stackchan_get_status({"detail":true}) -> ok 350 ms {"status":"ready"}'
    );
    expect(lines).toContain("Pico: 準備できています [stop=stop]");
    expect(lines.at(-1)).toBe(
      "時間: STT 125 ms | Pi初字 750 ms | Pi 1.08 s | TTS初音 240 ms | 再生 600 ms | 合成末尾無音 100 ms | PTT→再生 1.40 s"
    );
  });

  it("truncates Japanese text only at UTF-8 character boundaries", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      maximumTextBytes: 32,
      setLines: (lines) => renders.push([...lines])
    });

    display.record({
      kind: "staff_transcript",
      text: "あ".repeat(11)
    });

    expect(renders.at(-1)).toEqual(["Pico voice", `Staff: ${"あ".repeat(9)}…`]);
  });

  it("shows a terminal stop reason even when no Pi response follows", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      setLines: (lines) => renders.push([...lines])
    });

    display.record({ kind: "assistant_settled", stopReason: "error" });

    expect(renders.at(-1)).toEqual(["Pico voice", "Pico: [stop=error]"]);
  });

  it("keeps transcripts and tool names on one terminal-safe line", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      setLines: (lines) => renders.push([...lines])
    });

    display.record({ kind: "staff_transcript", text: "一行目\n時間: 偽装\u001B[31m" });
    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "unsafe\r\nname\u001B",
      args: {}
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "unsafe",
      result: {},
      status: "ok",
      durationMs: 1
    });

    const lines = renders.at(-1) ?? [];
    expect(lines).toContain("Staff: 一行目 時間: 偽装 [31m");
    expect(lines).toContain("Tool: unsafe name({}) -> ok 1 ms {}");
    expect(
      lines.every(
        (line) => !line.includes("\r") && !line.includes("\n") && !line.includes("\u001B")
      )
    ).toBe(true);
  });

  it("shows and releases a tool call that is cancelled before an SDK end event", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      setLines: (lines) => renders.push([...lines])
    });

    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "slow_tool",
      args: { wait: true }
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "slow_tool",
      status: "skipped",
      errorCode: "cancelled",
      durationMs: 250
    });

    expect(renders.at(-1)).toContain(
      'Tool: slow_tool({"wait":true}) -> cancelled 250 ms [cancelled]'
    );
  });

  it("bounds cyclic tool payloads and keeps only the configured history", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      maximumHistoryEntries: 2,
      maximumPayloadBytes: 48,
      setLines: (lines) => renders.push([...lines])
    });
    const cyclic: Record<string, unknown> = { value: "x".repeat(100) };
    cyclic.self = cyclic;

    display.record({
      kind: "turn_started"
    });
    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "example",
      args: cyclic
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "example",
      result: cyclic,
      status: "error",
      durationMs: 100
    });
    display.record({
      kind: "staff_transcript",
      text: "二つ目"
    });
    display.record({
      kind: "pi_response",
      text: "三つ目"
    });

    const lines = renders.at(-1) ?? [];
    expect(lines).toEqual(["Pico voice", "Staff: 二つ目", "Pico: 三つ目"]);
    expect(renders.flat().join("\n")).toContain("…");
  });

  it("does not execute accessors, toJSON, custom inspection, or Proxy traps", () => {
    const renders: string[][] = [];
    const sideEffect = vi.fn();
    class HostileBytes extends Uint8Array {
      override get byteLength(): number {
        sideEffect();
        return super.byteLength;
      }
    }
    const payload: Record<string, unknown> = { bytes: new HostileBytes(1) };
    Object.defineProperty(payload, "secret", {
      enumerable: true,
      get: sideEffect
    });
    Object.defineProperty(payload, "toJSON", {
      enumerable: false,
      value: sideEffect
    });
    const proxy = new Proxy(payload, {
      get() {
        sideEffect();
        return undefined;
      },
      getOwnPropertyDescriptor(target, property) {
        sideEffect();
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        sideEffect();
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        sideEffect();
        return Reflect.ownKeys(target);
      }
    });
    const display = createResidentVoiceTerminalDisplay({
      maximumPayloadBytes: 64,
      setLines: (lines) => renders.push([...lines])
    });

    display.record({
      kind: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "safe_tool",
      args: payload
    });
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "safe_tool",
      status: "ok",
      result: proxy,
      durationMs: 1
    });

    expect(sideEffect).not.toHaveBeenCalled();
    expect(renders.at(-1)?.join("\n")).toContain("[accessor]");
    expect(renders.at(-1)?.join("\n")).toContain("[Proxy]");
  });

  it("caps pending tool snapshots and evicts the oldest bounded payload", () => {
    const renders: string[][] = [];
    const display = createResidentVoiceTerminalDisplay({
      setLines: (lines) => renders.push([...lines])
    });

    for (let index = 0; index < 33; index += 1) {
      display.record({
        kind: "tool_execution_start",
        toolCallId: `call-${String(index)}`,
        toolName: `tool-${String(index)}`,
        args: { index }
      });
    }
    display.record({
      kind: "tool_execution_end",
      toolCallId: "call-0",
      toolName: "tool-0",
      status: "ok",
      result: {},
      durationMs: 1
    });

    expect(renders.at(-1)).toContain("Tool: tool-0(undefined) -> ok 1 ms {}");
  });

  it("contains widget failures so observability cannot fail the voice runtime", () => {
    const display = createResidentVoiceTerminalDisplay({
      setLines: vi.fn(() => {
        throw new Error("widget unavailable");
      })
    });

    expect(() =>
      display.record({
        kind: "staff_transcript",
        text: "続行する"
      })
    ).not.toThrow();
  });

  it("contains malformed operator events so formatting cannot fail the voice runtime", () => {
    const display = createResidentVoiceTerminalDisplay({ setLines: vi.fn() });
    const malformedEvent = {
      kind: "staff_transcript",
      text: undefined
    } as unknown as ResidentVoiceOperatorEvent;

    expect(() => display.record(malformedEvent)).not.toThrow();
  });
});
