import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import {
  buildMem0OssConfig,
  createMem0OssClient,
  type Mem0OssRuntime,
  type PiAgentLlmSession
} from "../src/modules/long-memory/mem0-runtime.js";

function enabledConfig(model = "vendor/arbitrary-worker-2026") {
  const mem0 = definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        historyDbPath: "/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_facility_memory"
        },
        worker: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model,
          thinkingLevel: "high",
          timeoutMs: 12_345
        },
        embedder: {
          provider: "sidecar",
          localBaseUrl: "http://127.0.0.1:18081",
          model: "jinaai/jina-embeddings-v5-text-small",
          embeddingDims: 3,
          timeoutMs: 1_000
        }
      }
    }
  }).memory.mem0;

  if (!mem0.enabled) {
    throw new Error("test config is disabled");
  }

  return mem0;
}

function runtime(overrides: Partial<Mem0OssRuntime> = {}): Mem0OssRuntime {
  return {
    add: vi.fn().mockResolvedValue({ results: [{ id: "mem0-1", memory: "facility fact" }] }),
    search: vi.fn().mockResolvedValue({
      results: [
        {
          id: "mem0-1",
          memory: "facility fact",
          score: 0.8,
          metadata: { category: "facility_knowledge" }
        }
      ]
    }),
    delete: vi.fn().mockResolvedValue({ message: "deleted" }),
    ...overrides
  };
}

describe("Mem0 OSS runtime client", () => {
  it("builds a local Qdrant and sidecar configuration from the Mem0-only config", () => {
    const config = buildMem0OssConfig(enabledConfig());

    expect(config).toMatchObject({
      historyDbPath: "/pico/mem0-history.sqlite",
      vectorStore: {
        provider: "qdrant",
        config: {
          url: "http://127.0.0.1:6333",
          collectionName: "pico_facility_memory",
          dimension: 3
        }
      },
      llm: { provider: "langchain" },
      embedder: { provider: "langchain", config: { embeddingDims: 3 } }
    });
  });

  it("passes an arbitrary configured model to the Pi model session unchanged", async () => {
    const model = "provider/new-arbitrary-model";
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session: PiAgentLlmSession = {
      subscribe(next) {
        listener = next;
        return () => undefined;
      },
      prompt: vi.fn(() => {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "ok" }
        } as AgentSessionEvent);
        return Promise.resolve();
      }),
      dispose: vi.fn()
    };
    const createPiAgentSession = vi.fn().mockResolvedValue(session);
    const config = buildMem0OssConfig(enabledConfig(model), { createPiAgentSession });
    const llm = (
      config.llm as {
        config: { model: { invoke: (messages: unknown[]) => Promise<{ content: string }> } };
      }
    ).config.model;

    await expect(llm.invoke([{ content: "extract" }])).resolves.toEqual({ content: "ok" });
    expect(createPiAgentSession).toHaveBeenCalledExactlyOnceWith({
      provider: "pi_model",
      piProvider: "openai-codex",
      api: "openai-codex-responses",
      model,
      thinkingLevel: "high",
      timeoutMs: 12_345
    });
  });

  it("forces exact-payload adds and forwards the requested search limit", async () => {
    const mem0 = runtime();
    const client = await createMem0OssClient(enabledConfig(), {
      createMemory: () => mem0
    });

    await client.add({
      messages: [{ role: "user", content: "facility fact" }],
      scopeId: "facility:pico",
      metadata: { category: "facility_knowledge" }
    });
    await expect(
      client.search({ query: "facility", scopeId: "facility:pico", limit: 4 })
    ).resolves.toEqual({
      memories: [
        {
          id: "mem0-1",
          content: "facility fact",
          score: 0.8,
          metadata: { category: "facility_knowledge" }
        }
      ]
    });

    expect(mem0.add).toHaveBeenCalledExactlyOnceWith([{ role: "user", content: "facility fact" }], {
      userId: "facility:pico",
      metadata: { category: "facility_knowledge", pico_scope_id: "facility:pico" },
      infer: false
    });
    expect(mem0.search).toHaveBeenCalledExactlyOnceWith("facility", {
      filters: { user_id: "facility:pico" },
      topK: 4
    });
  });

  it("maps sidecar embeddings and rejects a wrong configured dimension", async () => {
    const config = buildMem0OssConfig(enabledConfig(), {
      fetchEmbeddingSidecar: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    });
    const embedder = (
      config.embedder as {
        config: { model: { embedQuery: (text: string) => Promise<number[]> } };
      }
    ).config.model;

    await expect(embedder.embedQuery("facility")).rejects.toThrow(
      "dimension does not match configured embeddingDims"
    );
  });

  it("rejects disabled Mem0 config", () => {
    expect(() => buildMem0OssConfig(definePicoConfig({}).memory.mem0)).toThrow(
      "memory.mem0.enabled=true"
    );
  });
});
