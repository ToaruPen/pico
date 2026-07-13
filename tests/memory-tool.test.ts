import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { emptyPicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { Mem0MemoryProvider } from "../src/modules/long-memory/mem0.js";
import { createPicoMemorySearchRuntime } from "../src/runtime/memory-tool.js";
import { defineEnabledLongMemoryTestConfig } from "./long-memory-config-fixture.js";

const enabledConfig = defineEnabledLongMemoryTestConfig("/pico/mem0-history.sqlite");

function extractToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: readonly { type: string; text?: string }[] }).content;
  const text = content.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("pico_memory_search did not return text");
  }

  return JSON.parse(text) as Record<string, unknown>;
}

async function execute(
  runtime: ReturnType<typeof createPicoMemorySearchRuntime>,
  parameters: { readonly query: string; readonly limit?: number }
): Promise<Record<string, unknown>> {
  return extractToolJson(
    await runtime.tool.execute("call", parameters, undefined, undefined, {} as ExtensionContext)
  );
}

describe("pico memory search tool", () => {
  it("lazily creates one Mem0 provider and forwards bounded limits", async () => {
    const search = vi.fn<Mem0MemoryProvider["search"]>().mockResolvedValue([
      {
        id: "mem0-1",
        content: "雨の日は工作セットを準備する。",
        score: 0.82,
        metadata: { category: "facility_knowledge", confidence: 0.9 }
      }
    ]);
    const provider = { search } as unknown as Mem0MemoryProvider;
    const createClient = vi.fn().mockResolvedValue({});
    const createProvider = vi.fn().mockReturnValue(provider);
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      createClient,
      createProvider
    });

    const first = await execute(runtime, { query: "  雨の日  " });
    await execute(runtime, { query: "工作", limit: 5 });

    expect(createClient).toHaveBeenCalledExactlyOnceWith(enabledConfig.memory.mem0);
    expect(createProvider).toHaveBeenCalledOnce();
    expect(search).toHaveBeenNthCalledWith(1, "雨の日", 3);
    expect(search).toHaveBeenNthCalledWith(2, "工作", 5);
    expect(first).toMatchObject({
      result: {
        status: "completed",
        trust: "untrusted_memory_data",
        memories: [
          {
            id: "mem0-1",
            body: "雨の日は工作セットを準備する。",
            category: "facility_knowledge",
            confidence: 0.9,
            score: 0.82,
            truncated: false
          }
        ]
      }
    });
  });

  it("bounds each memory to 2,000 characters and total text to 6,000", async () => {
    const provider = {
      search: vi.fn().mockResolvedValue(
        Array.from({ length: 4 }, (_, index) => ({
          id: `mem0-${index + 1}`,
          content: "記".repeat(2_500)
        }))
      )
    } as unknown as Mem0MemoryProvider;
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      createClient: vi.fn().mockResolvedValue({}),
      createProvider: () => provider
    });
    const output = (await execute(runtime, { query: "施設", limit: 5 })) as {
      result: { memories: readonly { body: string; truncated: boolean }[] };
    };

    expect(output.result.memories.map((memory) => Array.from(memory.body).length)).toEqual([
      2_000, 2_000, 2_000, 0
    ]);
    expect(output.result.memories.map((memory) => memory.truncated)).toEqual([
      true,
      true,
      true,
      true
    ]);
  });

  it("distinguishes disabled config from an unavailable Mem0 provider", async () => {
    const disabled = createPicoMemorySearchRuntime({ loadConfig: () => emptyPicoConfig });
    const unavailable = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      createClient: vi.fn().mockRejectedValue(new Error("sensitive endpoint"))
    });

    expect(await execute(disabled, { query: "雨" })).toMatchObject({
      result: { status: "unavailable", code: "disabled" }
    });
    expect(await execute(unavailable, { query: "雨" })).toMatchObject({
      result: { status: "unavailable", code: "provider_unavailable" }
    });
  });

  it("audits counts and fixed codes without raw query or memory content", async () => {
    const audit = createStructuredAuditLog();
    const runtime = createPicoMemorySearchRuntime({
      loadConfig: () => enabledConfig,
      createClient: vi.fn().mockResolvedValue({}),
      createProvider: () =>
        ({
          search: vi.fn().mockResolvedValue([{ id: "mem0-1", content: "秘密の本文" }])
        }) as unknown as Mem0MemoryProvider,
      audit,
      now: () => "2026-07-13T00:00:00.000Z"
    });

    await execute(runtime, { query: "秘密の検索" });

    expect(audit.entries().at(-1)).toMatchObject({
      name: "long_memory.search.completed",
      attributes: { resultCount: 1 }
    });
    expect(JSON.stringify(audit.entries())).not.toContain("秘密");
  });

  it.each([
    [{ query: "" }, "invalid_query"],
    [{ query: "あ".repeat(257) }, "invalid_query"],
    [{ query: "雨", limit: 0 }, "invalid_limit"],
    [{ query: "雨", limit: 6 }, "invalid_limit"]
  ])("rejects invalid input with a fixed code", async (parameters, code) => {
    const runtime = createPicoMemorySearchRuntime({ loadConfig: () => enabledConfig });

    await expect(
      runtime.tool.execute("call", parameters, undefined, undefined, {} as ExtensionContext)
    ).rejects.toThrow(`pico_memory_search ${code}`);
  });
});
