import { describe, expect, it } from "vitest";

import {
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
        "Set voice.echoControl, voice.stt.mlxWhisper, and voice.tts.aivis to run the voice echo pickup field test."
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
            mlxWhisper: {
              localBaseUrl: "http://127.0.0.1:8765",
              samplePcm16lePath: "/tmp/pico-known-ja.pcm"
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
        localBaseUrl: "http://127.0.0.1:8765",
        samplePcm16lePath: "/tmp/pico-known-ja.pcm"
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
        echoAction: "suppress",
        transcriptLength: 7,
        resumedTranscriptLength: 0,
        wouldTriggerSession: false
      }
    });

    expect(
      classifyVoiceEchoPickupResult({
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
        echoAction: "suppress",
        transcriptLength: 0,
        resumedTranscriptLength: 14,
        wouldTriggerSession: false
      }
    });
  });
});
