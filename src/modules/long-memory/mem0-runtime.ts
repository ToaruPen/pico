import { createRequire } from "node:module";

import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, Message, SearchResult } from "mem0ai/oss";

import type {
  PicoMem0Config,
  PicoMem0EmbedderConfig,
  PicoMem0LlmConfig,
  PicoMem0OllamaLlmConfig,
  PicoMem0PiModelLlmConfig
} from "../../config/index.js";
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
  readonly fetchEmbeddingSidecar?: typeof fetch;
  readonly fetchOllamaTags?: (localBaseUrl: string, signal: AbortSignal) => Promise<unknown>;
  readonly createPiAgentSession?: (config: PicoMem0PiModelLlmConfig) => Promise<PiAgentLlmSession>;
  readonly modelPreflightTimeoutMs?: number;
};

export type PiAgentLlmSession = {
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  readonly prompt: (text: string) => Promise<void>;
  readonly abort?: () => Promise<void>;
  readonly dispose: () => void;
};

type Mem0OssModule = {
  readonly Memory: {
    readonly fromConfig: (config: MemoryConfig) => Mem0OssRuntime;
  };
};

const require = createRequire(import.meta.url);
const defaultModelPreflightTimeoutMs = 10_000;
const defaultEmbeddingSidecarTimeoutMs = 30_000;
const defaultPiModelLlmTimeoutMs = 60_000;

export async function createMem0OssClient(
  config: PicoMem0Config,
  options: Mem0OssClientFactoryOptions = {}
): Promise<Mem0Client> {
  const runtimeConfig = buildMem0OssConfig(config, toMem0OssConfigOptions(options));
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

function toMem0OssConfigOptions(
  options: Mem0OssClientFactoryOptions
): Pick<Mem0OssClientFactoryOptions, "fetchEmbeddingSidecar" | "createPiAgentSession"> {
  return {
    ...(options.fetchEmbeddingSidecar === undefined
      ? {}
      : { fetchEmbeddingSidecar: options.fetchEmbeddingSidecar }),
    ...(options.createPiAgentSession === undefined
      ? {}
      : { createPiAgentSession: options.createPiAgentSession })
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
  const llm = requireMem0Llm(config.llm);
  const modelChecks: Promise<void>[] =
    llm.provider === "ollama" ? [assertLocalOllamaModelAvailable(llm, fetchTags, timeoutMs)] : [];
  const embedder = requireMem0Embedder(config.embedder);

  if (embedder.provider === "ollama") {
    modelChecks.push(assertLocalOllamaModelAvailable(embedder, fetchTags, timeoutMs));
  }

  await Promise.all(modelChecks);
}

async function assertLocalOllamaModelAvailable(
  config: PicoMem0OllamaLlmConfig | PicoMem0EmbedderConfig,
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

export function buildMem0OssConfig(
  config: PicoMem0Config,
  options: Pick<Mem0OssClientFactoryOptions, "fetchEmbeddingSidecar" | "createPiAgentSession"> = {}
): MemoryConfig {
  if (!config.enabled) {
    throw new Error("pico Mem0 runtime requires memory.mem0.enabled=true");
  }

  const vectorStore = requireMem0VectorStore(config);
  const llm = requireMem0Llm(config.llm);
  const embedder = requireMem0Embedder(config.embedder);
  const embeddingDims = embedder.embeddingDims;

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
    llm: toMem0LlmConfig(llm, options.createPiAgentSession),
    embedder: toMem0EmbedderConfig(embedder, options.fetchEmbeddingSidecar)
  };
}

function toMem0LlmConfig(
  llm: PicoMem0LlmConfig,
  createPiAgentSession: Mem0OssClientFactoryOptions["createPiAgentSession"]
): MemoryConfig["llm"] {
  if (llm.provider === "ollama") {
    return {
      provider: "ollama",
      config: {
        url: llm.localBaseUrl,
        model: llm.model
      }
    };
  }

  return {
    provider: "langchain",
    config: {
      model: createPiAgentLlm(llm, createPiAgentSession ?? createDefaultPiAgentSession)
    }
  };
}

type LangchainCompatibleLlm = {
  readonly model: string;
  readonly provider: string;
  readonly api: string;
  readonly invoke: (messages: readonly { readonly content?: unknown }[]) => Promise<{
    readonly content: string;
  }>;
};

function createPiAgentLlm(
  config: PicoMem0PiModelLlmConfig,
  createSession: (config: PicoMem0PiModelLlmConfig) => Promise<PiAgentLlmSession>
): LangchainCompatibleLlm {
  const timeoutMs = config.timeoutMs ?? defaultPiModelLlmTimeoutMs;

  return Object.freeze({
    model: config.model,
    provider: config.piProvider,
    api: config.api,
    async invoke(messages) {
      const session = await createSession(config);
      const chunks: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          chunks.push(event.assistantMessageEvent.delta);
        }
      });

      try {
        await withAbortTimeout(
          async (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                session.abort?.().catch(() => undefined);
              },
              { once: true }
            );
            await session.prompt(serializeLangchainMessages(messages));
          },
          `Pi Agent ${config.piProvider}/${config.model} LLM request`,
          timeoutMs
        );

        return { content: chunks.join("") };
      } finally {
        unsubscribe();
        session.dispose();
      }
    }
  });
}

async function createDefaultPiAgentSession(
  config: PicoMem0PiModelLlmConfig
): Promise<PiAgentLlmSession> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(config.piProvider, config.model);

  if (model === undefined) {
    throw new Error(
      `pico Mem0 runtime requires Pi Agent model ${config.piProvider}/${config.model} to be available`
    );
  }

  if (model.api !== config.api) {
    throw new Error(
      `pico Mem0 runtime requires Pi Agent model ${config.piProvider}/${config.model} to use ${config.api}`
    );
  }

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    noTools: "all",
    resourceLoader: createMinimalPiResourceLoader(),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: false
      },
      retry: {
        provider: {
          timeoutMs: config.timeoutMs ?? defaultPiModelLlmTimeoutMs,
          maxRetries: 0
        }
      },
      httpIdleTimeoutMs: config.timeoutMs ?? defaultPiModelLlmTimeoutMs
    })
  });

  return session;
}

function createMinimalPiResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: () => Promise.resolve()
  };
}

function serializeLangchainMessages(messages: readonly { readonly content?: unknown }[]): string {
  return messages
    .map((message) => langchainContentToText(message.content).trim())
    .filter((content) => content !== "")
    .join("\n\n");
}

function langchainContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(langchainContentToText).join("");
  }

  if (typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { readonly text?: unknown }).text;

    return typeof text === "string" ? text : "";
  }

  return "";
}

function toMem0EmbedderConfig(
  embedder: PicoMem0EmbedderConfig,
  fetchEmbeddingSidecar: typeof fetch | undefined
): MemoryConfig["embedder"] {
  if (embedder.provider === "ollama") {
    return {
      provider: "ollama",
      config: {
        url: embedder.localBaseUrl,
        model: embedder.model,
        ...(embedder.embeddingDims === undefined ? {} : { embeddingDims: embedder.embeddingDims })
      }
    };
  }

  return {
    provider: "langchain",
    config: {
      model: createEmbeddingSidecar(embedder, fetchEmbeddingSidecar ?? fetch),
      ...(embedder.embeddingDims === undefined ? {} : { embeddingDims: embedder.embeddingDims })
    }
  };
}

type LangchainCompatibleEmbedder = {
  readonly model: string;
  readonly baseUrl: string;
  readonly embedQuery: (text: string) => Promise<number[]>;
  readonly embedDocuments: (texts: string[]) => Promise<number[][]>;
};

function createEmbeddingSidecar(
  config: PicoMem0EmbedderConfig,
  fetchEmbeddingSidecar: typeof fetch
): LangchainCompatibleEmbedder {
  const endpoint = new URL("/v1/embeddings", config.localBaseUrl);
  const timeoutMs = config.timeoutMs ?? defaultEmbeddingSidecarTimeoutMs;

  return Object.freeze({
    model: config.model,
    baseUrl: config.localBaseUrl,
    async embedQuery(text) {
      const embeddings = await requestEmbeddingSidecar(
        endpoint,
        config.model,
        [text],
        fetchEmbeddingSidecar,
        timeoutMs,
        config.embeddingDims
      );
      const embedding = embeddings[0];

      if (embedding === undefined) {
        throw new Error("pico Mem0 embedding sidecar response is malformed");
      }

      return embedding;
    },
    embedDocuments(texts) {
      return requestEmbeddingSidecar(
        endpoint,
        config.model,
        texts,
        fetchEmbeddingSidecar,
        timeoutMs,
        config.embeddingDims
      );
    }
  });
}

async function requestEmbeddingSidecar(
  endpoint: URL,
  model: string,
  input: readonly string[],
  fetchEmbeddingSidecar: typeof fetch,
  timeoutMs: number,
  embeddingDims: number | undefined
): Promise<number[][]> {
  const responseJson = await withAbortTimeout(
    async (signal) => {
      const response = await fetchEmbeddingSidecar(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input
        }),
        signal
      });

      if (!response.ok) {
        throw new Error(`pico Mem0 embedding sidecar request failed: ${response.status}`);
      }

      try {
        return (await response.json()) as unknown;
      } catch (error) {
        throw new Error("pico Mem0 embedding sidecar response is malformed", {
          cause: error
        });
      }
    },
    "embedding sidecar request",
    timeoutMs
  );

  return readEmbeddingSidecarResponse(responseJson, input.length, embeddingDims);
}

function readEmbeddingSidecarResponse(
  value: unknown,
  expectedCount: number,
  embeddingDims: number | undefined
): number[][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico Mem0 embedding sidecar response is malformed");
  }

  const data = (value as { readonly data?: unknown }).data;

  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error("pico Mem0 embedding sidecar response is malformed");
  }

  return data.map((item): number[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("pico Mem0 embedding sidecar response is malformed");
    }

    const embedding = (item as { readonly embedding?: unknown }).embedding;

    if (!Array.isArray(embedding)) {
      throw new Error("pico Mem0 embedding sidecar response is malformed");
    }

    const vector = embedding.map((dimension) => {
      if (typeof dimension !== "number" || !Number.isFinite(dimension)) {
        throw new Error("pico Mem0 embedding sidecar response is malformed");
      }

      return dimension;
    });

    if (embeddingDims !== undefined && vector.length !== embeddingDims) {
      throw new Error(
        "pico Mem0 embedding sidecar response dimension does not match configured embeddingDims"
      );
    }

    return vector;
  });
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

function requireMem0Llm(config: PicoMem0Config["llm"]): PicoMem0LlmConfig {
  if (config === undefined) {
    throw new Error("pico Mem0 runtime requires memory.mem0.llm");
  }

  return config;
}

function requireMem0Embedder(config: PicoMem0Config["embedder"]): PicoMem0EmbedderConfig {
  if (config === undefined) {
    throw new Error("pico Mem0 runtime requires memory.mem0.embedder");
  }

  return config;
}

function requireMem0Text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`pico Mem0 runtime requires ${label}`);
  }

  return value.trim();
}
