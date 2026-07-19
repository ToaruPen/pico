#!/usr/bin/env jiti
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  type AivisSpeechServiceConfig,
  type AppleSpeechSidecarConfig,
  collectTtsSynthesisEvents,
  createAivisSpeechTtsClient,
  createAppleSpeechSttClient,
  defineAivisSpeechService,
  defineAppleSpeechSidecar,
  type SttTranscriptionRequest
} from "../../src/modules/voice/index.js";

const defaultLanguage = "ja-JP";
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
  readonly provider: "apple-speech" | "aivis-speech";
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
};

type SttSmokePlan =
  | {
      readonly status: "run";
      readonly sidecar: AppleSpeechSidecarConfig;
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
  config: PicoConfig = loadPicoConfigFromEnvironment()
): Promise<VoiceSmokeReport> {
  const plan = buildVoiceSmokePlan(config);

  return {
    stt: await runSttSmoke(plan.stt),
    tts: await runTtsSmoke(plan.tts)
  };
}

export function buildVoiceSmokePlan(config: PicoConfig): VoiceSmokePlan {
  return {
    stt: buildSttSmokePlan(config),
    tts: buildTtsSmokePlan(config)
  };
}

export function voiceSmokeExitCode(report: VoiceSmokeReport): number {
  return [report.stt, report.tts].some((section) => section.status === "failed") ? 1 : 0;
}

async function runSttSmoke(plan: SttSmokePlan): Promise<VoiceSmokeSectionReport> {
  if (plan.status === "skip") {
    return {
      status: "skipped",
      provider: "apple-speech",
      reason: plan.reason
    };
  }

  let audio: Uint8Array;

  try {
    audio = await readFile(plan.samplePath);
  } catch (error) {
    return voiceSmokeFailure(
      "apple-speech",
      `pico voice STT smoke could not read PCM16LE sample: ${errorMessage(error)}`
    );
  }

  const request: SttTranscriptionRequest = {
    audio,
    encoding: "pcm16le",
    sampleRateHz: plan.sampleRateHz,
    channels: plan.channels
  };
  const result = await createAppleSpeechSttClient(plan.sidecar).transcribe(request);

  if (!result.ok) {
    return voiceSmokeFailure(
      "apple-speech",
      `pico voice STT smoke failed: ${result.reason}: ${result.message}`
    );
  }

  if (result.text.trim() === "") {
    return voiceSmokeFailure("apple-speech", "pico voice STT smoke produced an empty transcript");
  }

  return {
    status: "passed",
    provider: "apple-speech",
    details: {
      sidecarId: result.source.sidecarId,
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

  const result = await collectTtsSynthesisEvents(
    createAivisSpeechTtsClient(plan.service).synthesize({ text: plan.text })
  );

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

function buildSttSmokePlan(config: PicoConfig): SttSmokePlan {
  const appleSpeech = config.voice.stt.appleSpeech;

  if (appleSpeech === undefined) {
    return {
      status: "skip",
      reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
    };
  }

  if (appleSpeech.samplePcm16lePath === undefined) {
    return {
      status: "skip",
      reason: "Set voice.stt.appleSpeech.samplePcm16lePath to run the Apple Speech STT smoke."
    };
  }

  return {
    status: "run",
    sidecar: buildAppleSpeechSidecar(appleSpeech),
    samplePath: appleSpeech.samplePcm16lePath,
    sampleRateHz: appleSpeech.sampleRateHz ?? defaultSampleRateHz,
    channels: appleSpeech.channels ?? defaultChannels
  };
}

function buildTtsSmokePlan(config: PicoConfig): TtsSmokePlan {
  const aivis = config.voice.tts.aivis;

  if (aivis === undefined) {
    return {
      status: "skip",
      reason: "Set voice.tts.aivis in pico config to run the Aivis Speech TTS smoke."
    };
  }

  return {
    status: "run",
    service: defineAivisSpeechService({
      id: aivis.id ?? "local-aivis",
      provider: "aivis-speech",
      localBaseUrl: aivis.localBaseUrl,
      speakerId: aivis.speakerId,
      timeoutMs: aivis.timeoutMs ?? defaultTimeoutMs
    }),
    text: aivis.text ?? defaultTtsText
  };
}

function buildAppleSpeechSidecar(
  config: PicoConfig["voice"]["stt"]["appleSpeech"]
): AppleSpeechSidecarConfig {
  if (config === undefined) {
    throw new Error("pico Apple Speech smoke config is required");
  }

  return defineAppleSpeechSidecar({
    id: config.id ?? "local-apple-speech",
    provider: "apple-speech",
    localBaseUrl: config.localBaseUrl,
    language: config.language ?? defaultLanguage,
    timeoutMs: config.timeoutMs ?? defaultTimeoutMs,
    warmup: {
      audioSeconds: config.warmupAudioSeconds ?? defaultWarmupAudioSeconds
    }
  });
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
