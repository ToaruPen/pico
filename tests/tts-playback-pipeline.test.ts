import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog, type StructuredAuditLog } from "../src/modules/audit/index.js";
import {
  createHttpEchoControlProvider,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../src/modules/voice/echo-control.js";
import type {
  TtsAudioChunk,
  TtsClient,
  TtsSynthesisEvent,
  TtsSynthesisFailure
} from "../src/modules/voice/index.js";
import {
  measureTrailingPcm16SilenceMs,
  runTtsPlaybackPipeline
} from "../src/runtime/tts-playback-pipeline.js";
import type { VoicePlaybackSink } from "../src/runtime/voice-playback.js";
import type { VoiceStageProbe } from "../src/runtime/voice-stage-probe.js";

const source = {
  serviceId: "local-tts",
  provider: "aivis-speech",
  speakerId: 1
} as const;

describe("TTS playback pipeline", () => {
  it("forwards the bounded speech plan with the canonical text", async () => {
    const requests: unknown[] = [];
    const speechPlan = {
      v: 1,
      style: "clear",
      annotations: []
    } as const;
    const tts: TtsClient = {
      synthesize(request) {
        requests.push(request);
        return ttsFromArray([completedEvent(0)]).synthesize(request);
      }
    };

    await runTtsPlaybackPipeline({
      ...pipelineInput({
        text: "施設の入口は右手です。",
        tts,
        playback: recordingPlayback()
      }),
      speechPlan
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      text: "施設の入口は右手です。",
      speechPlan
    });
  });

  it("measures trailing PCM16 silence by complete mono and stereo frames", () => {
    expect(measureTrailingPcm16SilenceMs(pcm16([100, 0, 0, 0]), 1_000, 1)).toBe(3);
    expect(measureTrailingPcm16SilenceMs(pcm16([100, -100, 0, 0, 0, 0]), 1_000, 2)).toBe(2);
    expect(measureTrailingPcm16SilenceMs(pcm16([0, 0, 0]), 1_000, 1)).toBe(3);
    expect(measureTrailingPcm16SilenceMs(pcm16([0, 17]), 1_000, 1)).toBe(0);
  });

  it("rejects unaligned PCM16 tail diagnostics", () => {
    expect(() => measureTrailingPcm16SilenceMs(Uint8Array.from([0]), 24_000, 1)).toThrow(
      "trailing silence received invalid PCM16 audio"
    );
    expect(() => measureTrailingPcm16SilenceMs(Uint8Array.from([0, 0]), 24_000, 2)).toThrow(
      "trailing silence received invalid PCM16 audio"
    );
  });

  it("starts the next synthesis before writing the current chunk", async () => {
    const order: string[] = [];
    const secondChunk = createGate<TtsSynthesisEvent>();
    const tts = ttsFromEvents(async function* () {
      yield chunkEvent(0);
      order.push("second-synthesis-started");
      yield await secondChunk.promise;
      yield completedEvent(2);
    });
    const playback = recordingPlayback({
      onWrite: (chunk) => {
        order.push(`write-${String(chunk.sentenceIndex)}`);
      }
    });
    const running = runTtsPlaybackPipeline(pipelineInput({ tts, playback }));

    await vi.waitFor(() => expect(order).toEqual(["second-synthesis-started", "write-0"]));
    secondChunk.resolve(chunkEvent(1));
    await expect(running).resolves.toMatchObject({ status: "completed", playedChunkCount: 2 });
  });

  it("notifies the first accepted playback write after it resolves exactly once", async () => {
    const events: string[] = [];
    const firstWrite = createSignalGate();
    const playback = recordingPlayback({
      onOpen: () => {
        events.push("open-playback");
      },
      onWrite: async (chunk) => {
        events.push(`write:${String(chunk.sentenceIndex)}`);
        if (chunk.sentenceIndex === 0) await firstWrite.promise;
      }
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), chunkEvent(1), completedEvent(2)]),
        playback,
        onFirstPlaybackStart: () => {
          events.push("admit-playback");
          return true;
        },
        onFirstPlaybackWriteAccepted: () => {
          events.push("first-write-accepted");
          throw new Error("observer unavailable");
        }
      })
    );

    await vi.waitFor(() => expect(events).toEqual(["admit-playback", "open-playback", "write:0"]));
    firstWrite.resolve();

    await expect(running).resolves.toEqual({
      status: "completed",
      playedChunkCount: 2,
      durationMs: 20
    });
    expect(events).toEqual([
      "admit-playback",
      "open-playback",
      "write:0",
      "first-write-accepted",
      "write:1"
    ]);
  });

  it("pulls at most one event ahead while the current chunk is pending playback", async () => {
    const writeGate = createSignalGate();
    let pullCount = 0;
    const tts = ttsFromEvents(async function* () {
      await Promise.resolve();
      pullCount += 1;
      yield chunkEvent(0);
      pullCount += 1;
      yield chunkEvent(1);
      pullCount += 1;
      yield completedEvent(2);
    });
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const running = runTtsPlaybackPipeline(pipelineInput({ tts, playback }));

    await vi.waitFor(() => expect(pullCount).toBe(2));
    expect(playback.state.writes).toHaveLength(1);
    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "completed",
      playedChunkCount: 2,
      durationMs: 20
    });
    expect(pullCount).toBe(3);
  });

  it("invokes every lookahead pull before registering the current echo reference", async () => {
    const order: string[] = [];
    const events = [chunkEvent(0), chunkEvent(1), completedEvent(2)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        order.push(eventIndex === 2 ? "pull-terminal" : `pull-${String(eventIndex)}`);
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      }
    });
    const echo = recordingEcho({ onAccept: (frame) => order.push(`echo-${frame.id}`) });
    const playback = recordingPlayback({
      onWrite: (chunk) => {
        order.push(`write-${String(chunk.sentenceIndex)}`);
      }
    });

    await runTtsPlaybackPipeline(pipelineInput({ tts, playback, echoControl: echo.provider }));

    expect(order).toEqual([
      "pull-0",
      "pull-1",
      "echo-tts-0",
      "write-0",
      "pull-terminal",
      "echo-tts-1",
      "write-1"
    ]);
  });

  it("opens one session, writes chunks in order, and awaits playback completion", async () => {
    const finishGate = createSignalGate();
    const playback = recordingPlayback({ onFinish: () => finishGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), chunkEvent(1), completedEvent(2)]),
        playback
      })
    );

    await vi.waitFor(() => expect(playback.state.finishes).toBe(1));
    expect(playback.state.opens).toBe(1);
    expect(playback.state.writes.map((chunk) => chunk.sentenceIndex)).toEqual([0, 1]);
    await expect(
      Promise.race([
        running.then(
          () => "settled",
          () => "rejected"
        ),
        Promise.resolve("pending")
      ])
    ).resolves.toBe("pending");

    finishGate.resolve();
    await expect(running).resolves.toEqual({
      status: "completed",
      playedChunkCount: 2,
      durationMs: 20
    });
  });

  it("returns empty without opening playback", async () => {
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(pipelineInput({ tts: ttsFromArray([completedEvent(0)]), playback }))
    ).resolves.toEqual({ status: "empty", playedChunkCount: 0 });
    expect(playback.state.opens).toBe(0);
    expect(playback.state.finishes).toBe(0);
  });

  it("returns the first provider failure without playback", async () => {
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({ tts: ttsFromArray([failedEvent("backend_error", 0)]), playback })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "backend_error",
      playedChunkCount: 0,
      sentenceIndex: 0
    });
    expect(playback.state.opens).toBe(0);
    expect(playback.state.stops).toBe(0);
  });

  it("drains the submitted chunk after a later provider failure without stopping playback", async () => {
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), failedEvent("backend_error", 1)]),
          playback
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "backend_error",
      playedChunkCount: 1,
      sentenceIndex: 1
    });
    expect(playback.state.finishes).toBe(1);
    expect(playback.state.stops).toBe(0);
  });

  it.each([
    ["open", "playback_open_failed"],
    ["write", "playback_write_failed"],
    ["finish", "playback_finish_failed"]
  ] as const)("converges a playback %s failure", async (failurePoint, errorCode) => {
    const producerAbort = createSignalGate();
    const controller = new AbortController();
    const tts: TtsClient = {
      synthesize: ({ signal }) =>
        (async function* () {
          yield chunkEvent(0);
          if (failurePoint === "finish") {
            yield completedEvent(1);
            return;
          }
          await waitForAbort(requireAbortSignal(signal));
          producerAbort.resolve();
          throw new Error("synthesis aborted");
        })()
    };
    const playback = recordingPlayback({
      ...(failurePoint === "open" ? { openError: new Error("open failed") } : {}),
      ...(failurePoint === "write" ? { writeError: new Error("write failed") } : {}),
      ...(failurePoint === "finish" ? { finishError: new Error("finish failed") } : {})
    });

    const result = await runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, signal: controller.signal })
    );

    expect(result).toMatchObject({ status: "failed", errorCode });
    if (failurePoint !== "finish") {
      await expect(producerAbort.promise).resolves.toBeUndefined();
    }
    expect(playback.state.stops).toBe(1);
  });

  it("cancels before the first chunk without opening or stopping playback", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback,
          signal: controller.signal
        })
      )
    ).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(playback.state.opens).toBe(0);
    expect(playback.state.stops).toBe(0);
  });

  it("cancels while first-chunk synthesis is pending", async () => {
    const controller = new AbortController();
    const playback = recordingPlayback();
    const tts = ttsFromEvents(async function* () {
      await waitForAbort(controller.signal);
      yield failedEvent("cancelled", 0);
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, signal: controller.signal })
    );

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(playback.state.opens).toBe(0);
    expect(playback.state.stops).toBe(0);
  });

  it.each([
    [
      "completed",
      completedEvent(0),
      { status: "ok" as const, durationMs: 20, chunkCount: 0, playedChunkCount: 0 }
    ],
    [
      "failed",
      failedEvent("backend_error", 0),
      {
        status: "error" as const,
        durationMs: 20,
        errorCode: "backend_error",
        sentenceIndex: 0,
        playedChunkCount: 0
      }
    ],
    [
      "non-terminal chunk",
      chunkEvent(0),
      {
        status: "skipped" as const,
        durationMs: 10,
        errorCode: "cancelled",
        playedChunkCount: 0
      }
    ]
  ] as const)("settles %s initial-pull telemetry after cancellation without iterator cleanup", async (_name, event, expected) => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const controller = new AbortController();
    const nextStarted = createSignalGate();
    const nextGate = createGate<IteratorResult<TtsSynthesisEvent>>();
    const tts = ttsFromIterator({
      next: () => {
        nextStarted.resolve();
        return nextGate.promise;
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback: recordingPlayback(),
        signal: controller.signal,
        probe: { audit },
        monotonicNow: () => clock.value
      })
    );
    await nextStarted.promise;
    clock.value = 10;

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(
      audit.entries().find((entry) => entry.attributes["pico.voice.stage"] === "tts_request_wall")
    ).toBeUndefined();
    clock.value = 20;

    nextGate.resolve({ done: false, value: event });

    await vi.waitFor(() => expectRequestTelemetry(audit, expected));
    expectRequestTelemetry(audit, expected);
  });

  it("stops immediately when cancelled during a pending playback write", async () => {
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const echo = recordingEcho();
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), chunkEvent(1), completedEvent(2)]),
        playback,
        echoControl: echo.provider,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(playback.state.writes).toHaveLength(1));

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(playback.state.stops).toBe(1);
    expect(echo.state.flushes).toBe(1);
    writeGate.resolve();
  });

  it("flushes a late echo reference that completes after cancellation", async () => {
    const controller = new AbortController();
    const acceptGate = createSignalGate();
    const echo = delayedEcho(acceptGate.promise);
    const playback = recordingPlayback();
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback,
        echoControl: echo.provider,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(echo.state.acceptStarts).toBe(1));

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(playback.state.writes).toHaveLength(0);
    expect(echo.state.flushes).toBe(1);

    acceptGate.resolve();
    await vi.waitFor(() => expect(echo.state.acceptCompletions).toBe(1));
    expect(echo.state.references).toEqual([]);
    expect(echo.state.flushes).toBe(2);
  });

  it("does not flush the next generation reference when a cancelled echo registration arrives late", async () => {
    const controller = new AbortController();
    const firstAcceptGate = createSignalGate();
    const echo = generationEcho(firstAcceptGate.promise);
    const firstPlayback = recordingPlayback();
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0, { audio: [1, 0] }), completedEvent(1)]),
        playback: firstPlayback,
        echoControl: echo.provider,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(echo.state.acceptedStarts).toEqual([1]));

    controller.abort(new Error("cancelled"));

    await expect(firstRunning).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(firstPlayback.state.writes).toHaveLength(0);

    const secondPlayback = recordingPlayback();
    const secondRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0, { audio: [2, 0] }), completedEvent(1)]),
        playback: secondPlayback,
        echoControl: echo.provider
      })
    );
    await Promise.race([
      echo.secondAcceptStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 25))
    ]);

    firstAcceptGate.resolve();

    await expect(secondRunning).resolves.toMatchObject({
      status: "completed",
      playedChunkCount: 1
    });
    await vi.waitFor(() => expect(echo.state.flushes).toBe(2));
    expect(echo.state.references).toEqual([2]);
  });

  it("fails the next generation when a cancelled echo registration never settles", async () => {
    const controller = new AbortController();
    const echo = delayedEcho(new Promise<void>(() => undefined));
    const firstPlayback = recordingPlayback();
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: firstPlayback,
        echoControl: echo.provider,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(echo.state.acceptStarts).toBe(1));

    controller.abort(new Error("cancelled"));

    await expect(firstRunning).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(firstPlayback.state.writes).toHaveLength(0);

    const secondPlayback = recordingPlayback();
    const secondRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: secondPlayback,
        echoControl: echo.provider
      })
    );

    await expect(
      Promise.race([
        secondRunning,
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 1_200))
      ])
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(echo.state.acceptStarts).toBe(1);
    expect(secondPlayback.state.writes).toHaveLength(0);
  });

  it("does not reuse an HTTP provider after an aborted request can still mutate remote state", async () => {
    const controller = new AbortController();
    const lateRemoteMutation = createSignalGate();
    const remoteReferences: number[] = [];
    let farEndRequests = 0;
    const echoControl = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: (_url, init) => {
        farEndRequests += 1;
        const generation = farEndRequests;
        if (generation === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("client request aborted after dispatch"));
                void lateRemoteMutation.promise.then(
                  () => remoteReferences.push(generation),
                  () => undefined
                );
              },
              { once: true }
            );
          });
        }

        remoteReferences.push(generation);
        return Promise.resolve(echoRegistrationResponse());
      }
    });
    const firstPlayback = recordingPlayback();
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: firstPlayback,
        echoControl,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(farEndRequests).toBe(1));

    controller.abort(new Error("cancelled"));

    await expect(firstRunning).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });

    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(farEndRequests).toBe(1);
    expect(secondPlayback.state.writes).toHaveLength(0);

    lateRemoteMutation.resolve();
    await vi.waitFor(() => expect(remoteReferences).toEqual([1]));
  });

  it("does not reuse an HTTP provider when cancellation leaves an applied reference unwritten", async () => {
    const controller = new AbortController();
    let farEndRequests = 0;
    const echoControl = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () => {
        farEndRequests += 1;
        if (farEndRequests === 1) {
          queueMicrotask(() => controller.abort(new Error("cancelled after apply")));
        }
        return Promise.resolve(echoRegistrationResponse());
      }
    });
    const firstPlayback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: firstPlayback,
          echoControl,
          signal: controller.signal
        })
      )
    ).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(firstPlayback.state.writes).toHaveLength(0);

    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(farEndRequests).toBe(1);
    expect(secondPlayback.state.writes).toHaveLength(0);
  });

  it("does not reuse an HTTP provider when post-write cancellation cannot reset it", async () => {
    const controller = new AbortController();
    const producerGate = createSignalGate();
    let farEndRequests = 0;
    const echoControl = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () => {
        farEndRequests += 1;
        return Promise.resolve(echoRegistrationResponse());
      }
    });
    const firstPlayback = recordingPlayback();
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromEvents(async function* () {
          yield chunkEvent(0);
          await producerGate.promise;
          yield completedEvent(1);
        }),
        playback: firstPlayback,
        echoControl,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(firstPlayback.state.writes).toHaveLength(1));

    controller.abort(new Error("cancelled after write"));

    await expect(firstRunning).resolves.toEqual({ status: "cancelled", playedChunkCount: 1 });

    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(farEndRequests).toBe(1);
    expect(secondPlayback.state.writes).toHaveLength(0);
    producerGate.resolve();
  });

  it("fails closed when a provider returns an unknown registration status", async () => {
    await expectNonConformingRegistrationToFailClosed(() =>
      Promise.resolve({ status: "unexpected" } as never)
    );
  });

  it("fails closed when a provider rejects its registration promise", async () => {
    await expectNonConformingRegistrationToFailClosed(() =>
      Promise.reject(new Error("provider contract rejection"))
    );
  });

  it("fails closed when a provider throws during registration invocation", async () => {
    await expectNonConformingRegistrationToFailClosed(() => {
      throw new Error("provider contract throw");
    });
  });

  it("poisons a provider within the safety bound when stop and reset never settle", async () => {
    const controller = new AbortController();
    const pending = new Promise<void>(() => undefined);
    const flushStarted = createSignalGate();
    const state = { acceptStarts: 0, flushes: 0 };
    const echoControl = hostileResetEcho(
      state,
      () => pending as never,
      () => {
        if (state.acceptStarts === 1) {
          queueMicrotask(() => controller.abort(new Error("cancelled after apply")));
        }
      },
      () => flushStarted.resolve()
    );
    const firstPlayback = recordingPlayback({ onStop: () => pending });
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: firstPlayback,
        echoControl,
        signal: controller.signal
      })
    );
    await flushStarted.promise;

    const secondPlayback = recordingPlayback();
    const secondRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: secondPlayback,
        echoControl
      })
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 1_250));
    expect(state.acceptStarts).toBe(1);
    expect(firstPlayback.state.writes).toHaveLength(0);
    expect(secondPlayback.state.writes).toHaveLength(0);
    await expect(within(firstRunning, 1_250)).resolves.toEqual({
      status: "failed",
      errorCode: "playback_stop_timeout",
      playedChunkCount: 0
    });
    await expect(within(secondRunning, 1_250)).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
  });

  it.each([
    [
      "throwing status getter",
      Object.defineProperty({}, "status", {
        get: () => {
          throw new Error("hostile status getter");
        }
      })
    ],
    [
      "throwing proxy",
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("hostile proxy");
          }
        }
      )
    ],
    ["non-object", 42],
    ["malformed object", { status: "unexpected" }],
    ["transparent proxy", new Proxy({ status: "reset" }, {})],
    [
      "spoofing proxy",
      new Proxy(
        { status: "reset" },
        {
          getPrototypeOf: () => {
            throw new Error("hostile prototype trap");
          }
        }
      )
    ]
  ] as const)("poisons a provider after a %s reset result", async (_name, resetResult) => {
    await expectUnsafeResetToPoisonProvider(resetResult);
  });

  it.each([
    ["unsupported", () => Promise.resolve({ status: "unsupported" }) as never],
    ["rejection", () => Promise.reject(new Error("reset rejected")) as never],
    ["non-object", () => Promise.resolve(42) as never],
    ["malformed object", () => Promise.resolve({ status: "unexpected" }) as never],
    [
      "throwing getter",
      () =>
        Promise.resolve(
          Object.defineProperty({}, "status", {
            get: () => {
              throw new Error("hostile status getter");
            }
          })
        ) as never
    ],
    ["transparent proxy", () => Promise.resolve(new Proxy({ status: "reset" }, {})) as never],
    [
      "spoofing proxy",
      () =>
        Promise.resolve(
          new Proxy(
            { status: "reset" },
            {
              getOwnPropertyDescriptor: () => {
                throw new Error("hostile descriptor trap");
              }
            }
          )
        ) as never
    ]
  ] as const)("poisons a provider after a post-write %s reset", async (_name, reset) => {
    await expectUnsafePostWriteResetToPoisonProvider(reset);
  });

  it("poisons a provider after a post-write reset timeout", async () => {
    await expectUnsafePostWriteResetToPoisonProvider(
      () => new Promise<never>(() => undefined),
      1_250
    );
  });

  it("reuses a provider after a post-write plain reset", async () => {
    const controller = new AbortController();
    const producerGate = createSignalGate();
    const state = { acceptStarts: 0, flushes: 0 };
    const echoControl = hostileResetEcho(
      state,
      () => Promise.resolve({ status: "reset" }) as never
    );
    const firstPlayback = recordingPlayback();
    const firstRunning = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromEvents(async function* () {
          yield chunkEvent(0);
          await producerGate.promise;
          yield completedEvent(1);
        }),
        playback: firstPlayback,
        echoControl,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(firstPlayback.state.writes).toHaveLength(1));

    controller.abort(new Error("cancelled after write"));

    await expect(firstRunning).resolves.toEqual({ status: "cancelled", playedChunkCount: 1 });
    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({ status: "completed", playedChunkCount: 1, durationMs: 10 });
    expect(state.acceptStarts).toBe(2);
    expect(secondPlayback.state.writes).toHaveLength(1);
    producerGate.resolve();
  });

  it("poisons a provider when playback failure cannot reset a written reference", async () => {
    const state = { acceptStarts: 0, flushes: 0 };
    const echoControl = hostileResetEcho(
      state,
      () => Promise.resolve({ status: "unsupported" }) as never
    );
    const firstPlayback = recordingPlayback({ finishError: new Error("finish failed") });

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: firstPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "playback_finish_failed",
      playedChunkCount: 1
    });

    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(state.acceptStarts).toBe(1);
    expect(firstPlayback.state.writes).toHaveLength(1);
    expect(secondPlayback.state.writes).toHaveLength(0);
  });

  it("does not wait for an abort-insensitive lookahead after stopping playback", async () => {
    const controller = new AbortController();
    const pendingSynthesis = createSignalGate();
    const writeGate = createSignalGate();
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const tts = ttsFromEvents(async function* () {
      yield chunkEvent(0);
      await pendingSynthesis.promise;
      yield completedEvent(1);
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, signal: controller.signal })
    );
    await vi.waitFor(() => expect(playback.state.writes).toHaveLength(1));

    controller.abort(new Error("cancelled"));

    await expect(
      Promise.race([
        running,
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 25))
      ])
    ).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(playback.state.stops).toBe(1);
    writeGate.resolve();
    pendingSynthesis.resolve();
  });

  it("cancels instead of reporting playback failure while draining a partial provider failure", async () => {
    const controller = new AbortController();
    const finishGate = createSignalGate();
    const echo = recordingEcho();
    const playback = recordingPlayback({ onFinish: () => finishGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), failedEvent("backend_error", 1)]),
        playback,
        echoControl: echo.provider,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(playback.state.finishes).toBe(1));

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 1 });
    expect(playback.state.stops).toBe(1);
    expect(echo.state.flushes).toBe(1);
    finishGate.resolve();
  });

  it("invalidates the generation before opening playback", async () => {
    const playback = recordingPlayback();
    let producerAborted = false;
    const tts: TtsClient = {
      synthesize: ({ signal }) =>
        (async function* () {
          yield chunkEvent(0);
          await waitForAbort(requireAbortSignal(signal));
          producerAborted = true;
          yield completedEvent(1);
        })()
    };

    await expect(
      runTtsPlaybackPipeline(pipelineInput({ tts, playback, onFirstPlaybackStart: () => false }))
    ).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expect(producerAborted).toBe(true);
    expect(playback.state.opens).toBe(0);
    expect(playback.state.stops).toBe(0);
  });

  it("passes format metadata and chunks through in synthesis order", async () => {
    const playback = recordingPlayback();
    const first = chunkEvent(0, { sampleRateHz: 16_000, channels: 1, audio: [1, 2] });
    const second = chunkEvent(1, { sampleRateHz: 48_000, channels: 2, audio: [3, 4, 5, 6] });

    await runTtsPlaybackPipeline(
      pipelineInput({ tts: ttsFromArray([first, second, completedEvent(2)]), playback })
    );

    expect(playback.state.writes).toEqual([first.chunk, second.chunk]);
  });

  it.each([
    ["empty audio", { audio: [] }],
    ["zero duration", { durationMs: 0 }],
    ["invalid sample rate", { sampleRateHz: 0 }]
  ] as const)("rejects a locally malformed TTS chunk with %s without poisoning echo", async (_name, malformed) => {
    const echo = recordingEcho();
    const firstPlayback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0, malformed), completedEvent(1)]),
          playback: firstPlayback,
          echoControl: echo.provider
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "tts_invalid_chunk",
      playedChunkCount: 0
    });
    expect(echo.state.acceptStarts).toBe(0);
    expect(firstPlayback.state.writes).toHaveLength(0);

    const secondPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: secondPlayback,
          echoControl: echo.provider
        })
      )
    ).resolves.toEqual({ status: "completed", playedChunkCount: 1, durationMs: 10 });
    expect(echo.state.acceptStarts).toBe(1);
    expect(secondPlayback.state.writes).toHaveLength(1);
  });

  it("converges an active playback session after a later malformed TTS chunk", async () => {
    const audit = createStructuredAuditLog();
    const echo = recordingEcho();
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), chunkEvent(1, { durationMs: 0 }), completedEvent(2)]),
          playback,
          echoControl: echo.provider,
          probe: { audit }
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "tts_invalid_chunk",
      playedChunkCount: 1
    });
    expect(echo.state.acceptStarts).toBe(1);
    expect(echo.state.flushes).toBe(1);
    expect(playback.state.writes).toHaveLength(1);
    expect(playback.state.finishes).toBe(0);
    expect(playback.state.stops).toBe(1);
    const playbackEvents = audit
      .entries()
      .filter((event) => event.attributes["pico.voice.stage"] === "tts_playback");
    expect(playbackEvents).toHaveLength(1);
    expect(playbackEvents[0]?.attributes).toMatchObject({
      "pico.voice.stage_status": "error",
      "pico.voice.error_code": "tts_invalid_chunk",
      "pico.voice.played_chunk_count": 1
    });

    const nextPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: nextPlayback,
          echoControl: echo.provider
        })
      )
    ).resolves.toEqual({ status: "completed", playedChunkCount: 1, durationMs: 10 });
    expect(echo.state.acceptStarts).toBe(2);
    expect(nextPlayback.state.writes).toHaveLength(1);
  });

  it("poisons echo when a later malformed chunk cannot reset an applied reference", async () => {
    const state = { acceptStarts: 0, flushes: 0 };
    const echoControl = hostileResetEcho(
      state,
      () => Promise.resolve({ status: "unsupported" }) as never
    );
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), chunkEvent(1, { audio: [] }), completedEvent(2)]),
          playback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "tts_invalid_chunk",
      playedChunkCount: 1
    });
    expect(state.acceptStarts).toBe(1);
    expect(state.flushes).toBe(1);
    expect(playback.state.writes).toHaveLength(1);
    expect(playback.state.stops).toBe(1);

    const nextPlayback = recordingPlayback();
    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback: nextPlayback,
          echoControl
        })
      )
    ).resolves.toEqual({
      status: "failed",
      errorCode: "echo_control_failed",
      playedChunkCount: 0
    });
    expect(state.acceptStarts).toBe(1);
    expect(nextPlayback.state.writes).toHaveLength(0);
  });

  it("registers echo references immediately before submitted writes with cumulative offsets", async () => {
    const order: string[] = [];
    const echo = recordingEcho({ onAccept: (frame) => order.push(`echo-${frame.id}`) });
    const playback = recordingPlayback({
      onWrite: (chunk) => {
        order.push(`write-${String(chunk.sentenceIndex)}`);
      }
    });

    await runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([
          chunkEvent(0, { durationMs: 15 }),
          chunkEvent(1, { durationMs: 25 }),
          completedEvent(2)
        ]),
        playback,
        echoControl: echo.provider
      })
    );

    expect(order).toEqual(["echo-tts-0", "write-0", "echo-tts-1", "write-1"]);
    expect(echo.state.references.map((frame) => frame.capturedAt)).toEqual([
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.015Z"
    ]);
  });

  it("does not register a synthesized chunk that was never submitted", async () => {
    const echo = recordingEcho();
    const playback = recordingPlayback({ writeError: new Error("write failed") });

    await runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), chunkEvent(1), completedEvent(2)]),
        playback,
        echoControl: echo.provider
      })
    );

    expect(echo.state.references.map((frame) => frame.id)).toEqual(["tts-0"]);
  });

  it("stops and flushes echo after echo registration failure", async () => {
    const echo = recordingEcho({ acceptError: new Error("echo failed") });
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback,
          echoControl: echo.provider
        })
      )
    ).resolves.toMatchObject({ status: "failed", errorCode: "echo_control_failed" });
    expect(playback.state.stops).toBe(1);
    expect(echo.state.flushes).toBe(1);
  });

  it("records bounded pipeline telemetry once at each applicable boundary", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const tts = ttsFromEvents(async function* () {
      await Promise.resolve();
      clock.value = 10;
      yield chunkEvent(0);
      clock.value = 20;
      yield completedEvent(1);
    });
    const playback = recordingPlayback({
      onWrite: () => {
        clock.value = 30;
      },
      onFinish: () => {
        clock.value = 40;
      }
    });

    await runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback,
        probe: { audit },
        monotonicNow: () => clock.value,
        text: "private assistant body"
      })
    );

    const events = audit.entries();
    expect(events.map((event) => event.attributes["pico.voice.stage"])).toEqual([
      "tts_time_to_first_chunk",
      "tts_request_wall",
      "tts_playback"
    ]);
    expect(events.map((event) => event.attributes["pico.voice.stage_duration_ms"])).toEqual([
      10, 20, 20
    ]);
    expect(events[2]?.attributes).toMatchObject({
      "pico.voice.played_chunk_count": 1,
      "pico.voice.utterance_duration_ms": 10,
      "pico.voice.trailing_silence_ms": 1 / 24
    });
    expect(JSON.stringify(events)).not.toContain("private assistant body");
    expect(JSON.stringify(events)).not.toContain('"audio"');
  });

  it("keeps playback successful when trailing-silence diagnostics reject invalid PCM", async () => {
    const audit = createStructuredAuditLog();
    const playback = recordingPlayback();

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), chunkEvent(1, { audio: [1] }), completedEvent(2)]),
          playback,
          probe: { audit }
        })
      )
    ).resolves.toEqual({ status: "completed", playedChunkCount: 2, durationMs: 20 });

    const playbackEvent = audit
      .entries()
      .find((event) => event.attributes["pico.voice.stage"] === "tts_playback");
    expect(playbackEvent?.attributes).not.toHaveProperty("pico.voice.trailing_silence_ms");
    expect(playback.state.writes).toHaveLength(2);
  });

  it("settles failed request telemetry at the producer terminal without delaying the result", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const producerTerminal = createSignalGate();
    const tts: TtsClient = {
      synthesize: ({ signal }) =>
        (async function* () {
          clock.value = 10;
          yield chunkEvent(0);
          await waitForAbort(requireAbortSignal(signal));
          await producerTerminal.promise;
          clock.value = 100;
          throw new Error("producer stopped");
        })()
    };
    const playback = recordingPlayback({
      onWrite: () => {
        clock.value = 20;
        throw new Error("write failed");
      }
    });

    await expect(
      runTtsPlaybackPipeline(
        pipelineInput({
          tts,
          playback,
          probe: { audit },
          monotonicNow: () => clock.value
        })
      )
    ).resolves.toMatchObject({ status: "failed", errorCode: "playback_write_failed" });
    expect(
      audit.entries().find((event) => event.attributes["pico.voice.stage"] === "tts_request_wall")
    ).toBeUndefined();

    producerTerminal.resolve();
    await vi.waitFor(() =>
      expect(
        audit
          .entries()
          .filter((event) => event.attributes["pico.voice.stage"] === "tts_request_wall")
      ).toHaveLength(1)
    );
    expect(
      audit.entries().find((event) => event.attributes["pico.voice.stage"] === "tts_request_wall")
        ?.attributes["pico.voice.stage_duration_ms"]
    ).toBe(100);
  });

  it("keeps completed lookahead telemetry when the current write fails", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), completedEvent(1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({
      onWrite: () =>
        writeGate.promise.then(() => {
          throw new Error("write failed");
        })
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_write_failed",
      playedChunkCount: 0
    });
    expectRequestTelemetry(audit, {
      status: "ok",
      durationMs: 20,
      chunkCount: 1,
      playedChunkCount: 0
    });
    returnGate.resolve();
    await Promise.resolve();
    expectRequestTelemetry(audit, {
      status: "ok",
      durationMs: 20,
      chunkCount: 1,
      playedChunkCount: 0
    });
  });

  it("keeps completed lookahead telemetry when the current write is cancelled", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), completedEvent(1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback,
        probe: { audit },
        monotonicNow: () => clock.value,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expectRequestTelemetry(audit, {
      status: "ok",
      durationMs: 20,
      chunkCount: 1,
      playedChunkCount: 0
    });
    returnGate.resolve();
    writeGate.resolve();
    await Promise.resolve();
    expectRequestTelemetry(audit, {
      status: "ok",
      durationMs: 20,
      chunkCount: 1,
      playedChunkCount: 0
    });
  });

  it("keeps failed lookahead telemetry when the current write fails", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("backend_error", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({
      onWrite: () =>
        writeGate.promise.then(() => {
          throw new Error("write failed");
        })
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_write_failed",
      playedChunkCount: 0
    });
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 20,
      errorCode: "backend_error",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
    returnGate.resolve();
    await Promise.resolve();
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 20,
      errorCode: "backend_error",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
  });

  it("records a cancelled producer terminal as skipped when the current write fails", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("cancelled", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const playback = recordingPlayback({
      onWrite: () =>
        writeGate.promise.then(() => {
          throw new Error("write failed");
        })
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_write_failed",
      playedChunkCount: 0
    });
    expectRequestTelemetry(audit, {
      status: "skipped",
      durationMs: 20,
      errorCode: "cancelled",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
  });

  it("records a cancelled producer terminal as skipped when the caller cancels", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("cancelled", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback,
        signal: controller.signal,
        probe: { audit },
        monotonicNow: () => clock.value
      })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expectRequestTelemetry(audit, {
      status: "skipped",
      durationMs: 20,
      errorCode: "cancelled",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
    writeGate.resolve();
  });

  it("emits partial-failure telemetry after the current write updates played count", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("backend_error", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    expect(
      audit.entries().find((entry) => entry.attributes["pico.voice.stage"] === "tts_request_wall")
    ).toBeUndefined();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "backend_error",
      playedChunkCount: 1,
      sentenceIndex: 1
    });
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 20,
      errorCode: "backend_error",
      sentenceIndex: 1,
      playedChunkCount: 1
    });
  });

  it.each([
    "rejected",
    "done"
  ] as const)("defers a %s lookahead outcome until the current write updates played count", async (outcome) => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    let pullCount = 0;
    const tts = ttsFromIterator({
      next: (): Promise<IteratorResult<TtsSynthesisEvent>> => {
        pullCount += 1;
        if (pullCount === 1) {
          clock.value = 10;
          return Promise.resolve({ done: false, value: chunkEvent(0) });
        }
        clock.value = 20;
        if (outcome === "rejected") {
          return Promise.reject(new Error("producer failed"));
        }
        return Promise.resolve({ done: true, value: undefined });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback: recordingPlayback({ onWrite: () => writeGate.promise }),
        probe: { audit },
        monotonicNow: () => clock.value
      })
    );
    await vi.waitFor(() => expect(pullCount).toBe(2));
    await Promise.resolve();
    expect(
      audit.entries().find((entry) => entry.attributes["pico.voice.stage"] === "tts_request_wall")
    ).toBeUndefined();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "tts_request_failed",
      playedChunkCount: 1
    });
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 20,
      errorCode: "tts_request_failed",
      playedChunkCount: 1
    });
  });

  it("emits a producer failure before stalled playback cleanup finishes", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const stopStarted = createSignalGate();
    const stopGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("backend_error", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const playback = recordingPlayback({
      onWrite: () =>
        writeGate.promise.then(() => {
          throw new Error("write failed");
        }),
      onStop: () => {
        stopStarted.resolve();
        return stopGate.promise;
      }
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    writeGate.resolve();
    await stopStarted.promise;

    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 20,
      errorCode: "backend_error",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
    stopGate.resolve();
    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_write_failed",
      playedChunkCount: 0
    });
  });

  it("emits a cancelled producer terminal before stalled cancellation cleanup finishes", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const stopStarted = createSignalGate();
    const stopGate = createSignalGate();
    const events = [chunkEvent(0), failedEvent("cancelled", 1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined)
    });
    const playback = recordingPlayback({
      onWrite: () => writeGate.promise,
      onStop: () => {
        stopStarted.resolve();
        return stopGate.promise;
      }
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback,
        signal: controller.signal,
        probe: { audit },
        monotonicNow: () => clock.value
      })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    controller.abort(new Error("cancelled"));
    await stopStarted.promise;

    expectRequestTelemetry(audit, {
      status: "skipped",
      durationMs: 20,
      errorCode: "cancelled",
      sentenceIndex: 1,
      playedChunkCount: 0
    });
    stopGate.resolve();
    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    writeGate.resolve();
  });

  it("waits beyond the echo safety bound for TERM then KILL playback ownership to settle", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const termGate = createSignalGate();
    const killTerminal = createSignalGate();
    const stopPhases: string[] = [];
    const playback = recordingPlayback({
      onWrite: () => writeGate.promise,
      onStop: async () => {
        stopPhases.push("term");
        await termGate.promise;
        stopPhases.push("kill");
        await killTerminal.promise;
        stopPhases.push("terminal");
      }
    });
    let settled = false;

    try {
      const running = runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback,
          signal: controller.signal
        })
      );
      void running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await vi.waitFor(() => expect(playback.state.writes).toHaveLength(1));

      controller.abort(new Error("cancelled"));
      await vi.waitFor(() => expect(stopPhases).toEqual(["term"]));
      await vi.advanceTimersByTimeAsync(1_100);
      expect(settled).toBe(false);

      termGate.resolve();
      await vi.waitFor(() => expect(stopPhases).toEqual(["term", "kill"]));
      expect(settled).toBe(false);
      killTerminal.resolve();

      await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
      expect(stopPhases).toEqual(["term", "kill", "terminal"]);
      writeGate.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a rejected terminal playback stop as infrastructure failure", async () => {
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const playback = recordingPlayback({
      onWrite: () => writeGate.promise,
      onStop: () => Promise.reject(new Error("playback final termination timeout"))
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(playback.state.writes).toHaveLength(1));

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_stop_failed",
      playedChunkCount: 0
    });
    writeGate.resolve();
  });

  it("bounds a malicious playback stop above the production termination contract", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const playback = recordingPlayback({
      onWrite: () => writeGate.promise,
      onStop: () => new Promise<void>(() => undefined)
    });

    try {
      const running = runTtsPlaybackPipeline(
        pipelineInput({
          tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
          playback,
          signal: controller.signal
        })
      );
      await vi.waitFor(() => expect(playback.state.writes).toHaveLength(1));

      controller.abort(new Error("cancelled"));
      await vi.advanceTimersByTimeAsync(2_099);
      let settled = false;
      void running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(running).resolves.toEqual({
        status: "failed",
        errorCode: "playback_stop_timeout",
        playedChunkCount: 0
      });
      writeGate.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records downstream telemetry before cleanup when lookahead is non-terminal", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const writeGate = createSignalGate();
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), chunkEvent(1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({
      onWrite: () =>
        writeGate.promise.then(() => {
          throw new Error("write failed");
        })
    });
    const running = runTtsPlaybackPipeline(
      pipelineInput({ tts, playback, probe: { audit }, monotonicNow: () => clock.value })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    writeGate.resolve();

    await expect(running).resolves.toEqual({
      status: "failed",
      errorCode: "playback_write_failed",
      playedChunkCount: 0
    });
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 30,
      errorCode: "playback_write_failed"
    });
    returnGate.resolve();
    await Promise.resolve();
    expectRequestTelemetry(audit, {
      status: "error",
      durationMs: 30,
      errorCode: "playback_write_failed"
    });
  });

  it("records cancellation telemetry before cleanup when lookahead is non-terminal", async () => {
    const audit = createStructuredAuditLog();
    const clock = { value: 0 };
    const controller = new AbortController();
    const writeGate = createSignalGate();
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), chunkEvent(1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        clock.value = eventIndex === 0 ? 10 : 20;
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({ onWrite: () => writeGate.promise });
    const running = runTtsPlaybackPipeline(
      pipelineInput({
        tts,
        playback,
        probe: { audit },
        monotonicNow: () => clock.value,
        signal: controller.signal
      })
    );
    await vi.waitFor(() => expect(eventIndex).toBe(2));
    await Promise.resolve();
    clock.value = 30;

    controller.abort(new Error("cancelled"));

    await expect(running).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });
    expectRequestTelemetry(audit, {
      status: "skipped",
      durationMs: 30,
      errorCode: "cancelled"
    });
    returnGate.resolve();
    writeGate.resolve();
    await Promise.resolve();
    expectRequestTelemetry(audit, {
      status: "skipped",
      durationMs: 30,
      errorCode: "cancelled"
    });
  });

  it("does not wait for an abort-insensitive iterator return after playback failure", async () => {
    const returnGate = createSignalGate();
    const events = [chunkEvent(0), completedEvent(1)] as const;
    let eventIndex = 0;
    const tts = ttsFromIterator({
      next: () => {
        const value = requireSynthesisEvent(events[eventIndex]);
        eventIndex += 1;
        return Promise.resolve({ done: false, value });
      },
      return: () => returnGate.promise.then(() => ({ done: true, value: undefined }))
    });
    const playback = recordingPlayback({ finishError: new Error("finish failed") });
    const running = runTtsPlaybackPipeline(pipelineInput({ tts, playback }));

    await expect(
      Promise.race([
        running,
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 25))
      ])
    ).resolves.toMatchObject({ status: "failed", errorCode: "playback_finish_failed" });
    returnGate.resolve();
  });

  it("bounds iterator cleanup after a completed playback", async () => {
    const events = [chunkEvent(0), completedEvent(1)] as const;
    let eventIndex = 0;
    let returnStarts = 0;
    let rejectReturn: (error: Error) => void = () => {
      throw new Error("test iterator reject function was not initialized");
    };
    const pendingReturn = new Promise<IteratorResult<TtsSynthesisEvent>>((_resolve, reject) => {
      rejectReturn = reject;
    });
    const playback = recordingPlayback();
    const tts = ttsFromIterator({
      next: () =>
        Promise.resolve({ done: false, value: requireSynthesisEvent(events[eventIndex++]) }),
      return: () => {
        returnStarts += 1;
        return pendingReturn;
      }
    });

    await expect(
      within(runTtsPlaybackPipeline(pipelineInput({ tts, playback })), 250)
    ).resolves.toEqual({ status: "completed", playedChunkCount: 1, durationMs: 10 });
    expect(returnStarts).toBe(1);
    expect(playback.state.writes).toHaveLength(1);
    rejectReturn(new Error("late iterator cleanup rejection"));
    await Promise.resolve();
    expect(returnStarts).toBe(1);
    expect(playback.state.writes).toHaveLength(1);
  });

  it("bounds iterator cleanup after an empty completion", async () => {
    let nextCalls = 0;
    let returnStarts = 0;
    const playback = recordingPlayback();
    const tts = ttsFromIterator({
      next: () => {
        nextCalls += 1;
        return Promise.resolve({ done: false, value: completedEvent(0) });
      },
      return: () => {
        returnStarts += 1;
        return new Promise<IteratorResult<TtsSynthesisEvent>>(() => undefined);
      }
    });

    await expect(
      within(runTtsPlaybackPipeline(pipelineInput({ tts, playback })), 250)
    ).resolves.toEqual({ status: "empty", playedChunkCount: 0 });
    expect(nextCalls).toBe(1);
    expect(returnStarts).toBe(1);
    expect(playback.state.opens).toBe(0);
  });
});

function chunkEvent(
  sentenceIndex: number,
  options: {
    readonly durationMs?: number;
    readonly sampleRateHz?: number;
    readonly channels?: number;
    readonly audio?: readonly number[];
  } = {}
): Extract<TtsSynthesisEvent, { readonly kind: "chunk" }> {
  return {
    kind: "chunk",
    chunk: {
      sentenceIndex,
      text: `sentence-${String(sentenceIndex)}`,
      audio: Uint8Array.from(options.audio ?? [sentenceIndex + 1, 0]),
      encoding: "pcm16le",
      sampleRateHz: options.sampleRateHz ?? 24_000,
      channels: options.channels ?? 1,
      durationMs: options.durationMs ?? 10,
      source
    }
  };
}

function pcm16(samples: readonly number[]): Uint8Array {
  const audio = new Uint8Array(samples.length * 2);
  const view = new DataView(audio.buffer);

  for (const [index, sample] of samples.entries()) {
    view.setInt16(index * 2, sample, true);
  }
  return audio;
}

function failedEvent(
  reason: TtsSynthesisFailure["reason"],
  sentenceIndex: number
): Extract<TtsSynthesisEvent, { readonly kind: "failed" }> {
  return {
    kind: "failed",
    failure: {
      ok: false,
      reason,
      message: `${reason} at sentence ${String(sentenceIndex)}`,
      sentenceIndex,
      source
    }
  };
}

function completedEvent(chunkCount: number): TtsSynthesisEvent {
  return {
    kind: "completed",
    chunkCount,
    totalDurationMs: chunkCount * 10,
    source
  };
}

function ttsFromEvents(events: () => AsyncIterable<TtsSynthesisEvent>): TtsClient {
  return { synthesize: events };
}

function ttsFromArray(events: readonly TtsSynthesisEvent[]): TtsClient {
  return ttsFromEvents(async function* () {
    await Promise.resolve();
    yield* events;
  });
}

function ttsFromIterator(iterator: AsyncIterator<TtsSynthesisEvent>): TtsClient {
  return {
    synthesize: () => ({
      [Symbol.asyncIterator]: () => iterator
    })
  };
}

function requireSynthesisEvent(event: TtsSynthesisEvent | undefined): TtsSynthesisEvent {
  if (event === undefined) {
    throw new Error("test TTS event is required");
  }
  return event;
}

function recordingPlayback(
  options: {
    readonly onOpen?: () => void;
    readonly onWrite?: (chunk: TtsAudioChunk) => void | Promise<void>;
    readonly onFinish?: () => void | Promise<void>;
    readonly onStop?: () => void | Promise<void>;
    readonly openError?: Error;
    readonly writeError?: Error;
    readonly finishError?: Error;
  } = {}
): VoicePlaybackSink & {
  readonly state: {
    opens: number;
    readonly writes: TtsAudioChunk[];
    finishes: number;
    stops: number;
  };
} {
  const state = { opens: 0, writes: [] as TtsAudioChunk[], finishes: 0, stops: 0 };
  const sink: VoicePlaybackSink = {
    open: () => ({
      write: (chunk) => {
        state.writes.push(chunk);
        if (options.writeError !== undefined) {
          throw options.writeError;
        }
        return Promise.resolve(options.onWrite?.(chunk));
      },
      finish: () => {
        state.finishes += 1;
        if (options.finishError !== undefined) {
          throw options.finishError;
        }
        return Promise.resolve(options.onFinish?.());
      }
    }),
    stop: () => {
      state.stops += 1;
      return Promise.resolve(options.onStop?.());
    },
    close: () => Promise.resolve()
  };
  return {
    ...sink,
    open(firstChunk, signal) {
      state.opens += 1;
      options.onOpen?.();
      if (options.openError !== undefined) {
        throw options.openError;
      }
      return sink.open(firstChunk, signal);
    },
    state
  };
}

function hostileResetEcho(
  state: { acceptStarts: number; flushes: number },
  reset: () => Promise<never>,
  onAccept?: () => void,
  onFlush?: () => void
): EchoControlProvider {
  return {
    describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
    checkHealth: () =>
      Promise.resolve({
        ok: true,
        provider: "half_duplex",
        mode: "half_duplex",
        engine: "test"
      }),
    acceptFarEndReference: () => {
      state.acceptStarts += 1;
      onAccept?.();
      return Promise.resolve({ status: "applied" });
    },
    processNearEnd: (frame) =>
      Promise.resolve({
        action: "pass",
        reason: "no_far_end_tail",
        frame,
        diagnostics: {
          provider: "half_duplex",
          residualEchoProbability: 0,
          voiceActivity: false
        }
      }),
    flush: () => {
      state.flushes += 1;
      onFlush?.();
      return reset();
    }
  };
}

async function expectUnsafeResetToPoisonProvider(resetResult: unknown): Promise<void> {
  const controller = new AbortController();
  const state = { acceptStarts: 0, flushes: 0 };
  const echoControl = hostileResetEcho(
    state,
    () => Promise.resolve(resetResult) as never,
    () => {
      if (state.acceptStarts === 1) {
        queueMicrotask(() => controller.abort(new Error("cancelled after apply")));
      }
    }
  );
  const firstPlayback = recordingPlayback();

  await expect(
    runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: firstPlayback,
        echoControl,
        signal: controller.signal
      })
    )
  ).resolves.toEqual({ status: "cancelled", playedChunkCount: 0 });

  const secondPlayback = recordingPlayback();
  await expect(
    runTtsPlaybackPipeline(
      pipelineInput({
        tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
        playback: secondPlayback,
        echoControl
      })
    )
  ).resolves.toEqual({
    status: "failed",
    errorCode: "echo_control_failed",
    playedChunkCount: 0
  });
  expect(state.acceptStarts).toBe(1);
  expect(firstPlayback.state.writes).toHaveLength(0);
  expect(secondPlayback.state.writes).toHaveLength(0);
}

async function expectUnsafePostWriteResetToPoisonProvider(
  reset: () => Promise<never>,
  timeoutMs?: number
): Promise<void> {
  const controller = new AbortController();
  const producerGate = createSignalGate();
  const state = { acceptStarts: 0, flushes: 0 };
  const echoControl = hostileResetEcho(state, reset);
  const firstPlayback = recordingPlayback();
  const firstRunning = runTtsPlaybackPipeline(
    pipelineInput({
      tts: ttsFromEvents(async function* () {
        yield chunkEvent(0);
        await producerGate.promise;
        yield completedEvent(1);
      }),
      playback: firstPlayback,
      echoControl,
      signal: controller.signal
    })
  );
  await vi.waitFor(() => expect(firstPlayback.state.writes).toHaveLength(1));

  controller.abort(new Error("cancelled after write"));

  const firstResult =
    timeoutMs === undefined ? await firstRunning : await within(firstRunning, timeoutMs);
  expect(firstResult).toEqual({ status: "cancelled", playedChunkCount: 1 });

  const secondPlayback = recordingPlayback();
  const secondRunning = runTtsPlaybackPipeline(
    pipelineInput({
      tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
      playback: secondPlayback,
      echoControl
    })
  );
  const secondResult =
    timeoutMs === undefined ? await secondRunning : await within(secondRunning, timeoutMs);
  expect(secondResult).toEqual({
    status: "failed",
    errorCode: "echo_control_failed",
    playedChunkCount: 0
  });
  expect(state.acceptStarts).toBe(1);
  expect(firstPlayback.state.writes).toHaveLength(1);
  expect(secondPlayback.state.writes).toHaveLength(0);
  producerGate.resolve();
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timed_out"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise,
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    })
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
}

function expectRequestTelemetry(
  audit: StructuredAuditLog,
  expected: {
    readonly status: "ok" | "error" | "skipped";
    readonly durationMs: number;
    readonly chunkCount?: number;
    readonly playedChunkCount?: number;
    readonly errorCode?: string;
    readonly sentenceIndex?: number;
  }
): void {
  const events = audit
    .entries()
    .filter((event) => event.attributes["pico.voice.stage"] === "tts_request_wall");
  expect(events).toHaveLength(1);
  expect(events[0]?.attributes).toMatchObject({
    "pico.voice.stage_status": expected.status,
    "pico.voice.stage_duration_ms": expected.durationMs,
    ...(expected.chunkCount === undefined ? {} : { "pico.voice.chunk_count": expected.chunkCount }),
    ...(expected.playedChunkCount === undefined
      ? {}
      : { "pico.voice.played_chunk_count": expected.playedChunkCount }),
    ...(expected.errorCode === undefined ? {} : { "pico.voice.error_code": expected.errorCode }),
    ...(expected.sentenceIndex === undefined
      ? {}
      : { "pico.voice.sentence_index": expected.sentenceIndex })
  });
}

function pipelineInput(input: {
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly signal?: AbortSignal;
  readonly echoControl?: EchoControlProvider;
  readonly probe?: VoiceStageProbe;
  readonly monotonicNow?: () => number;
  readonly onFirstPlaybackStart?: () => boolean | Promise<boolean>;
  readonly onFirstPlaybackWriteAccepted?: () => void;
  readonly text?: string;
}) {
  return {
    text: input.text ?? "一文目。二文目。",
    signal: input.signal ?? new AbortController().signal,
    tts: input.tts,
    playback: input.playback,
    echoControl: input.echoControl ?? recordingEcho().provider,
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    now: () => "2026-07-19T00:00:00.000Z",
    monotonicNow: input.monotonicNow ?? (() => 0),
    ...(input.onFirstPlaybackStart === undefined
      ? {}
      : { onFirstPlaybackStart: input.onFirstPlaybackStart }),
    ...(input.onFirstPlaybackWriteAccepted === undefined
      ? {}
      : { onFirstPlaybackWriteAccepted: input.onFirstPlaybackWriteAccepted })
  };
}

function recordingEcho(
  options: { readonly onAccept?: (frame: VoicePcmFrame) => void; readonly acceptError?: Error } = {}
): {
  readonly provider: EchoControlProvider;
  readonly state: { readonly references: VoicePcmFrame[]; acceptStarts: number; flushes: number };
} {
  const state = { references: [] as VoicePcmFrame[], acceptStarts: 0, flushes: 0 };
  return {
    provider: {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: (frame) => {
        state.acceptStarts += 1;
        if (options.acceptError !== undefined) {
          return Promise.resolve({
            status: "definitely_not_applied",
            error: options.acceptError
          });
        }
        state.references.push(frame);
        options.onAccept?.(frame);
        return Promise.resolve({ status: "applied" });
      },
      processNearEnd: (frame) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: false
          }
        }),
      flush: () => {
        state.flushes += 1;
        return Promise.resolve({ status: "reset" });
      }
    },
    state
  };
}

function delayedEcho(accept: Promise<void>): {
  readonly provider: EchoControlProvider;
  readonly state: {
    readonly references: VoicePcmFrame[];
    acceptStarts: number;
    acceptCompletions: number;
    flushes: number;
  };
} {
  const state = {
    references: [] as VoicePcmFrame[],
    acceptStarts: 0,
    acceptCompletions: 0,
    flushes: 0
  };
  return {
    provider: {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: async (frame) => {
        state.acceptStarts += 1;
        await accept;
        state.references.push(frame);
        state.acceptCompletions += 1;
        return { status: "applied" };
      },
      processNearEnd: (frame) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: false
          }
        }),
      flush: () => {
        state.references.length = 0;
        state.flushes += 1;
        return Promise.resolve({ status: "reset" });
      }
    },
    state
  };
}

function generationEcho(firstAccept: Promise<void>): {
  readonly provider: EchoControlProvider;
  readonly secondAcceptStarted: Promise<void>;
  readonly state: {
    readonly references: number[];
    readonly acceptedStarts: number[];
    flushes: number;
  };
} {
  const secondAcceptStarted = createSignalGate();
  const state = { references: [] as number[], acceptedStarts: [] as number[], flushes: 0 };
  return {
    provider: {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: async (frame) => {
        const generation = frame.audio[0];
        if (generation === undefined) {
          throw new Error("test echo generation marker is required");
        }
        state.acceptedStarts.push(generation);
        if (generation === 1) {
          await firstAccept;
        } else {
          secondAcceptStarted.resolve();
        }
        state.references.push(generation);
        return { status: "applied" };
      },
      processNearEnd: (frame) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: false
          }
        }),
      flush: () => {
        state.references.length = 0;
        state.flushes += 1;
        return Promise.resolve({ status: "reset" });
      }
    },
    secondAcceptStarted: secondAcceptStarted.promise,
    state
  };
}

async function expectNonConformingRegistrationToFailClosed(
  registration: () => Promise<never>
): Promise<void> {
  const echo = nonConformingEcho(registration);
  const firstPlayback = recordingPlayback();
  const firstResult = await runTtsPlaybackPipeline(
    pipelineInput({
      tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
      playback: firstPlayback,
      echoControl: echo.provider
    })
  );
  const secondPlayback = recordingPlayback();
  const secondResult = await runTtsPlaybackPipeline(
    pipelineInput({
      tts: ttsFromArray([chunkEvent(0), completedEvent(1)]),
      playback: secondPlayback,
      echoControl: echo.provider
    })
  );

  expect(firstResult).toEqual({
    status: "failed",
    errorCode: "echo_control_failed",
    playedChunkCount: 0
  });
  expect(secondResult).toEqual({
    status: "failed",
    errorCode: "echo_control_failed",
    playedChunkCount: 0
  });
  expect(echo.state.acceptStarts).toBe(1);
  expect(firstPlayback.state.writes).toHaveLength(0);
  expect(secondPlayback.state.writes).toHaveLength(0);
}

function nonConformingEcho(registration: () => Promise<never>): {
  readonly provider: EchoControlProvider;
  readonly state: { acceptStarts: number };
} {
  const state = { acceptStarts: 0 };
  return {
    provider: {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: () => {
        state.acceptStarts += 1;
        return registration();
      },
      processNearEnd: (frame) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: false
          }
        }),
      flush: () => Promise.resolve({ status: "reset" })
    },
    state
  };
}

function echoRegistrationResponse(): Response {
  return new Response(
    JSON.stringify({
      action: "pass",
      reason: "aec_processed",
      audioBase64: Buffer.from([1, 0]).toString("base64"),
      diagnostics: {
        residualEchoProbability: 0,
        voiceActivity: false
      }
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function requireAbortSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) {
    throw new Error("test TTS signal is required");
  }
  return signal;
}

function createSignalGate(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
