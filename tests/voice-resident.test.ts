import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createSessionLifecycle, type SessionLifecycle } from "../src/modules/session/index.js";
import type { EchoControlProvider, VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import type { SttClient, TtsAudioChunk, TtsClient } from "../src/modules/voice/index.js";
import { runVoiceResidentRuntime, type VoicePlaybackSink } from "../src/runtime/voice-resident.js";

describe("voice resident runtime", () => {
  it("buffers speech frames into one utterance before sending audio to STT", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const transcribedDurations: number[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        speechFrame("speech-1", 0),
        speechFrame("speech-2", 10),
        speechFrame("speech-3", 20),
        silenceFrame("silence-1", 30),
        silenceFrame("silence-2", 40)
      ],
      utteranceWindow: testUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: (request) => {
          transcribedDurations.push((request.audio.byteLength / 2 / 16_000) * 1_000);
          return Promise.resolve(successfulTranscript("ピコ"));
        }
      },
      tts: createSuccessfulTts("はい。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "はい。" })
      }
    });

    expect(transcribedDurations).toEqual([50]);
    expect(result.processedFrames).toBe(5);
    expect(result.startedSessions).toBe(1);
  });

  it("does not send silence-only windows to STT", async () => {
    let sttCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [silenceFrame("silence-1", 0), silenceFrame("silence-2", 10)],
      utteranceWindow: testUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          sttCalls += 1;
          throw new Error("silence-only windows must not be transcribed");
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("silence-only windows must not reach Pi Agent");
        }
      }
    });

    expect(sttCalls).toBe(0);
    expect(result.processedFrames).toBe(2);
    expect(result.completedTurns).toBe(0);
  });

  it("flushes a pending utterance before shutdown cleanup after abort", async () => {
    const abortController = new AbortController();
    const transcribedDurations: number[] = [];

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: abortingFrames(abortController),
        utteranceWindow: {
          minSpeechMs: 20,
          silenceMs: 700,
          maxUtteranceMs: 1_000,
          minRmsDb: -50
        },
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createIdleEchoControl(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: (request) => {
            transcribedDurations.push((request.audio.byteLength / 2 / 16_000) * 1_000);
            return Promise.resolve(successfulTranscript("ピコ"));
          }
        },
        tts: createSuccessfulTts("はい。"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => Promise.resolve({ text: "はい。" })
        },
        signal: abortController.signal
      })
    ).rejects.toThrow("pico resident voice runtime aborted");

    expect(transcribedDurations).toEqual([20]);
  });

  it("runs shutdown cleanup even when pending utterance flush fails", async () => {
    const events: string[] = [];
    const abortController = new AbortController();

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: abortingFrames(abortController),
        utteranceWindow: {
          minSpeechMs: 20,
          silenceMs: 700,
          maxUtteranceMs: 1_000,
          minRmsDb: -50
        },
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createCleanupTrackingEchoControl(events),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => {
            events.push("stt:throw");
            throw new Error("stt failed during pending flush");
          }
        },
        tts: createSuccessfulTts("unused"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => {
            throw new Error("Pi Agent must not run after failed STT");
          },
          disposeAll: () => {
            events.push("pi:disposeAll");
          }
        },
        memoryWorker: {
          enqueueCutoff: () => {
            throw new Error("no cutoff is expected");
          },
          close: () => {
            events.push("memory:close");
          }
        },
        signal: abortController.signal
      })
    ).rejects.toThrow("stt failed during pending flush");

    expect(events).toEqual(["stt:throw", "pi:disposeAll", "memory:close", "echo:flush"]);
  });

  it("continues shutdown cleanup when Pi Agent disposal fails", async () => {
    const events: string[] = [];

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createCleanupTrackingEchoControl(events),
        stt: successfulStt(""),
        tts: createSuccessfulTts("unused"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => {
            throw new Error("no prompt is expected");
          },
          disposeAll: () => {
            events.push("pi:disposeAll");
            throw new Error("dispose failed");
          }
        },
        memoryWorker: {
          enqueueCutoff: () => {
            throw new Error("no cutoff is expected");
          },
          close: () => {
            events.push("memory:close");
          }
        }
      })
    ).rejects.toThrow("dispose failed");

    expect(events).toEqual(["pi:disposeAll", "memory:close", "echo:flush"]);
  });

  it("keeps pre-trigger transcripts ephemeral and processes an active Pi Agent voice turn", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const echoCalls: string[] = [];
    const farEndFrames: VoicePcmFrame[] = [];
    const playbackCalls: Array<{
      readonly chunk: TtsAudioChunk;
      readonly startedAt: string;
      readonly farEndReferenceCountAtPlayback: number;
    }> = [];
    const echoControl = createPassingEchoControl(echoCalls, farEndFrames);
    const sttTexts = ["雑談です", "ピコ", "今日の予定は？"];
    const stt: SttClient = {
      warmup: () => {
        throw new Error("warmup is not part of resident runtime");
      },
      transcribe: () => Promise.resolve(successfulTranscript(sttTexts.shift() ?? "追加の発話です"))
    };
    const tts = createSuccessfulTts("予定を確認します。");
    const playback: VoicePlaybackSink = {
      play: (chunk, startedAt) => {
        playbackCalls.push({
          chunk,
          startedAt,
          farEndReferenceCountAtPlayback: farEndFrames.length
        });
        return Promise.resolve();
      }
    };
    const agentPrompts: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        sampleNearEndFrame("mic-1"),
        sampleNearEndFrame("mic-2"),
        sampleNearEndFrame("mic-3")
      ],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl,
      stt,
      tts,
      playback,
      piAgent: {
        prompt: (input) => {
          agentPrompts.push(input.text);
          return Promise.resolve({ text: "予定を確認します。" });
        }
      }
    });

    expect(result).toEqual({
      processedFrames: 3,
      startedSessions: 1,
      completedTurns: 1,
      enqueuedCutoffs: 0,
      failedCutoffs: 0,
      failedFrames: 0,
      failedTurns: 0,
      suppressedFrames: 0
    });
    expect(agentPrompts).toEqual(["今日の予定は？"]);
    expect(lifecycle.read("session-1")?.entries).toEqual([
      {
        id: "session-1-entry-1",
        role: "staff",
        content: "今日の予定は？"
      },
      {
        id: "session-1-entry-2",
        role: "assistant",
        content: "予定を確認します。"
      }
    ]);
    expect(echoCalls).toEqual(["near:mic-1", "near:mic-2", "near:mic-3", "far:tts-0"]);
    expect(playbackCalls.map((call) => call.startedAt)).toEqual(["2026-06-18T00:00:00.000Z"]);
    expect(playbackCalls.map((call) => call.farEndReferenceCountAtPlayback)).toEqual([1]);
    expect(farEndFrames.map((frame) => frame.capturedAt)).toEqual(["2026-06-18T00:00:00.000Z"]);
  });

  it("cuts off and enqueues an active session during shutdown cleanup", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const enqueuedSessions: string[] = [];
    let disposedAll = 0;

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createIdleEchoControl(),
        stt: (() => {
          const texts = ["ピコ", "終了前の会話です。"];

          return {
            warmup: () => {
              throw new Error("warmup is not part of resident runtime");
            },
            transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
          };
        })(),
        tts: createSuccessfulTts("はい。"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => Promise.resolve({ text: "はい。" }),
          disposeAll: () => {
            disposedAll += 1;
          }
        },
        memoryWorker: {
          enqueueCutoff: (cutoff) => {
            enqueuedSessions.push(cutoff.sessionId);

            return {
              id: 99,
              sessionId: cutoff.sessionId,
              status: "queued",
              sourceEntryCount: cutoff.entries.length,
              queuedAt: "2026-06-18T00:00:00.000Z",
              processingStartedAt: undefined,
              processedAt: undefined
            };
          }
        }
      })
    ).resolves.toMatchObject({
      enqueuedCutoffs: 1
    });

    expect(enqueuedSessions).toEqual(["session-1"]);
    expect(lifecycle.read("session-1")).toBeUndefined();
    expect(disposedAll).toBe(1);
  });

  it("does not send suppressed microphone frames to STT", async () => {
    let sttCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-1")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createSuppressingEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          sttCalls += 1;
          throw new Error("suppressed frames must not be transcribed");
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("suppressed frames must not reach Pi Agent");
        }
      }
    });

    expect(sttCalls).toBe(0);
    expect(result.suppressedFrames).toBe(1);
    expect(result.completedTurns).toBe(0);
  });

  it("enqueues ended sessions before acknowledging cutoff cleanup", async () => {
    const calls: string[] = [];
    const lifecycle = createOrderingLifecycle(calls);

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      endedSessionIds: ["session-ended"],
      echoControl: createIdleEchoControl(),
      stt: successfulStt(""),
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("no turn is expected");
        }
      },
      memoryWorker: {
        enqueueCutoff: (cutoff) => {
          calls.push(`enqueue:${cutoff.sessionId}`);
          return {
            id: 42,
            sessionId: cutoff.sessionId,
            status: "queued",
            sourceEntryCount: cutoff.entries.length,
            queuedAt: "2026-06-18T00:00:00.000Z",
            processingStartedAt: undefined,
            processedAt: undefined
          };
        }
      }
    });

    expect(calls).toEqual([
      "read:session-ended",
      "cutoff:session-ended",
      "enqueue:session-ended",
      "ack:session-ended"
    ]);
    expect(result.enqueuedCutoffs).toBe(1);
  });

  it("keeps ended sessions unacknowledged and keeps running when memory enqueue fails", async () => {
    const calls: string[] = [];
    const lifecycle = createOrderingLifecycle(calls);

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("mic-after-failed-cutoff")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        endedSessionIds: ["session-ended"],
        echoControl: createIdleEchoControl(),
        stt: successfulStt(""),
        tts: createSuccessfulTts("unused"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => {
            throw new Error("no turn is expected");
          }
        },
        memoryWorker: {
          enqueueCutoff: () => {
            calls.push("enqueue:failed");
            throw new Error("queue full");
          }
        }
      })
    ).resolves.toMatchObject({
      processedFrames: 1,
      failedCutoffs: 4
    });

    expect(calls).toEqual([
      "read:session-ended",
      "cutoff:session-ended",
      "enqueue:failed",
      "read:session-ended",
      "cutoff:session-ended",
      "enqueue:failed",
      "read:session-ended",
      "cutoff:session-ended",
      "enqueue:failed",
      "read:session-ended",
      "cutoff:session-ended",
      "enqueue:failed"
    ]);
  });

  it("records probe events without transcript payloads", async () => {
    const audit = createStructuredAuditLog();

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-1")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createPassingEchoControl([], []),
      stt: successfulStt("ピコ"),
      tts: createSuccessfulTts("はい。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "はい。" })
      },
      probe: { audit }
    });

    expect(audit.entries().map((entry) => entry.name)).toContain("voice.runtime.stage");
    expect(JSON.stringify(audit.entries())).not.toContain("ピコ");
  });

  it("does not start a session from low-confidence trigger transcripts", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-low-confidence")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      minTriggerConfidence: 0.7,
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ", 0.2),
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("low-confidence trigger must not reach Pi Agent");
        }
      }
    });

    expect(result.startedSessions).toBe(0);
    expect(lifecycle.read("session-1")).toBeUndefined();
  });

  it("continues listening after STT failures", async () => {
    let sttCalls = 0;

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [
          sampleNearEndFrame("mic-stt-fails"),
          sampleNearEndFrame("mic-stt-trigger"),
          sampleNearEndFrame("mic-stt-recovers")
        ],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createIdleEchoControl(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => {
            sttCalls += 1;

            if (sttCalls === 1) {
              return Promise.resolve({
                ok: false,
                reason: "backend_error",
                message: "sidecar unavailable",
                source: {
                  sidecarId: "local-mlx-whisper",
                  provider: "mlx-whisper",
                  modelRepo: "mlx-community/whisper-large-v3-turbo"
                }
              });
            }

            return Promise.resolve(successfulTranscript("ピコ"));
          }
        },
        tts: createSuccessfulTts("はい。"),
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => Promise.resolve({ text: "はい。" })
        }
      })
    ).resolves.toMatchObject({
      processedFrames: 3,
      failedFrames: 1,
      completedTurns: 1
    });
  });

  it("continues listening after TTS failures", async () => {
    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [
          sampleNearEndFrame("mic-tts-trigger"),
          sampleNearEndFrame("mic-tts-fails"),
          sampleNearEndFrame("mic-next")
        ],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createIdleEchoControl(),
        stt: successfulStt("ピコ"),
        tts: {
          synthesize: () =>
            Promise.resolve({
              ok: false,
              reason: "backend_error",
              message: "aivis unavailable",
              sentenceIndex: 0,
              source: {
                serviceId: "local-aivis",
                provider: "aivis-speech",
                speakerId: 888_753_760
              }
            })
        },
        playback: {
          play: () => Promise.resolve()
        },
        piAgent: {
          prompt: () => Promise.resolve({ text: "はい。" })
        }
      })
    ).resolves.toMatchObject({
      processedFrames: 3,
      failedTurns: 2
    });
  });
});

function createPassingEchoControl(
  calls: string[],
  farEndFrames: VoicePcmFrame[]
): EchoControlProvider {
  return {
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
      return Promise.resolve({
        action: "pass",
        reason: "aec_processed",
        frame,
        diagnostics: {
          provider: "web_rtc_aec3",
          residualEchoProbability: 0.1,
          voiceActivity: true
        }
      });
    },
    flush: () => Promise.resolve()
  };
}

function createSuppressingEchoControl(): EchoControlProvider {
  return {
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
}

function createIdleEchoControl(): EchoControlProvider {
  return createPassingEchoControl([], []);
}

function createCleanupTrackingEchoControl(events: string[]): EchoControlProvider {
  return {
    ...createIdleEchoControl(),
    flush: () => {
      events.push("echo:flush");
      return Promise.resolve();
    }
  };
}

function createSuccessfulTts(text: string): TtsClient {
  return {
    synthesize: () =>
      Promise.resolve({
        ok: true,
        chunks: [
          {
            sentenceIndex: 0,
            text,
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

function successfulStt(text: string, confidence = 0.9): SttClient {
  return {
    warmup: () => {
      throw new Error("warmup is not part of resident runtime");
    },
    transcribe: () => Promise.resolve(successfulTranscript(text, confidence))
  };
}

function successfulTranscript(text: string, confidence = 0.9) {
  return {
    ok: true as const,
    text,
    language: "ja",
    confidence,
    durationMs: 100,
    segments: [],
    source: {
      sidecarId: "local-mlx-whisper",
      provider: "mlx-whisper" as const,
      modelRepo: "mlx-community/whisper-large-v3-turbo"
    }
  };
}

function sampleNearEndFrame(id: string): VoicePcmFrame {
  return {
    id,
    direction: "near_end",
    audio: new Uint8Array([4, 5, 6]),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt: "2026-06-18T00:00:00.000Z",
    durationMs: 100
  };
}

function* abortingFrames(abortController: AbortController): Iterable<VoicePcmFrame> {
  yield speechFrame("speech-before-abort-1", 0);
  yield speechFrame("speech-before-abort-2", 10);
  abortController.abort();
  yield speechFrame("speech-after-abort", 20);
}

function speechFrame(id: string, offsetMs: number): VoicePcmFrame {
  return pcmFrame(id, offsetMs, 3_000);
}

function silenceFrame(id: string, offsetMs: number): VoicePcmFrame {
  return pcmFrame(id, offsetMs, 0);
}

function pcmFrame(id: string, offsetMs: number, sample: number): VoicePcmFrame {
  const sampleRateHz = 16_000;
  const durationMs = 10;
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  const audio = new Uint8Array(sampleCount * 2);

  for (let index = 0; index < audio.length; index += 2) {
    audio[index] = sample & 0xff;
    audio[index + 1] = (sample >> 8) & 0xff;
  }

  return {
    id,
    direction: "near_end",
    audio,
    encoding: "pcm16le",
    sampleRateHz,
    channels: 1,
    capturedAt: addTestMilliseconds("2026-06-18T00:00:00.000Z", offsetMs),
    durationMs
  };
}

function fixedNow(): () => string {
  return () => "2026-06-18T00:00:00.000Z";
}

function testUtteranceWindow() {
  return {
    minSpeechMs: 20,
    silenceMs: 20,
    maxUtteranceMs: 1_000,
    minRmsDb: -50
  };
}

function perFrameCompatibleUtteranceWindow() {
  return {
    minSpeechMs: 1,
    silenceMs: 1,
    maxUtteranceMs: 100,
    minRmsDb: -120
  };
}

function addTestMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function createOrderingLifecycle(calls: string[]): SessionLifecycle {
  return {
    start: () => {
      throw new Error("start is not expected");
    },
    read: (id) => {
      calls.push(`read:${id}`);
      return {
        id,
        state: "ended",
        startedAt: "2026-06-18T00:00:00.000Z",
        endedAt: "2026-06-18T00:01:00.000Z",
        trigger: {
          kind: "wake_name",
          label: "ピコ",
          source: "voice"
        },
        entries: [
          {
            id: `${id}-entry-1`,
            role: "staff",
            content: "記憶化する会話です。"
          }
        ]
      };
    },
    appendEntry: () => {
      throw new Error("append is not expected");
    },
    end: (id) => {
      calls.push(`end:${id}`);

      return {
        id,
        state: "ended",
        startedAt: "2026-06-18T00:00:00.000Z",
        endedAt: "2026-06-18T00:01:00.000Z",
        trigger: {
          kind: "wake_name",
          label: "ピコ",
          source: "voice"
        },
        entries: []
      };
    },
    cutoff: (id) => {
      calls.push(`cutoff:${id}`);
      return {
        sessionId: id,
        cutoffAt: "2026-06-18T00:01:00.000Z",
        sourceEntryIds: [`${id}-entry-1`],
        entries: [
          {
            id: `${id}-entry-1`,
            role: "staff",
            content: "記憶化する会話です。"
          }
        ],
        requestedBy: "session_lifecycle"
      };
    },
    acknowledgeCutoff: (id) => {
      calls.push(`ack:${id}`);
    }
  };
}
