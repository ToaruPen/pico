import { describe, expect, it } from "vitest";

import {
  buildVoiceSmokePlan,
  runVoiceProviderSmoke,
  type VoiceSmokeReport,
  voiceSmokeExitCode
} from "../scripts/smoke/voice-providers.js";

describe("voice provider smoke configuration", () => {
  it("skips both provider smokes when endpoints are not configured", async () => {
    await expect(runVoiceProviderSmoke({})).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "mlx-whisper",
        reason: "Set PICO_STT_MLX_WHISPER_BASE_URL to run the mlx-whisper STT smoke."
      },
      tts: {
        status: "skipped",
        provider: "aivis-speech",
        reason: "Set PICO_TTS_AIVIS_BASE_URL to run the Aivis Speech TTS smoke."
      }
    });
  });

  it("builds explicit mlx-whisper and Aivis Speech smoke plans from environment", () => {
    const plan = buildVoiceSmokePlan({
      PICO_STT_MLX_WHISPER_BASE_URL: " http://127.0.0.1:8765 ",
      PICO_STT_SAMPLE_PCM16LE_PATH: " ./samples/known-ja.pcm ",
      PICO_STT_SAMPLE_RATE_HZ: "16000",
      PICO_STT_CHANNELS: "1",
      PICO_TTS_AIVIS_BASE_URL: " http://127.0.0.1:10101 ",
      PICO_TTS_AIVIS_SPEAKER_ID: "1",
      PICO_TTS_TEXT: "こんにちは。"
    });

    expect(plan.stt).toMatchObject({
      status: "run",
      samplePath: "./samples/known-ja.pcm",
      sampleRateHz: 16_000,
      channels: 1,
      sidecar: {
        provider: "mlx-whisper",
        localBaseUrl: "http://127.0.0.1:8765",
        modelRepo: "mlx-community/whisper-large-v3-turbo",
        language: "ja"
      }
    });
    expect(plan.tts).toMatchObject({
      status: "run",
      text: "こんにちは。",
      service: {
        provider: "aivis-speech",
        localBaseUrl: "http://127.0.0.1:10101",
        speakerId: 1
      }
    });
  });

  it("rejects invalid numeric smoke environment values", () => {
    expect(() =>
      buildVoiceSmokePlan({
        PICO_TTS_AIVIS_BASE_URL: "http://127.0.0.1:10101",
        PICO_TTS_AIVIS_SPEAKER_ID: "-1"
      })
    ).toThrow("PICO_TTS_AIVIS_SPEAKER_ID must be a non-negative integer");
  });

  it("rejects partial provider smoke configuration", () => {
    expect(() =>
      buildVoiceSmokePlan({
        PICO_STT_MLX_WHISPER_BASE_URL: "http://127.0.0.1:8765"
      })
    ).toThrow("PICO_STT_SAMPLE_PCM16LE_PATH is required when PICO_STT_MLX_WHISPER_BASE_URL is set");

    expect(() =>
      buildVoiceSmokePlan({
        PICO_TTS_AIVIS_BASE_URL: "http://127.0.0.1:10101"
      })
    ).toThrow("PICO_TTS_AIVIS_SPEAKER_ID is required when PICO_TTS_AIVIS_BASE_URL is set");
  });

  it("returns a failing process code only when a smoke section fails", () => {
    const report = {
      stt: {
        status: "skipped",
        provider: "mlx-whisper"
      },
      tts: {
        status: "failed",
        provider: "aivis-speech",
        reason: "empty audio"
      }
    } satisfies VoiceSmokeReport;

    expect(voiceSmokeExitCode(report)).toBe(1);

    const nonFailingReport = {
      stt: {
        status: "skipped",
        provider: "mlx-whisper"
      },
      tts: {
        status: "passed",
        provider: "aivis-speech"
      }
    } satisfies VoiceSmokeReport;

    expect(voiceSmokeExitCode(nonFailingReport)).toBe(0);
  });
});
