import { describe, expect, it } from "vitest";

import { createShortTermMemoryStore } from "../src/modules/memory/index.js";

describe("short-term memory store", () => {
  it("appends and reads active interaction memory entries in order", () => {
    const memory = createShortTermMemoryStore();

    const first = memory.append({
      role: "staff",
      content: "今日は雨なので室内遊びを中心にする。"
    });
    const second = memory.append({
      role: "assistant",
      content: "工作セットを提案する。"
    });

    expect(memory.read()).toEqual([
      {
        id: "memory-1",
        role: "staff",
        content: "今日は雨なので室内遊びを中心にする。"
      },
      {
        id: "memory-2",
        role: "assistant",
        content: "工作セットを提案する。"
      }
    ]);
    expect(first.id).toBe("memory-1");
    expect(second.id).toBe("memory-2");
  });

  it("returns immutable snapshots of short-term memory entries", () => {
    const memory = createShortTermMemoryStore();

    const appended = memory.append({
      role: "staff",
      content: "宿題の時間を少し延ばす。"
    });

    const snapshot = memory.read();
    snapshot.pop();
    try {
      (appended as Record<string, unknown>).content = "changed";
    } catch {
      // Frozen snapshots may reject external mutation in strict mode.
    }

    expect(memory.read()).toHaveLength(1);
    expect(memory.read()[0]?.content).toBe("宿題の時間を少し延ばす。");
  });

  it("clears active interaction memory", () => {
    const memory = createShortTermMemoryStore();

    memory.append({
      role: "staff",
      content: "お迎え前に片付けを始める。"
    });

    memory.clear();

    expect(memory.read()).toEqual([]);
  });

  it("rejects empty memory content", () => {
    const memory = createShortTermMemoryStore();

    expect(() =>
      memory.append({
        role: "staff",
        content: " "
      })
    ).toThrow("pico short-term memory content is required");
  });

  it("rejects unsupported memory roles", () => {
    const memory = createShortTermMemoryStore();

    expect(() =>
      memory.append({
        role: "child" as "staff",
        content: "個人単位の記録にはしない。"
      })
    ).toThrow("pico short-term memory role is invalid");
  });
});
