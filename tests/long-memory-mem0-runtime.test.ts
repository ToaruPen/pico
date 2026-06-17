import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { definePicoConfig } from "../src/config/index.js";
import type { buildMem0OssConfig } from "../src/modules/long-memory/mem0-runtime.js";
import { createMem0OssClient } from "../src/modules/long-memory/mem0-runtime.js";

type CapturedMem0Config = ReturnType<typeof buildMem0OssConfig>;
type CapturedSidecarEmbedder = {
  readonly model: string;
  readonly baseUrl: string;
  readonly embedQuery: (text: string) => Promise<number[]>;
  readonly embedDocuments: (texts: readonly string[]) => Promise<number[][]>;
};
type CapturedPiModelLlm = {
  readonly model: string;
  readonly provider: string;
  readonly api: string;
  readonly invoke: (messages: readonly { readonly content?: unknown }[]) => Promise<{
    readonly content: string;
  }>;
};

function requireCapturedSidecarEmbedder(
  config: CapturedMem0Config | undefined
): CapturedSidecarEmbedder {
  const model: unknown = config?.embedder.config.model;

  if (typeof model !== "object" || model === null) {
    throw new Error("expected captured sidecar embedder");
  }

  return model as CapturedSidecarEmbedder;
}

function requireCapturedPiModelLlm(config: CapturedMem0Config | undefined): CapturedPiModelLlm {
  const model: unknown = config?.llm.config.model;

  if (typeof model !== "object" || model === null) {
    throw new Error("expected captured Pi model LLM");
  }

  return model as CapturedPiModelLlm;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof input === "string") {
    return input;
  }

  return input.url;
}

function mem0EnabledConfig() {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        infer: false,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory"
        },
        llm: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        },
        embedder: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    }
  }).memory.mem0;
}

function mem0EnabledConfigWithoutInfer() {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory"
        },
        llm: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        },
        embedder: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    }
  }).memory.mem0;
}

function mem0SidecarEmbedderConfig(embeddingDims = 1024) {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        infer: false,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory"
        },
        llm: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        },
        embedder: {
          provider: "sidecar",
          localBaseUrl: "http://127.0.0.1:18081",
          model: "jinaai/jina-embeddings-v5-text-small",
          embeddingDims,
          timeoutMs: 25
        }
      }
    }
  }).memory.mem0;
}

function mem0PiModelLlmConfig() {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        infer: false,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory_jina_v5_small_1024_v1"
        },
        llm: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          timeoutMs: 25
        },
        embedder: {
          provider: "sidecar",
          localBaseUrl: "http://127.0.0.1:18081",
          model: "jinaai/jina-embeddings-v5-text-small",
          embeddingDims: 1024,
          timeoutMs: 25
        }
      }
    }
  }).memory.mem0;
}

function mem0PiModelLlmWithOllamaEmbedderConfig() {
  return definePicoConfig({
    memory: {
      mem0: {
        enabled: true,
        infer: false,
        historyDbPath: "/var/lib/pico/mem0-history.sqlite",
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory"
        },
        llm: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4"
        },
        embedder: {
          provider: "ollama",
          localBaseUrl: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    }
  }).memory.mem0;
}

describe("Mem0 OSS runtime client", () => {
  it("disables Mem0 OSS telemetry before constructing the runtime", async () => {
    const previousTelemetry = process.env.MEM0_TELEMETRY;
    delete process.env.MEM0_TELEMETRY;

    try {
      await createMem0OssClient(mem0EnabledConfig(), {
        createMemory: () => {
          expect(process.env.MEM0_TELEMETRY).toBe("false");

          return {
            add: () => Promise.resolve({ results: [] }),
            search: () => Promise.resolve({ results: [] }),
            delete: () => Promise.resolve({ message: "deleted" })
          };
        }
      });
    } finally {
      if (previousTelemetry === undefined) {
        delete process.env.MEM0_TELEMETRY;
      } else {
        process.env.MEM0_TELEMETRY = previousTelemetry;
      }
    }
  });

  it("builds a local-only Mem0 OSS configuration from pico config", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    const client = await createMem0OssClient(mem0EnabledConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      }
    });

    await client.add({
      messages: [{ role: "user", content: "雨の日は工作セットを早めに出す。" }],
      scopeId: "pico-facility",
      metadata: {
        source_session_id: "session-1",
        source_entry_ids: ["entry-1"],
        cutoff_at: "2026-06-10T18:30:00.000Z",
        requested_by: "pico"
      }
    });

    expect(capturedConfig).toMatchObject({
      historyDbPath: "/var/lib/pico/mem0-history.sqlite",
      vectorStore: {
        provider: "qdrant",
        config: {
          url: "http://127.0.0.1:6333",
          collectionName: "pico_long_memory",
          dimension: 768
        }
      },
      llm: {
        provider: "ollama",
        config: {
          url: "http://127.0.0.1:11434",
          model: "qwen3.5:9b"
        }
      },
      embedder: {
        provider: "ollama",
        config: {
          url: "http://127.0.0.1:11434",
          model: "nomic-embed-text",
          embeddingDims: 768
        }
      }
    });
    expect(JSON.stringify(capturedConfig)).not.toContain("openai");
  });

  it("maps the Jina sidecar embedder to a Langchain-compatible Mem0 embedder", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    const requests: unknown[] = [];
    await createMem0OssClient(mem0SidecarEmbedderConfig(3), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      },
      fetchEmbeddingSidecar: (url, init) => {
        requests.push({
          url: requestUrl(url),
          body: init?.body
        });

        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        );
      }
    });

    const embedder = requireCapturedSidecarEmbedder(capturedConfig);

    expect(capturedConfig).toMatchObject({
      vectorStore: {
        config: {
          dimension: 3
        }
      },
      embedder: {
        provider: "langchain",
        config: {
          embeddingDims: 3
        }
      }
    });
    expect(embedder).toMatchObject({
      model: "jinaai/jina-embeddings-v5-text-small",
      baseUrl: "http://127.0.0.1:18081"
    });
    await expect(embedder.embedDocuments(["雨の日", "sports event"])).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ]);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18081/v1/embeddings",
        body: JSON.stringify({
          model: "jinaai/jina-embeddings-v5-text-small",
          input: ["雨の日", "sports event"]
        })
      }
    ]);
  });

  it("preflights only Ollama models when the embedder is served by a sidecar", async () => {
    const fetchedBaseUrls: string[] = [];
    await expect(
      createMem0OssClient(mem0SidecarEmbedderConfig(), {
        fetchOllamaTags: (localBaseUrl) => {
          fetchedBaseUrls.push(localBaseUrl);

          return Promise.resolve({
            models: []
          });
        }
      })
    ).rejects.toThrow(
      "pico Mem0 runtime requires local Ollama model qwen3.5:9b to be available before Mem0 startup"
    );

    expect(fetchedBaseUrls).toEqual(["http://127.0.0.1:11434"]);
  });

  it("maps the Pi Agent Codex Responses LLM to a Langchain-compatible Mem0 LLM", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    const prompts: string[] = [];
    await createMem0OssClient(mem0PiModelLlmConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      },
      createPiAgentSession: () =>
        Promise.resolve({
          subscribe: () => {
            return () => undefined;
          },
          prompt: (text) => {
            prompts.push(text);

            return Promise.resolve();
          },
          dispose: () => undefined
        })
    });

    const llm = requireCapturedPiModelLlm(capturedConfig);

    expect(capturedConfig).toMatchObject({
      llm: {
        provider: "langchain"
      }
    });
    expect(llm).toMatchObject({
      model: "gpt-5.4",
      provider: "openai-codex",
      api: "openai-codex-responses"
    });
    await expect(llm.invoke([{ content: "記憶を整理してください。" }])).resolves.toEqual({
      content: ""
    });
    expect(prompts).toEqual(["記憶を整理してください。"]);
  });

  it("collects streamed Pi Agent text deltas into the Mem0 LLM response", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    await createMem0OssClient(mem0PiModelLlmConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      },
      createPiAgentSession: () => {
        let listener: ((event: AgentSessionEvent) => void) | undefined;

        return Promise.resolve({
          subscribe: (nextListener) => {
            listener = nextListener;

            return () => undefined;
          },
          prompt: () => {
            listener?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "工作"
              }
            } as AgentSessionEvent);
            listener?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "セット"
              }
            } as AgentSessionEvent);

            return Promise.resolve();
          },
          dispose: () => undefined
        });
      }
    });

    const llm = requireCapturedPiModelLlm(capturedConfig);

    await expect(llm.invoke([{ content: "記憶を整理してください。" }])).resolves.toEqual({
      content: "工作セット"
    });
  });

  it("preflights only Ollama embedders when the LLM is served by Pi Agent", async () => {
    const fetchedBaseUrls: string[] = [];
    await expect(
      createMem0OssClient(mem0PiModelLlmWithOllamaEmbedderConfig(), {
        fetchOllamaTags: (localBaseUrl) => {
          fetchedBaseUrls.push(localBaseUrl);

          return Promise.resolve({
            models: []
          });
        }
      })
    ).rejects.toThrow(
      "pico Mem0 runtime requires local Ollama model nomic-embed-text to be available before Mem0 startup"
    );

    expect(fetchedBaseUrls).toEqual(["http://127.0.0.1:11434"]);
  });

  it("rejects malformed embedding sidecar responses", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    await createMem0OssClient(mem0SidecarEmbedderConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      },
      fetchEmbeddingSidecar: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: ["not-a-number"] }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
    });

    const embedder = requireCapturedSidecarEmbedder(capturedConfig);

    await expect(embedder.embedQuery("雨の日")).rejects.toThrow(
      "pico Mem0 embedding sidecar response is malformed"
    );
  });

  it("rejects embedding sidecar responses with the wrong vector dimension", async () => {
    let capturedConfig: CapturedMem0Config | undefined;
    await createMem0OssClient(mem0SidecarEmbedderConfig(), {
      createMemory: (config) => {
        capturedConfig = config;

        return {
          add: () => Promise.resolve({ results: [] }),
          search: () => Promise.resolve({ results: [] }),
          delete: () => Promise.resolve({ message: "deleted" })
        };
      },
      fetchEmbeddingSidecar: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
    });

    const embedder = requireCapturedSidecarEmbedder(capturedConfig);

    await expect(embedder.embedQuery("雨の日")).rejects.toThrow(
      "pico Mem0 embedding sidecar response dimension does not match configured embeddingDims"
    );
  });

  it("times out embedding sidecar requests explicitly", async () => {
    vi.useFakeTimers();

    try {
      let capturedConfig: CapturedMem0Config | undefined;
      await createMem0OssClient(mem0SidecarEmbedderConfig(), {
        createMemory: (config) => {
          capturedConfig = config;

          return {
            add: () => Promise.resolve({ results: [] }),
            search: () => Promise.resolve({ results: [] }),
            delete: () => Promise.resolve({ message: "deleted" })
          };
        },
        fetchEmbeddingSidecar: () =>
          Promise.resolve({
            ok: true,
            json: () => new Promise<unknown>(() => undefined)
          } as Response)
      });

      const embedder = requireCapturedSidecarEmbedder(capturedConfig);
      const request = embedder.embedQuery("雨の日");
      const expectedRejection = expect(request).rejects.toThrow(
        "pico Mem0 runtime embedding sidecar request timed out after 25 ms"
      );

      await vi.advanceTimersByTimeAsync(25);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("adapts add, search, and delete to the existing Mem0 client contract", async () => {
    const calls: string[] = [];
    const client = await createMem0OssClient(mem0EnabledConfig(), {
      createMemory: () => ({
        add: (messages, options) => {
          const sourceSessionId = options.metadata?.source_session_id;

          if (typeof sourceSessionId !== "string") {
            throw new Error("expected source session id metadata");
          }
          calls.push(`add:${options.userId}:${sourceSessionId}:${String(options.infer)}`);
          expect(messages).toEqual([{ role: "user", content: "工作セットを準備する。" }]);

          return Promise.resolve({
            results: [
              {
                id: "mem0-1",
                memory: "工作セットを準備する。"
              }
            ]
          });
        },
        search: (query, options) => {
          const userId = options.filters?.user_id;

          if (typeof userId !== "string") {
            throw new Error("expected Mem0 search user_id filter");
          }
          calls.push(`search:${query}:${userId}`);

          return Promise.resolve({
            results: [
              {
                id: "mem0-1",
                memory: "工作セットを準備する。",
                score: 0.92
              }
            ]
          });
        },
        delete: (memoryId) => {
          calls.push(`delete:${memoryId}`);

          return Promise.resolve({ message: "deleted" });
        }
      })
    });

    await expect(
      client.add({
        messages: [{ role: "user", content: "工作セットを準備する。" }],
        scopeId: "pico-facility",
        metadata: {
          source_session_id: "session-1",
          source_entry_ids: ["entry-1"],
          cutoff_at: "2026-06-10T18:30:00.000Z",
          requested_by: "pico"
        }
      })
    ).resolves.toEqual({
      memories: [
        {
          id: "mem0-1",
          content: "工作セットを準備する。"
        }
      ]
    });
    await expect(
      client.search({
        query: "工作",
        scopeId: "pico-facility"
      })
    ).resolves.toEqual({
      memories: [
        {
          id: "mem0-1",
          content: "工作セットを準備する。",
          score: 0.92
        }
      ]
    });
    await client.delete("mem0-1");

    expect(calls).toEqual([
      "add:pico-facility:session-1:false",
      "search:工作:pico-facility",
      "delete:mem0-1"
    ]);
  });

  it("defaults Mem0 inference to false when config does not opt in", async () => {
    const calls: string[] = [];
    const client = await createMem0OssClient(mem0EnabledConfigWithoutInfer(), {
      createMemory: () => ({
        add: (_messages, options) => {
          calls.push(`infer:${String(options.infer)}`);

          return Promise.resolve({
            results: [{ id: "mem0-1", memory: "工作セットを準備する。" }]
          });
        },
        search: () => Promise.resolve({ results: [] }),
        delete: () => Promise.resolve({ message: "deleted" })
      })
    });

    await client.add({
      messages: [{ role: "user", content: "工作セットを準備する。" }],
      scopeId: "pico-facility",
      metadata: {
        source_session_id: "session-1",
        source_entry_ids: ["entry-1"],
        cutoff_at: "2026-06-10T18:30:00.000Z",
        requested_by: "pico"
      }
    });

    expect(calls).toEqual(["infer:false"]);
  });

  it("rejects missing local Ollama models before constructing the default runtime", async () => {
    await expect(
      createMem0OssClient(mem0EnabledConfig(), {
        fetchOllamaTags: () =>
          Promise.resolve({
            models: [{ name: "qwen3.5:9b" }]
          })
      })
    ).rejects.toThrow(
      "pico Mem0 runtime requires local Ollama model nomic-embed-text to be available before Mem0 startup"
    );
  });

  it("times out local Ollama model preflight when the model endpoint does not settle", async () => {
    vi.useFakeTimers();

    try {
      const client = createMem0OssClient(mem0EnabledConfig(), {
        fetchOllamaTags: () => new Promise<unknown>(() => undefined),
        modelPreflightTimeoutMs: 25
      });
      const expectedRejection = expect(client).rejects.toThrow(
        "pico Mem0 runtime Ollama model list for qwen3.5:9b timed out after 25 ms"
      );

      await vi.advanceTimersByTimeAsync(25);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects disabled Mem0 config before constructing a runtime client", async () => {
    await expect(
      createMem0OssClient(definePicoConfig({}).memory.mem0, {
        createMemory: () => {
          throw new Error("should not construct Mem0");
        }
      })
    ).rejects.toThrow("pico Mem0 runtime requires memory.mem0.enabled=true");
  });
});
