import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createSessionLifecycle, type SessionLifecycle } from "../src/modules/session/index.js";
import {
  createHalfDuplexEchoControl,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../src/modules/voice/echo-control.js";
import type { SttClient, TtsAudioChunk, TtsClient } from "../src/modules/voice/index.js";
import {
  runVoiceResidentRuntime,
  type VoicePlaybackSink,
  type VoiceResidentActivationSource
} from "../src/runtime/voice-resident.js";

describe("voice resident runtime", () => {
  it("shows the waiting phase when the resident capture loop starts", async () => {
    const phases: string[] = [];

    await runVoiceResidentRuntime({
      frames: [],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 60_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("unused"),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: { prompt: () => Promise.resolve({ text: "unused" }) },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "待機中です。",
        close: () => undefined
      }
    });

    expect(phases).toEqual(["waiting"]);
  });

  it("returns to waiting without projecting unaddressed speech when the wake name does not match", async () => {
    const phases: string[] = [];
    const acceptedTranscripts: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("unaddressed")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("キコ聞こえていますか"),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: { prompt: () => Promise.resolve({ text: "unused" }) },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: (text) => acceptedTranscripts.push(text),
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "待機中です。",
        close: () => undefined
      }
    });

    expect(phases).toEqual(["waiting", "transcribing", "waiting"]);
    expect(acceptedTranscripts).toEqual([]);
  });

  it("finalizes an ended interaction without memory processing", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const calls: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "この会話は終わりです。"];
        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("はい。"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          lifecycle.end("session-1");
          return Promise.resolve({ text: "はい。" });
        },
        disposeSession: async (sessionId) => {
          calls.push(`dispose:${sessionId}:start`);
          await Promise.resolve();
          calls.push(`dispose:${sessionId}:end`);
        }
      },
      deferredTools: {
        collectDeliverableResults: () => [],
        cancelSession: (sessionId, reason) => {
          calls.push(`cancel:${sessionId}:${reason}`);
        }
      }
    });

    expect(result).not.toHaveProperty("processedCutoffs");
    expect(result).not.toHaveProperty("failedCutoffs");
    expect(calls).toEqual([
      "cancel:session-1:session_closed",
      "dispose:session-1:start",
      "dispose:session-1:end"
    ]);
    expect(lifecycle.read("session-1")).toBeUndefined();
  });

  it("waits for Pi disposal when an active interaction disappears before collection", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const disposal = createPromiseGate();
    const disposalStarted = createPromiseGate();

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "終了済みです。"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("はい。"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          lifecycle.end("session-1");
          lifecycle.remove("session-1");

          return Promise.resolve({ text: "はい。" });
        },
        disposeSession: async () => {
          disposalStarted.release();
          await disposal.promise;
        }
      }
    });

    await disposalStarted.promise;
    const settlement = await Promise.race([
      runtime.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0))
    ]);
    disposal.release();
    await runtime;

    expect(settlement).toBe("pending");
  });

  it("waits for Pi disposal when an active interaction disappears during shutdown", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const disposal = createPromiseGate();
    const disposalStarted = createPromiseGate();
    const frames = (function* () {
      yield sampleNearEndFrame("mic-trigger");
      lifecycle.end("session-1");
      lifecycle.remove("session-1");
      throw new Error("frame source failed");
    })();

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ"),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          throw new Error("wake-only shutdown should not prompt Pi Agent");
        },
        disposeSession: async () => {
          disposalStarted.release();
          await disposal.promise;
        }
      }
    });
    const runtimeOutcome = runtime.then(
      () => "resolved" as const,
      (error: unknown) => error
    );

    await disposalStarted.promise;
    const settlement = await Promise.race([
      runtimeOutcome,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0))
    ]);
    disposal.release();
    const error = await runtimeOutcome;

    expect(settlement).toBe("pending");
    expect(error).toEqual(new Error("frame source failed"));
  });

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

  it("does not send known no-speech hallucination transcripts to Pi Agent during an active session", async () => {
    let piAgentCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        sampleNearEndFrameAt("wake", 0),
        sampleNearEndFrameAt("hallucinated-no-speech", 1_000)
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
      stt: (() => {
        const texts = ["ピコ", "ご視聴ありがとうございました"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          piAgentCalls += 1;
          throw new Error("no-speech hallucination must not reach Pi Agent");
        }
      },
      wakeAcknowledgement: {
        enabled: false
      }
    });

    expect(result.startedSessions).toBe(1);
    expect(result.completedTurns).toBe(0);
    expect(piAgentCalls).toBe(0);
  });

  it("restores the listening phase after failed, empty, and hallucinated STT results", async () => {
    const phases: string[] = [];
    const acceptedTranscripts: string[] = [];
    let sttCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        sampleNearEndFrame("wake"),
        sampleNearEndFrame("stt-failure"),
        sampleNearEndFrame("empty"),
        sampleNearEndFrame("hallucination")
      ],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          sttCalls += 1;

          if (sttCalls === 1) {
            return Promise.resolve(successfulTranscript("ピコ"));
          }

          if (sttCalls === 2) {
            return Promise.resolve({
              ok: false as const,
              reason: "backend_error" as const,
              message: "sidecar unavailable",
              source: {
                sidecarId: "local-apple-speech",
                provider: "apple-speech" as const,
                language: "ja-JP"
              }
            });
          }

          return Promise.resolve(
            successfulTranscript(sttCalls === 3 ? "" : "ご視聴ありがとうございました")
          );
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          throw new Error("wake-only and unusable speech must not prompt Pi Agent");
        }
      },
      wakeAcknowledgement: { enabled: false },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: (text) => acceptedTranscripts.push(text),
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "聞き取り中です。",
        close: () => undefined
      }
    });

    expect(result.failedFrames).toBe(1);
    expect(acceptedTranscripts).toEqual(["ピコ"]);
    expect(phases).toEqual([
      "waiting",
      "transcribing",
      "listening",
      "transcribing",
      "listening",
      "transcribing",
      "listening",
      "transcribing",
      "listening"
    ]);
  });

  it("does not send echo-passed frames to STT when the speech gate rejects them", async () => {
    let sttCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [speechFrame("trigger", 0), speechFrame("noise-after-trigger", 1_000)],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      speechActivity: {
        process: (() => {
          const values = [true, false];

          return () =>
            Promise.resolve({
              speech: values.shift() ?? false,
              provider: "energy" as const,
              rmsDb: -20
            });
        })()
      },
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          sttCalls += 1;
          return Promise.resolve(successfulTranscript("ピコ"));
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("speech-gated noise must not reach Pi Agent");
        }
      },
      wakeAcknowledgement: {
        enabled: false
      }
    });

    expect(sttCalls).toBe(1);
    expect(result.startedSessions).toBe(1);
    expect(result.completedTurns).toBe(0);
  });

  it("does not accept a pending utterance after shutdown begins", async () => {
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

    expect(transcribedDurations).toEqual([]);
  });

  it("does not accept an addressed transcript returned after shutdown begins", async () => {
    const abortController = new AbortController();
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const transcriptionStarted = createPromiseGate();
    const finishTranscription = createPromiseGate();
    const startedSessions: string[] = [];
    const acceptedTranscripts: string[] = [];
    const prompts: string[] = [];
    const terminalStates: string[] = [];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("addressed")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        start(trigger) {
          const session = lifecycle.start(trigger);
          startedSessions.push(session.id);
          return session;
        }
      },
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        async transcribe() {
          transcriptionStarted.release();
          await finishTranscription.promise;
          return successfulTranscript("ピコ、確認して");
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "unused" });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: (text) => acceptedTranscripts.push(text),
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "待機中です。",
        close: () => undefined
      },
      signal: abortController.signal
    });

    await transcriptionStarted.promise;
    abortController.abort();
    finishTranscription.release();
    await expect(runtime).rejects.toThrow("pico resident voice runtime aborted");

    expect(startedSessions).toEqual([]);
    expect(acceptedTranscripts).toEqual([]);
    expect(prompts).toEqual([]);
    expect(terminalStates).toEqual([]);
  });

  it("runs shutdown cleanup without transcribing pending audio after abort", async () => {
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
        signal: abortController.signal
      })
    ).rejects.toThrow("pico resident voice runtime aborted");

    expect(events).toEqual(["pi:disposeAll", "echo:flush"]);
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
        }
      })
    ).rejects.toThrow("dispose failed");

    expect(events).toEqual(["pi:disposeAll", "echo:flush"]);
  });

  it("preserves every shutdown cleanup failure", async () => {
    const events: string[] = [];
    const error = await runVoiceResidentRuntime({
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
          throw new Error("Pi cleanup failed");
        }
      },
      deferredTools: {
        collectDeliverableResults: () => [],
        waitForIdle: () => {
          events.push("deferred:wait");
          throw new Error("deferred cleanup failed");
        }
      }
    }).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(
      (error as AggregateError).errors.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)
      )
    ).toEqual(["Pi cleanup failed", "deferred cleanup failed"]);
    expect(events).toEqual(["pi:disposeAll", "deferred:wait", "echo:flush"]);
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
      failedFrames: 0,
      failedTurns: 0,
      suppressedFrames: 0
    });
    expect(agentPrompts).toEqual(["今日の予定は？"]);
    expect(lifecycle.read("session-1")).toBeUndefined();
    expect(echoCalls).toEqual(["near:mic-1", "near:mic-2", "near:mic-3", "far:tts-0"]);
    expect(playbackCalls.map((call) => call.startedAt)).toEqual(["2026-06-18T00:00:00.000Z"]);
    expect(playbackCalls.map((call) => call.farEndReferenceCountAtPlayback)).toEqual([1]);
    expect(farEndFrames.map((frame) => frame.capturedAt)).toEqual(["2026-06-18T00:00:00.000Z"]);
  });

  it("records active input and Pi Agent response metadata without duplicating text", async () => {
    const logEvents: unknown[] = [];

    await runVoiceResidentRuntime({
      now: sequenceNow([
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.250Z",
        "2026-06-18T00:00:00.250Z",
        "2026-06-18T00:00:00.250Z"
      ]),
      monotonicNow: sequenceNumber([1_000, 1_250]),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "今日はテストです"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("了解です。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "了解です。" })
      },
      log: {
        record: (event) => {
          logEvents.push(event);
        }
      }
    });

    expect(logEvents).toEqual([
      {
        kind: "staff_input",
        occurredAt: "2026-06-18T00:00:00.000Z",
        sessionId: "session-1"
      },
      {
        kind: "pi_agent_response",
        occurredAt: "2026-06-18T00:00:00.250Z",
        sessionId: "session-1",
        durationMs: 250
      }
    ]);
    expect(JSON.stringify(logEvents)).not.toContain("今日はテストです");
    expect(JSON.stringify(logEvents)).not.toContain("了解です。");
    expect(JSON.stringify(logEvents)).not.toContain('"text"');
  });

  it("passes deliverable deferred tool results separately from the active turn transcript", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const deferredResult = {
      jobId: "deferred-job-1",
      kind: "camera_scene_description" as const,
      status: "completed" as const,
      capturedAt: "2026-06-18T00:00:02.000Z",
      completedAt: "2026-06-18T00:00:03.000Z",
      summary: "撮影時点では机の上に教材が見えました。"
    };
    const prompts: Array<{
      readonly text: string;
      readonly deferredToolResults: unknown;
    }> = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "それで、さっきの確認は？"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("確認結果を伝えます。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          prompts.push({
            text: input.text,
            deferredToolResults: input.deferredToolResults
          });
          return Promise.resolve({ text: "確認結果を伝えます。" });
        }
      },
      deferredTools: {
        collectDeliverableResults: (input) => {
          expect(input).toMatchObject({
            sessionId: "session-1",
            activeSessionId: "session-1"
          });

          return [deferredResult];
        }
      }
    });

    expect(prompts).toEqual([
      {
        text: "それで、さっきの確認は？",
        deferredToolResults: [deferredResult]
      }
    ]);
    expect(lifecycle.read("session-1")).toBeUndefined();
  });

  it("does not acknowledge deferred tool delivery when the Pi Agent turn fails", async () => {
    let acknowledged: readonly string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "結果は？"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          if (input.text === "ピコ") {
            return Promise.resolve({ text: "はい。" });
          }

          throw new Error("model unavailable");
        }
      },
      deferredTools: {
        collectDeliverableResults: () => [
          {
            jobId: "deferred-job-1",
            kind: "camera_scene_description",
            status: "completed",
            capturedAt: "2026-06-18T00:00:02.000Z",
            completedAt: "2026-06-18T00:00:03.000Z",
            summary: "撮影時点では机の上に教材が見えました。"
          }
        ],
        acknowledgeDelivered: (jobIds) => {
          acknowledged = jobIds;
        }
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(acknowledged).toEqual([]);
  });

  it("keeps the completed turn when deferred delivery acknowledgement fails", async () => {
    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "結果は？"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("確認しました。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "確認しました。" })
      },
      deferredTools: {
        collectDeliverableResults: () => [
          {
            jobId: "deferred-job-1",
            kind: "camera_scene_description",
            status: "completed",
            capturedAt: "2026-06-18T00:00:02.000Z",
            completedAt: "2026-06-18T00:00:03.000Z",
            summary: "撮影時点では机の上に教材が見えました。"
          }
        ],
        acknowledgeDelivered: () => {
          throw new Error("deferred acknowledgement store unavailable");
        }
      }
    });

    expect(result.completedTurns).toBe(1);
    expect(result.failedTurns).toBe(0);
  });

  it("does not acknowledge deferred tool delivery when TTS synthesis fails", async () => {
    let acknowledged: readonly string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "結果は？"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
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
        prompt: () => Promise.resolve({ text: "確認しました。" })
      },
      deferredTools: {
        collectDeliverableResults: () => [
          {
            jobId: "deferred-job-1",
            kind: "camera_scene_description",
            status: "completed",
            capturedAt: "2026-06-18T00:00:02.000Z",
            completedAt: "2026-06-18T00:00:03.000Z",
            summary: "撮影時点では机の上に教材が見えました。"
          }
        ],
        acknowledgeDelivered: (jobIds) => {
          acknowledged = jobIds;
        }
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(acknowledged).toEqual([]);
  });

  it("does not acknowledge deferred tool delivery when TTS playback fails", async () => {
    let acknowledged: readonly string[] = [];

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 60_000
          }
        }),
        echoControl: createIdleEchoControl(),
        stt: (() => {
          const texts = ["ピコ", "結果は？"];

          return {
            warmup: () => {
              throw new Error("warmup is not part of resident runtime");
            },
            transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
          };
        })(),
        tts: createSuccessfulTts("確認しました。"),
        playback: {
          play: () => Promise.reject(new Error("speaker unavailable"))
        },
        piAgent: {
          prompt: () => Promise.resolve({ text: "確認しました。" })
        },
        deferredTools: {
          collectDeliverableResults: () => [
            {
              jobId: "deferred-job-1",
              kind: "camera_scene_description",
              status: "completed",
              capturedAt: "2026-06-18T00:00:02.000Z",
              completedAt: "2026-06-18T00:00:03.000Z",
              summary: "撮影時点では机の上に教材が見えました。"
            }
          ],
          acknowledgeDelivered: (jobIds) => {
            acknowledged = jobIds;
          }
        }
      })
    ).resolves.toMatchObject({ failedTurns: 1, completedTurns: 0 });

    expect(acknowledged).toEqual([]);
  });

  it("cancels deferred tool jobs when an active session closes", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const cancelled: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "この会話は終わりです。"];

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
        prompt: () => {
          lifecycle.end("session-1");

          return Promise.resolve({ text: "はい。" });
        }
      },
      deferredTools: {
        collectDeliverableResults: () => [],
        cancelSession: (sessionId, reason) => {
          cancelled.push(`${sessionId}:${reason}`);
        }
      }
    });

    expect(cancelled).toEqual(["session-1:session_closed"]);
  });

  it("keeps active session close cleanup running when deferred cancellation fails", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createIdleEchoControl(),
        stt: (() => {
          const texts = ["ピコ", "この会話は終わりです。"];

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
          prompt: () => {
            lifecycle.end("session-1");

            return Promise.resolve({ text: "はい。" });
          }
        },
        deferredTools: {
          collectDeliverableResults: () => [],
          cancelSession: () => {
            throw new Error("deferred cancellation store unavailable");
          }
        }
      })
    ).resolves.toMatchObject({
      completedTurns: 1,
      failedTurns: 0
    });
  });

  it("drains deferred tool jobs during shutdown cleanup before returning", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const events: string[] = [];
    let resolveIdle: (() => void) | undefined;

    await runVoiceResidentRuntime({
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
        prompt: () => Promise.resolve({ text: "はい。" })
      },
      deferredTools: {
        collectDeliverableResults: () => [],
        cancelSession: (sessionId, reason) => {
          events.push(`cancel:${sessionId}:${reason}`);
        },
        waitForIdle: () =>
          new Promise<void>((resolve) => {
            events.push("wait:start");
            resolveIdle = () => {
              events.push("wait:done");
              resolve();
            };
            queueMicrotask(() => resolveIdle?.());
          })
      }
    });

    expect(events).toEqual(["cancel:session-1:session_closed", "wait:start", "wait:done"]);
  });

  it("measures Pi Agent response duration with monotonic time instead of wall-clock timestamps", async () => {
    const logEvents: unknown[] = [];

    await runVoiceResidentRuntime({
      now: sequenceNow([
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:10.000Z",
        "2026-06-18T00:00:08.000Z",
        "2026-06-18T00:00:08.000Z",
        "2026-06-18T00:00:08.000Z"
      ]),
      monotonicNow: sequenceNumber([1_000, 1_123]),
      frames: [
        sampleNearEndFrameAt("mic-trigger", 10_000),
        sampleNearEndFrameAt("mic-turn", 10_000)
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
      stt: (() => {
        const texts = ["ピコ", "今日はテストです"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("了解です。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "了解です。" })
      },
      log: {
        record: (event) => {
          logEvents.push(event);
        }
      }
    });

    expect(logEvents).toContainEqual({
      kind: "pi_agent_response",
      occurredAt: "2026-06-18T00:00:08.000Z",
      sessionId: "session-1",
      durationMs: 123
    });
  });

  it("keeps active voice turns running when resident logging fails", async () => {
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    let playbackCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "今日はテストです"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: () => {
          playbackCalls += 1;
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "了解です。" });
        }
      },
      log: {
        record: () => {
          throw new Error("log sink unavailable");
        }
      }
    });

    expect(result.completedTurns).toBe(1);
    expect(result.failedTurns).toBe(0);
    expect(prompts).toEqual(["今日はテストです"]);
    expect(spokenTexts).toEqual(["了解です。"]);
    expect(playbackCalls).toBe(1);
  });

  it("generates and speaks a wake acknowledgement through Pi Agent after a trigger starts a session", async () => {
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const logEvents: unknown[] = [];
    const calls: string[] = [];
    const phases: string[] = [];
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });

    const result = await runVoiceResidentRuntime({
      now: sequenceNow([
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.180Z",
        "2026-06-18T00:00:00.180Z",
        "2026-06-18T00:00:00.180Z"
      ]),
      monotonicNow: sequenceNumber([2_000, 2_180]),
      frames: [sampleNearEndFrame("mic-trigger")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        suspendInactivity(id) {
          calls.push(`suspend:${id}`);
          return lifecycle.suspendInactivity(id);
        },
        resumeInactivity(id) {
          calls.push(`resume:${id}`);
          return lifecycle.resumeInactivity(id);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ"),
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: () => {
          calls.push("playback");
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          calls.push("prompt");
          prompts.push(input.text);
          return Promise.resolve({ text: "はい、聞いています。" });
        }
      },
      wakeAcknowledgement: {
        enabled: true
      },
      log: {
        record: (event) => {
          logEvents.push(event);
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "聞き取り中です。",
        close: () => undefined
      }
    });

    expect(result).toMatchObject({
      startedSessions: 1,
      completedTurns: 1,
      failedTurns: 0
    });
    expect(prompts).toEqual([
      'The user just woke you up by saying: "ピコ". Respond briefly in spoken Japanese to show you are listening. Do not answer a separate task yet.'
    ]);
    expect(spokenTexts).toEqual(["はい、聞いています。"]);
    expect(calls).toEqual(["suspend:session-1", "prompt", "playback", "resume:session-1"]);
    expect(phases.at(-1)).toBe("listening");
    expect(logEvents).toEqual([
      {
        kind: "wake_ack_input",
        occurredAt: "2026-06-18T00:00:00.000Z",
        sessionId: "session-1"
      },
      {
        kind: "wake_ack_response",
        occurredAt: "2026-06-18T00:00:00.180Z",
        sessionId: "session-1",
        durationMs: 180
      }
    ]);
    expect(JSON.stringify(logEvents)).not.toContain("The user just woke you up by saying");
    expect(JSON.stringify(logEvents)).not.toContain("はい、聞いています。");
    expect(JSON.stringify(logEvents)).not.toContain('"text"');
  });

  it("uses the request after the wake name as the first turn instead of discarding it", async () => {
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const acceptedTranscripts: string[] = [];
    const phases: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger-and-request")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、文書を作って"),
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          input.onProgress?.({ phase: "thinking" });
          return Promise.resolve({ text: "作りました。" });
        }
      },
      wakeAcknowledgement: { enabled: true },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: (text) => acceptedTranscripts.push(text),
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "待機中です。",
        close: () => undefined
      }
    });

    expect(result.completedTurns).toBe(1);
    expect(prompts).toEqual(["文書を作って"]);
    expect(spokenTexts).toEqual(["作りました。"]);
    expect(acceptedTranscripts).toEqual(["ピコ、文書を作って"]);
    expect(phases).toEqual(["waiting", "transcribing", "thinking", "speaking", "completed"]);
  });

  it("projects a failed voice turn before returning the active session to listening", async () => {
    const phases: string[] = [];
    const terminalStates: string[] = [];
    const spokenTexts: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("failed-request")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、失敗する作業"),
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        play: (chunk) => {
          spokenTexts.push(chunk.text);
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          input.onProgress?.({ phase: "thinking" });
          return Promise.reject(new Error("Pi unavailable"));
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(spokenTexts).toEqual(["ごめん、作業を続けられませんでした。"]);
    expect(terminalStates).toEqual(["failed"]);
    expect(phases).toEqual(["waiting", "transcribing", "thinking", "speaking", "error"]);
  });

  it("reports a preface synthesis failure as audio output failure without starting the tool", async () => {
    const phaseDetails: unknown[] = [];
    const terminalDetails: unknown[] = [];
    let toolStarts = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("preface-audio-failure")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、文書を作って"),
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
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: async (input) => {
          await input.beforeFirstTool?.("わかった。文書を作るね。");
          toolStarts += 1;
          return { text: "完了しました。" };
        }
      },
      monitor: {
        setPhase: (phase, detail) => phaseDetails.push({ phase, detail }),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state, detail) => terminalDetails.push({ state, detail }),
        describeCurrentWork: () => "準備中です。",
        close: () => undefined
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(toolStarts).toBe(0);
    expect(phaseDetails).toContainEqual({
      phase: "error",
      detail: { resumePhase: "listening", errorDetail: "audio_output" }
    });
    expect(terminalDetails).toEqual([{ state: "failed", detail: { reason: "audio_output" } }]);
  });

  it("reports a preface playback failure as audio output failure without starting the tool", async () => {
    const phaseDetails: unknown[] = [];
    const terminalDetails: unknown[] = [];
    let toolStarts = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("preface-playback-failure")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、文書を作って"),
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: { play: () => Promise.reject(new Error("speaker unavailable")) },
      piAgent: {
        prompt: async (input) => {
          await input.beforeFirstTool?.("わかった。文書を作るね。");
          toolStarts += 1;
          return { text: "完了しました。" };
        }
      },
      monitor: {
        setPhase: (phase, detail) => phaseDetails.push({ phase, detail }),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state, detail) => terminalDetails.push({ state, detail }),
        describeCurrentWork: () => "準備中です。",
        close: () => undefined
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(toolStarts).toBe(0);
    expect(phaseDetails).toContainEqual({
      phase: "error",
      detail: { resumePhase: "listening", errorDetail: "audio_output" }
    });
    expect(terminalDetails).toEqual([{ state: "failed", detail: { reason: "audio_output" } }]);
  });

  it("keeps listening when prompt failure acknowledgement audio also fails", async () => {
    const firstFailureObserved = createPromiseGate();
    const transcripts = ["ピコ、最初の作業", "次の作業"];
    const prompts: string[] = [];
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("first-request");
        await firstFailureObserved.promise;
        yield sampleNearEndFrame("second-request");
      }
    };

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) =>
          request.text === "ごめん、作業を続けられませんでした。"
            ? Promise.reject(new Error("failure acknowledgement audio unavailable"))
            : createSuccessfulTts(request.text).synthesize(request)
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return input.text === "最初の作業"
            ? Promise.reject(new Error("Pi unavailable"))
            : Promise.resolve({ text: "次の作業は完了しました。" });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => {
          if (state === "failed") {
            firstFailureObserved.release();
          }
        },
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    expect(result).toMatchObject({ failedTurns: 1, completedTurns: 1 });
    expect(prompts).toEqual(["最初の作業", "次の作業"]);
  });

  it("converges to failed when Pi reports a failed tool execution", async () => {
    const phases: string[] = [];
    const terminalStates: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("tool-failure")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、失敗するtoolを実行"),
      tts: createSuccessfulTts("toolが失敗しました。"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          input.onProgress?.({ phase: "working", toolName: "write" });
          input.onProgress?.({
            phase: "tool_finished",
            toolName: "write",
            succeeded: false
          });
          return Promise.resolve({ text: "toolが失敗しました。" });
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "writeが失敗しました。",
        close: () => undefined
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(terminalStates).toEqual(["failed"]);
    expect(phases.at(-1)).toBe("error");
  });

  it("answers status phrases from the latest terminal state without a new Pi turn", async () => {
    const firstTurnCompleted = createPromiseGate();
    const transcripts = ["ピコ、確認して", "今どう？", "まだ", "進み具合は", "状況教えて"];
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await firstTurnCompleted.promise;
        yield sampleNearEndFrame("status-now");
        yield sampleNearEndFrame("status-yet");
        yield sampleNearEndFrame("status-progress");
        yield sampleNearEndFrame("status-detail");
      }
    };

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "確認が完了しました。" });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => {
          if (state === "completed") {
            firstTurnCompleted.release();
          }
        },
        describeCurrentWork: () => "完了です。",
        close: () => undefined
      }
    });

    expect(prompts).toEqual(["確認して"]);
    expect(spokenTexts).toEqual([
      "確認が完了しました。",
      "直前の作業は完了しています。",
      "直前の作業は完了しています。",
      "直前の作業は完了しています。",
      "直前の作業は完了しています。"
    ]);
  });

  it("hides ambient speech when inactivity ends the session during transcription", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      });
      const transcriptionStarted = createPromiseGate();
      const finishTranscription = createPromiseGate();
      const transcripts = ["ピコ", "これは周囲の会話です"];
      const acceptedTranscripts: string[] = [];
      const prompts: string[] = [];
      const terminalStates: string[] = [];
      let sttCalls = 0;

      const runtime = runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("wake"), sampleNearEndFrame("ambient")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createIdleEchoControl(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          async transcribe() {
            sttCalls += 1;

            if (sttCalls === 2) {
              transcriptionStarted.release();
              await finishTranscription.promise;
            }

            return successfulTranscript(transcripts.shift() ?? "");
          }
        },
        tts: createSuccessfulTts("unused"),
        playback: { play: () => Promise.resolve() },
        piAgent: {
          prompt: (input) => {
            prompts.push(input.text);
            return Promise.resolve({ text: "unused" });
          }
        },
        wakeAcknowledgement: { enabled: false },
        monitor: {
          setPhase: () => undefined,
          showAcceptedTranscript: (text) => acceptedTranscripts.push(text),
          notifyTerminal: (state) => terminalStates.push(state),
          describeCurrentWork: () => "待機中です。",
          close: () => undefined
        }
      });

      await transcriptionStarted.promise;
      vi.advanceTimersByTime(300_000);
      expect(lifecycle.read("session-1")).toMatchObject({
        state: "ended",
        endReason: "inactivity"
      });
      finishTranscription.release();
      const result = await runtime;

      expect(result).toMatchObject({ startedSessions: 1, completedTurns: 0 });
      expect(acceptedTranscripts).toEqual(["ピコ"]);
      expect(prompts).toEqual([]);
      expect(terminalStates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new session when addressed speech returns after transcription-time inactivity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      });
      const transcriptionStarted = createPromiseGate();
      const finishTranscription = createPromiseGate();
      const transcripts = ["ピコ", "ピコ、再開して"];
      const prompts: string[] = [];
      let sttCalls = 0;

      const runtime = runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("wake"), sampleNearEndFrame("addressed")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createIdleEchoControl(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          async transcribe() {
            sttCalls += 1;

            if (sttCalls === 2) {
              transcriptionStarted.release();
              await finishTranscription.promise;
            }

            return successfulTranscript(transcripts.shift() ?? "");
          }
        },
        tts: createSuccessfulTts("再開しました。"),
        playback: { play: () => Promise.resolve() },
        piAgent: {
          prompt: (input) => {
            prompts.push(`${input.sessionId}:${input.text}`);
            return Promise.resolve({ text: "再開しました。" });
          }
        },
        wakeAcknowledgement: { enabled: false }
      });

      await transcriptionStarted.promise;
      vi.advanceTimersByTime(300_000);
      finishTranscription.release();
      const result = await runtime;

      expect(result).toMatchObject({ startedSessions: 2, completedTurns: 1 });
      expect(prompts).toEqual(["session-2:再開して"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts a full five-minute inactivity window after local terminal status playback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      });
      const firstTurnCompleted = createPromiseGate();
      const statusPlaybackStarted = createPromiseGate();
      const finishStatusPlayback = createPromiseGate();
      const statusHandled = createPromiseGate();
      const finishFrames = createPromiseGate();
      const transcripts = ["ピコ、確認して", "今どう？"];
      const phases: string[] = [];
      const frames = {
        async *[Symbol.asyncIterator]() {
          yield sampleNearEndFrame("request");
          await firstTurnCompleted.promise;
          vi.advanceTimersByTime(299_999);
          yield sampleNearEndFrame("terminal-status");
          statusHandled.release();
          await finishFrames.promise;
        }
      };

      const runtime = runVoiceResidentRuntime({
        now: fixedNow(),
        frames,
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createIdleEchoControl(),
        stt: {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
        },
        tts: {
          synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
        },
        playback: {
          async play(chunk) {
            if (chunk.text === "直前の作業は完了しています。") {
              statusPlaybackStarted.release();
              await finishStatusPlayback.promise;
            }
          }
        },
        piAgent: { prompt: () => Promise.resolve({ text: "確認が完了しました。" }) },
        monitor: {
          setPhase: (phase) => phases.push(phase),
          showAcceptedTranscript: () => undefined,
          notifyTerminal: (state) => {
            if (state === "completed") {
              firstTurnCompleted.release();
            }
          },
          describeCurrentWork: () => "完了です。",
          close: () => undefined
        }
      });

      await statusPlaybackStarted.promise;
      expect(lifecycle.read("session-1")?.state).toBe("active");

      vi.advanceTimersByTime(600_000);
      expect(lifecycle.read("session-1")?.state).toBe("active");

      finishStatusPlayback.release();
      await statusHandled.promise;
      expect(phases.at(-1)).toBe("listening");

      vi.advanceTimersByTime(299_999);
      expect(lifecycle.read("session-1")?.state).toBe("active");
      vi.advanceTimersByTime(1);
      expect(lifecycle.read("session-1")).toMatchObject({
        state: "ended",
        endReason: "inactivity"
      });

      finishFrames.release();
      await runtime;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports final TTS synthesis failure as an audio output failure", async () => {
    const phaseDetails: unknown[] = [];
    const terminalDetails: unknown[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("audio-output-failure")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、確認して"),
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
      playback: { play: () => Promise.resolve() },
      piAgent: { prompt: () => Promise.resolve({ text: "確認しました。" }) },
      monitor: {
        setPhase: (phase, detail) => phaseDetails.push({ phase, detail }),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state, detail) => terminalDetails.push({ state, detail }),
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    expect(result.failedTurns).toBe(1);
    expect(phaseDetails).toContainEqual({
      phase: "error",
      detail: { resumePhase: "listening", errorDetail: "audio_output" }
    });
    expect(terminalDetails).toEqual([{ state: "failed", detail: { reason: "audio_output" } }]);
  });

  it("reports a failed final playback and accepts the next utterance while capture stays open", async () => {
    const firstFailureObserved = createPromiseGate();
    const transcripts = ["ピコ、失敗する作業", "次は成功して"];
    const prompts: string[] = [];
    const terminalStates: string[] = [];
    const spokenTexts: string[] = [];
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("failed-request");
        await firstFailureObserved.promise;
        yield sampleNearEndFrame("successful-request");
      }
    };

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        play: (chunk) => {
          spokenTexts.push(chunk.text);

          return chunk.text === "最初の完了です。"
            ? Promise.reject(new Error("speaker unavailable"))
            : Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({
            text: input.text === "失敗する作業" ? "最初の完了です。" : "次は成功しました。"
          });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => {
          terminalStates.push(state);

          if (state === "failed") {
            firstFailureObserved.release();
          }
        },
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    expect(result).toMatchObject({ failedTurns: 1, completedTurns: 1 });
    expect(prompts).toEqual(["失敗する作業", "次は成功して"]);
    expect(spokenTexts).toEqual(["最初の完了です。", "次は成功しました。"]);
    expect(terminalStates).toEqual(["failed", "completed"]);
  });

  it("suspends inactivity for a Pi turn and resumes it after final playback", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const calls: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger-and-request")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        suspendInactivity(id) {
          calls.push(`suspend:${id}`);
          return lifecycle.suspendInactivity(id);
        },
        resumeInactivity(id) {
          calls.push(`resume:${id}`);
          return lifecycle.resumeInactivity(id);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、確認して"),
      tts: createSuccessfulTts("完了です。"),
      playback: {
        play: () => {
          calls.push("playback");
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: () => {
          calls.push("prompt");
          return Promise.resolve({ text: "完了です。" });
        }
      }
    });

    expect(calls).toEqual(["suspend:session-1", "prompt", "playback", "resume:session-1"]);
  });

  it("resumes inactivity only after the cancel acknowledgement finishes playing", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const acknowledgementStarted = createPromiseGate();
    const finishAcknowledgement = createPromiseGate();
    const calls: string[] = [];
    const transcripts = ["ピコ、長い作業をして", "やめて"];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("cancel")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        suspendInactivity(id) {
          calls.push(`suspend:${id}`);
          return lifecycle.suspendInactivity(id);
        },
        resumeInactivity(id) {
          calls.push(`resume:${id}`);
          return lifecycle.resumeInactivity(id);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        async play(chunk) {
          if (chunk.text !== "わかった。中止するね。") {
            return;
          }

          calls.push("ack:start");
          acknowledgementStarted.release();
          await finishAcknowledgement.promise;
          calls.push("ack:end");
        }
      },
      piAgent: {
        prompt: (input) =>
          new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          })
      }
    });

    await acknowledgementStarted.promise;
    expect(calls).toEqual(["suspend:session-1", "ack:start"]);

    finishAcknowledgement.release();
    await runtime;

    expect(calls).toEqual(["suspend:session-1", "ack:start", "ack:end", "resume:session-1"]);
  });

  it("continues with the next frame after cancel acknowledgement playback fails", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const promptStarted = createPromiseGate();
    const cancellationFailureObserved = createPromiseGate();
    const transcripts = ["ピコ、長い作業をして", "やめて", "次の作業をして"];
    const prompts: string[] = [];
    const sessionStates: Array<string | undefined> = [];
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await promptStarted.promise;
        yield sampleNearEndFrame("cancel");
        await cancellationFailureObserved.promise;
        yield sampleNearEndFrame("next-request");
      }
    };

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        play: (chunk) =>
          chunk.text === "わかった。中止するね。"
            ? Promise.reject(new Error("cancel acknowledgement speaker unavailable"))
            : Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          sessionStates.push(lifecycle.read("session-1")?.state);

          if (input.text === "次の作業をして") {
            return Promise.resolve({ text: "次の作業が終わりました。" });
          }

          promptStarted.release();
          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => {
          if (state === "failed") {
            cancellationFailureObserved.release();
          }
        },
        describeCurrentWork: () => "作業中です。",
        close: () => undefined
      }
    });

    expect(result).toMatchObject({ failedTurns: 1, completedTurns: 1 });
    expect(prompts).toEqual(["長い作業をして", "次の作業をして"]);
    expect(sessionStates).toEqual(["active", "active"]);
  });

  it("ends the session and plays farewell after busy end acknowledgement fails", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const transcripts = ["ピコ、長い作業をして", "じゃあね"];
    const farewellPromptText =
      "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic.";
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const endReasons: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("end")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        end(id, reason) {
          endReasons.push(reason ?? "explicit");
          return lifecycle.end(id, reason);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        play: (chunk) => {
          if (chunk.text === "わかった。作業を止めて終わりにするね。") {
            return Promise.reject(new Error("end acknowledgement speaker unavailable"));
          }

          spokenTexts.push(chunk.text);
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);

          if (input.text === farewellPromptText) {
            return Promise.resolve({ text: "またね。" });
          }

          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          });
        }
      },
      farewell: { enabled: true }
    });

    expect(prompts).toEqual(["長い作業をして", farewellPromptText]);
    expect(spokenTexts).toEqual(["またね。"]);
    expect(endReasons).toEqual(["explicit"]);
    expect(lifecycle.read("session-1")).toBeUndefined();
  });

  it("plays the Pi preface before tool work and reads the final response afterward", async () => {
    const calls: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger-and-request")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、文書を作って"),
      tts: {
        synthesize: (request) => {
          calls.push(`synthesize:${request.text}`);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: () => {
          calls.push("playback");
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: async (input) => {
          await input.beforeFirstTool?.("わかった。文書を作るね。");
          calls.push("tool");
          return { text: "文書を作りました。" };
        }
      }
    });

    expect(calls).toEqual([
      "synthesize:わかった。文書を作るね。",
      "playback",
      "tool",
      "synthesize:文書を作りました。",
      "playback"
    ]);
  });

  it("keeps transcribing bounded status controls while a Pi turn is busy", async () => {
    const promptStarted = createPromiseGate();
    const promptCompletion = createPromiseGate();
    const statusSpoken = createPromiseGate();
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const phases: string[] = [];
    let sttCalls = 0;
    const transcripts = ["ピコ、長い作業をして", "今どう？"];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("status")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          sttCalls += 1;
          return Promise.resolve(successfulTranscript(transcripts.shift() ?? ""));
        }
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);

          if (request.text.includes("開始から12秒")) {
            statusSpoken.release();
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: async (input) => {
          prompts.push(input.text);
          input.onProgress?.({ phase: "working", toolName: "write" });
          promptStarted.release();
          await promptCompletion.promise;
          return { text: "作業が終わりました。" };
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "writeを実行中です。開始から12秒です。",
        close: () => undefined
      }
    });

    await promptStarted.promise;
    await statusSpoken.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observedWhileBusy = {
      sttCalls,
      prompts: [...prompts],
      spokenTexts: [...spokenTexts],
      lastPhase: phases.at(-1)
    };
    promptCompletion.release();
    await runtime;

    expect(observedWhileBusy.sttCalls).toBe(2);
    expect(observedWhileBusy.prompts).toEqual(["長い作業をして"]);
    expect(observedWhileBusy.spokenTexts).toContain(
      "writeを実行中です。開始から12秒です。終わったら声をかけます。"
    );
    expect(observedWhileBusy.lastPhase).toBe("working");
  });

  it("does not mark a successful Pi turn failed when busy status audio fails", async () => {
    const promptStarted = createPromiseGate();
    const promptCompletion = createPromiseGate();
    const statusFailed = createPromiseGate();
    const terminalStates: string[] = [];
    const transcripts = ["ピコ、長い作業をして", "今どう？"];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("status")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          if (request.text.endsWith("終わったら声をかけます。")) {
            statusFailed.release();
            return Promise.resolve({
              ok: false as const,
              reason: "backend_error" as const,
              message: "status synthesis unavailable",
              sentenceIndex: 0,
              source: {
                serviceId: "local-aivis",
                provider: "aivis-speech" as const,
                speakerId: 888_753_760
              }
            });
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: async () => {
          promptStarted.release();
          await promptCompletion.promise;
          return { text: "作業が終わりました。" };
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "writeを実行中です。開始から12秒です。",
        close: () => undefined
      }
    });

    await promptStarted.promise;
    await statusFailed.promise;
    promptCompletion.release();
    const result = await runtime;

    expect(result).toMatchObject({ completedTurns: 1, failedTurns: 1 });
    expect(terminalStates).toEqual(["completed"]);
  });

  it("refuses a new request while a Pi turn is busy", async () => {
    const promptCompletion = createPromiseGate();
    const refusalSpoken = createPromiseGate();
    const transcripts = ["ピコ、長い作業をして", "別の文書も作って"];
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const phases: string[] = [];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("new-request")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          if (request.text === "今の作業が終わってから、もう一度お願いしてね。") {
            refusalSpoken.release();
          }
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: async (input) => {
          prompts.push(input.text);
          input.onProgress?.({ phase: "thinking" });
          await promptCompletion.promise;
          return { text: "作業が終わりました。" };
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    await refusalSpoken.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prompts).toEqual(["長い作業をして"]);
    expect(spokenTexts).toContain("今の作業が終わってから、もう一度お願いしてね。");
    expect(phases.at(-1)).toBe("thinking");

    promptCompletion.release();
    await runtime;
  });

  it("cancels the active turn and ends the interaction on an explicit busy farewell", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const transcripts = ["ピコ、長い作業をして", "じゃあね"];
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const endedSessions: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("end")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        end(id) {
          endedSessions.push(id);
          return lifecycle.end(id);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);

          if (
            input.text ===
            "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic."
          ) {
            return Promise.resolve({ text: "またね。" });
          }

          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          });
        }
      },
      farewell: { enabled: true }
    });

    expect(prompts).toEqual([
      "長い作業をして",
      "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic."
    ]);
    expect(spokenTexts).toContain("わかった。作業を止めて終わりにするね。");
    expect(spokenTexts).toContain("またね。");
    expect(endedSessions).toContain("session-1");
  });

  it.each([
    {
      name: "keeps end sticky after a later cancel",
      controls: ["じゃあ終わり", "やめて"] as const,
      shouldEnd: true
    },
    {
      name: "keeps the session active after repeated cancel",
      controls: ["やめて", "やめて"] as const,
      shouldEnd: false
    },
    {
      name: "promotes cancel to end after a later end",
      controls: ["やめて", "じゃあ終わり"] as const,
      shouldEnd: true
    }
  ])("$name while Pi settlement is pending", async ({ controls, shouldEnd }) => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const promptStarted = createPromiseGate();
    const acknowledgementPlayed = createPromiseGate();
    const controlsHandled = createPromiseGate();
    const allowPiSettlement = createPromiseGate();
    const cancellationFinalized = createPromiseGate();
    const finishFrames = createPromiseGate();
    const transcripts = ["ピコ、長い作業をして", ...controls];
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const endReasons: string[] = [];
    const farewellPromptText =
      "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic.";
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await promptStarted.promise;
        yield sampleNearEndFrame("first-control");
        await acknowledgementPlayed.promise;
        yield sampleNearEndFrame("second-control");
        controlsHandled.release();
        await finishFrames.promise;
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: {
        ...lifecycle,
        end(id, reason) {
          endReasons.push(reason ?? "explicit");
          return lifecycle.end(id, reason);
        }
      },
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: (chunk) => {
          if (
            chunk.text === "わかった。中止するね。" ||
            chunk.text === "わかった。作業を止めて終わりにするね。"
          ) {
            acknowledgementPlayed.release();
          }

          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);

          if (input.text === farewellPromptText) {
            return Promise.resolve({ text: "またね。" });
          }

          promptStarted.release();
          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                allowPiSettlement.promise.then(
                  () => reject(new Error("aborted")),
                  (error: unknown) =>
                    reject(error instanceof Error ? error : new Error(String(error)))
                );
              },
              { once: true }
            );
          });
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => {
          if (state === "cancelled") {
            cancellationFinalized.release();
          }
        },
        describeCurrentWork: () => "作業中です。",
        close: () => undefined
      },
      farewell: { enabled: true }
    });

    await controlsHandled.promise;
    allowPiSettlement.release();
    await cancellationFinalized.promise;
    expect(lifecycle.read("session-1")?.state).toBe(shouldEnd ? "ended" : "active");

    finishFrames.release();
    await runtime;

    expect(prompts).toEqual(
      shouldEnd ? ["長い作業をして", farewellPromptText] : ["長い作業をして"]
    );
    expect(spokenTexts).toContain(
      controls[0] === "じゃあ終わり"
        ? "わかった。作業を止めて終わりにするね。"
        : "わかった。中止するね。"
    );
    expect(spokenTexts.includes("またね。")).toBe(shouldEnd);
    expect(endReasons).toEqual([shouldEnd ? "explicit" : "shutdown"]);
  });

  it("cancels a busy Pi turn once without starting a second prompt", async () => {
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const phases: string[] = [];
    const terminalStates: string[] = [];
    const transcripts = ["ピコ、長い作業をして", "やめて"];
    const cancelAcknowledgementPlayed = createPromiseGate();
    const allowPiSettlement = createPromiseGate();
    let abortEvents = 0;

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("cancel")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: (chunk) => {
          if (chunk.text === "わかった。中止するね。") {
            cancelAcknowledgementPlayed.release();
          }

          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);

          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                abortEvents += 1;
                allowPiSettlement.promise.then(
                  () => reject(new Error("aborted")),
                  (error: unknown) =>
                    reject(error instanceof Error ? error : new Error(String(error)))
                );
              },
              { once: true }
            );
          });
        }
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "作業中です。",
        close: () => undefined
      }
    });

    await cancelAcknowledgementPlayed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalStates).toEqual([]);
    expect(phases.at(-1)).toBe("cancelling");
    allowPiSettlement.release();
    await runtime;

    expect(prompts).toEqual(["長い作業をして"]);
    expect(abortEvents).toBe(1);
    expect(spokenTexts).toContain("わかった。中止するね。");
    expect(terminalStates).toEqual(["cancelled"]);
    expect(phases).toContain("cancelled");
  });

  it("suppresses late Pi progress and final speech after cancellation", async () => {
    const transcripts = ["ピコ、長い作業をして", "やめて"];
    const spokenTexts: string[] = [];
    const phases: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("cancel")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) =>
          new Promise((resolve) => {
            input.onProgress?.({ phase: "thinking" });
            input.signal?.addEventListener(
              "abort",
              () => {
                input.onProgress?.({ phase: "working", toolName: "late-write" });
                resolve({ text: "遅着した完了文" });
              },
              { once: true }
            );
          })
      },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "作業中です。",
        close: () => undefined
      }
    });

    expect(spokenTexts).toContain("わかった。中止するね。");
    expect(spokenTexts).not.toContain("遅着した完了文");
    expect(phases.slice(phases.indexOf("cancelling") + 1)).not.toContain("working");
  });

  it("cancels a final response while TTS synthesis is still running", async () => {
    const finalSynthesisStarted = createPromiseGate();
    const releaseFinalSynthesis = createPromiseGate();
    const cancelAcknowledgementPlayed = createPromiseGate();
    const transcripts = ["ピコ、確認して", "やめて"];
    const playedTexts: string[] = [];
    const terminalStates: string[] = [];
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await finalSynthesisStarted.promise;
        yield sampleNearEndFrame("cancel");
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        async synthesize(request) {
          if (request.text === "最終応答です。") {
            finalSynthesisStarted.release();
            await releaseFinalSynthesis.promise;
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: (chunk) => {
          playedTexts.push(chunk.text);

          if (chunk.text === "わかった。中止するね。") {
            cancelAcknowledgementPlayed.release();
          }

          return Promise.resolve();
        }
      },
      piAgent: { prompt: () => Promise.resolve({ text: "最終応答です。" }) },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    await cancelAcknowledgementPlayed.promise;
    expect(terminalStates).toEqual([]);
    releaseFinalSynthesis.release();
    await runtime;

    expect(playedTexts).toEqual(["わかった。中止するね。"]);
    expect(terminalStates).toEqual(["cancelled"]);
  });

  it("skips an aborted final response that is waiting in the playback queue", async () => {
    const unblockOutput = createPromiseGate();
    const finalPlaybackQueued = createPromiseGate();
    const cancelAcknowledgementSynthesized = createPromiseGate();
    const transcripts = ["ピコ、確認して", "やめて"];
    const playedTexts: string[] = [];
    let tail = unblockOutput.promise;
    let queuedOperations = 0;
    const outputQueue = {
      enqueue<T>(operation: () => Promise<T>): Promise<T> {
        queuedOperations += 1;

        if (queuedOperations === 1) {
          finalPlaybackQueued.release();
        }

        const result = tail.then(operation);
        tail = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      },
      drain: () => tail
    };
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await finalPlaybackQueued.promise;
        yield sampleNearEndFrame("cancel");
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          if (request.text === "わかった。中止するね。") {
            cancelAcknowledgementSynthesized.release();
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: (chunk) => {
          playedTexts.push(chunk.text);
          return Promise.resolve();
        }
      },
      piAgent: { prompt: () => Promise.resolve({ text: "最終応答です。" }) },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      },
      outputQueue
    });

    await cancelAcknowledgementSynthesized.promise;
    unblockOutput.release();
    await runtime;

    expect(playedTexts).toEqual(["わかった。中止するね。"]);
  });

  it("aborts an actively playing final response before the cancel acknowledgement", async () => {
    const finalPlaybackStarted = createPromiseGate();
    const stopFinalPlayback = createPromiseGate();
    const cancelAcknowledgementSynthesized = createPromiseGate();
    const transcripts = ["ピコ、確認して", "やめて"];
    const playedTexts: string[] = [];
    const terminalEvents: string[] = [];
    let finalPlaybackSignal: AbortSignal | undefined;
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await finalPlaybackStarted.promise;
        yield sampleNearEndFrame("cancel");
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          if (request.text === "わかった。中止するね。") {
            cancelAcknowledgementSynthesized.release();
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        async play(chunk, _startedAt, signal) {
          if (chunk.text === "最終応答です。") {
            finalPlaybackSignal = signal;
            finalPlaybackStarted.release();
            await stopFinalPlayback.promise;

            if (signal?.aborted) {
              throw new Error("playback aborted");
            }
          }

          playedTexts.push(chunk.text);
        }
      },
      piAgent: { prompt: () => Promise.resolve({ text: "最終応答です。" }) },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalEvents.push(`terminal:${state}`),
        describeCurrentWork: () => "考え中です。",
        close: () => undefined
      }
    });

    await finalPlaybackStarted.promise;
    await cancelAcknowledgementSynthesized.promise;
    const signalWasAborted = finalPlaybackSignal?.aborted === true;
    stopFinalPlayback.release();
    await runtime;

    expect(signalWasAborted).toBe(true);
    expect(playedTexts).toEqual(["わかった。中止するね。"]);
    expect(terminalEvents).toEqual(["terminal:cancelled"]);
  });

  it("ends an idle active interaction locally instead of sending the ending phrase as a task", async () => {
    const prompts: string[] = [];
    const transcripts = ["ピコ", "じゃあね"];
    const phases: string[] = [];

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("wake"), sampleNearEndFrame("end")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: createSuccessfulTts("またね。"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "またね。" });
        }
      },
      wakeAcknowledgement: { enabled: false },
      farewell: { enabled: true },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "聞き取り中です。",
        close: () => undefined
      }
    });

    expect(prompts).toEqual([
      "The voice session is ending now. Respond with one brief spoken Japanese farewell for the staff. Do not introduce a new topic."
    ]);
    expect(phases.at(-1)).toBe("waiting");
  });

  it("returns to waiting after an interaction times out between capture iterations", async () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 300_000 }
    });
    const phases: string[] = [];
    const frames = (function* () {
      yield sampleNearEndFrame("wake");
      lifecycle.end("session-1");
    })();

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ"),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          throw new Error("wake-only timeout must not prompt Pi Agent");
        }
      },
      wakeAcknowledgement: { enabled: false },
      monitor: {
        setPhase: (phase) => phases.push(phase),
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "聞き取り中です。",
        close: () => undefined
      }
    });

    expect(phases.at(-1)).toBe("waiting");
  });

  it("serializes preface, control, and final playback through one output queue", async () => {
    const firstPlayback = createPromiseGate();
    const firstPlaybackStarted = createPromiseGate();
    const statusSynthesized = createPromiseGate();
    const transcripts = ["ピコ、長い作業をして", "今どう？"];
    let activePlayback = 0;
    let maximumConcurrentPlayback = 0;
    let playbackCalls = 0;
    const playedTexts: string[] = [];

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("request"), sampleNearEndFrame("status")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(transcripts.shift() ?? ""))
      },
      tts: {
        synthesize: (request) => {
          if (request.text.includes("開始から12秒")) {
            statusSynthesized.release();
          }

          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: async (chunk) => {
          playbackCalls += 1;
          playedTexts.push(chunk.text);
          activePlayback += 1;
          maximumConcurrentPlayback = Math.max(maximumConcurrentPlayback, activePlayback);

          if (playbackCalls === 1) {
            firstPlaybackStarted.release();
            await firstPlayback.promise;
          }

          activePlayback -= 1;
        }
      },
      piAgent: {
        prompt: async (input) => {
          await input.beforeFirstTool?.("わかった。始めるね。");
          return { text: "終わりました。" };
        }
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: () => undefined,
        describeCurrentWork: () => "writeを実行中です。開始から12秒です。",
        close: () => undefined
      }
    });

    await firstPlaybackStarted.promise;
    await statusSynthesized.promise;
    firstPlayback.release();
    await runtime;

    expect(playedTexts).toEqual([
      "わかった。始めるね。",
      "writeを実行中です。開始から12秒です。終わったら声をかけます。",
      "終わりました。"
    ]);
    expect(playbackCalls).toBe(3);
    expect(maximumConcurrentPlayback).toBe(1);
  });

  it("keeps wake acknowledgement running when resident logging fails", async () => {
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    let playbackCalls = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger")],
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
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: () => {
          playbackCalls += 1;
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "はい、聞いています。" });
        }
      },
      wakeAcknowledgement: {
        enabled: true
      },
      log: {
        record: () => {
          throw new Error("log sink unavailable");
        }
      }
    });

    expect(result.completedTurns).toBe(1);
    expect(result.failedTurns).toBe(0);
    expect(prompts).toEqual([
      'The user just woke you up by saying: "ピコ". Respond briefly in spoken Japanese to show you are listening. Do not answer a separate task yet.'
    ]);
    expect(spokenTexts).toEqual(["はい、聞いています。"]);
    expect(playbackCalls).toBe(1);
  });

  it("finalizes an active interaction during shutdown cleanup", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const cancelled: string[] = [];
    const disposedSessions: string[] = [];
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
          disposeSession: (sessionId) => {
            disposedSessions.push(sessionId);
          },
          disposeAll: () => {
            disposedAll += 1;
          }
        },
        deferredTools: {
          collectDeliverableResults: () => [],
          cancelSession: (sessionId, reason) => {
            cancelled.push(`${sessionId}:${reason}`);
          },
          waitForIdle: () => {
            cancelled.push("waitForIdle");

            return Promise.resolve();
          }
        }
      })
    ).resolves.toMatchObject({ completedTurns: 1 });

    expect(cancelled).toEqual(["session-1:session_closed", "waitForIdle"]);
    expect(disposedSessions).toEqual(["session-1"]);
    expect(lifecycle.read("session-1")).toBeUndefined();
    expect(disposedAll).toBe(1);
  });

  it("disposes the Pi client before waiting for an aborted prompt to settle", async () => {
    const abortController = new AbortController();
    const promptStarted = createPromiseGate();
    const disposeStarted = createPromiseGate();
    let rejectPrompt: ((error: Error) => void) | undefined;
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await promptStarted.promise;
        abortController.abort();
        yield sampleNearEndFrame("must-not-be-accepted");
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、長い作業をして"),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          promptStarted.release();
          return new Promise((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
        disposeAll: () => {
          disposeStarted.release();
          rejectPrompt?.(new Error("Pi client closed"));
        }
      },
      signal: abortController.signal
    });

    await disposeStarted.promise;
    await expect(runtime).rejects.toThrow("pico resident voice runtime aborted");
  });

  it("closes an active turn silently during shutdown", async () => {
    const abortController = new AbortController();
    const promptStarted = createPromiseGate();
    const terminalStates: string[] = [];
    const spokenTexts: string[] = [];
    let rejectPrompt: ((error: Error) => void) | undefined;
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await promptStarted.promise;
        abortController.abort();
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、長い作業をして"),
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        play: (chunk) => {
          spokenTexts.push(chunk.text);
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: () => {
          promptStarted.release();
          return new Promise((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
        disposeAll: () => rejectPrompt?.(new Error("Pi client closed"))
      },
      monitor: {
        setPhase: () => undefined,
        showAcceptedTranscript: () => undefined,
        notifyTerminal: (state) => terminalStates.push(state),
        describeCurrentWork: () => "作業中です。",
        close: () => undefined
      },
      signal: abortController.signal
    });

    await expect(runtime).rejects.toThrow("pico resident voice runtime aborted");
    expect(terminalStates).toEqual([]);
    expect(spokenTexts).toEqual([]);
  });

  it("waits for an active preface gate to drain after Pi disposal during shutdown", async () => {
    const abortController = new AbortController();
    const prefacePlaybackStarted = createPromiseGate();
    const finishPrefacePlayback = createPromiseGate();
    const disposeStarted = createPromiseGate();
    let runtimeSettled = false;
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await prefacePlaybackStarted.promise;
        abortController.abort();
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、文書を作って"),
      tts: {
        synthesize: (request) => createSuccessfulTts(request.text).synthesize(request)
      },
      playback: {
        async play() {
          prefacePlaybackStarted.release();
          await finishPrefacePlayback.promise;
        }
      },
      piAgent: {
        prompt: async (input) => {
          await input.beforeFirstTool?.("わかった。文書を作るね。");
          return { text: "完了しました。" };
        },
        disposeAll: () => disposeStarted.release()
      },
      signal: abortController.signal
    });
    void runtime.then(
      () => {
        runtimeSettled = true;
      },
      () => {
        runtimeSettled = true;
      }
    );

    await disposeStarted.promise;
    expect(runtimeSettled).toBe(false);

    finishPrefacePlayback.release();
    await expect(runtime).rejects.toThrow("pico resident voice runtime aborted");
  });

  it("waits for active playback and the output queue to drain after Pi disposal", async () => {
    const abortController = new AbortController();
    const playbackStarted = createPromiseGate();
    const finishPlayback = createPromiseGate();
    const disposeStarted = createPromiseGate();
    const queueDrained = createPromiseGate();
    let drainCalled = false;
    const frames = {
      async *[Symbol.asyncIterator]() {
        yield sampleNearEndFrame("request");
        await playbackStarted.promise;
        abortController.abort();
      }
    };

    const runtime = runVoiceResidentRuntime({
      now: fixedNow(),
      frames,
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: { mode: "timed", durationMs: 300_000 }
      }),
      echoControl: createIdleEchoControl(),
      stt: successfulStt("ピコ、確認して"),
      tts: createSuccessfulTts("完了しました。"),
      playback: {
        async play() {
          playbackStarted.release();
          await finishPlayback.promise;
        }
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "完了しました。" }),
        disposeAll: () => disposeStarted.release()
      },
      outputQueue: {
        enqueue: (operation) => operation(),
        drain: () => {
          drainCalled = true;
          queueDrained.release();
          return Promise.resolve();
        }
      },
      signal: abortController.signal
    });

    await disposeStarted.promise;
    expect(drainCalled).toBe(false);
    finishPlayback.release();
    await expect(runtime).rejects.toThrow("pico resident voice runtime aborted");
    await queueDrained.promise;
  });

  it("continues resource cleanup when per-session Pi disposal fails", async () => {
    const events: string[] = [];
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });

    await expect(
      runVoiceResidentRuntime({
        now: fixedNow(),
        frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
        utteranceWindow: perFrameCompatibleUtteranceWindow(),
        triggerPhrases: ["ピコ"],
        sessionLifecycle: lifecycle,
        echoControl: createCleanupTrackingEchoControl(events),
        speechActivity: {
          process: () => Promise.resolve({ speech: true, provider: "energy", rmsDb: -20 }),
          close: () => {
            events.push("speech:close");
          }
        },
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
          disposeSession: () => {
            events.push("pi:disposeSession");
            throw new Error("per-session disposal failed");
          },
          disposeAll: () => {
            events.push("pi:disposeAll");
          }
        }
      })
    ).resolves.toMatchObject({ completedTurns: 1 });

    expect(events).toEqual(["pi:disposeAll", "pi:disposeSession", "echo:flush", "speech:close"]);
    expect(lifecycle.read("session-1")).toBeUndefined();
  });

  it("cancels deferred jobs when shutdown ends an interaction", async () => {
    const cancelled: string[] = [];
    let prompts = 0;

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("mic-trigger")],
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
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          prompts += 1;
          throw new Error("wake-only shutdown should not prompt Pi Agent");
        }
      },
      deferredTools: {
        collectDeliverableResults: () => [],
        cancelSession: (sessionId, reason) => {
          cancelled.push(`${sessionId}:${reason}`);
        }
      },
      wakeAcknowledgement: {
        enabled: false
      },
      farewell: { enabled: true }
    });

    expect(result.startedSessions).toBe(1);
    expect(result.failedTurns).toBe(0);
    expect(prompts).toBe(0);
    expect(cancelled).toEqual(["session-1:session_closed"]);
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

  it("does not transcribe microphone frames captured while pico audio is playing", async () => {
    const sttTexts = ["ピコ", "用件です", "pico own speech"];
    const transcribedFrameLengths: number[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        sampleNearEndFrameAt("wake", 0),
        sampleNearEndFrameAt("staff-turn", 100),
        sampleNearEndFrameAt("captured-during-playback", 500)
      ],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createHalfDuplexEchoControl({
        tailMuteMs: 700
      }),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: (request) => {
          transcribedFrameLengths.push(request.audio.byteLength);
          return Promise.resolve(successfulTranscript(sttTexts.shift() ?? ""));
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

    expect(result).toMatchObject({
      processedFrames: 3,
      startedSessions: 1,
      completedTurns: 1,
      suppressedFrames: 1
    });
    expect(transcribedFrameLengths).toHaveLength(2);
  });

  it("waits for Pi session disposal before removing an ended interaction", async () => {
    const calls: string[] = [];
    const lifecycle = createOrderingLifecycle(calls);

    await runVoiceResidentRuntime({
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
        },
        disposeSession: async (sessionId) => {
          calls.push(`dispose:start:${sessionId}`);
          await Promise.resolve();
          calls.push(`dispose:end:${sessionId}`);
        }
      }
    });

    expect(calls).toEqual([
      "read:session-ended",
      "dispose:start:session-ended",
      "dispose:end:session-ended",
      "remove:session-ended"
    ]);
  });

  it("does not generate a farewell when inactivity ends an interaction", async () => {
    const calls: string[] = [];
    const lifecycle = createOrderingLifecycle(calls);
    const prompts: string[] = [];
    const spokenTexts: string[] = [];

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      endedSessionIds: ["session-ended"],
      echoControl: createIdleEchoControl(),
      stt: successfulStt(""),
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          calls.push(`tts:${request.text}`);
          return createSuccessfulTts(request.text).synthesize(request);
        }
      },
      playback: {
        play: () => {
          calls.push("play");
          return Promise.resolve();
        }
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          calls.push(`prompt:${input.sessionId}`);
          return Promise.resolve({ text: "また呼んでね。" });
        },
        disposeSession: (sessionId) => {
          calls.push(`dispose:${sessionId}`);
        }
      },
      farewell: {
        enabled: true
      }
    });

    expect(result.failedTurns).toBe(0);
    expect(prompts).toEqual([]);
    expect(spokenTexts).toEqual([]);
    expect(calls).toEqual(["read:session-ended", "dispose:session-ended", "remove:session-ended"]);
  });

  it("does not attempt farewell providers for an inactivity-ended interaction", async () => {
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
      tts: {
        synthesize: () => {
          throw new Error("farewell TTS must not run after prompt failure");
        }
      },
      playback: {
        play: () => {
          throw new Error("farewell playback must not run after prompt failure");
        }
      },
      piAgent: {
        prompt: () => {
          calls.push("prompt:failed");
          throw new Error("LLM unavailable");
        },
        disposeSession: (sessionId) => {
          calls.push(`dispose:${sessionId}`);
        }
      },
      farewell: {
        enabled: true
      }
    });

    expect(result.failedTurns).toBe(0);
    expect(calls).toEqual(["read:session-ended", "dispose:session-ended", "remove:session-ended"]);
  });

  it("suppresses per-session disposal failure and removes the ended interaction", async () => {
    const calls: string[] = [];
    const lifecycle = createOrderingLifecycle(calls);

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: lifecycle,
      endedSessionIds: ["session-ended"],
      echoControl: createIdleEchoControl(),
      stt: successfulStt(""),
      tts: createSuccessfulTts("unused"),
      playback: { play: () => Promise.resolve() },
      piAgent: {
        prompt: () => {
          throw new Error("no turn is expected");
        },
        disposeSession: (sessionId) => {
          calls.push(`dispose:${sessionId}`);
          throw new Error("per-session disposal failed");
        }
      }
    });

    expect(calls).toEqual(["read:session-ended", "dispose:session-ended", "remove:session-ended"]);
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

  it("records TTS request wall latency separately from synthesized audio duration", async () => {
    const audit = createStructuredAuditLog();

    await runVoiceResidentRuntime({
      now: fixedNow(),
      monotonicNow: sequenceNumber([10, 20, 100, 145]),
      frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      sessionLifecycle: createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      }),
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["ピコ", "今日はテストです"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: createSuccessfulTts("了解です。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => Promise.resolve({ text: "了解です。" })
      },
      probe: { audit }
    });

    expect(
      audit.entries().map((entry) => ({
        stage: entry.attributes["pico.voice.stage"],
        durationMs: entry.attributes["pico.voice.stage_duration_ms"]
      }))
    ).toContainEqual({
      stage: "tts_request_wall",
      durationMs: 45
    });
    expect(
      audit.entries().map((entry) => ({
        stage: entry.attributes["pico.voice.stage"],
        durationMs: entry.attributes["pico.voice.stage_duration_ms"]
      }))
    ).toContainEqual({
      stage: "tts_audio_duration",
      durationMs: 120
    });
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

  it("sends only post-activation utterances in push-to-talk mode", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const prompts: string[] = [];
    const spokenTexts: string[] = [];
    const activations = createSequenceActivationSource([
      undefined,
      {
        id: "activation-1",
        occurredAt: "2026-06-18T00:00:00.500Z",
        expiresAt: "2026-06-18T00:00:08.500Z",
        trigger: {
          kind: "button_trigger",
          label: "push_to_talk",
          source: "loopback_http"
        }
      }
    ]);

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [sampleNearEndFrame("ambient-child-voice"), sampleNearEndFrame("button-turn")],
      utteranceWindow: perFrameCompatibleUtteranceWindow(),
      triggerPhrases: ["ピコ"],
      activation: {
        mode: "push_to_talk",
        source: activations
      },
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: (() => {
        const texts = ["周りの声です", "今日の予定を確認して"];

        return {
          warmup: () => {
            throw new Error("warmup is not part of resident runtime");
          },
          transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
        };
      })(),
      tts: {
        synthesize: (request) => {
          spokenTexts.push(request.text);
          return createSuccessfulTts("予定を確認します。").synthesize(request);
        }
      },
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "予定を確認します。" });
        }
      },
      wakeAcknowledgement: {
        enabled: true
      }
    });

    expect(result.startedSessions).toBe(1);
    expect(result.completedTurns).toBe(1);
    expect(prompts).toEqual(["今日の予定を確認して"]);
    expect(spokenTexts).toEqual(["予定を確認します。"]);
  });

  it("drops speech buffered before a push-to-talk activation", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const prompts: string[] = [];
    const sttDurations: number[] = [];
    const activations = createSequenceActivationSource([
      undefined,
      {
        id: "activation-1",
        occurredAt: "2026-06-18T00:00:00.010Z",
        expiresAt: "2026-06-18T00:00:08.010Z",
        trigger: {
          kind: "button_trigger",
          label: "push_to_talk",
          source: "loopback_http"
        }
      }
    ]);

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        speechFrame("speech-before-button", 0),
        speechFrame("speech-after-button", 10),
        silenceFrame("silence-after-button-1", 20),
        silenceFrame("silence-after-button-2", 30)
      ],
      utteranceWindow: {
        minSpeechMs: 10,
        silenceMs: 20,
        maxUtteranceMs: 1_000,
        minRmsDb: -50
      },
      triggerPhrases: ["ピコ"],
      activation: {
        mode: "push_to_talk",
        source: activations
      },
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: (request) => {
          sttDurations.push((request.audio.byteLength / 2 / 16_000) * 1_000);
          return Promise.resolve(successfulTranscript("ボタン後の発話です"));
        }
      },
      tts: createSuccessfulTts("了解です。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "了解です。" });
        }
      }
    });

    expect(sttDurations).toEqual([30]);
    expect(prompts).toEqual(["ボタン後の発話です"]);
  });

  it("keeps push-to-talk activations unacknowledged until a turn is consumed", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const acknowledgedActivations: string[] = [];
    const activation = {
      id: "activation-1",
      occurredAt: "2026-06-18T00:00:00.000Z",
      expiresAt: "2026-06-18T00:00:08.000Z",
      trigger: {
        kind: "button_trigger" as const,
        label: "push_to_talk",
        source: "loopback_http"
      }
    };

    const result = await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        silenceFrame("silence-after-button-1", 0),
        silenceFrame("silence-after-button-2", 10)
      ],
      utteranceWindow: {
        minSpeechMs: 10,
        silenceMs: 20,
        maxUtteranceMs: 1_000,
        minRmsDb: -50
      },
      triggerPhrases: ["ピコ"],
      activation: {
        mode: "push_to_talk",
        source: {
          peek: () => activation,
          acknowledge: (activationId) => {
            acknowledgedActivations.push(activationId);
          }
        }
      },
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => {
          throw new Error("silence must not reach STT");
        }
      },
      tts: createSuccessfulTts("unused"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: () => {
          throw new Error("silence must not reach Pi Agent");
        }
      }
    });

    expect(result.startedSessions).toBe(0);
    expect(acknowledgedActivations).toEqual([]);
  });

  it("rearms a fresh push-to-talk activation after an expired pending activation", async () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const prompts: string[] = [];
    const acknowledgedActivations: string[] = [];
    const activations = createSequenceActivationSource([
      {
        id: "activation-expired",
        occurredAt: "2026-06-17T23:59:51.000Z",
        expiresAt: "2026-06-17T23:59:59.000Z",
        trigger: {
          kind: "button_trigger",
          label: "push_to_talk",
          source: "loopback_http"
        }
      },
      {
        id: "activation-fresh",
        occurredAt: "2026-06-18T00:00:00.000Z",
        expiresAt: "2026-06-18T00:00:08.000Z",
        trigger: {
          kind: "button_trigger",
          label: "push_to_talk",
          source: "loopback_http"
        }
      }
    ]);
    const activationSource: VoiceResidentActivationSource = {
      peek: activations.peek,
      acknowledge: (activationId) => {
        acknowledgedActivations.push(activationId);
        activations.acknowledge(activationId);
      }
    };

    await runVoiceResidentRuntime({
      now: fixedNow(),
      frames: [
        silenceFrame("silence-with-expired-activation", 0),
        speechFrame("speech-after-fresh-activation", 10),
        silenceFrame("silence-after-fresh-activation-1", 20),
        silenceFrame("silence-after-fresh-activation-2", 30)
      ],
      utteranceWindow: {
        minSpeechMs: 10,
        silenceMs: 20,
        maxUtteranceMs: 1_000,
        minRmsDb: -50
      },
      triggerPhrases: ["ピコ"],
      activation: {
        mode: "push_to_talk",
        source: activationSource
      },
      sessionLifecycle: lifecycle,
      echoControl: createIdleEchoControl(),
      stt: {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript("再度ボタン後の発話です"))
      },
      tts: createSuccessfulTts("了解です。"),
      playback: {
        play: () => Promise.resolve()
      },
      piAgent: {
        prompt: (input) => {
          prompts.push(input.text);
          return Promise.resolve({ text: "了解です。" });
        }
      }
    });

    expect(prompts).toEqual(["再度ボタン後の発話です"]);
    expect(acknowledgedActivations).toEqual(["activation-expired", "activation-fresh"]);
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
                  sidecarId: "local-apple-speech",
                  provider: "apple-speech",
                  language: "ja-JP"
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
    language: "ja-JP",
    confidence,
    durationMs: 100,
    segments: [],
    source: {
      sidecarId: "local-apple-speech",
      provider: "apple-speech" as const,
      language: "ja-JP"
    }
  };
}

function sampleNearEndFrame(id: string): VoicePcmFrame {
  return sampleNearEndFrameAt(id, 0);
}

function sampleNearEndFrameAt(id: string, offsetMs: number): VoicePcmFrame {
  return {
    id,
    direction: "near_end",
    audio: new Uint8Array([4, 5, 6]),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt: addTestMilliseconds("2026-06-18T00:00:00.000Z", offsetMs),
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

function createSequenceActivationSource(
  values: readonly ReturnType<VoiceResidentActivationSource["peek"]>[]
): VoiceResidentActivationSource {
  const remaining = [...values];
  let pending: ReturnType<VoiceResidentActivationSource["peek"]> | undefined;

  return {
    peek: () => {
      if (pending !== undefined) {
        return pending;
      }

      const activation = remaining.shift();

      if (activation !== undefined) {
        pending = activation;
      }

      return activation;
    },
    acknowledge: (activationId) => {
      if (pending?.id === activationId) {
        pending = undefined;
      }
    }
  };
}

function fixedNow(): () => string {
  return () => "2026-06-18T00:00:00.000Z";
}

function sequenceNow(timestamps: readonly string[]): () => string {
  let index = 0;

  return () => timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0] ?? "";
}

function sequenceNumber(values: readonly number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] ?? values[0] ?? 0;
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
  let removed = false;

  return {
    start: () => {
      throw new Error("start is not expected");
    },
    read: (id) => {
      calls.push(`read:${id}`);

      if (removed) {
        return undefined;
      }

      return {
        id,
        state: "ended",
        startedAt: "2026-06-18T00:00:00.000Z",
        endedAt: "2026-06-18T00:01:00.000Z",
        endReason: "inactivity",
        trigger: {
          kind: "wake_name",
          label: "ピコ",
          source: "voice"
        }
      };
    },
    refreshActivity: () => {
      throw new Error("refresh activity is not expected");
    },
    suspendInactivity: () => {
      throw new Error("suspend inactivity is not expected");
    },
    resumeInactivity: () => {
      throw new Error("resume inactivity is not expected");
    },
    end: (id) => {
      calls.push(`end:${id}`);

      return {
        id,
        state: "ended",
        startedAt: "2026-06-18T00:00:00.000Z",
        endedAt: "2026-06-18T00:01:00.000Z",
        endReason: "explicit",
        trigger: {
          kind: "wake_name",
          label: "ピコ",
          source: "voice"
        }
      };
    },
    remove: (id) => {
      calls.push(`remove:${id}`);
      removed = true;
    }
  };
}

function createPromiseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}
