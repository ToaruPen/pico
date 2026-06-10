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

export type AivisSpeechServiceConfigInput = {
  readonly id: string;
  readonly provider: "aivis-speech";
  readonly localBaseUrl: string;
  readonly speakerId: number;
  readonly timeoutMs: number;
  readonly voice?: Partial<AivisSpeechVoiceParameters>;
};

export type AivisSpeechServiceConfig = {
  readonly id: string;
  readonly provider: "aivis-speech";
  readonly localBaseUrl: string;
  readonly speakerId: number;
  readonly timeoutMs: number;
  readonly voice: AivisSpeechVoiceParameters;
};

export type AivisSpeechVoiceParameters = {
  readonly speedScale: number;
  readonly pitchScale: number;
  readonly intonationScale: number;
  readonly volumeScale: number;
};

export type TtsSynthesisRequest = {
  readonly text: string;
  readonly signal?: AbortSignal;
};

export type TtsAudioChunk = {
  readonly sentenceIndex: number;
  readonly text: string;
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly durationMs: number;
  readonly source: TtsSynthesisSource;
};

export type TtsSynthesisSuccess = {
  readonly ok: true;
  readonly chunks: readonly TtsAudioChunk[];
  readonly totalDurationMs: number;
  readonly source: TtsSynthesisSource;
};

export type TtsSynthesisFailure = {
  readonly ok: false;
  readonly reason:
    | "invalid_request"
    | "timeout"
    | "cancelled"
    | "backend_error"
    | "invalid_response";
  readonly message: string;
  readonly sentenceIndex: number;
  readonly source: TtsSynthesisSource;
};

export type TtsSynthesisResult = TtsSynthesisSuccess | TtsSynthesisFailure;

export type TtsClient = {
  readonly synthesize: (request: TtsSynthesisRequest) => Promise<TtsSynthesisResult>;
};

type SttTranscriptionSource = {
  readonly sidecarId: string;
  readonly provider: "mlx-whisper";
  readonly modelRepo: string;
};

type TtsSynthesisSource = {
  readonly serviceId: string;
  readonly provider: "aivis-speech";
  readonly speakerId: number;
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
const AIVIS_DEFAULT_VOICE: AivisSpeechVoiceParameters = {
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1
};
const SENTENCE_BOUNDARIES = new Set([".", "。", "！", "？", "!", "?", "…"]);
const TRAILING_SENTENCE_CLOSERS = new Set([
  '"',
  "'",
  ")",
  "]",
  "}",
  "」",
  "』",
  "】",
  "）",
  "］",
  "｝",
  "〉",
  "》",
  "〗",
  "〙",
  "〛"
]);

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

export function defineAivisSpeechService(input: unknown): AivisSpeechServiceConfig {
  if (input === undefined) {
    throw new Error("pico TTS service config is required");
  }

  const config = requireRecord(input, "pico TTS service must be one config object");

  return {
    id: requireString(config.id, "pico TTS service id is required"),
    provider: requireAivisSpeechProvider(config.provider),
    localBaseUrl: requireLocalAivisSpeechBaseUrl(config.localBaseUrl),
    speakerId: requireNonNegativeInteger(
      config.speakerId,
      "pico TTS service speakerId is required"
    ),
    timeoutMs: requirePositiveInteger(config.timeoutMs, "pico TTS service timeoutMs is required"),
    voice: defineAivisSpeechVoice(config.voice)
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

export function createAivisSpeechTtsClient(
  service: AivisSpeechServiceConfig,
  fetchImplementation: typeof fetch = fetch
): TtsClient {
  return {
    async synthesize(request) {
      const source = ttsSynthesisSource(service);
      const sentences = segmentJapaneseSentences(request.text);
      const chunks: TtsAudioChunk[] = [];

      for (const [sentenceIndex, sentence] of sentences.entries()) {
        if (request.signal?.aborted) {
          return ttsFailure(
            service,
            "cancelled",
            "pico TTS Aivis Speech request was cancelled",
            sentenceIndex
          );
        }

        const result = await synthesizeSentenceWithAivisSpeech(
          sentenceIndex,
          sentence,
          service,
          fetchImplementation,
          request.signal
        );

        if (!result.ok) {
          return result;
        }

        chunks.push(result.chunk);
      }

      return {
        ok: true,
        chunks,
        totalDurationMs: chunks.reduce((total, chunk) => total + chunk.durationMs, 0),
        source
      };
    }
  };
}

export function segmentJapaneseSentences(text: string): readonly string[] {
  const stripped = text.trim();

  if (stripped === "") {
    return [];
  }

  const { complete, residual } = splitCompleteJapaneseSentences(stripped);

  if (residual.trim() !== "") {
    return [...complete, residual.trim()];
  }

  return complete;
}

export function splitCompleteJapaneseSentences(text: string): {
  readonly complete: readonly string[];
  readonly residual: string;
} {
  const complete: string[] = [];
  let current = "";
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    current += character;
    index += 1;

    if (!SENTENCE_BOUNDARIES.has(character)) {
      continue;
    }

    const consumed = consumeTrailingSentenceClosers(text, index);
    current += consumed.closers;
    index = consumed.nextIndex;
    pushSentenceSegment(complete, current);
    current = "";
  }

  return { complete, residual: current };
}

function consumeTrailingSentenceClosers(
  text: string,
  startIndex: number
): {
  readonly closers: string;
  readonly nextIndex: number;
} {
  let closers = "";
  let index = startIndex;

  while (index < text.length && TRAILING_SENTENCE_CLOSERS.has(text.charAt(index))) {
    closers += text.charAt(index);
    index += 1;
  }

  return { closers, nextIndex: index };
}

function pushSentenceSegment(segments: string[], text: string): void {
  const segment = text.trim();

  if (segment !== "") {
    segments.push(segment);
  }
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

async function synthesizeSentenceWithAivisSpeech(
  sentenceIndex: number,
  text: string,
  service: AivisSpeechServiceConfig,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined
): Promise<
  | {
      readonly ok: true;
      readonly chunk: TtsAudioChunk;
    }
  | TtsSynthesisFailure
> {
  const audioQueryResult = await postAivisAudioQuery(
    sentenceIndex,
    text,
    service,
    fetchImplementation,
    signal
  );

  if (!audioQueryResult.ok) {
    return audioQueryResult;
  }

  return postAivisSynthesis(
    sentenceIndex,
    text,
    audioQueryResult.payload,
    service,
    fetchImplementation,
    signal
  );
}

async function postAivisAudioQuery(
  sentenceIndex: number,
  text: string,
  service: AivisSpeechServiceConfig,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined
): Promise<
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
    }
  | TtsSynthesisFailure
> {
  const result = await runAivisSpeechStage(
    sentenceIndex,
    "audio_query",
    service,
    signal,
    async (stageSignal) => {
      const response = await fetchImplementation(
        buildAivisUrl(service, "/audio_query", { text, speaker: String(service.speakerId) }),
        {
          method: "POST",
          signal: stageSignal
        }
      );

      if (!response.ok) {
        return ttsFailure(
          service,
          "backend_error",
          `pico TTS Aivis Speech audio_query request failed with status ${response.status}`,
          sentenceIndex
        );
      }

      try {
        return {
          ok: true as const,
          payload: requireRecord(
            await response.json(),
            "pico TTS Aivis Speech response is malformed"
          )
        };
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        return ttsFailure(
          service,
          "invalid_response",
          "pico TTS Aivis Speech response is malformed",
          sentenceIndex
        );
      }
    }
  );

  if (!result.ok) {
    return result;
  }

  return result.value;
}

async function postAivisSynthesis(
  sentenceIndex: number,
  text: string,
  audioQueryPayload: Record<string, unknown>,
  service: AivisSpeechServiceConfig,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined
): Promise<
  | {
      readonly ok: true;
      readonly chunk: TtsAudioChunk;
    }
  | TtsSynthesisFailure
> {
  const result = await runAivisSpeechStage(
    sentenceIndex,
    "synthesis",
    service,
    signal,
    async (stageSignal) => {
      const response = await fetchImplementation(
        buildAivisUrl(service, "/synthesis", { speaker: String(service.speakerId) }),
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...audioQueryPayload,
            ...service.voice,
            text
          }),
          signal: stageSignal
        }
      );

      if (!response.ok) {
        return ttsFailure(
          service,
          "backend_error",
          `pico TTS Aivis Speech synthesis request failed with status ${response.status}`,
          sentenceIndex
        );
      }

      try {
        const wav = decodeWavPcm16le(new Uint8Array(await response.arrayBuffer()));

        return {
          ok: true as const,
          chunk: {
            sentenceIndex,
            text,
            audio: wav.audio,
            encoding: "pcm16le" as const,
            sampleRateHz: wav.sampleRateHz,
            channels: wav.channels,
            durationMs: wavDurationMs(wav.audio, wav.sampleRateHz, wav.channels),
            source: ttsSynthesisSource(service)
          }
        };
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        return ttsFailure(
          service,
          "invalid_response",
          "pico TTS Aivis Speech WAV response is malformed",
          sentenceIndex
        );
      }
    }
  );

  if (!result.ok) {
    return result;
  }

  return result.value;
}

async function runAivisSpeechStage<T>(
  sentenceIndex: number,
  stage: "audio_query" | "synthesis",
  service: AivisSpeechServiceConfig,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<{ readonly ok: true; readonly value: T } | TtsSynthesisFailure> {
  if (signal?.aborted) {
    return ttsFailure(
      service,
      "cancelled",
      "pico TTS Aivis Speech request was cancelled",
      sentenceIndex
    );
  }

  const abortController = new AbortController();
  let abortReason: "timeout" | "cancelled" = "cancelled";
  const timeout = setTimeout(() => {
    abortReason = "timeout";
    abortController.abort();
  }, service.timeoutMs);
  const cancel = (): void => {
    abortReason = "cancelled";
    abortController.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    return {
      ok: true,
      value: await Promise.race([run(abortController.signal), abortPromise(abortController.signal)])
    };
  } catch (error) {
    if (isAbortError(error)) {
      return aivisAbortFailure(service, abortReason, stage, sentenceIndex);
    }

    return ttsFailure(
      service,
      "backend_error",
      aivisRequestErrorMessage(stage, error),
      sentenceIndex
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function buildAivisUrl(
  service: AivisSpeechServiceConfig,
  pathname: "/audio_query" | "/synthesis",
  parameters: Record<string, string>
): string {
  const url = new URL(pathname, service.localBaseUrl);

  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function decodeWavPcm16le(wav: Uint8Array): {
  readonly audio: Uint8Array;
  readonly sampleRateHz: number;
  readonly channels: number;
} {
  const buffer = Buffer.from(wav);

  requireWavHeader(buffer);

  return requireDecodedWav(readWavChunks(buffer));
}

type WavChunks = {
  audioFormat?: number;
  bitsPerSample?: number;
  channels?: number;
  sampleRateHz?: number;
  audio?: Uint8Array;
};

type DecodedWavChunks = WavChunks & {
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly audio: Uint8Array;
};

function readWavChunks(buffer: Buffer): WavChunks {
  const chunks: WavChunks = {};
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    offset = readWavChunk(buffer, offset, chunks);
  }

  return chunks;
}

function readWavChunk(buffer: Buffer, offset: number, chunks: WavChunks): number {
  const chunkId = buffer.toString("ascii", offset, offset + 4);
  const chunkSize = buffer.readUInt32LE(offset + 4);
  const chunkStart = offset + 8;
  const chunkEnd = chunkStart + chunkSize;

  if (chunkEnd > buffer.byteLength) {
    throw new Error("pico TTS Aivis Speech WAV response is malformed");
  }

  if (chunkId === "fmt ") {
    readWavFormatChunk(buffer, chunkStart, chunkSize, chunks);
  }

  if (chunkId === "data") {
    chunks.audio = buffer.subarray(chunkStart, chunkEnd);
  }

  return chunkEnd + (chunkSize % 2);
}

function readWavFormatChunk(
  buffer: Buffer,
  chunkStart: number,
  chunkSize: number,
  chunks: WavChunks
): void {
  if (chunkSize < 16) {
    throw new Error("pico TTS Aivis Speech WAV response is malformed");
  }

  chunks.audioFormat = buffer.readUInt16LE(chunkStart);
  chunks.channels = buffer.readUInt16LE(chunkStart + 2);
  chunks.sampleRateHz = buffer.readUInt32LE(chunkStart + 4);
  chunks.bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
}

function requireDecodedWav(chunks: WavChunks): {
  readonly audio: Uint8Array;
  readonly sampleRateHz: number;
  readonly channels: number;
} {
  if (!isDecodedPcm16leWav(chunks)) {
    throw new Error("pico TTS Aivis Speech WAV response is malformed");
  }

  return {
    audio: chunks.audio,
    sampleRateHz: chunks.sampleRateHz,
    channels: chunks.channels
  };
}

function isDecodedPcm16leWav(chunks: WavChunks): chunks is DecodedWavChunks {
  return isPcm16leWavFormat(chunks) && hasPositiveWavMetadata(chunks) && hasAlignedWavAudio(chunks);
}

function isPcm16leWavFormat(chunks: WavChunks): boolean {
  return chunks.audioFormat === 1 && chunks.bitsPerSample === 16;
}

function hasPositiveWavMetadata(
  chunks: WavChunks
): chunks is WavChunks & { readonly channels: number; readonly sampleRateHz: number } {
  return (
    chunks.channels !== undefined &&
    chunks.channels > 0 &&
    chunks.sampleRateHz !== undefined &&
    chunks.sampleRateHz > 0
  );
}

function hasAlignedWavAudio(
  chunks: WavChunks
): chunks is WavChunks & { readonly audio: Uint8Array } {
  if (chunks.audio === undefined || chunks.channels === undefined) {
    return false;
  }

  return chunks.audio.byteLength % (chunks.channels * PCM16LE_BYTES_PER_SAMPLE) === 0;
}

function requireWavHeader(buffer: Buffer): void {
  if (
    buffer.byteLength < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("pico TTS Aivis Speech WAV response is malformed");
  }
}

function wavDurationMs(audio: Uint8Array, sampleRateHz: number, channels: number): number {
  if (audio.byteLength === 0) {
    return 0;
  }

  const frameCount = audio.byteLength / (channels * PCM16LE_BYTES_PER_SAMPLE);
  return Math.max(1, Math.trunc((frameCount / sampleRateHz) * 1000));
}

function defineAivisSpeechVoice(value: unknown): AivisSpeechVoiceParameters {
  if (value === undefined) {
    return AIVIS_DEFAULT_VOICE;
  }

  const voice = requireRecord(value, "pico TTS service voice config must be one config object");

  return {
    speedScale: requireFiniteNumberOrDefault(voice.speedScale, AIVIS_DEFAULT_VOICE.speedScale),
    pitchScale: requireFiniteNumberOrDefault(voice.pitchScale, AIVIS_DEFAULT_VOICE.pitchScale),
    intonationScale: requireFiniteNumberOrDefault(
      voice.intonationScale,
      AIVIS_DEFAULT_VOICE.intonationScale
    ),
    volumeScale: requireFiniteNumberOrDefault(voice.volumeScale, AIVIS_DEFAULT_VOICE.volumeScale)
  };
}

function requireFiniteNumberOrDefault(value: unknown, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("pico TTS service voice parameter must be finite");
  }

  return value;
}

function requireAivisSpeechProvider(value: unknown): "aivis-speech" {
  if (value === "aivis-speech") {
    return value;
  }

  throw new Error("pico TTS service provider must be aivis-speech");
}

function requireLocalAivisSpeechBaseUrl(value: unknown): string {
  const localBaseUrl = requireString(value, "pico TTS service localBaseUrl is required");

  if (!URL.canParse(localBaseUrl)) {
    throw new Error("pico TTS service localBaseUrl must be a valid URL");
  }

  const parsedUrl = new URL(localBaseUrl);

  requireHttpUrl(parsedUrl);
  requireOriginUrl(parsedUrl);
  requireLoopbackAivisSpeechUrl(parsedUrl);

  return localBaseUrl;
}

function requireLoopbackAivisSpeechUrl(parsedUrl: URL): void {
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsedUrl.hostname)) {
    throw new Error("pico TTS service must use a local Aivis Speech URL");
  }
}

function requireNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(message);
  }

  return value;
}

function ttsFailure(
  service: AivisSpeechServiceConfig,
  reason: TtsSynthesisFailure["reason"],
  message: string,
  sentenceIndex: number
): TtsSynthesisFailure {
  return {
    ok: false,
    reason,
    message,
    sentenceIndex,
    source: ttsSynthesisSource(service)
  };
}

function ttsSynthesisSource(service: AivisSpeechServiceConfig): TtsSynthesisSource {
  return {
    serviceId: service.id,
    provider: service.provider,
    speakerId: service.speakerId
  };
}

function aivisAbortFailure(
  service: AivisSpeechServiceConfig,
  reason: "timeout" | "cancelled",
  stage: "audio_query" | "synthesis",
  sentenceIndex: number
): TtsSynthesisFailure {
  if (reason === "timeout") {
    return ttsFailure(
      service,
      reason,
      `pico TTS Aivis Speech ${stage} request timed out`,
      sentenceIndex
    );
  }

  return ttsFailure(service, reason, "pico TTS Aivis Speech request was cancelled", sentenceIndex);
}

function aivisRequestErrorMessage(stage: "audio_query" | "synthesis", error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return `pico TTS Aivis Speech ${stage} request failed: ${error.message}`;
  }

  return `pico TTS Aivis Speech ${stage} request failed`;
}
