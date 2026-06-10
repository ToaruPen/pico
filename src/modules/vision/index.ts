import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";
import type { SelectedModelEndpointConfig } from "../local-models/index.js";

export const visionModuleMetadata = {
  kind: "vision",
  status: "planned",
  summary: "Bounded scene understanding through Qwen/Qwen3.5-9B on a protected Windows GPU host.",
  selectedProvider:
    "Qwen/Qwen3.5-9B via Ollama qwen3.5:9b over a Tailscale or Cloudflare-protected SSH tunnel",
  capabilities: [
    {
      id: "vision.describe_scene",
      description: "Return bounded scene summaries as structured text or JSON."
    }
  ]
} as const satisfies FuturePicoModuleMetadata;

const BOUNDED_SCENE_PROMPT =
  "Describe this after-school care scene as bounded JSON. Do not identify children, infer private traits, diagnose, score, or make final safety decisions. Include only visible scene details, uncertainty, and items a human staff member may need to check.";

const OLLAMA_REQUEST_TIMEOUT_MS = 30_000;

const SCENE_DESCRIPTION_FORMAT = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "observedPeople", "environment", "humanAttention", "uncertainty"],
  properties: {
    summary: { type: "string" },
    observedPeople: { type: "array", items: { type: "string" } },
    environment: { type: "array", items: { type: "string" } },
    humanAttention: { type: "array", items: { type: "string" } },
    uncertainty: { type: "array", items: { type: "string" } }
  }
} as const;

export type SceneDescriptionRequest = {
  readonly endpoint: SelectedModelEndpointConfig;
  readonly image: Uint8Array;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly purpose: "motion_followup" | "staff_requested_snapshot";
};

export type SceneDescription = {
  readonly summary: string;
  readonly observedPeople: readonly string[];
  readonly environment: readonly string[];
  readonly humanAttention: readonly string[];
  readonly uncertainty: readonly string[];
  readonly source: {
    readonly endpointId: string;
    readonly model: "qwen3.5:9b";
    readonly purpose: SceneDescriptionRequest["purpose"];
  };
};

export type SceneDescriptionClient = {
  readonly describeScene: (request: SceneDescriptionRequest) => Promise<SceneDescription>;
};

type ParsedSceneDescription = Omit<SceneDescription, "source">;

export function createOllamaSceneDescriptionClient(
  fetchImplementation: typeof fetch = fetch
): SceneDescriptionClient {
  return {
    describeScene(request) {
      return describeScene(request, fetchImplementation);
    }
  };
}

export async function describeScene(
  request: SceneDescriptionRequest,
  fetchImplementation: typeof fetch = fetch
): Promise<SceneDescription> {
  const responsePayload = await postOllamaSceneRequest(request, fetchImplementation);
  const scene = parseOllamaSceneDescriptionResponse(responsePayload);

  return {
    ...scene,
    source: {
      endpointId: request.endpoint.id,
      model: request.endpoint.model,
      purpose: request.purpose
    }
  };
}

async function postOllamaSceneRequest(
  request: SceneDescriptionRequest,
  fetchImplementation: typeof fetch
): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, OLLAMA_REQUEST_TIMEOUT_MS);

  const response = await fetchImplementation(buildOllamaChatUrl(request.endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(buildOllamaSceneRequestBody(request)),
    signal: abortController.signal
  })
    .catch((error: unknown) => {
      if (isAbortError(error)) {
        throw new Error("pico vision Ollama request timed out");
      }

      throw error;
    })
    .finally(() => {
      clearTimeout(timeout);
    });

  if (!response.ok) {
    throw new Error(`pico vision Ollama request failed with status ${response.status}`);
  }

  return (await response.json()) as unknown;
}

function buildOllamaSceneRequestBody(request: SceneDescriptionRequest): Record<string, unknown> {
  return {
    model: request.endpoint.model,
    messages: [
      {
        role: "user",
        content: BOUNDED_SCENE_PROMPT,
        images: [Buffer.from(request.image).toString("base64")]
      }
    ],
    stream: false,
    think: false,
    format: SCENE_DESCRIPTION_FORMAT,
    options: {
      temperature: 0.2,
      num_predict: 256
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function parseOllamaSceneDescriptionResponse(
  responsePayload: unknown
): ParsedSceneDescription {
  const response = requireRecord(responsePayload);
  const message = requireRecord(response.message);
  const content = requireContent(message.content);
  const parsedContent = parseSceneContent(content);

  return requireSceneDescription(parsedContent);
}

function buildOllamaChatUrl(endpoint: SelectedModelEndpointConfig): string {
  return `${endpoint.host.tunnel.localBaseUrl}/api/chat`;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico vision scene response is malformed");
  }

  return value as Record<string, unknown>;
}

function requireContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico vision scene response is malformed");
  }

  if (value.trim() === "") {
    throw new Error("pico vision scene response content is empty");
  }

  return value;
}

function parseSceneContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("pico vision scene response is malformed");
  }
}

function requireSceneDescription(value: unknown): ParsedSceneDescription {
  const scene = requireRecord(value);

  if (
    typeof scene.summary !== "string" ||
    scene.summary.trim() === "" ||
    !isStringArray(scene.observedPeople) ||
    !isStringArray(scene.environment) ||
    !isStringArray(scene.humanAttention) ||
    !isStringArray(scene.uncertainty)
  ) {
    throw new Error("pico vision scene response is malformed");
  }

  return {
    summary: scene.summary,
    observedPeople: scene.observedPeople,
    environment: scene.environment,
    humanAttention: scene.humanAttention,
    uncertainty: scene.uncertainty
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
