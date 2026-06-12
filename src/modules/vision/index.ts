import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";
import {
  buildSelectedModelEndpointAuthHeaders,
  type SelectedModelEndpointConfig
} from "../local-models/index.js";

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
  "Return exactly one JSON object and no markdown. The object must have these keys: summary, observedPeople, environment, humanAttention, uncertainty. Each key except summary must be an array of strings. Describe only visible after-school care scene details. Do not identify children, infer private traits, diagnose, score, or make final safety decisions. If no people, attention items, or uncertainties are visible, use an empty array. Uncertainty must be an array of short strings.";

const OLLAMA_REQUEST_TIMEOUT_MS = 30_000;
const visionBoundaryMarkers = [
  "childid",
  "childevaluation",
  "childscore",
  "childscoring",
  "evaluatechild",
  "evaluatethechild",
  "identifythechild",
  "identifyachild",
  "identifiesthechild",
  "identifiedthechild",
  "diagnosechild",
  "diagnosethechild",
  "diagnosingchild",
  "childdiagnosis",
  "assessthechild",
  "児童id",
  "子どもid",
  "児童スコア",
  "子どもスコア",
  "児童のスコア",
  "子どものスコア",
  "児童を特定",
  "子どもを特定",
  "児童の特定",
  "子どもの特定",
  "児童診断",
  "子ども診断",
  "児童を診断",
  "子どもを診断",
  "児童の診断",
  "子どもの診断",
  "児童を評価",
  "子どもを評価",
  "児童の評価",
  "子どもの評価"
];
const normalizedVisionBoundaryMarkers = visionBoundaryMarkers.map(normalizeVisionBoundaryText);

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

  try {
    const response = await rejectOnAbort(
      fetchImplementation(buildOllamaChatUrl(request.endpoint), {
        method: "POST",
        headers: buildOllamaSceneRequestHeaders(request.endpoint),
        body: JSON.stringify(buildOllamaSceneRequestBody(request)),
        signal: abortController.signal
      }),
      abortController.signal
    );

    if (!response.ok) {
      throw new Error(`pico vision Ollama request failed with status ${response.status}`);
    }

    return await rejectOnAbort(response.json() as Promise<unknown>, abortController.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("pico vision Ollama request timed out", { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildOllamaSceneRequestHeaders(endpoint: SelectedModelEndpointConfig): HeadersInit {
  return {
    ...buildSelectedModelEndpointAuthHeaders(endpoint),
    "content-type": "application/json"
  };
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
  return new URL("/api/chat", endpoint.host.tunnel.localBaseUrl).toString();
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
    return JSON.parse(stripJsonFence(content)) as unknown;
  } catch {
    throw new Error("pico vision scene response is malformed");
  }
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);

  return fencedJson?.[1] ?? trimmed;
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

  rejectIndividualChildAssessmentText([
    scene.summary,
    ...scene.observedPeople,
    ...scene.environment,
    ...scene.humanAttention,
    ...scene.uncertainty
  ]);

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

function rejectIndividualChildAssessmentText(values: readonly string[]): void {
  for (const value of values) {
    const normalized = normalizeVisionBoundaryText(value);

    if (normalizedVisionBoundaryMarkers.some((marker) => normalized.includes(marker))) {
      throw new Error("pico vision scene response must not identify or assess individual children");
    }
  }
}

function normalizeVisionBoundaryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/\s|_|-/gu, "");
}
