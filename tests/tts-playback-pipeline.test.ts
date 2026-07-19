import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
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
import { runTtsPlaybackPipeline } from "../src/runtime/tts-playback-pipeline.js";
import type { VoicePlaybackSink } from "../src/runtime/voice-playback.js";
import type { VoiceStageProbe } from "../src/runtime/voice-stage-probe.js";

const source = {
  serviceId: "local-tts",
  provider: "aivis-speech",
  speakerId: 1
} as const;

describe("TTS playback pipeline", () => {
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

  it("reuses an HTTP provider after cancellation when its applied reference was written", async () => {
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
    ).resolves.toEqual({ status: "completed", playedChunkCount: 1, durationMs: 10 });
    expect(farEndRequests).toBe(2);
    expect(secondPlayback.state.writes).toHaveLength(1);
    producerGate.resolve();
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
      "pico.voice.utterance_duration_ms": 10
    });
    expect(JSON.stringify(events)).not.toContain("private assistant body");
    expect(JSON.stringify(events)).not.toContain('"audio"');
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
    readonly onWrite?: (chunk: TtsAudioChunk) => void | Promise<void>;
    readonly onFinish?: () => void | Promise<void>;
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
      return Promise.resolve();
    },
    close: () => Promise.resolve()
  };
  return {
    ...sink,
    open(firstChunk, signal) {
      state.opens += 1;
      if (options.openError !== undefined) {
        throw options.openError;
      }
      return sink.open(firstChunk, signal);
    },
    state
  };
}

function pipelineInput(input: {
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly signal?: AbortSignal;
  readonly echoControl?: EchoControlProvider;
  readonly probe?: VoiceStageProbe;
  readonly monotonicNow?: () => number;
  readonly onFirstPlaybackStart?: () => boolean;
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
      : { onFirstPlaybackStart: input.onFirstPlaybackStart })
  };
}

function recordingEcho(
  options: { readonly onAccept?: (frame: VoicePcmFrame) => void; readonly acceptError?: Error } = {}
): {
  readonly provider: EchoControlProvider;
  readonly state: { readonly references: VoicePcmFrame[]; flushes: number };
} {
  const state = { references: [] as VoicePcmFrame[], flushes: 0 };
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
