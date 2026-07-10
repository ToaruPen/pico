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
        provider: "apple-speech",
        reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
      },
      tts: {
        status: "skipped",
        provider: "aivis-speech",
        reason: "Set voice.tts.aivis in pico config to run the Aivis Speech TTS smoke."
      }
    });
  });

  it("builds explicit Apple Speech and Aivis Speech smoke plans from YAML config", () => {
    const plan = buildVoiceSmokePlan(
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: " http://127.0.0.1:8766 ",
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
        id: "local-apple-speech",
        provider: "apple-speech",
        localBaseUrl: "http://127.0.0.1:8766",
        language: "ja-JP",
        timeoutMs: 30_000,
        warmup: {
          audioSeconds: 0.25
        }
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

  it("uses a distinct skip reason when Apple Speech has no smoke sample", () => {
    expect(
      buildVoiceSmokePlan(
        definePicoConfig({
          voice: {
            stt: {
              appleSpeech: {
                localBaseUrl: "http://127.0.0.1:8766"
              }
            }
          }
        })
      ).stt
    ).toEqual({
      status: "skip",
      reason: "Set voice.stt.appleSpeech.samplePcm16lePath to run the Apple Speech STT smoke."
    });
  });

  it("rejects partial TTS provider smoke configuration", () => {
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
        provider: "apple-speech"
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
        provider: "apple-speech"
      },
      tts: {
        status: "passed",
        provider: "aivis-speech"
      }
    } satisfies VoiceSmokeReport;

    expect(voiceSmokeExitCode(nonFailingReport)).toBe(0);
  });
});
