import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionLifecycle } from "../src/modules/session/index.js";
import type { VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import type {
  SttClient,
  SttTranscriptionResult,
  TtsClient,
  TtsSynthesisResult
} from "../src/modules/voice/index.js";
import type {
  ResidentAudioCapture,
  ResidentCaptureSession
} from "../src/runtime/resident-audio-io.js";
import {
  createVoiceResidentRuntime,
  type PiAgentTurnClient,
  type VoicePlaybackSink
} from "../src/runtime/voice-resident.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("resident hold-to-talk voice runtime", () => {
  it("owns no microphone and makes no STT call while idle", async () => {
    const driver = createDriver();

    expect(driver.capture.starts()).toBe(0);
    expect(driver.sttRequests).toEqual([]);
    expect(driver.runtime.state()).toBe("idle");

    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      acceptedHolds: 0,
      completedTurns: 0
    });
  });

  it("captures only after press, keeps the 250 ms tail, and submits one Pi turn", async () => {
    vi.useFakeTimers();
    const driver = createDriver();

    await expect(driver.press()).resolves.toBe("accepted");
    expect(driver.capture.starts()).toBe(1);
    driver.capture.emit(frame("first", [1, 0]));
    await expect(driver.release()).resolves.toBe("accepted");
    driver.capture.emit(frame("tail", [2, 0], "2026-07-17T00:00:00.010Z"));

    await vi.advanceTimersByTimeAsync(249);
    expect(driver.capture.stops()).toBe(0);
    expect(driver.sttRequests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.capture.stops()).toBe(1);
    expect(driver.sttRequests).toHaveLength(1);
    const sttRequest = driver.sttRequests[0];

    if (sttRequest === undefined) {
      throw new Error("expected one STT request");
    }

    expect([...sttRequest.audio]).toEqual([1, 0, 2, 0]);
    expect(driver.piRequests).toHaveLength(1);
    expect(driver.piRequests[0]).toMatchObject({
      sessionId: "session-1",
      text: "職員の発話"
    });
    expect(driver.playedChunks).toHaveLength(1);

    await driver.runtime.stop();
  });

  it("reuses the Pi parent conversation across separate holds", async () => {
    vi.useFakeTimers();
    const driver = createDriver();

    await completeHold(driver, "first");
    await completeHold(driver, "second");

    expect(driver.piRequests.map((request) => request.sessionId)).toEqual([
      "session-1",
      "session-1"
    ]);
    expect(driver.piRequests).toHaveLength(2);

    await driver.runtime.stop();
  });

  it("rejects a no-speech hold before STT and Pi", async () => {
    vi.useFakeTimers();
    const driver = createDriver({ speechDetected: false });

    await driver.press();
    driver.capture.emit(frame("quiet", [0, 0]));
    await driver.release();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.sttRequests).toEqual([]);
    expect(driver.piRequests).toEqual([]);

    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({ emptyHolds: 1 });
  });

  it("ignores talk while processing and never queues it", async () => {
    vi.useFakeTimers();
    const piGate = createGate<{ readonly text: string }>();
    const driver = createDriver({ piResponse: () => piGate.promise });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));

    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.capture.starts()).toBe(1);
    piGate.resolve({ text: "応答" });
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    expect(driver.capture.starts()).toBe(1);

    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      ignoredBusyTalkPresses: 1
    });
  });

  it("cancels listening without STT, farewell, or parent-session disposal", async () => {
    const driver = createDriver();

    await driver.press();
    driver.capture.emit(frame("partial", [1, 0]));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.capture.stops()).toBe(1);
    expect(driver.sttRequests).toEqual([]);
    expect(driver.piRequests).toEqual([]);
    expect(driver.disposedSessions).toEqual([]);

    await driver.runtime.stop();
  });

  it("aborts the active Pi turn exactly once and preserves its parent session", async () => {
    vi.useFakeTimers();
    let aborts = 0;
    const piResponse = (signal: AbortSignal | undefined): Promise<{ readonly text: string }> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(new Error("Pi turn aborted"));
          },
          { once: true }
        );
      });
    const driver = createDriver({ piResponse });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(aborts).toBe(1);
    expect(driver.disposedSessions).toEqual([]);
    expect(driver.playedChunks).toEqual([]);

    await driver.runtime.stop();
  });

  it("stops playback once when cancelled while speaking", async () => {
    vi.useFakeTimers();
    const playbackGate = createGate<undefined>();
    const driver = createDriver({ playbackCompletion: () => playbackGate.promise });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    expect(driver.playbackStops()).toBe(1);
    playbackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.playbackStops()).toBe(1);

    await driver.runtime.stop();
  });

  it("suppresses a late STT result from a cancelled generation", async () => {
    vi.useFakeTimers();
    const sttGate = createGate<SttTranscriptionResult>();
    const driver = createDriver({ sttResponse: () => sttGate.promise });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("transcribing"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    expect(driver.runtime.state()).toBe("cancelling");
    sttGate.resolve(successfulTranscript("遅い結果"));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.piRequests).toEqual([]);
    expect(driver.playedChunks).toEqual([]);

    await driver.runtime.stop();
  });

  it("drains owned work on shutdown and rejects later controls", async () => {
    const driver = createDriver();

    await driver.press();
    const firstStop = driver.runtime.stop();
    const secondStop = driver.runtime.stop();

    await expect(firstStop).resolves.toBeUndefined();
    await expect(secondStop).resolves.toBeUndefined();
    expect(driver.runtime.state()).toBe("stopped");
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.capture.stops()).toBe(1);
    expect(driver.playbackCloses()).toBe(1);
  });
});

type Driver = ReturnType<typeof createDriver>;

function createDriver(
  options: {
    readonly speechDetected?: boolean;
    readonly sttResponse?: (signal: AbortSignal | undefined) => Promise<SttTranscriptionResult>;
    readonly piResponse?: (signal: AbortSignal | undefined) => Promise<{ readonly text: string }>;
    readonly ttsResponse?: (signal: AbortSignal | undefined) => Promise<TtsSynthesisResult>;
    readonly playbackCompletion?: (signal: AbortSignal | undefined) => Promise<void>;
  } = {}
) {
  const capture = createControlledCapture();
  const sttRequests: Array<Parameters<SttClient["transcribe"]>[0]> = [];
  const piRequests: Array<Parameters<PiAgentTurnClient["prompt"]>[0]> = [];
  const playedChunks: Array<Parameters<VoicePlaybackSink["play"]>[0]> = [];
  const disposedSessions: string[] = [];
  let playbackStopCount = 0;
  let playbackCloseCount = 0;
  const stt: SttClient = {
    warmup: () => Promise.resolve(successfulTranscript("warm")),
    transcribe(request) {
      sttRequests.push(request);
      return (
        options.sttResponse?.(request.signal) ?? Promise.resolve(successfulTranscript("職員の発話"))
      );
    }
  };
  const piAgent: PiAgentTurnClient = {
    prompt(request) {
      piRequests.push(request);
      return options.piResponse?.(request.signal) ?? Promise.resolve({ text: "Picoの応答" });
    },
    disposeSession(sessionId) {
      disposedSessions.push(sessionId);
    },
    disposeAll() {}
  };
  const tts: TtsClient = {
    synthesize(request) {
      return options.ttsResponse?.(request.signal) ?? Promise.resolve(successfulSynthesis());
    }
  };
  const playback: VoicePlaybackSink = {
    play(chunk, _startedAt, signal) {
      playedChunks.push(chunk);
      return options.playbackCompletion?.(signal) ?? Promise.resolve();
    },
    stop() {
      playbackStopCount += 1;
      return Promise.resolve();
    },
    close() {
      playbackCloseCount += 1;
      return Promise.resolve();
    }
  };
  const runtime = createVoiceResidentRuntime({
    audioCapture: capture.provider,
    sessionLifecycle: createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    }),
    echoControl: {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: () => Promise.resolve(),
      processNearEnd: (input) =>
        Promise.resolve({
          action: "pass",
          reason: "no_far_end_tail",
          frame: input,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: options.speechDetected ?? true
          }
        }),
      flush: () => Promise.resolve()
    },
    speechActivity: {
      process: () =>
        Promise.resolve({
          speech: options.speechDetected ?? true,
          provider: "energy",
          rmsDb: -20
        })
    },
    stt,
    tts,
    playback,
    piAgent,
    now: () => "2026-07-17T00:00:00.000Z",
    monotonicNow: () => 0
  });

  return {
    runtime,
    capture,
    sttRequests,
    piRequests,
    playedChunks,
    disposedSessions,
    playbackStops: () => playbackStopCount,
    playbackCloses: () => playbackCloseCount,
    press: () =>
      runtime.handleControl({
        kind: "talk_pressed",
        occurredAt: "2026-07-17T00:00:00.000Z"
      }),
    release: () =>
      runtime.handleControl({
        kind: "talk_released",
        occurredAt: "2026-07-17T00:00:00.000Z"
      }),
    cancel: () =>
      runtime.handleControl({
        kind: "cancel_pressed",
        occurredAt: "2026-07-17T00:00:00.000Z"
      })
  };
}

async function startReleasedHold(driver: Driver): Promise<void> {
  await driver.press();
  driver.capture.emit(frame("speech", [1, 0]));
  await driver.release();
}

async function completeHold(driver: Driver, id: string): Promise<void> {
  await driver.press();
  driver.capture.emit(frame(id, [1, 0]));
  await driver.release();
  await vi.advanceTimersByTimeAsync(250);
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
}

function createControlledCapture(): {
  readonly provider: ResidentAudioCapture;
  readonly starts: () => number;
  readonly stops: () => number;
  readonly emit: (frame: VoicePcmFrame) => void;
} {
  let startCount = 0;
  let stopCount = 0;
  let active: ReturnType<typeof createFrameChannel> | undefined;
  const provider: ResidentAudioCapture = {
    start(signal): ResidentCaptureSession {
      startCount += 1;
      const channel = createFrameChannel();
      active = channel;
      let stopOperation: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        if (stopOperation === undefined) {
          stopCount += 1;
          channel.end();
          stopOperation = Promise.resolve();
        }

        return stopOperation;
      };
      signal.addEventListener("abort", () => {
        stop().catch(() => undefined);
      });

      return { frames: channel.frames, stop };
    },
    close() {
      active?.end();
      return Promise.resolve();
    }
  };

  return {
    provider,
    starts: () => startCount,
    stops: () => stopCount,
    emit(value) {
      if (active === undefined) {
        throw new Error("capture is not active");
      }

      active.emit(value);
    }
  };
}

function createFrameChannel(): {
  readonly frames: AsyncIterable<VoicePcmFrame>;
  readonly emit: (frame: VoicePcmFrame) => void;
  readonly end: () => void;
} {
  const queued: VoicePcmFrame[] = [];
  const waiters: Array<(result: IteratorResult<VoicePcmFrame>) => void> = [];
  let ended = false;

  return {
    frames: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const value = queued.shift();

            if (value !== undefined) {
              return Promise.resolve({ value, done: false });
            }

            if (ended) {
              return Promise.resolve({ value: undefined, done: true });
            }

            return new Promise<IteratorResult<VoicePcmFrame>>((resolve) => {
              waiters.push(resolve);
            });
          }
        };
      }
    },
    emit(value) {
      const waiter = waiters.shift();

      if (waiter === undefined) {
        queued.push(value);
        return;
      }

      waiter({ value, done: false });
    },
    end() {
      ended = true;

      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    }
  };
}

function frame(id: string, audio: readonly number[], capturedAt = "2026-07-17T00:00:00.000Z") {
  return {
    id,
    direction: "near_end",
    audio: new Uint8Array(audio),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt,
    durationMs: 10
  } as const satisfies VoicePcmFrame;
}

function successfulTranscript(text: string): SttTranscriptionResult {
  return {
    ok: true,
    text,
    language: "ja-JP",
    confidence: 1,
    durationMs: 10,
    segments: [],
    source: {
      sidecarId: "test-stt",
      provider: "apple-speech",
      language: "ja-JP"
    }
  };
}

function successfulSynthesis(): TtsSynthesisResult {
  return {
    ok: true,
    chunks: [
      {
        sentenceIndex: 0,
        text: "Picoの応答",
        audio: new Uint8Array([1, 0]),
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        durationMs: 10,
        source: {
          serviceId: "test-tts",
          provider: "aivis-speech",
          speakerId: 1
        }
      }
    ],
    totalDurationMs: 10,
    source: {
      serviceId: "test-tts",
      provider: "aivis-speech",
      speakerId: 1
    }
  };
}

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveGate: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveGate = resolve;
  });

  return { promise, resolve: resolveGate };
}
