import { describe, expect, it } from "vitest";

import { createResidentVoiceConsoleLog } from "../src/runtime/resident-voice-console-log.js";

describe("resident voice console log", () => {
  it("writes active input and Pi Agent response blocks with bounded multiline text", () => {
    const writes: string[] = [];
    const log = createResidentVoiceConsoleLog({
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    log.record({
      kind: "staff_transcript",
      occurredAt: "2026-06-22T00:00:00.000Z",
      sessionId: "session-1",
      text: '今日は"テスト"です\n続き'
    });
    log.record({
      kind: "pi_agent_response",
      occurredAt: "2026-06-22T00:00:00.250Z",
      sessionId: "session-1",
      durationMs: 250,
      text: "了解です。"
    });
    log.record({
      kind: "wake_ack_response",
      occurredAt: "2026-06-22T00:00:00.500Z",
      sessionId: "session-1",
      durationMs: 120,
      text: "はい。\n聞いています。"
    });

    expect(writes).toEqual([
      '[pico voice] 2026-06-22T00:00:00.000Z input session=session-1\n  text:\n    今日は"テスト"です\n    続き\n',
      "[pico voice] 2026-06-22T00:00:00.250Z pi_agent session=session-1 duration_ms=250\n  text:\n    了解です。\n",
      "[pico voice] 2026-06-22T00:00:00.500Z wake_ack session=session-1 duration_ms=120\n  text:\n    はい。\n    聞いています。\n"
    ]);
  });

  it("truncates very long console text", () => {
    const writes: string[] = [];
    const log = createResidentVoiceConsoleLog({
      maxTextLength: 8,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    log.record({
      kind: "staff_transcript",
      occurredAt: "2026-06-22T00:00:00.000Z",
      sessionId: "session-1",
      text: "123456789"
    });

    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z input session=session-1\n  text:\n    1234567…\n"
    ]);
  });
});
