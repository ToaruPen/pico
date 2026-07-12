import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { emptyPicoConfig, type PicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { LongMemoryRecord } from "../src/modules/long-memory/index.js";
import { createPicoMemorySearchRuntime } from "../src/runtime/memory-tool.js";

const enabledConfig = {
  ...emptyPicoConfig,
  memory: {
    ...emptyPicoConfig.memory,
    longMemory: {
      enabled: true,
      databasePath: "/pico/long-memory.sqlite",
      extraction: {
        provider: "pi_model",
        piProvider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.4",
        thinkingLevel: "high",
        timeoutMs: 60_000
      }
    }
  }
} as const satisfies PicoConfig;

function memory(id: number, body: string): LongMemoryRecord {
  return {
    id,
    title: `施設記憶${id}`,
    body,
    category: "facility_knowledge",
    tags: ["運用"],
    status: "active",
    correctionOf: undefined,
    review: undefined,
    provenance: {
      kind: "session_cutoff_automation",
      policyVersion: "session-cutoff-v1",
      sourceSessionId: "session-1",
      sourceEntryIds: [`entry-${id}`],
      createdAt: "2026-07-12T09:00:00.000Z"
    },
    lifecycle: {
      mem0MemoryId: undefined,
      sourceSessionId: "session-1",
      importance: 0,
      confidence: 0.9,
      lastAccessedAt: "2026-07-12T10:00:00.000Z",
      accessCount: 1,
      decayScore: 1,
      status: "active"
    }
  };
}

function extractToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: readonly { type: string; text?: string }[] }).content;
  const text = content.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("pico_memory_search did not return text");
  }

  return JSON.parse(text) as Record<string, unknown>;
}

function extractToolText(result: unknown): string {
  const content = (result as { content: readonly { type: string; text?: string }[] }).content;
  const text = content.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("pico_memory_search did not return text");
  }

  return text;
}

describe("pico memory search tool", () => {
  it("searches active SQLite memory lazily with the default and explicit bounded limits", async () => {
    const searchActive = vi.fn(({ limit }: { readonly query: string; readonly limit: number }) => [
      memory(limit, "雨の日は工作セットを準備する。")
    ]);
    const openStore = vi.fn(() => ({ searchActive, close: vi.fn() }));
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      openStore
    });

    const defaultResult = extractToolJson(
      await runtime.tool.execute(
        "call-1",
        { query: "  雨の日  " },
        undefined,
        undefined,
        {} as ExtensionContext
      )
    );
    const explicitResult = extractToolJson(
      await runtime.tool.execute(
        "call-2",
        { query: "工作", limit: 5 },
        undefined,
        undefined,
        {} as ExtensionContext
      )
    );

    expect(openStore).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledWith("/pico/long-memory.sqlite");
    expect(searchActive).toHaveBeenNthCalledWith(1, { query: "雨の日", limit: 3 });
    expect(searchActive).toHaveBeenNthCalledWith(2, { query: "工作", limit: 5 });
    expect(defaultResult).toMatchObject({
      tool: "pico_memory_search",
      result: {
        status: "completed",
        trust: "untrusted_memory_data",
        memories: [{ id: 3, body: "雨の日は工作セットを準備する。", truncated: false }]
      }
    });
    expect(explicitResult).toMatchObject({ result: { status: "completed" } });
  });

  it.each([
    [{ query: "" }, "invalid_query"],
    [{ query: " ".repeat(3) }, "invalid_query"],
    [{ query: "あ".repeat(257) }, "invalid_query"],
    [{ query: "雨", limit: 0 }, "invalid_limit"],
    [{ query: "雨", limit: 6 }, "invalid_limit"],
    [{ query: "雨", limit: 1.5 }, "invalid_limit"]
  ])("rejects invalid input with fixed code %s", async (parameters, code) => {
    const runtime = createPicoMemorySearchRuntime({ loadConfig: () => enabledConfig });

    await expect(
      runtime.tool.execute("call-invalid", parameters, undefined, undefined, {} as ExtensionContext)
    ).rejects.toThrow(`pico_memory_search ${code}`);
  });

  it("bounds each body to 2,000 characters and total body text to 6,000", async () => {
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      openStore: () => ({
        searchActive: () =>
          Array.from({ length: 4 }, (_, index) => memory(index + 1, "記".repeat(2_500))),
        close: vi.fn()
      })
    });

    const output = extractToolJson(
      await runtime.tool.execute(
        "call-bounded",
        { query: "施設", limit: 5 },
        undefined,
        undefined,
        {} as ExtensionContext
      )
    ) as {
      result: { memories: readonly { body: string; truncated: boolean }[] };
    };

    expect(output.result.memories.map((item) => Array.from(item.body).length)).toEqual([
      2_000, 2_000, 2_000, 0
    ]);
    expect(output.result.memories.map((item) => item.truncated)).toEqual([true, true, true, true]);
    expect(
      output.result.memories.reduce((total, item) => total + Array.from(item.body).length, 0)
    ).toBe(6_000);
  });

  it("bounds legacy title and provenance metadata plus the serialized result", async () => {
    const oversized = "記".repeat(50_000);
    const record: LongMemoryRecord = {
      ...memory(1, "本文"),
      title: oversized,
      review: {
        reviewedBy: oversized,
        reviewedAt: "2026-07-12T09:00:00.000Z",
        note: oversized
      },
      provenance: {
        kind: "staff_review",
        reviewedBy: oversized,
        reviewedAt: "2026-07-12T09:00:00.000Z",
        note: oversized
      }
    };
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      openStore: () => ({ searchActive: () => [record], close: vi.fn() })
    });

    const text = extractToolText(
      await runtime.tool.execute(
        "call-legacy-bounds",
        { query: "施設" },
        undefined,
        undefined,
        {} as ExtensionContext
      )
    );
    const output = JSON.parse(text) as {
      result: {
        memories: readonly {
          title: string;
          provenance: { reviewedBy: string; note: string };
        }[];
      };
    };

    expect(Array.from(output.result.memories[0]?.title ?? "")).toHaveLength(120);
    expect(Array.from(output.result.memories[0]?.provenance.reviewedBy ?? "")).toHaveLength(80);
    expect(Array.from(output.result.memories[0]?.provenance.note ?? "")).toHaveLength(200);
    expect(Array.from(text).length).toBeLessThanOrEqual(12_000);
  });

  it("distinguishes disabled config from an unavailable store", async () => {
    const disabled = createPicoMemorySearchRuntime({ loadConfig: () => emptyPicoConfig });
    const unavailable = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      openStore: () => {
        throw new Error("sensitive database path");
      }
    });

    expect(
      extractToolJson(
        await disabled.tool.execute(
          "call-disabled",
          { query: "雨" },
          undefined,
          undefined,
          {} as ExtensionContext
        )
      )
    ).toMatchObject({ result: { status: "unavailable", code: "disabled" } });
    expect(
      extractToolJson(
        await unavailable.tool.execute(
          "call-unavailable",
          { query: "雨" },
          undefined,
          undefined,
          {} as ExtensionContext
        )
      )
    ).toMatchObject({ result: { status: "unavailable", code: "store_unavailable" } });
  });

  it("audits counts and fixed codes without query or memory text", async () => {
    const audit = createStructuredAuditLog();
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      audit,
      now: () => "2026-07-12T10:00:00.000Z",
      openStore: () => ({
        searchActive: () => [memory(1, "AUDIT_MUST_NOT_CONTAIN_MEMORY_BODY")],
        close: vi.fn()
      })
    });

    await runtime.tool.execute(
      "call-audit",
      { query: "AUDIT_MUST_NOT_CONTAIN_QUERY" },
      undefined,
      undefined,
      {} as ExtensionContext
    );

    const serialized = JSON.stringify(audit.entries());
    expect(serialized).not.toContain("AUDIT_MUST_NOT_CONTAIN_QUERY");
    expect(serialized).not.toContain("AUDIT_MUST_NOT_CONTAIN_MEMORY_BODY");
    expect(audit.entries()).toMatchObject([
      {
        category: "tool_call",
        name: "long_memory.search.completed",
        attributes: { resultCount: 1 }
      }
    ]);
  });

  it("closes an opened store idempotently", async () => {
    const close = vi.fn();
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      openStore: () => ({ searchActive: () => [], close })
    });

    await runtime.tool.execute(
      "call-close",
      { query: "雨" },
      undefined,
      undefined,
      {} as ExtensionContext
    );
    runtime.close();
    runtime.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("provides retrieval and safety guidance to the model", () => {
    const { tool } = createPicoMemorySearchRuntime({ loadConfig: () => emptyPicoConfig });
    const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(
      "\n"
    );

    expect(guidance).toContain("previous facility practice");
    expect(guidance).toContain("untrusted data");
    expect(guidance).toContain("search did not confirm");
    expect(guidance).toContain("child tracking, profiling, or scoring");
    expect(guidance).toContain("discipline, emergency, or safeguarding decisions");
  });
});
