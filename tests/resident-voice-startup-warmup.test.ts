import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  type ResidentVoiceStartupWarmupClients,
  warmResidentVoiceStartupProviders
} from "../src/runtime/resident-voice-startup-warmup.js";

describe("resident voice startup warmup", () => {
  it("warms STT and TTS providers before listening and records a startup metric", async () => {
    const audit = createStructuredAuditLog();
    const calls: string[] = [];

    const result = await warmResidentVoiceStartupProviders({
      clients: createSuccessfulClients(calls),
      now: fixedNow(),
      monotonicNow: sequenceNumber([100, 350]),
      probe: { audit }
    });

    expect(calls).toEqual(["stt:warmup", "tts:はい。"]);
    expect(result).toEqual({
      sttDurationMs: 80,
      ttsAudioDurationMs: 120,
      ttsChunkCount: 1,
      totalDurationMs: 250
    });
    expect(
      audit.entries().map((entry) => ({
        stage: entry.attributes["pico.voice.stage"],
        status: entry.attributes["pico.voice.stage_status"],
        durationMs: entry.attributes["pico.voice.stage_duration_ms"],
        chunkCount: entry.attributes["pico.voice.chunk_count"],
        audioDurationMs: entry.attributes["pico.voice.utterance_duration_ms"]
      }))
    ).toContainEqual({
      stage: "startup_warmup",
      status: "ok",
      durationMs: 250,
      chunkCount: 1,
      audioDurationMs: 120
    });
  });

  it("fails startup when STT warmup fails and records the provider error", async () => {
    const audit = createStructuredAuditLog();

    await expect(
      warmResidentVoiceStartupProviders({
        clients: {
          stt: {
            warmup: () =>
              Promise.resolve({
                ok: false,
                reason: "backend_error",
                message: "mlx sidecar unavailable",
                source: {
                  sidecarId: "local-mlx-whisper",
                  provider: "mlx-whisper",
                  modelRepo: "mlx-community/whisper-large-v3-turbo"
                }
              }),
            transcribe: () => {
              throw new Error("startup warmup must not transcribe arbitrary audio");
            }
          },
          tts: createSuccessfulClients([]).tts
        },
        now: fixedNow(),
        monotonicNow: sequenceNumber([100, 125]),
        probe: { audit }
      })
    ).rejects.toThrow(
      "pico resident voice STT warmup failed: backend_error: mlx sidecar unavailable"
    );

    expect(
      audit.entries().map((entry) => ({
        stage: entry.attributes["pico.voice.stage"],
        status: entry.attributes["pico.voice.stage_status"],
        errorCode: entry.attributes["pico.voice.error_code"]
      }))
    ).toContainEqual({
      stage: "startup_warmup",
      status: "error",
      errorCode: "backend_error"
    });
  });
});

function createSuccessfulClients(calls: string[]): ResidentVoiceStartupWarmupClients {
  return {
    stt: {
      warmup: () => {
        calls.push("stt:warmup");

        return Promise.resolve({
          ok: true,
          text: "",
          language: "ja",
          confidence: 0.5,
          durationMs: 80,
          segments: [],
          source: {
            sidecarId: "local-mlx-whisper",
            provider: "mlx-whisper",
            modelRepo: "mlx-community/whisper-large-v3-turbo"
          }
        });
      },
      transcribe: () => {
        throw new Error("startup warmup must not transcribe arbitrary audio");
      }
    },
    tts: {
      synthesize: (request) => {
        calls.push(`tts:${request.text}`);

        return Promise.resolve({
          ok: true,
          chunks: [
            {
              sentenceIndex: 0,
              text: request.text,
              audio: new Uint8Array([1, 2, 3]),
              encoding: "pcm16le",
              sampleRateHz: 44_100,
              channels: 1,
              durationMs: 120,
              source: {
                serviceId: "local-aivis",
                provider: "aivis-speech",
                speakerId: 888_753_760
              }
            }
          ],
          totalDurationMs: 120,
          source: {
            serviceId: "local-aivis",
            provider: "aivis-speech",
            speakerId: 888_753_760
          }
        });
      }
    }
  };
}

function fixedNow(): () => string {
  return () => "2026-06-18T00:00:00.000Z";
}

function sequenceNumber(values: readonly number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] ?? values[0] ?? 0;
}
