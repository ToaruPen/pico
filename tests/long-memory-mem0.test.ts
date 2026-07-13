import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { AutomatedFacilityMemoryDraft } from "../src/modules/long-memory/extractor.js";
import type { SessionMemoryCutoffInput } from "../src/modules/long-memory/index.js";
import { createMem0MemoryProvider, type Mem0Client } from "../src/modules/long-memory/mem0.js";
import { createFacilityMemoryWorker } from "../src/modules/long-memory/worker.js";

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

const draft = {
  title: "雨の日の準備",
  body: "雨の日は工作セットを早めに準備する。",
  category: "facility_knowledge",
  tags: ["雨天", "工作"],
  sourceEntryIds: ["session-1-entry-1"],
  confidence: 0.9
} as const satisfies AutomatedFacilityMemoryDraft;

function client(overrides: Partial<Mem0Client> = {}): Mem0Client {
  return {
    add: vi.fn<Mem0Client["add"]>().mockResolvedValue({ memories: [{ id: "mem0-1" }] }),
    search: vi.fn<Mem0Client["search"]>().mockResolvedValue({ memories: [] }),
    delete: vi.fn<Mem0Client["delete"]>().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("Mem0 facility-memory provider", () => {
  it("stores only validated drafts with facility provenance metadata", async () => {
    const mem0 = client();
    const audit = createStructuredAuditLog();
    const provider = createMem0MemoryProvider({ client: mem0, scopeId: "facility:pico", audit });

    await expect(provider.addFacilityMemories(completedSession, [draft])).resolves.toEqual({
      memoryIds: ["mem0-1"],
      sourceSessionId: completedSession.sessionId
    });

    expect(mem0.add).toHaveBeenCalledExactlyOnceWith({
      messages: [{ role: "user", content: "雨の日の準備\n\n雨の日は工作セットを早めに準備する。" }],
      scopeId: "facility:pico",
      metadata: {
        pico_scope_id: "facility:pico",
        category: "facility_knowledge",
        tags: ["雨天", "工作"],
        confidence: 0.9,
        source_session_id: completedSession.sessionId,
        source_entry_ids: ["session-1-entry-1"],
        cutoff_at: completedSession.cutoffAt,
        requested_by: "session_lifecycle",
        policy_version: "session-cutoff-v1"
      }
    });
    expect(JSON.stringify(audit.entries())).not.toContain("工作セットを早めに準備");
  });

  it("does not call Mem0 when extraction returns no durable facility memories", async () => {
    const mem0 = client();
    const provider = createMem0MemoryProvider({ client: mem0, scopeId: "facility:pico" });
    const worker = createFacilityMemoryWorker({
      extractor: { extract: vi.fn().mockResolvedValue([]) },
      provider
    });

    await expect(worker.processCutoff(completedSession)).resolves.toEqual({
      memoryIds: [],
      sourceSessionId: completedSession.sessionId
    });
    expect(mem0.add).not.toHaveBeenCalled();
  });

  it("surfaces extraction and Mem0 failures without retrying", async () => {
    const add = vi.fn<Mem0Client["add"]>().mockRejectedValue(new Error("qdrant unavailable"));
    const provider = createMem0MemoryProvider({
      client: client({ add }),
      scopeId: "facility:pico"
    });
    const worker = createFacilityMemoryWorker({
      extractor: { extract: vi.fn().mockResolvedValue([draft]) },
      provider
    });

    await expect(worker.processCutoff(completedSession)).rejects.toThrow("qdrant unavailable");
    expect(add).toHaveBeenCalledOnce();
  });

  it("searches and deletes through the scoped Mem0 client without auditing content", async () => {
    const search = vi.fn<Mem0Client["search"]>().mockResolvedValue({
      memories: [{ id: "mem0-1", content: draft.body, score: 0.82 }]
    });
    const mem0 = client({ search });
    const audit = createStructuredAuditLog();
    const provider = createMem0MemoryProvider({ client: mem0, scopeId: "facility:pico", audit });

    await expect(provider.search("工作セット", 3)).resolves.toEqual([
      { id: "mem0-1", content: draft.body, score: 0.82 }
    ]);
    await expect(provider.delete("mem0-1")).resolves.toBeUndefined();

    expect(search).toHaveBeenCalledExactlyOnceWith({
      query: "工作セット",
      scopeId: "facility:pico",
      limit: 3
    });
    expect(JSON.stringify(audit.entries())).not.toContain("工作セット");
  });

  it("caps backend search results at the requested limit", async () => {
    const search = vi.fn<Mem0Client["search"]>().mockResolvedValue({
      memories: Array.from({ length: 5 }, (_, index) => ({
        id: `mem0-${String(index + 1)}`,
        content: `facility memory ${String(index + 1)}`
      }))
    });
    const provider = createMem0MemoryProvider({
      client: client({ search }),
      scopeId: "facility:pico"
    });

    await expect(provider.search("facility", 2)).resolves.toHaveLength(2);
  });
});
