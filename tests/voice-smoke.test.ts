import { describe, expect, it } from "vitest";

import {
  buildVoiceSmokePlan,
  runVoiceProviderSmoke,
  type VoiceSmokeReport,
  voiceSmokeExitCode
} from "../scripts/smoke/voice-providers.js";
import { definePicoConfig } from "../src/config/index.js";

describe("voice provider smoke configuration", () => {
  it("skips both provider smokes when endpoints are not configured", async () => {
    await expect(runVoiceProviderSmoke(definePicoConfig({}))).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "mlx-whisper",
        reason: "Set voice.stt.mlxWhisper in pico config to run the mlx-whisper STT smoke."
      },
      tts: {
        status: "skipped",
        provider: "aivis-speech",
        reason: "Set voice.tts.aivis in pico config to run the Aivis Speech TTS smoke."
      }
    });
  });

  it("builds explicit mlx-whisper and Aivis Speech smoke plans from YAML config", () => {
    const plan = buildVoiceSmokePlan(
      definePicoConfig({
        voice: {
          stt: {
            mlxWhisper: {
              localBaseUrl: " http://127.0.0.1:8765 ",
              samplePcm16lePath: " ./samples/known-ja.pcm ",
              sampleRateHz: 16_000,
              channels: 1
            }
          },
          tts: {
            aivis: {
              localBaseUrl: " http://127.0.0.1:10101 ",
              speakerId: 1,
              text: "こんにちは。"
            }
          }
        }
      })
    );

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

  it("rejects invalid numeric smoke config values", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: -1
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.speakerId must be a non-negative integer");
  });

  it("rejects partial provider smoke configuration", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            mlxWhisper: {
              localBaseUrl: "http://127.0.0.1:8765"
            }
          }
        }
      })
    ).toThrow(
      "pico config voice.stt.mlxWhisper.samplePcm16lePath is required when voice.stt.mlxWhisper is set"
    );

    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101"
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.speakerId is required when voice.tts.aivis is set");
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
