import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { SessionMemoryCutoffInput } from "../src/modules/long-memory/index.js";
import { createMem0MemoryProvider, type Mem0Client } from "../src/modules/long-memory/mem0.js";

const completedSession = {
  sessionId: "session-2026-06-12-evening",
  cutoffAt: "2026-06-12T18:30:00.000Z",
  sourceEntryIds: ["session-1-entry-1", "session-1-entry-2"],
  entries: [
    {
      id: "session-1-entry-1",
      role: "staff",
      content: "雨の日は工作セットを早めに出すと落ち着いて始められた。"
    },
    {
      id: "session-1-entry-2",
      role: "assistant",
      content: "次の雨の日も工作セットを先に準備する候補として扱う。"
    }
  ],
  requestedBy: "session_lifecycle"
} as const satisfies SessionMemoryCutoffInput;

describe("Mem0 long-memory provider", () => {
  it("maps session cutoffs to Mem0 messages with pico provenance metadata", async () => {
    const add = vi.fn<Mem0Client["add"]>().mockResolvedValue({
      memories: [
        {
          id: "mem0-1",
          content: "雨の日は工作セットを早めに準備する。"
        }
      ]
    });
    const client = {
      add,
      search: vi.fn<Mem0Client["search"]>(),
      delete: vi.fn<Mem0Client["delete"]>()
    } satisfies Mem0Client;
    const audit = createStructuredAuditLog();
    const provider = createMem0MemoryProvider({
      client,
      scopeId: "facility:pico",
      audit
    });

    await expect(provider.addSessionCutoff(completedSession)).resolves.toEqual({
      memoryIds: ["mem0-1"],
      sourceSessionId: "session-2026-06-12-evening"
    });

    expect(add).toHaveBeenCalledExactlyOnceWith({
      messages: [
        {
          role: "user",
          content: "雨の日は工作セットを早めに出すと落ち着いて始められた。"
        },
        {
          role: "assistant",
          content: "次の雨の日も工作セットを先に準備する候補として扱う。"
        }
      ],
      scopeId: "facility:pico",
      metadata: {
        cutoff_at: "2026-06-12T18:30:00.000Z",
        requested_by: "session_lifecycle",
        source_entry_ids: ["session-1-entry-1", "session-1-entry-2"],
        source_session_id: "session-2026-06-12-evening"
      }
    });
    expect(audit.entries().map((event) => event.name)).toEqual(["long_memory.mem0.added"]);
    expect(JSON.stringify(audit.entries())).not.toContain("工作セットを早めに出す");
  });

  it("rejects child profiling content before calling Mem0", async () => {
    const client = {
      add: vi.fn<Mem0Client["add"]>(),
      search: vi.fn<Mem0Client["search"]>(),
      delete: vi.fn<Mem0Client["delete"]>()
    } satisfies Mem0Client;
    const provider = createMem0MemoryProvider({
      client,
      scopeId: "facility:pico"
    });

    await expect(
      provider.addSessionCutoff({
        ...completedSession,
        entries: [
          {
            id: "session-1-entry-1",
            role: "staff",
            content: "child profile content must not become Mem0 memory."
          }
        ]
      })
    ).rejects.toThrow("pico long memory must not contain individual child profile data");
    expect(client.add).not.toHaveBeenCalled();
  });

  it("searches and deletes through the scoped Mem0 client without auditing raw query text", async () => {
    const client = {
      add: vi.fn<Mem0Client["add"]>(),
      search: vi.fn<Mem0Client["search"]>().mockResolvedValue({
        memories: [
          {
            id: "mem0-1",
            content: "雨の日は工作セットを早めに準備する。",
            score: 0.82
          }
        ]
      }),
      delete: vi.fn<Mem0Client["delete"]>().mockResolvedValue(undefined)
    } satisfies Mem0Client;
    const audit = createStructuredAuditLog();
    const provider = createMem0MemoryProvider({
      client,
      scopeId: "facility:pico",
      audit
    });

    await expect(provider.search("工作セット")).resolves.toEqual([
      {
        id: "mem0-1",
        content: "雨の日は工作セットを早めに準備する。",
        score: 0.82
      }
    ]);
    await expect(provider.delete("mem0-1")).resolves.toBeUndefined();

    expect(client.search).toHaveBeenCalledExactlyOnceWith({
      query: "工作セット",
      scopeId: "facility:pico"
    });
    expect(client.delete).toHaveBeenCalledExactlyOnceWith("mem0-1");
    expect(audit.entries().map((event) => event.name)).toEqual([
      "long_memory.mem0.searched",
      "long_memory.mem0.deleted"
    ]);
    expect(JSON.stringify(audit.entries())).not.toContain("工作セット");
    expect(JSON.stringify(audit.entries())).not.toContain("雨の日は工作セット");
  });
});
