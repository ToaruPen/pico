#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import {
  loadPicoConfigFromEnvironment,
  type PicoConfig,
  type PicoOllamaConfig
} from "../../src/config/index.js";
import { defineSelectedModelEndpoint } from "../../src/modules/local-models/index.js";
import { preflightProtectedOllamaEndpoint } from "../../src/modules/transport/index.js";

const defaultEndpointId = "windows-ollama-qwen3-5";
const defaultTunnelKind = "tailscale_ssh";
const defaultSshTarget = "pico-vision-host";
const defaultTimeoutMs = 10_000;

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

export async function runOllamaVlmConnectivitySmoke(
  config: PicoConfig = loadPicoConfigFromEnvironment(),
  fetchImplementation: typeof fetch = fetch
): Promise<OllamaVlmSmokeReport> {
  const plan = buildOllamaVlmSmokePlan(config);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "ollama",
      reason: plan.reason
    };
  }

  const preflight = await preflightProtectedOllamaEndpoint(plan.endpoint, {
    timeoutMs: plan.timeoutMs,
    fetchTags: (url, signal, headers) =>
      fetchImplementation(url, {
        method: "GET",
        headers,
        signal
      })
  });

  if (preflight.status === "failed") {
    return {
      status: "failed",
      provider: "ollama",
      reason: preflight.reason
    };
  }

  return {
    status: "passed",
    provider: "ollama",
    details: {
      endpointId: preflight.endpointId,
      model: preflight.model,
      checkedUrl: preflight.checkedUrl,
      modelCount: preflight.modelCount
    }
  };
}

export function buildOllamaVlmSmokePlan(config: PicoConfig): OllamaVlmSmokePlan {
  const ollama = config.vision.ollama;

  if (ollama === undefined) {
    return {
      status: "skip",
      reason: "Set vision.ollama in pico config to run the Ollama VLM connectivity smoke."
    };
  }

  return {
    status: "run",
    endpoint: defineSelectedModelEndpoint({
      id: ollama.endpointId ?? defaultEndpointId,
      provider: "ollama",
      model: "qwen3.5:9b",
      host: {
        platform: "windows",
        tunnel: {
          kind: ollama.tunnel?.kind ?? defaultTunnelKind,
          localBaseUrl: ollama.localBaseUrl,
          sshTarget: ollama.tunnel?.sshTarget ?? defaultSshTarget
        },
        ...defineOllamaEndpointAuth(ollama.auth)
      }
    }),
    timeoutMs: ollama.timeoutMs ?? defaultTimeoutMs
  };
}

function defineOllamaEndpointAuth(auth: PicoOllamaConfig["auth"]): {
  readonly auth?: NonNullable<PicoOllamaConfig["auth"]>;
} {
  if (auth === undefined) {
    return {};
  }

  return {
    auth: {
      ...(auth.headerName === undefined ? {} : { headerName: auth.headerName }),
      apiKey: auth.apiKey
    }
  };
}

export function ollamaVlmSmokeExitCode(report: OllamaVlmSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
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
