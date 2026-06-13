import { createRequire } from "node:module";

import type { MemoryConfig, Message, SearchResult } from "mem0ai/oss";

import type { PicoMem0Config, PicoMem0ModelConfig } from "../../config/index.js";
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
  readonly fetchOllamaTags?: (localBaseUrl: string, signal: AbortSignal) => Promise<unknown>;
  readonly modelPreflightTimeoutMs?: number;
};

type Mem0OssModule = {
  readonly Memory: {
    readonly fromConfig: (config: MemoryConfig) => Mem0OssRuntime;
  };
};

const require = createRequire(import.meta.url);
const defaultModelPreflightTimeoutMs = 10_000;

export async function createMem0OssClient(
  config: PicoMem0Config,
  options: Mem0OssClientFactoryOptions = {}
): Promise<Mem0Client> {
  const runtimeConfig = buildMem0OssConfig(config);
  disableMem0Telemetry();

  if (options.createMemory === undefined) {
    await assertLocalOllamaModelsAvailable(
      config,
      options.fetchOllamaTags ?? fetchOllamaTags,
      options.modelPreflightTimeoutMs ?? defaultModelPreflightTimeoutMs
    );
  }

  const memory = options.createMemory?.(runtimeConfig) ?? createDefaultMem0Runtime(runtimeConfig);

  return {
    async add(request) {
      const response = await memory.add(toMem0Messages(request), {
        userId: request.scopeId,
        metadata: {
          ...request.metadata,
          pico_scope_id: request.scopeId
        },
        infer: config.infer ?? false
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

async function assertLocalOllamaModelsAvailable(
  config: PicoMem0Config,
  fetchTags: (localBaseUrl: string, signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  await assertLocalOllamaModelAvailable(
    requireMem0Model(config.llm, "memory.mem0.llm"),
    fetchTags,
    timeoutMs
  );
  await assertLocalOllamaModelAvailable(
    requireMem0Model(config.embedder, "memory.mem0.embedder"),
    fetchTags,
    timeoutMs
  );
}

async function assertLocalOllamaModelAvailable(
  config: PicoMem0ModelConfig,
  fetchTags: (localBaseUrl: string, signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  const tags = await withAbortTimeout(
    (signal) => fetchTags(config.localBaseUrl, signal),
    `Ollama model list for ${config.model}`,
    timeoutMs
  );
  const models = readOllamaModelNames(tags);
  const expected = normalizeOllamaModelName(config.model);

  if (!models.some((model) => normalizeOllamaModelName(model) === expected)) {
    throw new Error(
      `pico Mem0 runtime requires local Ollama model ${config.model} to be available before Mem0 startup`
    );
  }
}

async function fetchOllamaTags(localBaseUrl: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL("/api/tags", localBaseUrl), { signal });

  if (!response.ok) {
    throw new Error(`pico Mem0 runtime failed to list local Ollama models: ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number
): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    return await rejectOnAbort(operation(abortController.signal), abortController.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`pico Mem0 runtime ${label} timed out after ${timeoutMs} ms`, {
        cause: error
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rejectOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(createAbortError());
    };

    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";

  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readOllamaModelNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico Mem0 runtime received malformed Ollama model list");
  }

  const models = (value as { readonly models?: unknown }).models;

  if (!Array.isArray(models)) {
    throw new Error("pico Mem0 runtime received malformed Ollama model list");
  }

  return models.map((model) => {
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
      throw new Error("pico Mem0 runtime received malformed Ollama model list");
    }

    return requireMem0Text((model as { readonly name?: unknown }).name, "Ollama model name");
  });
}

function normalizeOllamaModelName(value: string): string {
  return value.includes(":") ? value : `${value}:latest`;
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
