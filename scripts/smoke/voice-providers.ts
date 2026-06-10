#!/usr/bin/env jiti
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  type AivisSpeechServiceConfig,
  createAivisSpeechTtsClient,
  createMlxWhisperSttClient,
  defineAivisSpeechService,
  defineMlxWhisperSidecar,
  type MlxWhisperSidecarConfig,
  type SttTranscriptionRequest
} from "../../src/modules/voice/index.js";

const defaultMlxWhisperModelRepo = "mlx-community/whisper-large-v3-turbo";
const defaultLanguage = "ja";
const defaultTimeoutMs = 30_000;
const defaultWarmupAudioSeconds = 0.25;
const defaultSampleRateHz = 16_000;
const defaultChannels = 1;
const defaultTtsText = "こんにちは。picoの音声スモークです。";

export type VoiceSmokeStatus = "passed" | "failed" | "skipped";

export type VoiceSmokeReport = {
  readonly stt: VoiceSmokeSectionReport;
  readonly tts: VoiceSmokeSectionReport;
};

export type VoiceSmokeSectionReport = {
  readonly status: VoiceSmokeStatus;
  readonly provider: "mlx-whisper" | "aivis-speech";
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
};

type SttSmokePlan =
  | {
      readonly status: "run";
      readonly sidecar: MlxWhisperSidecarConfig;
      readonly samplePath: string;
      readonly sampleRateHz: number;
      readonly channels: number;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

type TtsSmokePlan =
  | {
      readonly status: "run";
      readonly service: AivisSpeechServiceConfig;
      readonly text: string;
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

type VoiceSmokePlan = {
  readonly stt: SttSmokePlan;
  readonly tts: TtsSmokePlan;
};

export async function runVoiceProviderSmoke(
  env: NodeJS.ProcessEnv = process.env
): Promise<VoiceSmokeReport> {
  const plan = buildVoiceSmokePlan(env);

  return {
    stt: await runSttSmoke(plan.stt),
    tts: await runTtsSmoke(plan.tts)
  };
}

export function buildVoiceSmokePlan(env: NodeJS.ProcessEnv): VoiceSmokePlan {
  return {
    stt: buildSttSmokePlan(env),
    tts: buildTtsSmokePlan(env)
  };
}

export function voiceSmokeExitCode(report: VoiceSmokeReport): number {
  return [report.stt, report.tts].some((section) => section.status === "failed") ? 1 : 0;
}

async function runSttSmoke(plan: SttSmokePlan): Promise<VoiceSmokeSectionReport> {
  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "mlx-whisper",
      reason: plan.reason
    };
  }

  let audio: Uint8Array;

  try {
    audio = await readFile(plan.samplePath);
  } catch (error) {
    return voiceSmokeFailure(
      "mlx-whisper",
      `pico voice STT smoke could not read PCM16LE sample: ${errorMessage(error)}`
    );
  }

  const request: SttTranscriptionRequest = {
    audio,
    encoding: "pcm16le",
    sampleRateHz: plan.sampleRateHz,
    channels: plan.channels
  };
  const result = await createMlxWhisperSttClient(plan.sidecar).transcribe(request);

  if (!result.ok) {
    return voiceSmokeFailure(
      "mlx-whisper",
      `pico voice STT smoke failed: ${result.reason}: ${result.message}`
    );
  }

  if (result.text.trim() === "") {
    return voiceSmokeFailure("mlx-whisper", "pico voice STT smoke produced an empty transcript");
  }

  return {
    status: "passed",
    provider: "mlx-whisper",
    details: {
      sidecarId: result.source.sidecarId,
      modelRepo: result.source.modelRepo,
      language: result.language,
      confidence: result.confidence,
      durationMs: result.durationMs,
      transcriptLength: result.text.length,
      segmentCount: result.segments.length
    }
  };
}

async function runTtsSmoke(plan: TtsSmokePlan): Promise<VoiceSmokeSectionReport> {
  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "aivis-speech",
      reason: plan.reason
    };
  }

  const result = await createAivisSpeechTtsClient(plan.service).synthesize({ text: plan.text });

  if (!result.ok) {
    return voiceSmokeFailure(
      "aivis-speech",
      `pico voice TTS smoke failed at sentence ${result.sentenceIndex}: ${result.reason}: ${result.message}`
    );
  }

  if (result.chunks.length === 0) {
    return voiceSmokeFailure("aivis-speech", "pico voice TTS smoke produced no audio chunks");
  }

  const totalAudioBytes = result.chunks.reduce((total, chunk) => total + chunk.audio.byteLength, 0);

  if (totalAudioBytes === 0) {
    return voiceSmokeFailure("aivis-speech", "pico voice TTS smoke produced empty audio");
  }

  return {
    status: "passed",
    provider: "aivis-speech",
    details: {
      serviceId: result.source.serviceId,
      speakerId: result.source.speakerId,
      chunkCount: result.chunks.length,
      totalAudioBytes,
      totalDurationMs: result.totalDurationMs,
      sampleRateHz: result.chunks[0]?.sampleRateHz,
      channels: result.chunks[0]?.channels,
      encoding: result.chunks[0]?.encoding
    }
  };
}

function buildSttSmokePlan(env: NodeJS.ProcessEnv): SttSmokePlan {
  const localBaseUrl = readEnvironment(env, "PICO_STT_MLX_WHISPER_BASE_URL");

  if (localBaseUrl === undefined) {
    return {
      status: "skip",
      reason: "Set PICO_STT_MLX_WHISPER_BASE_URL to run the mlx-whisper STT smoke."
    };
  }

  const samplePath = requireEnvironment(
    env,
    "PICO_STT_SAMPLE_PCM16LE_PATH",
    "PICO_STT_SAMPLE_PCM16LE_PATH is required when PICO_STT_MLX_WHISPER_BASE_URL is set"
  );

  return {
    status: "run",
    sidecar: buildMlxWhisperSidecar(localBaseUrl, env),
    samplePath,
    sampleRateHz:
      readPositiveIntegerEnvironment(env, "PICO_STT_SAMPLE_RATE_HZ") ?? defaultSampleRateHz,
    channels: readPositiveIntegerEnvironment(env, "PICO_STT_CHANNELS") ?? defaultChannels
  };
}

function buildTtsSmokePlan(env: NodeJS.ProcessEnv): TtsSmokePlan {
  const localBaseUrl = readEnvironment(env, "PICO_TTS_AIVIS_BASE_URL");

  if (localBaseUrl === undefined) {
    return {
      status: "skip",
      reason: "Set PICO_TTS_AIVIS_BASE_URL to run the Aivis Speech TTS smoke."
    };
  }

  const speakerId = requireNonNegativeIntegerEnvironment(
    env,
    "PICO_TTS_AIVIS_SPEAKER_ID",
    "PICO_TTS_AIVIS_SPEAKER_ID is required when PICO_TTS_AIVIS_BASE_URL is set"
  );

  return {
    status: "run",
    service: defineAivisSpeechService({
      id: readEnvironment(env, "PICO_TTS_AIVIS_ID") ?? "local-aivis",
      provider: "aivis-speech",
      localBaseUrl,
      speakerId,
      timeoutMs: readPositiveIntegerEnvironment(env, "PICO_TTS_TIMEOUT_MS") ?? defaultTimeoutMs
    }),
    text: readEnvironment(env, "PICO_TTS_TEXT") ?? defaultTtsText
  };
}

function buildMlxWhisperSidecar(
  localBaseUrl: string,
  env: NodeJS.ProcessEnv
): MlxWhisperSidecarConfig {
  return defineMlxWhisperSidecar({
    id: readEnvironment(env, "PICO_STT_MLX_WHISPER_ID") ?? "local-mlx-whisper",
    provider: "mlx-whisper",
    localBaseUrl,
    modelRepo:
      readEnvironment(env, "PICO_STT_MLX_WHISPER_MODEL_REPO") ?? defaultMlxWhisperModelRepo,
    language: readEnvironment(env, "PICO_STT_LANGUAGE") ?? defaultLanguage,
    timeoutMs: readPositiveIntegerEnvironment(env, "PICO_STT_TIMEOUT_MS") ?? defaultTimeoutMs,
    warmup: {
      audioSeconds:
        readPositiveNumberEnvironment(env, "PICO_STT_WARMUP_AUDIO_SECONDS") ??
        defaultWarmupAudioSeconds
    }
  });
}

function readEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === "" ? undefined : value;
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function readPositiveIntegerEnvironment(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readNonNegativeIntegerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string
): number | undefined {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function requireNonNegativeIntegerEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  message: string
): number {
  const value = readNonNegativeIntegerEnvironment(env, name);

  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function readPositiveNumberEnvironment(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = readEnvironment(env, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

function voiceSmokeFailure(
  provider: VoiceSmokeSectionReport["provider"],
  reason: string
): VoiceSmokeSectionReport {
  return {
    status: "failed",
    provider,
    reason
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runVoiceProviderSmoke();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = voiceSmokeExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
