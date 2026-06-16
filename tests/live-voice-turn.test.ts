import { describe, expect, it } from "vitest";

import type { EchoControlProvider, VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import type { SttClient, TtsClient } from "../src/modules/voice/index.js";
import { runLiveVoiceTurn } from "../src/runtime/live-voice-turn.js";

describe("live voice turn runtime", () => {
  it("routes TTS far-end and mic near-end through echo control before STT", async () => {
    const calls: string[] = [];
    const farEndFrames: VoicePcmFrame[] = [];
    const nearEndFrames: VoicePcmFrame[] = [];
    const processedAudio = new Uint8Array([9, 9, 9]);
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "web_rtc_aec3",
          mode: "aec",
          engine: "webrtc-aec3"
        }),
      acceptFarEndReference: (frame) => {
        calls.push(`far:${frame.id}`);
        farEndFrames.push(frame);
        return Promise.resolve();
      },
      processNearEnd: (frame) => {
        calls.push(`near:${frame.id}`);
        nearEndFrames.push(frame);
        return Promise.resolve({
          action: "pass",
          reason: "aec_processed",
          frame: {
            ...frame,
            audio: processedAudio
          },
          diagnostics: {
            provider: "web_rtc_aec3",
            residualEchoProbability: 0.1,
            voiceActivity: true
          }
        });
      },
      flush: () => Promise.resolve()
    };
    const tts: TtsClient = {
      synthesize: () =>
        Promise.resolve({
          ok: true,
          chunks: [
            {
              sentenceIndex: 0,
              text: "おはようピコ。",
              audio: new Uint8Array([1, 2, 3]),
              encoding: "pcm16le",
              sampleRateHz: 16_000,
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
        })
    };
    const sttRequests: Uint8Array[] = [];
    const stt: SttClient = {
      warmup: () => {
        throw new Error("warmup is not part of this runtime test");
      },
      transcribe: (request) => {
        sttRequests.push(request.audio);
        return Promise.resolve({
          ok: true,
          text: "こんにちは",
          language: "ja",
          confidence: 0.8,
          durationMs: 300,
          segments: [],
          source: {
            sidecarId: "local-mlx-whisper",
            provider: "mlx-whisper",
            modelRepo: "mlx-community/whisper-large-v3-turbo"
          }
        });
      }
    };

    const result = await runLiveVoiceTurn({
      now: () => "2026-06-16T10:00:00.000Z",
      tts,
      stt,
      echoControl,
      text: "おはようピコ。",
      micFrames: [
        {
          id: "mic-1",
          direction: "near_end",
          audio: new Uint8Array([4, 5, 6]),
          encoding: "pcm16le",
          sampleRateHz: 16_000,
          channels: 1,
          capturedAt: "2026-06-16T10:00:00.050Z",
          durationMs: 300
        }
      ],
      triggerPhrases: ["ピコ"]
    });

    expect(calls).toEqual(["far:tts-0", "near:mic-1"]);
    expect(farEndFrames).toHaveLength(1);
    expect(nearEndFrames).toHaveLength(1);
    expect(sttRequests).toEqual([processedAudio]);
    expect(result).toEqual({
      status: "completed",
      transcripts: ["こんにちは"],
      triggered: false,
      suppressedFrames: 0
    });
  });

  it("does not send suppressed microphone frames to STT", async () => {
    let sttCalls = 0;
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "half-duplex-safety"
        }),
      acceptFarEndReference: () => Promise.resolve(),
      processNearEnd: () =>
        Promise.resolve({
          action: "suppress",
          reason: "far_end_tail_mute",
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 1,
            voiceActivity: false
          }
        }),
      flush: () => Promise.resolve()
    };

    const result = await runLiveVoiceTurn({
      now: () => "2026-06-16T10:00:00.000Z",
      tts: successfulSingleChunkTts(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of this runtime test");
        },
        transcribe: () => {
          sttCalls += 1;
          throw new Error("suppressed audio must not be transcribed");
        }
      },
      echoControl,
      text: "おはようピコ。",
      micFrames: [sampleNearEndFrame()],
      triggerPhrases: ["ピコ"]
    });

    expect(sttCalls).toBe(0);
    expect(result.suppressedFrames).toBe(1);
    expect(result.transcripts).toEqual([]);
    expect(result.triggered).toBe(false);
  });

  it("timestamps multiple TTS far-end chunks sequentially", async () => {
    const farEndFrames: VoicePcmFrame[] = [];
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "half-duplex-safety"
        }),
      acceptFarEndReference: (frame) => {
        farEndFrames.push(frame);
        return Promise.resolve();
      },
      processNearEnd: (frame) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: true
          }
        }),
      flush: () => Promise.resolve()
    };

    await runLiveVoiceTurn({
      now: () => "2026-06-16T10:00:00.000Z",
      tts: successfulTwoChunkTts(),
      stt: successfulStt("こんにちは"),
      echoControl,
      text: "おはようピコ。こんにちは。",
      micFrames: [sampleNearEndFrame()],
      triggerPhrases: ["ピコ"]
    });

    expect(farEndFrames.map((frame) => frame.capturedAt)).toEqual([
      "2026-06-16T10:00:00.000Z",
      "2026-06-16T10:00:00.120Z"
    ]);
  });

  it("fails closed before TTS or STT when echo-control health is unhealthy", async () => {
    let ttsCalls = 0;
    let sttCalls = 0;
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
      checkHealth: () =>
        Promise.resolve({
          ok: false,
          provider: "web_rtc_aec3",
          mode: "aec",
          reason: "unavailable",
          message: "sidecar refused connection"
        }),
      acceptFarEndReference: () => {
        throw new Error("unhealthy provider must fail before far-end reference");
      },
      processNearEnd: () => {
        throw new Error("unhealthy provider must fail before near-end processing");
      },
      flush: () => Promise.resolve()
    };

    await expect(
      runLiveVoiceTurn({
        now: () => "2026-06-16T10:00:00.000Z",
        tts: {
          synthesize: () => {
            ttsCalls += 1;
            throw new Error("unhealthy provider must fail before TTS");
          }
        },
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of this runtime test");
          },
          transcribe: () => {
            sttCalls += 1;
            throw new Error("unhealthy provider must fail before STT");
          }
        },
        echoControl,
        text: "おはようピコ。",
        micFrames: [sampleNearEndFrame()],
        triggerPhrases: ["ピコ"]
      })
    ).rejects.toThrow(
      "pico live voice echo-control provider is unhealthy: sidecar refused connection"
    );
    expect(ttsCalls).toBe(0);
    expect(sttCalls).toBe(0);
  });

  it("detects trigger phrases split across adjacent STT frames", async () => {
    const echoControl = passThroughEchoControl();

    const result = await runLiveVoiceTurn({
      now: () => "2026-06-16T10:00:00.000Z",
      tts: successfulSingleChunkTts(),
      stt: sequentialStt(["おは", "ようピコ"]),
      echoControl,
      text: "おはようピコ。",
      micFrames: [
        sampleNearEndFrame(),
        {
          ...sampleNearEndFrame(),
          id: "mic-2",
          capturedAt: "2026-06-16T10:00:00.350Z"
        }
      ],
      triggerPhrases: ["おはようピコ"]
    });

    expect(result.transcripts).toEqual(["おは", "ようピコ"]);
    expect(result.triggered).toBe(true);
  });

  it("flushes echo-control state when the turn fails", async () => {
    let flushCalls = 0;
    const echoControl: EchoControlProvider = {
      ...passThroughEchoControl(),
      flush: () => {
        flushCalls += 1;
        return Promise.resolve();
      }
    };

    await expect(
      runLiveVoiceTurn({
        now: () => "2026-06-16T10:00:00.000Z",
        tts: successfulSingleChunkTts(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of this runtime test");
          },
          transcribe: () =>
            Promise.resolve({
              ok: false,
              reason: "backend_error",
              message: "STT sidecar failed",
              source: {
                sidecarId: "local-mlx-whisper",
                provider: "mlx-whisper",
                modelRepo: "mlx-community/whisper-large-v3-turbo"
              }
            })
        },
        echoControl,
        text: "おはようピコ。",
        micFrames: [sampleNearEndFrame()],
        triggerPhrases: ["ピコ"]
      })
    ).rejects.toThrow("pico live voice STT failed: backend_error: STT sidecar failed");
    expect(flushCalls).toBe(1);
  });
});

function sampleNearEndFrame(): VoicePcmFrame {
  return {
    id: "mic-1",
    direction: "near_end",
    audio: new Uint8Array([4, 5, 6]),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt: "2026-06-16T10:00:00.050Z",
    durationMs: 300
  };
}

function successfulSingleChunkTts(): TtsClient {
  return {
    synthesize: () =>
      Promise.resolve({
        ok: true,
        chunks: [
          {
            sentenceIndex: 0,
            text: "おはようピコ。",
            audio: new Uint8Array([1, 2, 3]),
            encoding: "pcm16le",
            sampleRateHz: 16_000,
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
      })
  };
}

function successfulTwoChunkTts(): TtsClient {
  return {
    synthesize: () =>
      Promise.resolve({
        ok: true,
        chunks: [
          {
            sentenceIndex: 0,
            text: "おはようピコ。",
            audio: new Uint8Array([1, 2, 3]),
            encoding: "pcm16le",
            sampleRateHz: 16_000,
            channels: 1,
            durationMs: 120,
            source: {
              serviceId: "local-aivis",
              provider: "aivis-speech",
              speakerId: 888_753_760
            }
          },
          {
            sentenceIndex: 1,
            text: "こんにちは。",
            audio: new Uint8Array([4, 5, 6]),
            encoding: "pcm16le",
            sampleRateHz: 16_000,
            channels: 1,
            durationMs: 200,
            source: {
              serviceId: "local-aivis",
              provider: "aivis-speech",
              speakerId: 888_753_760
            }
          }
        ],
        totalDurationMs: 320,
        source: {
          serviceId: "local-aivis",
          provider: "aivis-speech",
          speakerId: 888_753_760
        }
      })
  };
}

function successfulStt(text: string): SttClient {
  return {
    warmup: () => {
      throw new Error("warmup is not part of this runtime test");
    },
    transcribe: () =>
      Promise.resolve({
        ok: true,
        text,
        language: "ja",
        confidence: 0.8,
        durationMs: 300,
        segments: [],
        source: {
          sidecarId: "local-mlx-whisper",
          provider: "mlx-whisper",
          modelRepo: "mlx-community/whisper-large-v3-turbo"
        }
      })
  };
}

function sequentialStt(texts: readonly string[]): SttClient {
  let index = 0;

  return {
    warmup: () => {
      throw new Error("warmup is not part of this runtime test");
    },
    transcribe: () => {
      const text = texts[index] ?? "";
      index += 1;

      return Promise.resolve({
        ok: true,
        text,
        language: "ja",
        confidence: 0.8,
        durationMs: 300,
        segments: [],
        source: {
          sidecarId: "local-mlx-whisper",
          provider: "mlx-whisper",
          modelRepo: "mlx-community/whisper-large-v3-turbo"
        }
      });
    }
  };
}

function passThroughEchoControl(): EchoControlProvider {
  return {
    describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
    checkHealth: () =>
      Promise.resolve({
        ok: true,
        provider: "web_rtc_aec3",
        mode: "aec",
        engine: "webrtc-aec3"
      }),
    acceptFarEndReference: () => Promise.resolve(),
    processNearEnd: (frame) =>
      Promise.resolve({
        action: "pass",
        reason: "aec_processed",
        frame,
        diagnostics: {
          provider: "web_rtc_aec3",
          residualEchoProbability: 0,
          voiceActivity: true
        }
      }),
    flush: () => Promise.resolve()
  };
}
