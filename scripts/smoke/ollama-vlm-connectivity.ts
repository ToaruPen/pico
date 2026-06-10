#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { defineSelectedModelEndpoint } from "../../src/modules/local-models/index.js";

const defaultEndpointId = "windows-ollama-qwen3-5";
const defaultTunnelKind = "tailscale_ssh";
const defaultSshTarget = "pico-vision-host";
const defaultTimeoutMs = 10_000;
const maxNodeTimeoutMs = 2_147_483_647;

export type OllamaVlmSmokeStatus = "passed" | "failed" | "skipped";

export type OllamaVlmSmokeReport = {
  readonly status: OllamaVlmSmokeStatus;
  readonly provider: "ollama";
  readonly reason?: string;
  readonly details?: {
    readonly endpointId: string;
    readonly model: "qwen3.5:9b";
    readonly checkedUrl: string;
    readonly modelCount: number;
  };
};

type OllamaVlmSmokePlan =
  | {
      readonly status: "run";
      readonly endpoint: ReturnType<typeof defineSelectedModelEndpoint>;
      readonly timeoutMs: number;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

type OllamaTagsResponse = {
  readonly models: readonly {
    readonly name: string;
  }[];
};

export async function runOllamaVlmConnectivitySmoke(
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch
): Promise<OllamaVlmSmokeReport> {
  const plan = buildOllamaVlmSmokePlan(env);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "ollama",
      reason: plan.reason
    };
  }

  const checkedUrl = new URL("/api/tags", plan.endpoint.host.tunnel.localBaseUrl).toString();
  const tags = await fetchOllamaTags(checkedUrl, plan.timeoutMs, fetchImplementation);
  const hasSelectedModel = tags.models.some((model) => model.name === plan.endpoint.model);

  if (!hasSelectedModel) {
    return {
      status: "failed",
      provider: "ollama",
      reason: `pico Ollama VLM smoke could not find ${plan.endpoint.model} in /api/tags`
    };
  }

  return {
    status: "passed",
    provider: "ollama",
    details: {
      endpointId: plan.endpoint.id,
      model: plan.endpoint.model,
      checkedUrl,
      modelCount: tags.models.length
    }
  };
}

export function buildOllamaVlmSmokePlan(env: NodeJS.ProcessEnv): OllamaVlmSmokePlan {
  const localBaseUrl = readEnvironment(env, "PICO_VISION_LOCAL_BASE_URL");

  if (localBaseUrl === undefined) {
    return {
      status: "skip",
      reason: "Set PICO_VISION_LOCAL_BASE_URL to run the Ollama VLM connectivity smoke."
    };
  }

  return {
    status: "run",
    endpoint: defineSelectedModelEndpoint({
      id: readEnvironment(env, "PICO_VISION_ENDPOINT_ID") ?? defaultEndpointId,
      provider: "ollama",
      model: "qwen3.5:9b",
      host: {
        platform: "windows",
        tunnel: {
          kind: readEnvironment(env, "PICO_VISION_TUNNEL_KIND") ?? defaultTunnelKind,
          localBaseUrl,
          sshTarget: readEnvironment(env, "PICO_VISION_SSH_TARGET") ?? defaultSshTarget
        }
      }
    }),
    timeoutMs: readPositiveIntegerEnvironment(env, "PICO_VISION_TIMEOUT_MS") ?? defaultTimeoutMs
  };
}

export function ollamaVlmSmokeExitCode(report: OllamaVlmSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

async function fetchOllamaTags(
  url: string,
  timeoutMs: number,
  fetchImplementation: typeof fetch
): Promise<OllamaTagsResponse> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`pico Ollama VLM smoke /api/tags failed with status ${response.status}`);
    }

    return parseOllamaTagsResponse((await response.json()) as unknown);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`pico Ollama VLM smoke timed out after ${timeoutMs} ms`, { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseOllamaTagsResponse(value: unknown): OllamaTagsResponse {
  const response = requireRecord(value, "pico Ollama VLM smoke /api/tags response is malformed");

  if (!Array.isArray(response.models)) {
    throw new Error("pico Ollama VLM smoke /api/tags response is malformed");
  }

  return {
    models: response.models.map(requireOllamaModelTag)
  };
}

function requireOllamaModelTag(value: unknown): { readonly name: string } {
  const model = requireRecord(value, "pico Ollama VLM smoke /api/tags response is malformed");

  if (typeof model.name !== "string" || model.name.trim() === "") {
    throw new Error("pico Ollama VLM smoke /api/tags response is malformed");
  }

  return {
    name: model.name
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function readEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === "" ? undefined : value;
}

function readPositiveIntegerEnvironment(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxNodeTimeoutMs) {
    throw new Error(`${name} must be a positive integer <= ${maxNodeTimeoutMs}`);
  }

  return parsed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runOllamaVlmConnectivitySmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = ollamaVlmSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
