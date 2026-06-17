#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";

export type EmbeddingSidecarSmokeReport =
  | {
      readonly status: "passed";
      readonly provider: "embedding-sidecar";
      readonly details: {
        readonly model: string;
        readonly embeddingCount: number;
        readonly embeddingDims: number;
      };
    }
  | {
      readonly status: "failed" | "skipped";
      readonly provider: "embedding-sidecar";
      readonly reason: string;
    };

export type EmbeddingSidecarSmokeDependencies = {
  readonly fetchEmbeddingSidecar?: typeof fetch;
  readonly loadConfig?: () => PicoConfig;
};

type Mem0EmbedderConfig = NonNullable<PicoConfig["memory"]["mem0"]["embedder"]>;
type SidecarEmbedderConfig = Mem0EmbedderConfig & { readonly provider: "sidecar" };

const provider = "embedding-sidecar" as const;
const skipReason =
  "Set memory.mem0.enabled=true and memory.mem0.embedder.provider=sidecar to run the embedding sidecar smoke.";
const defaultEmbeddingSidecarTimeoutMs = 30_000;
const probeTexts = Object.freeze([
  "雨の日は工作セットを早めに準備する。",
  "sports event after school"
]);

export async function runEmbeddingSidecarSmoke(
  config?: PicoConfig,
  dependencies: EmbeddingSidecarSmokeDependencies = {}
): Promise<EmbeddingSidecarSmokeReport> {
  try {
    return await runEmbeddingSidecarSmokeUnchecked(config, dependencies);
  } catch (error) {
    return {
      status: "failed",
      provider,
      reason: `pico embedding sidecar smoke failed: ${errorMessage(error)}`
    };
  }
}

async function runEmbeddingSidecarSmokeUnchecked(
  config: PicoConfig | undefined,
  dependencies: EmbeddingSidecarSmokeDependencies
): Promise<EmbeddingSidecarSmokeReport> {
  const resolvedConfig = config ?? dependencies.loadConfig?.() ?? loadPicoConfigFromEnvironment();
  const embedder = sidecarEmbedderConfig(resolvedConfig);

  if (embedder === undefined) {
    return skipped(skipReason);
  }

  const response = await requestEmbeddings(embedder, dependencies.fetchEmbeddingSidecar ?? fetch);
  const embeddings = readEmbeddingResponse(response, embedder.embeddingDims);

  return {
    status: "passed",
    provider,
    details: {
      model: embedder.model,
      embeddingCount: embeddings.length,
      embeddingDims: embeddings[0]?.length ?? 0
    }
  };
}

function sidecarEmbedderConfig(config: PicoConfig): SidecarEmbedderConfig | undefined {
  const embedder = config.memory.mem0.embedder;

  if (!config.memory.mem0.enabled || embedder?.provider !== "sidecar") {
    return undefined;
  }

  return {
    ...embedder,
    provider: "sidecar"
  };
}

async function requestEmbeddings(
  embedder: SidecarEmbedderConfig,
  fetchEmbeddingSidecar: typeof fetch
): Promise<unknown> {
  const timeoutMs = embedder.timeoutMs ?? defaultEmbeddingSidecarTimeoutMs;

  return withAbortTimeout(
    async (signal) => {
      const response = await fetchEmbeddingSidecar(
        new URL("/v1/embeddings", embedder.localBaseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: embedder.model,
            input: probeTexts
          }),
          signal
        }
      );

      if (!response.ok) {
        throw new Error(`sidecar returned HTTP ${response.status}`);
      }

      return response.json() as Promise<unknown>;
    },
    "embedding sidecar request",
    timeoutMs
  );
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
      throw new Error(`${label} timed out after ${String(timeoutMs)} ms`, {
        cause: error
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

function readEmbeddingResponse(value: unknown, embeddingDims: number | undefined): number[][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("sidecar response is malformed");
  }

  const data = (value as { readonly data?: unknown }).data;

  if (!Array.isArray(data) || data.length !== probeTexts.length) {
    throw new Error("sidecar response is malformed");
  }

  return data.map((item, index): number[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("sidecar response is malformed");
    }

    const embedding = (item as { readonly embedding?: unknown }).embedding;

    if (!Array.isArray(embedding)) {
      throw new Error("sidecar response is malformed");
    }

    const vector = embedding.map((dimension) => {
      if (typeof dimension !== "number" || !Number.isFinite(dimension)) {
        throw new Error("sidecar response is malformed");
      }

      return dimension;
    });

    if (embeddingDims !== undefined && vector.length !== embeddingDims) {
      throw new Error(
        `embedding ${String(index)} dimension ${String(vector.length)} does not match configured embeddingDims ${String(embeddingDims)}`
      );
    }

    return vector;
  });
}

function skipped(reason: string): EmbeddingSidecarSmokeReport {
  return {
    status: "skipped",
    provider,
    reason
  };
}

export function embeddingSidecarSmokeExitCode(report: EmbeddingSidecarSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runEmbeddingSidecarSmoke();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = embeddingSidecarSmokeExitCode(report);
}
