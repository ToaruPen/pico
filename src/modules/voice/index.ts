import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const voiceModuleMetadata = {
  kind: "voice",
  status: "planned",
  summary: "Voice input and output through mlx-whisper and Aivis Speech.",
  selectedProvider: "mlx-whisper for STT and Aivis Speech for TTS",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;

export type MlxWhisperSidecarConfigInput = {
  readonly id: string;
  readonly provider: "mlx-whisper";
  readonly localBaseUrl: string;
  readonly modelRepo: string;
  readonly language: string;
  readonly timeoutMs: number;
  readonly warmup: {
    readonly audioSeconds: number;
  };
};

export type MlxWhisperSidecarConfig = MlxWhisperSidecarConfigInput;

export type SttTranscriptionRequest = {
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
};

export type SttTranscriptSegment = {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
};

export type SttTranscriptionSuccess = {
  readonly ok: true;
  readonly text: string;
  readonly language: string;
  readonly confidence: number;
  readonly durationMs: number;
  readonly segments: readonly SttTranscriptSegment[];
  readonly source: SttTranscriptionSource;
};

export type SttTranscriptionFailure = {
  readonly ok: false;
  readonly reason: "invalid_request" | "timeout" | "model_load" | "backend_error";
  readonly message: string;
  readonly source: SttTranscriptionSource;
};

export type SttTranscriptionResult = SttTranscriptionSuccess | SttTranscriptionFailure;

export type SttClient = {
  readonly warmup: () => Promise<SttTranscriptionResult>;
  readonly transcribe: (request: SttTranscriptionRequest) => Promise<SttTranscriptionResult>;
};

type SttTranscriptionSource = {
  readonly sidecarId: string;
  readonly provider: "mlx-whisper";
  readonly modelRepo: string;
};

type ParsedMlxWhisperSidecarResponse =
  | {
      readonly ok: true;
      readonly text: string;
      readonly language: string;
      readonly confidence: number;
      readonly durationMs: number;
      readonly segments: readonly SttTranscriptSegment[];
    }
  | {
      readonly ok: false;
      readonly reason: SttTranscriptionFailure["reason"];
      readonly message: string;
    };

const MLX_WHISPER_TARGET_SAMPLE_RATE_HZ = 16_000;
const PCM16LE_BYTES_PER_SAMPLE = 2;

export function defineMlxWhisperSidecar(input: unknown): MlxWhisperSidecarConfig {
  if (input === undefined) {
    throw new Error("pico STT sidecar config is required");
  }

  const config = requireRecord(input, "pico STT sidecar must be one config object");
  const warmup = requireRecord(config.warmup, "pico STT sidecar warmup config is required");

  return {
    id: requireString(config.id, "pico STT sidecar id is required"),
    provider: requireMlxWhisperProvider(config.provider),
    localBaseUrl: requireLocalSidecarBaseUrl(config.localBaseUrl),
    modelRepo: requireString(config.modelRepo, "pico STT sidecar modelRepo is required"),
    language: requireString(config.language, "pico STT sidecar language is required"),
    timeoutMs: requirePositiveInteger(config.timeoutMs, "pico STT sidecar timeoutMs is required"),
    warmup: {
      audioSeconds: requirePositiveNumber(
        warmup.audioSeconds,
        "pico STT sidecar warmup audioSeconds is required"
      )
    }
  };
}

export function createMlxWhisperSttClient(
  sidecar: MlxWhisperSidecarConfig,
  fetchImplementation: typeof fetch = fetch
): SttClient {
  return {
    warmup() {
      return transcribeWithMlxWhisperSidecar(
        buildWarmupRequest(sidecar),
        sidecar,
        fetchImplementation
      );
    },
    transcribe(request) {
      if (request.audio.length === 0) {
        return Promise.resolve(emptyTranscription(sidecar));
      }

      return transcribeWithMlxWhisperSidecar(request, sidecar, fetchImplementation);
    }
  };
}

async function transcribeWithMlxWhisperSidecar(
  request: SttTranscriptionRequest,
  sidecar: MlxWhisperSidecarConfig,
  fetchImplementation: typeof fetch
): Promise<SttTranscriptionResult> {
  const source = transcriptionSource(sidecar);
  const invalidRequestMessage = validatePcm16leRequest(request);

  if (invalidRequestMessage !== undefined) {
    return {
      ok: false,
      reason: "invalid_request",
      message: invalidRequestMessage,
      source
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, sidecar.timeoutMs);

  try {
    const response = await fetchImplementation(buildTranscriptionUrl(sidecar), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(buildTranscriptionRequestBody(request, sidecar)),
      signal: abortController.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: "backend_error",
        message: `pico STT mlx-whisper sidecar request failed with status ${response.status}`,
        source
      };
    }

    const parsed = parseMlxWhisperSidecarResponse((await response.json()) as unknown);

    if (!parsed.ok) {
      return {
        ...parsed,
        source
      };
    }

    return {
      ...parsed,
      source
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        reason: "timeout",
        message: "pico STT mlx-whisper sidecar request timed out",
        source
      };
    }

    return {
      ok: false,
      reason: "backend_error",
      message: sttRequestErrorMessage(error),
      source
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildWarmupRequest(sidecar: MlxWhisperSidecarConfig): SttTranscriptionRequest {
  const frameCount = Math.max(
    1,
    Math.round(sidecar.warmup.audioSeconds * MLX_WHISPER_TARGET_SAMPLE_RATE_HZ)
  );

  return {
    audio: new Uint8Array(frameCount * PCM16LE_BYTES_PER_SAMPLE),
    encoding: "pcm16le",
    sampleRateHz: MLX_WHISPER_TARGET_SAMPLE_RATE_HZ,
    channels: 1
  };
}

function emptyTranscription(sidecar: MlxWhisperSidecarConfig): SttTranscriptionSuccess {
  return {
    ok: true,
    text: "",
    language: sidecar.language,
    confidence: 0,
    durationMs: 0,
    segments: [],
    source: transcriptionSource(sidecar)
  };
}

function transcriptionSource(sidecar: MlxWhisperSidecarConfig): SttTranscriptionSource {
  return {
    sidecarId: sidecar.id,
    provider: sidecar.provider,
    modelRepo: sidecar.modelRepo
  };
}

function buildTranscriptionUrl(sidecar: MlxWhisperSidecarConfig): string {
  return new URL("/v1/transcriptions", sidecar.localBaseUrl).toString();
}

function buildTranscriptionRequestBody(
  request: SttTranscriptionRequest,
  sidecar: MlxWhisperSidecarConfig
): Record<string, unknown> {
  return {
    provider: sidecar.provider,
    modelRepo: sidecar.modelRepo,
    language: sidecar.language,
    timeoutMs: sidecar.timeoutMs,
    audio: {
      encoding: request.encoding,
      sampleRateHz: request.sampleRateHz,
      channels: request.channels,
      dataBase64: Buffer.from(request.audio).toString("base64")
    },
    normalization: {
      targetEncoding: "pcm16le",
      targetSampleRateHz: MLX_WHISPER_TARGET_SAMPLE_RATE_HZ,
      targetChannels: 1
    }
  };
}

function validatePcm16leRequest(request: SttTranscriptionRequest): string | undefined {
  if (
    !Number.isInteger(request.sampleRateHz) ||
    request.sampleRateHz < 1 ||
    !Number.isInteger(request.channels) ||
    request.channels < 1 ||
    request.audio.byteLength === 0 ||
    request.audio.byteLength % (request.channels * PCM16LE_BYTES_PER_SAMPLE) !== 0
  ) {
    return "pico STT transcription request must be PCM16LE audio with positive metadata";
  }

  return undefined;
}

export function parseMlxWhisperSidecarResponse(
  responsePayload: unknown
): ParsedMlxWhisperSidecarResponse {
  const response = requireRecord(
    responsePayload,
    "pico STT mlx-whisper sidecar response is malformed"
  );
  if (response.provider !== "mlx-whisper") {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  if (response.ok === true) {
    return parseMlxWhisperSuccessResponse(response.result);
  }

  if (response.ok === false) {
    return parseMlxWhisperFailureResponse(response.error);
  }

  throw new Error("pico STT mlx-whisper sidecar response is malformed");
}

function parseMlxWhisperSuccessResponse(resultPayload: unknown): ParsedMlxWhisperSidecarResponse {
  const result = requireRecord(resultPayload, "pico STT mlx-whisper sidecar response is malformed");
  const text = requireTranscriptText(result.text);
  const language = requireString(
    result.language,
    "pico STT mlx-whisper sidecar response is malformed"
  );
  const confidence = requireProbability(result.confidence);
  const durationMs = requireNonNegativeNumber(result.durationMs);
  const segments = requireTranscriptSegments(result.segments);

  return {
    ok: true,
    text,
    language,
    confidence,
    durationMs,
    segments
  };
}

function parseMlxWhisperFailureResponse(errorPayload: unknown): ParsedMlxWhisperSidecarResponse {
  const error = requireRecord(errorPayload, "pico STT mlx-whisper sidecar response is malformed");

  return {
    ok: false,
    reason: requireSidecarErrorCode(error.code),
    message: requireString(error.message, "pico STT mlx-whisper sidecar response is malformed")
  };
}

function requireTranscriptSegments(value: unknown): readonly SttTranscriptSegment[] {
  if (!Array.isArray(value)) {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  return value.map(requireTranscriptSegment);
}

function requireTranscriptSegment(value: unknown): SttTranscriptSegment {
  const segment = requireRecord(value, "pico STT mlx-whisper sidecar response is malformed");
  const text = requireTranscriptText(segment.text);
  const startMs = requireNonNegativeNumber(segment.startMs);
  const endMs = requireNonNegativeNumber(segment.endMs);

  if (endMs < startMs) {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  return {
    text,
    startMs,
    endMs,
    confidence: requireProbability(segment.confidence)
  };
}

function requireTranscriptText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }

  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(message);
  }

  return trimmed;
}

function requireMlxWhisperProvider(value: unknown): "mlx-whisper" {
  if (value === "mlx-whisper") {
    return value;
  }

  throw new Error("pico STT sidecar provider must be mlx-whisper");
}

function requireLocalSidecarBaseUrl(value: unknown): string {
  const localBaseUrl = requireString(value, "pico STT sidecar localBaseUrl is required");

  if (!URL.canParse(localBaseUrl)) {
    throw new Error("pico STT sidecar localBaseUrl must be a valid URL");
  }

  const parsedUrl = new URL(localBaseUrl);

  requireHttpUrl(parsedUrl);
  requireOriginUrl(parsedUrl);
  requireLoopbackSidecarUrl(parsedUrl);

  return localBaseUrl;
}

function requireHttpUrl(parsedUrl: URL): void {
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("pico STT sidecar localBaseUrl must use HTTP");
  }
}

function requireOriginUrl(parsedUrl: URL): void {
  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw new Error("pico STT sidecar localBaseUrl must be an origin URL");
  }
}

function requireLoopbackSidecarUrl(parsedUrl: URL): void {
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsedUrl.hostname)) {
    throw new Error("pico STT sidecar must use a local sidecar URL");
  }
}

function requirePositiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(message);
  }

  return value;
}

function requirePositiveNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }

  return value;
}

function requireNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  return value;
}

function requireProbability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("pico STT mlx-whisper sidecar response is malformed");
  }

  return value;
}

function requireSidecarErrorCode(value: unknown): SttTranscriptionFailure["reason"] {
  if (
    value === "invalid_request" ||
    value === "timeout" ||
    value === "model_load" ||
    value === "backend_error"
  ) {
    return value;
  }

  throw new Error("pico STT mlx-whisper sidecar response is malformed");
}

function sttRequestErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return `pico STT mlx-whisper sidecar request failed: ${error.message}`;
  }

  return "pico STT mlx-whisper sidecar request failed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
