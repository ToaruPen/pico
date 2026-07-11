import { describe, expect, it } from "vitest";

import {
  assertVoiceEchoPickupProviderReady,
  buildVoiceEchoPickupFieldPlan,
  classifyVoiceEchoPickupResult,
  voiceEchoPickupFieldExitCode
} from "../scripts/field/voice-echo-pickup.js";
import { definePicoConfig } from "../src/config/index.js";

describe("voice echo pickup field harness", () => {
  it("requires voice echo control, STT, and TTS configuration", () => {
    expect(buildVoiceEchoPickupFieldPlan(definePicoConfig({}))).toEqual({
      status: "skip",
      reason:
        "Set voice.echoControl, voice.stt.appleSpeech, and voice.tts.aivis to run the voice echo pickup field test."
    });
  });

  it("plans local echo pickup field execution from configured providers", () => {
    const plan = buildVoiceEchoPickupFieldPlan(
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "aec",
            provider: "web_rtc_aec3",
            providerEndpoint: "http://127.0.0.1:8770"
          },
          stt: {
            appleSpeech: {
              localBaseUrl: "http://127.0.0.1:8766"
            }
          },
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: 888_753_760
            }
          }
        }
      })
    );

    expect(plan).toEqual({
      status: "run",
      echoControl: {
        enabled: true,
        mode: "aec",
        provider: "web_rtc_aec3",
        providerEndpoint: "http://127.0.0.1:8770",
        sampleRateHz: 16_000,
        channels: 1,
        frameMs: 10,
        tailMuteMs: 700,
        diagnostics: {
          enabled: false
        }
      },
      stt: {
        localBaseUrl: "http://127.0.0.1:8766"
      },
      tts: {
        localBaseUrl: "http://127.0.0.1:10101",
        speakerId: 888_753_760
      },
      triggerPhrases: []
    });
  });

  it("uses non-zero exit only for failed field reports", () => {
    expect(voiceEchoPickupFieldExitCode({ status: "passed" })).toBe(0);
    expect(voiceEchoPickupFieldExitCode({ status: "skipped" })).toBe(0);
    expect(voiceEchoPickupFieldExitCode({ status: "failed" })).toBe(1);
  });

  it("passes only when pico suppresses its own TTS pickup before session triggering", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptText: "おはようピコ。",
        transcriptLength: 7,
        resumedTranscriptText: "",
        resumedTranscriptLength: 0,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "passed",
      details: {
        acceptance: "safety_pass",
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptLength: 7,
        resumedTranscriptLength: 0,
        wouldTriggerSession: false
      }
    });

    expect(
      classifyVoiceEchoPickupResult({
        provider: "half_duplex",
        echoAction: "pass",
        transcriptText: "おはようピコ。",
        transcriptLength: 7,
        resumedTranscriptText: "",
        resumedTranscriptLength: 0,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "failed",
      reason: "pico TTS pickup was allowed through echo control",
      details: {
        acceptance: "fail",
        provider: "half_duplex",
        echoAction: "pass",
        transcriptLength: 7,
        resumedTranscriptLength: 0,
        wouldTriggerSession: true
      }
    });
  });

  it("fails suppressed pickup when the post-tail resume window still contains trigger speech", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptText: "",
        transcriptLength: 0,
        resumedTranscriptText: "おはようピコ。",
        resumedTranscriptLength: 7,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "failed",
      reason: "pico TTS pickup remained audible after echo-control resume",
      details: {
        acceptance: "fail",
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptLength: 0,
        resumedTranscriptLength: 7,
        wouldTriggerSession: true
      }
    });
  });

  it("does not fail suppressed pickup for non-trigger text after resume", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptText: "",
        transcriptLength: 0,
        resumedTranscriptText: "ご視聴ありがとうございました。",
        resumedTranscriptLength: 14,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "passed",
      details: {
        acceptance: "safety_pass",
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptLength: 0,
        resumedTranscriptLength: 14,
        wouldTriggerSession: false
      }
    });
  });

  it("reports real AEC pass only for non-half-duplex pass results", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "web_rtc_aec3",
        echoAction: "pass",
        transcriptText: "今日は静かな確認です。",
        transcriptLength: 10,
        resumedTranscriptText: "",
        resumedTranscriptLength: 0,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "passed",
      details: {
        acceptance: "aec_pass",
        provider: "web_rtc_aec3",
        echoAction: "pass",
        transcriptLength: 10,
        resumedTranscriptLength: 0,
        wouldTriggerSession: false
      }
    });
  });

  it("reports half-duplex suppression as a safety pass rather than AEC acceptance", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptText: "おはようピコ。",
        transcriptLength: 7,
        resumedTranscriptText: "",
        resumedTranscriptLength: 0,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "passed",
      details: {
        acceptance: "safety_pass",
        provider: "half_duplex",
        echoAction: "suppress",
        transcriptLength: 7,
        resumedTranscriptLength: 0,
        wouldTriggerSession: false
      }
    });
  });

  it("does not report provider suppression as a real AEC pass", () => {
    expect(
      classifyVoiceEchoPickupResult({
        provider: "web_rtc_aec3",
        echoAction: "suppress",
        transcriptText: "",
        transcriptLength: 0,
        resumedTranscriptText: "",
        resumedTranscriptLength: 0,
        triggerPhrases: ["おはよう", "ピコ"]
      })
    ).toEqual({
      status: "passed",
      details: {
        acceptance: "safety_pass",
        provider: "web_rtc_aec3",
        echoAction: "suppress",
        transcriptLength: 0,
        resumedTranscriptLength: 0,
        wouldTriggerSession: false
      }
    });
  });

  it("fails AEC field readiness when the configured provider is unhealthy", async () => {
    await expect(
      assertVoiceEchoPickupProviderReady({
        describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
        checkHealth: () =>
          Promise.resolve({
            ok: false,
            provider: "web_rtc_aec3",
            mode: "aec",
            reason: "unavailable",
            message: "sidecar refused connection"
          }),
        acceptFarEndReference: () => Promise.resolve(),
        processNearEnd: () => {
          throw new Error("field readiness must fail before processing audio");
        },
        flush: () => Promise.resolve()
      })
    ).rejects.toThrow(
      /^pico voice echo pickup AEC provider is unhealthy: sidecar refused connection$/
    );
  });

  it("rejects half-duplex providers that claim AEC mode readiness", async () => {
    await expect(
      assertVoiceEchoPickupProviderReady({
        describe: () => ({ provider: "half_duplex", mode: "aec" }),
        checkHealth: () =>
          Promise.resolve({
            ok: true,
            provider: "half_duplex",
            mode: "aec",
            engine: "half-duplex-safety"
          }),
        acceptFarEndReference: () => Promise.resolve(),
        processNearEnd: () => {
          throw new Error("invalid AEC mode provider must fail before processing audio");
        },
        flush: () => Promise.resolve()
      })
    ).rejects.toThrow(/^pico voice echo pickup mode aec cannot use half_duplex provider$/);
  });
});
