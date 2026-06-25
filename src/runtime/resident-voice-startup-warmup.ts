import type {
  SttClient,
  SttTranscriptionResult,
  TtsClient,
  TtsSynthesisResult
} from "../modules/voice/index.js";
import { recordVoiceStageProbe, type VoiceStageProbe } from "./voice-stage-probe.js";

export type ResidentVoiceStartupWarmupClients = {
  readonly stt: SttClient;
  readonly tts: TtsClient;
};

export type ResidentVoiceStartupWarmupOptions = {
  readonly clients: ResidentVoiceStartupWarmupClients;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly probe?: VoiceStageProbe;
  readonly ttsText?: string;
  readonly signal?: AbortSignal;
};

export type ResidentVoiceStartupWarmupResult = {
  readonly sttDurationMs: number;
  readonly ttsAudioDurationMs: number;
  readonly ttsChunkCount: number;
  readonly totalDurationMs: number;
};

const defaultNow = (): string => new Date().toISOString();
const defaultMonotonicNow = (): number => performance.now();
const defaultTtsWarmupText = "はい。";

export async function warmResidentVoiceStartupProviders(
  options: ResidentVoiceStartupWarmupOptions
): Promise<ResidentVoiceStartupWarmupResult> {
  const now = options.now ?? defaultNow;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const startedAt = now();
  const startedAtMs = monotonicNow();

  try {
    const [sttResult, ttsResult] = await Promise.all([
      options.clients.stt.warmup(),
      options.clients.tts.synthesize({
        text: options.ttsText ?? defaultTtsWarmupText,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    ]);
    const totalDurationMs = monotonicNow() - startedAtMs;

    requireSuccessfulSttWarmup(sttResult, options.probe, startedAt, totalDurationMs);
    requireSuccessfulTtsWarmup(ttsResult, options.probe, startedAt, totalDurationMs);

    recordStartupWarmupProbe(options.probe, startedAt, totalDurationMs, "ok", {
      "pico.voice.chunk_count": ttsResult.chunks.length,
      "pico.voice.utterance_duration_ms": ttsResult.totalDurationMs
    });

    return {
      sttDurationMs: sttResult.durationMs,
      ttsAudioDurationMs: ttsResult.totalDurationMs,
      ttsChunkCount: ttsResult.chunks.length,
      totalDurationMs
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pico resident voice ")) {
      throw error;
    }

    const totalDurationMs = monotonicNow() - startedAtMs;
    recordStartupWarmupProbe(options.probe, startedAt, totalDurationMs, "error", {
      "pico.voice.error_code": "startup_warmup_exception"
    });
    throw error;
  }
}

function requireSuccessfulSttWarmup(
  result: SttTranscriptionResult,
  probe: VoiceStageProbe | undefined,
  startedAt: string,
  totalDurationMs: number
): asserts result is Extract<SttTranscriptionResult, { readonly ok: true }> {
  if (result.ok) {
    return;
  }

  recordStartupWarmupProbe(probe, startedAt, totalDurationMs, "error", {
    "pico.voice.error_code": result.reason
  });
  throw new Error(`pico resident voice STT warmup failed: ${result.reason}: ${result.message}`);
}

function requireSuccessfulTtsWarmup(
  result: TtsSynthesisResult,
  probe: VoiceStageProbe | undefined,
  startedAt: string,
  totalDurationMs: number
): asserts result is Extract<TtsSynthesisResult, { readonly ok: true }> {
  if (result.ok) {
    return;
  }

  recordStartupWarmupProbe(probe, startedAt, totalDurationMs, "error", {
    "pico.voice.error_code": result.reason
  });
  throw new Error(`pico resident voice TTS warmup failed: ${result.reason}: ${result.message}`);
}

function recordStartupWarmupProbe(
  probe: VoiceStageProbe | undefined,
  startedAt: string,
  durationMs: number,
  status: "ok" | "error",
  attributes: Readonly<Record<string, string | number | boolean>>
): void {
  recordVoiceStageProbe(probe ?? {}, {
    stage: "startup_warmup",
    status,
    startedAt,
    durationMs,
    attributes
  });
}
