import { describe, expect, it } from "vitest";

import { createResidentVoiceConsoleLog } from "../src/runtime/resident-voice-console-log.js";
import type { VoiceResidentLogEvent } from "../src/runtime/voice-resident.js";

describe("resident voice console log", () => {
  it("writes metadata-only input and Pi Agent response events", () => {
    const writes: string[] = [];
    const log = createResidentVoiceConsoleLog({
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    log.record({
      kind: "staff_input",
      occurredAt: "2026-06-22T00:00:00.000Z",
      sessionId: "session-1"
    });
    log.record({
      kind: "pi_agent_response",
      occurredAt: "2026-06-22T00:00:00.250Z",
      sessionId: "session-1",
      durationMs: 250
    });
    log.record({
      kind: "wake_ack_response",
      occurredAt: "2026-06-22T00:00:00.500Z",
      sessionId: "session-1",
      durationMs: 120
    });

    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z staff_input session=session-1\n",
      "[pico voice] 2026-06-22T00:00:00.250Z pi_agent_response session=session-1 duration_ms=250\n",
      "[pico voice] 2026-06-22T00:00:00.500Z wake_ack_response session=session-1 duration_ms=120\n"
    ]);
    expect(writes.join("\n")).not.toContain('今日は"テスト"です');
    expect(writes.join("\n")).not.toContain("了解です。");
    expect(writes.join("\n")).not.toContain("はい。");
    expect(writes.join("\n")).not.toContain("text:");
  });

  it("never formats legacy text fields", () => {
    const writes: string[] = [];
    const log = createResidentVoiceConsoleLog({
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    log.record({
      kind: "staff_input",
      occurredAt: "2026-06-22T00:00:00.000Z",
      sessionId: "session-1",
      text: "123456789"
    } as VoiceResidentLogEvent);

    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z staff_input session=session-1\n"
    ]);
    expect(writes[0]).not.toContain("123456789");
    expect(writes[0]).not.toContain("text");
  });
});
