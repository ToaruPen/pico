import { createRequire } from "node:module";

import type { MemoryConfig, Message, SearchResult } from "mem0ai/oss";

import type { PicoMem0Config } from "../../config/index.js";
import type { Mem0AddRequest, Mem0AddResponse, Mem0Client, Mem0SearchResponse } from "./mem0.js";

export type Mem0OssRuntime = {
  readonly add: (
    messages: string | Message[],
    options: {
      readonly userId: string;
      readonly metadata?: Record<string, unknown>;
      readonly infer?: boolean;
    }
  ) => Promise<SearchResult>;
  readonly search: (
    query: string,
    options: {
      readonly filters?: Record<string, unknown>;
      readonly topK?: number;
    }
  ) => Promise<SearchResult>;
  readonly delete: (memoryId: string) => Promise<{ readonly message: string }>;
};

export type Mem0OssClientFactoryOptions = {
  readonly createMemory?: (config: MemoryConfig) => Mem0OssRuntime;
};

type Mem0OssModule = {
  readonly Memory: {
    readonly fromConfig: (config: MemoryConfig) => Mem0OssRuntime;
  };
};

const require = createRequire(import.meta.url);

export function createMem0OssClient(
  config: PicoMem0Config,
  options: Mem0OssClientFactoryOptions = {}
): Mem0Client {
  const runtimeConfig = buildMem0OssConfig(config);
  disableMem0Telemetry();
  const memory = options.createMemory?.(runtimeConfig) ?? createDefaultMem0Runtime(runtimeConfig);

  return {
    async add(request) {
      const response = await memory.add(toMem0Messages(request), {
        userId: request.scopeId,
        metadata: {
          ...request.metadata,
          pico_scope_id: request.scopeId
        },
        infer: config.infer ?? true
      });

      return normalizeMem0AddResponse(response);
    },
    async search(request) {
      const response = await memory.search(request.query, {
        filters: {
          user_id: request.scopeId
        }
      });

      return normalizeMem0SearchResponse(response);
    },
    async delete(memoryId) {
      await memory.delete(memoryId);
    }
  };
}

function createDefaultMem0Runtime(config: MemoryConfig): Mem0OssRuntime {
  const { Memory } = require("mem0ai/oss") as Mem0OssModule;

  return Memory.fromConfig(config);
}

function disableMem0Telemetry(): void {
  process.env.MEM0_TELEMETRY = "false";
}

export function buildMem0OssConfig(config: PicoMem0Config): MemoryConfig {
  if (!config.enabled) {
    throw new Error("pico Mem0 runtime requires memory.mem0.enabled=true");
  }

  const vectorStore = requireMem0VectorStore(config);
  const llm = requireMem0Model(config.llm, "memory.mem0.llm");
  const embedder = requireMem0Model(config.embedder, "memory.mem0.embedder");
  const embeddingDims = config.embedder?.embeddingDims;

  return {
    historyDbPath: requireMem0Text(config.historyDbPath, "memory.mem0.historyDbPath"),
    vectorStore: {
      provider: "qdrant",
      config: {
        url: vectorStore.localBaseUrl,
        collectionName: vectorStore.collectionName,
        ...(embeddingDims === undefined ? {} : { dimension: embeddingDims })
      }
    },
    llm: {
      provider: "ollama",
      config: {
        url: llm.localBaseUrl,
        model: llm.model
      }
    },
    embedder: {
      provider: "ollama",
      config: {
        url: embedder.localBaseUrl,
        model: embedder.model,
        ...(embeddingDims === undefined ? {} : { embeddingDims })
      }
    }
  };
}

function toMem0Messages(request: Mem0AddRequest): Message[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function normalizeMem0AddResponse(response: SearchResult): Mem0AddResponse {
  return {
    memories: response.results.map((memory) => ({
      id: requireMem0Text(memory.id, "Mem0 memory id"),
      ...(typeof memory.memory === "string" ? { content: memory.memory } : {})
    }))
  };
}

function normalizeMem0SearchResponse(response: SearchResult): Mem0SearchResponse {
  return {
    memories: response.results.map((memory) => ({
      id: requireMem0Text(memory.id, "Mem0 memory id"),
      content: requireMem0Text(memory.memory, "Mem0 memory content"),
      ...(memory.score === undefined ? {} : { score: memory.score })
    }))
  };
}

function requireMem0VectorStore(
  config: PicoMem0Config
): NonNullable<PicoMem0Config["vectorStore"]> {
  if (config.vectorStore === undefined) {
    throw new Error("pico Mem0 runtime requires memory.mem0.vectorStore");
  }

  return config.vectorStore;
}

function requireMem0Model(
  config: PicoMem0Config["llm"],
  label: string
): NonNullable<PicoMem0Config["llm"]> {
  if (config === undefined) {
    throw new Error(`pico Mem0 runtime requires ${label}`);
  }

  return config;
}

function requireMem0Text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`pico Mem0 runtime requires ${label}`);
  }

  return value.trim();
}
