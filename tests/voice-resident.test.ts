import { afterEach, describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createSessionLifecycle } from "../src/modules/session/index.js";
import {
  createHttpEchoControlProvider,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../src/modules/voice/echo-control.js";
import type {
  SttClient,
  SttTranscriptionResult,
  TtsClient,
  TtsSynthesisEvent,
  TtsSynthesisFailure,
  TtsSynthesisResult,
  TtsSynthesisSuccess
} from "../src/modules/voice/index.js";
import type { DeferredToolDeliverableResult } from "../src/runtime/deferred-tool-coordinator.js";
import type {
  ResidentAudioCapture,
  ResidentCaptureSession
} from "../src/runtime/resident-audio-io.js";
import type { ResidentVoiceValidationEvent } from "../src/runtime/resident-voice-validation.js";
import type { VoicePlaybackSession, VoicePlaybackSink } from "../src/runtime/voice-playback.js";
import {
  createVoiceResidentRuntime,
  type PiAgentTurnClient
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

    expect(Array.from(sttRequest.audio)).toEqual([1, 0, 2, 0]);
    expect(driver.piRequests).toHaveLength(1);
    expect(driver.piRequests[0]).toMatchObject({
      sessionId: "session-1",
      text: "職員の発話"
    });
    expect(driver.playedChunks).toHaveLength(1);

    await driver.runtime.stop();
  });

  it("records STT wall time separately from utterance duration", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const sttGate = createGate<SttTranscriptionResult>();
    const piGate = createGate<{ readonly text: string }>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      sttResponse: () => sttGate.promise,
      piResponse: () => piGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("transcribing"));
    monotonicTimeMs = 175;
    sttGate.resolve(successfulTranscript("職員の発話", 1_000));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));

    expect(voiceStageEvent(audit, "stt")).toMatchObject({
      attributes: {
        "pico.voice.stage": "stt",
        "pico.voice.stage_duration_ms": 175,
        "pico.voice.utterance_duration_ms": 1_000
      }
    });

    piGate.resolve({ text: "応答" });
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    await driver.runtime.stop();
  });

  it("records TTS request and playback wall time", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const ttsGate = createGate<TtsSynthesisResult>();
    const playbackGate = createGate<undefined>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      ttsResponse: () => ttsGate.promise,
      playbackCompletion: () => playbackGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("synthesizing"));
    monotonicTimeMs = 450;
    ttsGate.resolve(successfulSynthesis(1_200));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    monotonicTimeMs = 1_500;
    playbackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(voiceStageEvent(audit, "tts_request_wall")).toMatchObject({
      attributes: {
        "pico.voice.stage_duration_ms": 450,
        "pico.voice.chunk_count": 1,
        "pico.voice.played_chunk_count": 1
      }
    });
    expect(voiceStageEvent(audit, "tts_playback")).toMatchObject({
      attributes: {
        "pico.voice.stage_duration_ms": 1_050,
        "pico.voice.utterance_duration_ms": 1_200,
        "pico.voice.played_chunk_count": 1
      }
    });

    await driver.runtime.stop();
  });

  it("starts speaking after the first chunk while the next synthesis remains pending", async () => {
    vi.useFakeTimers();
    const second = createGate<TtsSynthesisEvent>();
    const driver = createDriver({
      ttsEvents: async function* () {
        yield chunkEvent(0);
        yield await second.promise;
        yield completedEvent(2);
      }
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    expect(driver.playedChunks.map((chunk) => chunk.sentenceIndex)).toEqual([0]);
    second.resolve(chunkEvent(1));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    await driver.runtime.stop();
  });

  it("settles a non-empty completed turn exactly once", async () => {
    vi.useFakeTimers();
    const deferredResults = [deferredResult("job-1"), deferredResult("job-2")];
    const driver = createDriver({ deferredResults });

    await completeHold(driver, "completed-settlement");

    expect(driver.runtime.state()).toBe("idle");
    expect(driver.deferredAcknowledgements()).toEqual([["job-1", "job-2"]]);
    expect(driver.sessionRefreshes()).toEqual(["session-1"]);
    expect(driver.playbackOpens()).toBe(1);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      completedTurns: 1,
      failedTurns: 0
    });
  });

  it.each([
    [
      "provider",
      () => ({
        ttsEvents: async function* (): AsyncIterable<TtsSynthesisEvent> {
          await Promise.resolve();
          yield failedEvent("backend_error");
        }
      })
    ],
    ["playback", () => ({ playbackCompletion: () => Promise.reject(new Error("speaker failed")) })],
    ["echo", () => ({ echoControl: failingFarEndEchoControl() })]
  ] as const)("settles a representative %s failure without delivery activity", async (_name, setup) => {
    vi.useFakeTimers();
    const driver = createDriver({
      ...setup(),
      deferredResults: [deferredResult("failed-job")]
    });

    await completeHold(driver, "failed-settlement");

    expect(driver.runtime.state()).toBe("idle");
    expect(driver.deferredAcknowledgements()).toEqual([]);
    expect(driver.sessionRefreshes()).toEqual([]);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      completedTurns: 0,
      failedTurns: 1
    });
  });

  it("settles cancellation without completing or failing the turn", async () => {
    vi.useFakeTimers();
    const playbackGate = createGate<undefined>();
    const driver = createDriver({
      deferredResults: [deferredResult("cancelled-job")],
      playbackCompletion: () => playbackGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    playbackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.deferredAcknowledgements()).toEqual([]);
    expect(driver.sessionRefreshes()).toEqual([]);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      cancelledTurns: 1,
      completedTurns: 0,
      failedTurns: 0
    });
  });

  it("settles an empty completed event stream without delivery activity or playback", async () => {
    vi.useFakeTimers();
    const driver = createDriver({
      deferredResults: [deferredResult("empty-job")],
      ttsEvents: async function* () {
        await Promise.resolve();
        yield completedEvent(0);
      }
    });

    await completeHold(driver, "empty-settlement");

    expect(driver.runtime.state()).toBe("idle");
    expect(driver.deferredAcknowledgements()).toEqual([]);
    expect(driver.sessionRefreshes()).toEqual([]);
    expect(driver.playbackOpens()).toBe(0);
    expect(driver.playedChunks).toEqual([]);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      completedTurns: 0,
      failedTurns: 0
    });
  });

  it.each([
    ["completed", () => successfulSynthesis()],
    ["failed", () => failedSynthesis("backend_error")]
  ] as const)("suppresses an invalidated generation's late %s TTS result", async (_name, result) => {
    vi.useFakeTimers();
    const ttsGate = createGate<TtsSynthesisResult>();
    const driver = createDriver({
      deferredResults: [deferredResult("late-job")],
      ttsResponse: () => ttsGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("synthesizing"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    ttsGate.resolve(result());
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.deferredAcknowledgements()).toEqual([]);
    expect(driver.sessionRefreshes()).toEqual([]);
    expect(driver.playbackOpens()).toBe(0);
    expect(driver.playedChunks).toEqual([]);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      cancelledTurns: 1,
      completedTurns: 0,
      failedTurns: 0
    });
  });

  it("records wall time from an accepted PTT release to first playback", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const ttsGate = createGate<TtsSynthesisResult>();
    let monotonicTimeMs = 100;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      ttsResponse: () => ttsGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("synthesizing"));
    monotonicTimeMs = 850;
    ttsGate.resolve(successfulSynthesis());
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(voiceStageEvent(audit, "ptt_release_to_playback_start")).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 750
      }
    });

    await driver.runtime.stop();
  });

  it("settles an accepted PTT release when no playback starts", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const driver = createDriver({ audit, speechDetected: false });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(voiceStageEvent(audit, "ptt_release_to_playback_start")).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "skipped",
        "pico.voice.error_code": "playback_not_started"
      }
    });

    await driver.runtime.stop();
  });

  it("records Pi prompt failure wall time", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const piGate = createGate<{ readonly text: string }>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      piResponse: () => piGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));
    monotonicTimeMs = 900;
    piGate.reject(new Error("Pi prompt failed"));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(voiceStageEvent(audit, "pi_turn")).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "error",
        "pico.voice.stage_duration_ms": 900,
        "pico.voice.error_code": "pi_agent_prompt_failed"
      }
    });

    await driver.runtime.stop();
  });

  it("reuses the active Pi interaction session across separate holds", async () => {
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

  it("records recognized and generated text only in an explicit validation sink", async () => {
    vi.useFakeTimers();
    const validationEvents: ResidentVoiceValidationEvent[] = [];
    const driver = createDriver({ validationEvents });

    await completeHold(driver, "validation-content");

    expect(validationEvents).toEqual([
      {
        kind: "staff_transcript",
        occurredAt: "2026-07-17T00:00:00.000Z",
        sessionId: "session-1",
        text: "職員の発話"
      },
      {
        kind: "pi_response",
        occurredAt: "2026-07-17T00:00:00.000Z",
        sessionId: "session-1",
        text: "Picoの応答"
      }
    ]);

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

  it("records an STT provider failure separately from an empty hold", async () => {
    vi.useFakeTimers();
    const driver = createDriver({
      sttResponse: () =>
        Promise.resolve({
          ok: false,
          reason: "backend_error",
          message: "speech backend unavailable",
          source: {
            sidecarId: "test-stt",
            provider: "apple-speech",
            language: "ja-JP"
          }
        })
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.piRequests).toEqual([]);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      emptyHolds: 0,
      failedTurns: 1
    });
  });

  it("records a rejected STT request as a failed turn with wall time", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const sttGate = createGate<SttTranscriptionResult>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      sttResponse: () => sttGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("transcribing"));
    monotonicTimeMs = 275;
    sttGate.reject(new Error("STT request rejected"));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    const sttEvents = voiceStageEvents(audit, "stt");
    expect(sttEvents).toHaveLength(1);
    expect(sttEvents[0]).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "error",
        "pico.voice.stage_duration_ms": 275,
        "pico.voice.error_code": "stt_request_failed"
      }
    });

    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      failedTurns: 1,
      failedCaptures: 0
    });
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

  it("cancels listening without STT, farewell, or interaction-session disposal", async () => {
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

  it("cancels the release tail without starting transcription", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    let monotonicTimeMs = 100;
    const driver = createDriver({ audit, monotonicNow: () => monotonicTimeMs });

    await driver.press();
    driver.capture.emit(frame("tail-cancel", [1, 0]));
    await driver.release();
    expect(driver.runtime.state()).toBe("tailing");
    monotonicTimeMs = 175;
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    await vi.advanceTimersByTimeAsync(250);

    expect(driver.sttRequests).toEqual([]);
    expect(driver.piRequests).toEqual([]);
    const pttEvents = audit
      .entries()
      .filter((event) => event.attributes["pico.voice.stage"] === "ptt_release_to_playback_start");
    expect(pttEvents).toHaveLength(1);
    expect(pttEvents[0]?.attributes).toMatchObject({
      "pico.voice.stage_status": "skipped",
      "pico.voice.stage_duration_ms": 75,
      "pico.voice.error_code": "cancelled"
    });
    await driver.runtime.stop();
  });

  it("aborts the active Pi turn exactly once and preserves its interaction session", async () => {
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
    const audit = createStructuredAuditLog();
    const playbackGate = createGate<undefined>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      playbackCompletion: () => playbackGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    monotonicTimeMs = 500;
    await expect(driver.cancel()).resolves.toBe("accepted");
    expect(driver.playbackStops()).toBe(1);
    playbackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.playbackStops()).toBe(1);
    const playbackEvents = voiceStageEvents(audit, "tts_playback");
    expect(playbackEvents).toHaveLength(1);
    expect(playbackEvents[0]).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "skipped",
        "pico.voice.stage_duration_ms": 500,
        "pico.voice.error_code": "cancelled"
      }
    });

    await driver.runtime.stop();
  });

  it("keeps the turn cancelling until TERM then KILL playback ownership is terminal", async () => {
    vi.useFakeTimers();
    const writeGate = createGate<undefined>();
    const termGate = createGate<undefined>();
    const killTerminal = createGate<undefined>();
    const stopPhases: string[] = [];
    const driver = createDriver({
      playbackCompletion: () => writeGate.promise,
      playbackStopCompletion: async () => {
        stopPhases.push("term");
        await termGate.promise;
        stopPhases.push("kill");
        await killTerminal.promise;
        stopPhases.push("terminal");
      }
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(stopPhases).toEqual(["term"]));
    await vi.advanceTimersByTimeAsync(1_100);

    expect(driver.runtime.state()).toBe("cancelling");
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.playbackOpens()).toBe(1);
    termGate.resolve(undefined);
    await vi.waitFor(() => expect(stopPhases).toEqual(["term", "kill"]));
    expect(driver.runtime.state()).toBe("cancelling");
    killTerminal.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(stopPhases).toEqual(["term", "kill", "terminal"]);
    await expect(driver.press()).resolves.toBe("accepted");
    await expect(driver.cancel()).resolves.toBe("accepted");
    writeGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    await driver.runtime.stop();
  });

  it("surfaces terminal playback stop failure and blocks another playback generation", async () => {
    vi.useFakeTimers();
    const writeGate = createGate<undefined>();
    const stopFailure = new Error("playback final termination timeout");
    const driver = createDriver({
      playbackCompletion: () => writeGate.promise,
      playbackStopCompletion: () => Promise.reject(stopFailure)
    });
    const completionFailure = driver.runtime.completion.catch((error: unknown) => error);

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("error"));

    expect(await completionFailure).toEqual(
      new Error(
        "pico resident voice playback infrastructure failed during cancellation: playback_stop_failed"
      )
    );
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.playbackOpens()).toBe(1);
    writeGate.resolve(undefined);
    await expect(driver.runtime.stop()).rejects.toThrow("playback infrastructure failed");
  });

  it("poisons HTTP echo after post-write cancellation and blocks the next generation before registration", async () => {
    vi.useFakeTimers();
    const pendingSynthesis = createGate<TtsSynthesisEvent>();
    let synthesisCount = 0;
    let farEndRequests = 0;
    const echoControl = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: (input) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (path === "/v1/echo-control/far-end") {
          farEndRequests += 1;
        }
        return Promise.resolve(echoControlPassResponse());
      }
    });
    const driver = createDriver({
      echoControl,
      ttsEvents: async function* () {
        synthesisCount += 1;
        yield chunkEvent(0);
        if (synthesisCount === 1) {
          yield await pendingSynthesis.promise;
        }
        yield completedEvent(1);
      }
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(1));
    await driver.cancel();
    pendingSynthesis.resolve(completedEvent(1));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    await completeHold(driver, "poisoned-http-next-generation");
    expect(farEndRequests).toBe(1);
    expect(driver.playedChunks).toHaveLength(1);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      cancelledTurns: 1,
      failedTurns: 1
    });
  });

  it("poisons echo after an applied but unwritten cancellation with malformed cleanup", async () => {
    vi.useFakeTimers();
    let cancel = (): Promise<unknown> => Promise.resolve();
    let registrations = 0;
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: () => {
        registrations += 1;
        queueMicrotask(() => {
          void cancel().catch(() => undefined);
        });
        return Promise.resolve({ status: "applied" });
      },
      processNearEnd: (input) => Promise.resolve(passingNearEnd(input)),
      flush: () => Promise.resolve({ status: "unexpected" }) as never
    };
    const driver = createDriver({ echoControl });
    cancel = driver.cancel;

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    expect(driver.playedChunks).toHaveLength(0);

    await driver.press();
    driver.capture.emit(frame("poisoned-malformed-next-generation", [1, 0]));
    await driver.release();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    expect(registrations).toBe(1);
    expect(driver.playedChunks).toHaveLength(0);
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({
      cancelledTurns: 1,
      failedTurns: 1
    });
  });

  it("suppresses a late STT result from a cancelled generation", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const sttGate = createGate<SttTranscriptionResult>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      sttResponse: () => sttGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("transcribing"));
    monotonicTimeMs = 125;
    await expect(driver.cancel()).resolves.toBe("accepted");
    expect(driver.runtime.state()).toBe("cancelling");
    sttGate.resolve(successfulTranscript("遅い結果"));
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.piRequests).toEqual([]);
    expect(driver.playedChunks).toEqual([]);
    const sttEvents = voiceStageEvents(audit, "stt");
    expect(sttEvents).toHaveLength(1);
    expect(sttEvents[0]).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "skipped",
        "pico.voice.stage_duration_ms": 125,
        "pico.voice.error_code": "cancelled"
      }
    });

    await driver.runtime.stop();
  });

  it("stops admitting buffered frames after cancellation", async () => {
    vi.useFakeTimers();
    const nearEndGate = createGate<undefined>();
    const processedFrameIds: string[] = [];
    const driver = createDriver({ nearEndGate: nearEndGate.promise, processedFrameIds });

    await driver.press();
    driver.capture.emit(frame("first", [1, 0]));
    driver.capture.emit(frame("second", [2, 0]));
    await driver.release();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(processedFrameIds).toEqual(["first"]));

    await expect(driver.cancel()).resolves.toBe("accepted");
    nearEndGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(processedFrameIds).toEqual(["first"]);
    expect(driver.sttRequests).toEqual([]);
    await driver.runtime.stop();
  });

  it("suppresses a late synthesis result after cancellation", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const ttsGate = createGate<TtsSynthesisResult>();
    let monotonicTimeMs = 0;
    const driver = createDriver({
      audit,
      monotonicNow: () => monotonicTimeMs,
      ttsResponse: () => ttsGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("synthesizing"));
    monotonicTimeMs = 300;
    await expect(driver.cancel()).resolves.toBe("accepted");
    ttsGate.resolve(successfulSynthesis());
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.playedChunks).toEqual([]);
    const ttsEvents = voiceStageEvents(audit, "tts_request_wall");
    expect(ttsEvents).toHaveLength(1);
    expect(ttsEvents[0]).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "skipped",
        "pico.voice.stage_duration_ms": 300,
        "pico.voice.error_code": "cancelled"
      }
    });
    await driver.runtime.stop();
  });

  it("records a provider-cancelled TTS request as skipped", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const driver = createDriver({
      audit,
      ttsResponse: () =>
        Promise.resolve({
          ok: false,
          reason: "cancelled",
          message: "request cancelled",
          sentenceIndex: 0,
          source: {
            serviceId: "test-tts",
            provider: "aivis-speech",
            speakerId: 1
          }
        })
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    const events = voiceStageEvents(audit, "tts_request_wall");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attributes: {
        "pico.voice.stage": "tts_request_wall",
        "pico.voice.stage_status": "skipped",
        "pico.voice.error_code": "cancelled"
      }
    });
    await driver.runtime.stop();
    await expect(driver.runtime.completion).resolves.toMatchObject({ failedTurns: 1 });
  });

  it("fails the runtime immediately when capture frames reject during a hold", async () => {
    const driver = createDriver();

    await driver.press();
    driver.capture.fail(new Error("capture stream failed"));

    await expect(driver.runtime.completion).rejects.toThrow("capture stream failed");
    expect(driver.runtime.state()).toBe("error");
    await expect(driver.runtime.stop()).rejects.toThrow("capture stream failed");
  });

  it("observes a runtime failure before a completion consumer attaches", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const driver = createDriver();

    try {
      await driver.press();
      driver.capture.fail(new Error("early capture failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      await expect(driver.runtime.completion).rejects.toThrow("early capture failure");
      await expect(driver.runtime.stop()).rejects.toThrow("early capture failure");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears playback and echo state after playback fails", async () => {
    vi.useFakeTimers();
    const driver = createDriver({
      playbackCompletion: () => Promise.reject(new Error("speaker failed"))
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

    expect(driver.playbackStops()).toBe(1);
    expect(driver.echoFlushes()).toBe(1);
    await driver.runtime.stop();
  });

  it("cancels deferred work and drains the active turn before disposing owners", async () => {
    vi.useFakeTimers();
    const lifecycleEvents: string[] = [];
    const piGate = createGate<{ readonly text: string }>();
    const driver = createDriver({
      lifecycleEvents,
      piResponse: () => piGate.promise
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));

    const stopping = driver.runtime.stop();
    await Promise.resolve();
    expect(lifecycleEvents).toEqual(["cancel_session"]);

    piGate.resolve({ text: "late response" });
    await stopping;
    expect(lifecycleEvents).toEqual(["cancel_session", "dispose_all", "wait_idle"]);
  });

  it("runs farewell and cleanup when inactivity ends the interaction", async () => {
    vi.useFakeTimers();
    const lifecycleEvents: string[] = [];
    const driver = createDriver({
      farewellEnabled: true,
      lifecycleEvents,
      sessionDurationMs: 1_000
    });

    await completeHold(driver, "inactivity");
    expect(driver.piRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));

    expect(driver.piRequests).toHaveLength(2);
    expect(driver.piRequests[1]?.text).toContain("voice session is ending");
    expect(driver.playedChunks).toHaveLength(2);
    expect(lifecycleEvents).toContain("cancel_session");
    await driver.runtime.stop();
  });

  it("lets an active turn finish before inactivity farewell and cleanup", async () => {
    vi.useFakeTimers();
    const piGate = createGate<{ readonly text: string }>();
    let promptCount = 0;
    let aborts = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      piResponse: (signal) => {
        promptCount += 1;

        if (promptCount > 1) {
          return Promise.resolve({ text: "終了の挨拶" });
        }

        signal?.addEventListener("abort", () => {
          aborts += 1;
        });
        return piGate.promise;
      }
    });

    await startReleasedHold(driver);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("processing"));
    await vi.advanceTimersByTimeAsync(1_000);
    const stateAfterInactivity = driver.runtime.state();

    piGate.resolve({ text: "通常の応答" });
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    await driver.runtime.stop();

    expect(stateAfterInactivity).toBe("processing");
    expect(aborts).toBe(0);
    expect(driver.piRequests).toHaveLength(2);
    expect(driver.playedChunks).toHaveLength(2);
  });

  it("waits for a listening hold before inactivity farewell and cleanup", async () => {
    vi.useFakeTimers();
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000
    });

    await completeHold(driver, "first");
    await driver.press();
    driver.capture.emit(frame("second", [1, 0]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(driver.runtime.state()).toBe("listening");

    await driver.release();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    await driver.runtime.stop();

    expect(driver.piRequests.map((request) => request.sessionId)).toEqual([
      "session-1",
      "session-1",
      "session-1"
    ]);
    expect(driver.piRequests[2]?.text).toContain("voice session is ending");
    expect(driver.playedChunks).toHaveLength(3);
  });

  it("cancels a pending inactivity farewell without skipping session cleanup", async () => {
    vi.useFakeTimers();
    const farewellGate = createGate<{ readonly text: string }>();
    let promptCount = 0;
    let farewellAborts = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      piResponse: (signal) => {
        promptCount += 1;

        if (promptCount === 1) {
          return Promise.resolve({ text: "通常の応答" });
        }

        signal?.addEventListener("abort", () => {
          farewellAborts += 1;
        });
        return farewellGate.promise;
      }
    });

    await completeHold(driver, "farewell-cancel");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.piRequests).toHaveLength(2));
    const result = await driver.cancel();
    farewellGate.resolve({ text: "遅い終了の挨拶" });
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    await driver.runtime.stop();

    expect(result).toBe("accepted");
    expect(farewellAborts).toBe(1);
    expect(driver.playedChunks).toHaveLength(1);
  });

  it("flushes echo once when farewell is cancelled during the Pi prompt", async () => {
    vi.useFakeTimers();
    const farewellGate = createGate<{ readonly text: string }>();
    const flushTerminal = createGate<undefined>();
    let promptCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      echoFlush: () => flushTerminal.promise,
      piResponse: () => {
        promptCount += 1;
        return promptCount === 1 ? Promise.resolve({ text: "通常の応答" }) : farewellGate.promise;
      }
    });

    await completeHold(driver, "farewell-prompt-flush");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.piRequests).toHaveLength(2));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.echoFlushes()).toBe(1));
    farewellGate.resolve({ text: "遅い終了の挨拶" });
    await Promise.resolve();

    expect(driver.disposedSessions).toEqual([]);
    flushTerminal.resolve(undefined);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    expect(driver.echoFlushes()).toBe(1);
    await driver.runtime.stop();
  });

  it("flushes echo once when farewell is cancelled before the first TTS chunk", async () => {
    vi.useFakeTimers();
    const firstFarewellChunkStarted = createGate<undefined>();
    const firstFarewellChunk = createGate<undefined>();
    const flushTerminal = createGate<undefined>();
    let synthesisCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      echoFlush: () => flushTerminal.promise,
      ttsEvents: async function* () {
        synthesisCount += 1;
        if (synthesisCount === 1) {
          yield chunkEvent(0);
          yield completedEvent(1);
          return;
        }
        firstFarewellChunkStarted.resolve(undefined);
        await firstFarewellChunk.promise;
        yield chunkEvent(0);
        yield completedEvent(1);
      }
    });

    await completeHold(driver, "farewell-first-chunk-flush");
    await vi.advanceTimersByTimeAsync(1_000);
    await firstFarewellChunkStarted.promise;
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.echoFlushes()).toBe(1));
    firstFarewellChunk.resolve(undefined);
    await Promise.resolve();

    expect(driver.disposedSessions).toEqual([]);
    flushTerminal.resolve(undefined);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    expect(driver.echoFlushes()).toBe(1);
    expect(driver.playbackOpens()).toBe(1);
    await driver.runtime.stop();
  });

  it("records interaction ending wall time through Pi session disposal", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const disposalGate = createGate<undefined>();
    let monotonicTimeMs = 100;
    const driver = createDriver({
      audit,
      sessionDurationMs: 1_000,
      monotonicNow: () => monotonicTimeMs,
      disposalCompletion: () => disposalGate.promise
    });

    await completeHold(driver, "interaction-end-latency");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    monotonicTimeMs = 525;
    disposalGate.resolve(undefined);
    await vi.waitFor(() => expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(1));

    expect(voiceStageEvent(audit, "interaction_end")).toMatchObject({
      attributes: {
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 425
      }
    });

    await driver.runtime.stop();
  });

  it("stops farewell playback when interaction ending is cancelled", async () => {
    vi.useFakeTimers();
    const farewellPlaybackGate = createGate<undefined>();
    let playbackCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      playbackCompletion: () => {
        playbackCount += 1;
        return playbackCount === 1 ? Promise.resolve() : farewellPlaybackGate.promise;
      }
    });

    await completeHold(driver, "farewell-playback-cancel");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(2));
    const result = await driver.cancel();
    farewellPlaybackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));

    expect(result).toBe("accepted");
    expect(driver.playbackStops()).toBe(1);
    expect(driver.echoFlushes()).toBe(1);
    await driver.runtime.stop();
  });

  it("enters error after rejected farewell playback stop and required disposal", async () => {
    vi.useFakeTimers();
    const farewellPlaybackGate = createGate<undefined>();
    const disposalGate = createGate<undefined>();
    let playbackCount = 0;
    let stopCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      disposalCompletion: () => disposalGate.promise,
      playbackCompletion: () => {
        playbackCount += 1;
        return playbackCount === 1 ? Promise.resolve() : farewellPlaybackGate.promise;
      },
      playbackStopCompletion: () => {
        stopCount += 1;
        return stopCount === 1
          ? Promise.reject(new Error("playback final termination timeout"))
          : Promise.resolve();
      }
    });
    const completionFailure = driver.runtime.completion.catch((error: unknown) => error);

    await completeHold(driver, "farewell-stop-rejection");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(2));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));

    expect(driver.runtime.state()).not.toBe("error");
    expect(driver.playbackStops()).toBe(1);
    expect(driver.echoFlushes()).toBe(1);
    disposalGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("error"));
    expect(await completionFailure).toEqual(
      new Error(
        "pico resident voice playback infrastructure failed during cancellation: playback_stop_failed"
      )
    );
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.playbackOpens()).toBe(2);
    farewellPlaybackGate.resolve(undefined);
    await expect(driver.runtime.stop()).rejects.toThrow("playback infrastructure failed");
  });

  it("enters error after farewell playback stop timeout and required disposal", async () => {
    vi.useFakeTimers();
    const farewellPlaybackGate = createGate<undefined>();
    const disposalGate = createGate<undefined>();
    let playbackCount = 0;
    let stopCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      disposalCompletion: () => disposalGate.promise,
      playbackCompletion: () => {
        playbackCount += 1;
        return playbackCount === 1 ? Promise.resolve() : farewellPlaybackGate.promise;
      },
      playbackStopCompletion: () => {
        stopCount += 1;
        return stopCount === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
      }
    });
    const completionFailure = driver.runtime.completion.catch((error: unknown) => error);

    await completeHold(driver, "farewell-stop-timeout");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(2));
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.advanceTimersByTimeAsync(2_099);

    expect(driver.disposedSessions).toEqual([]);
    expect(driver.runtime.state()).not.toBe("error");
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.playbackOpens()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    disposalGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("error"));

    expect(await completionFailure).toEqual(
      new Error(
        "pico resident voice playback infrastructure failed during cancellation: playback_stop_timeout"
      )
    );
    expect(driver.playbackStops()).toBe(1);
    expect(driver.echoFlushes()).toBe(1);
    await expect(driver.press()).resolves.toBe("ignored_busy");
    expect(driver.playbackOpens()).toBe(2);
    farewellPlaybackGate.resolve(undefined);
    await expect(driver.runtime.stop()).rejects.toThrow("playback infrastructure failed");
  });

  it("reclaims farewell echo cleanup ownership after pipeline terminal", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const disposalGate = createGate<undefined>();
    const flushTerminal = createGate<undefined>();
    const driver = createDriver({
      audit,
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      disposalCompletion: () => disposalGate.promise,
      echoFlush: () => flushTerminal.promise
    });

    await completeHold(driver, "farewell-terminal-ownership");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));
    expect(driver.playbackOpens()).toBe(2);
    expect(driver.echoFlushes()).toBe(0);

    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.echoFlushes()).toBe(1));
    disposalGate.resolve(undefined);
    await Promise.resolve();
    expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(0);
    await expect(driver.press()).resolves.toBe("ignored_busy");

    flushTerminal.resolve(undefined);
    await vi.waitFor(() => expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(1));
    expect(driver.echoFlushes()).toBe(1);
    await expect(driver.press()).resolves.toBe("accepted");
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    await driver.runtime.stop();
  });

  it("awaits farewell cancellation admitted as final cleanup settles", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const flushTerminal = createGate<undefined>();
    const boundaryCancellations: Array<ReturnType<Driver["cancel"]>> = [];
    const driver = createDriver({
      audit,
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      disposalCompletion: async () => {
        boundaryCancellations.push(driver.cancel(), driver.cancel());
        await Promise.all(boundaryCancellations);
      },
      echoFlush: () => flushTerminal.promise
    });

    await completeHold(driver, "farewell-pre-close-cancellation");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(boundaryCancellations).toHaveLength(2));
    await expect(Promise.all(boundaryCancellations)).resolves.toEqual(["accepted", "noop"]);
    await vi.waitFor(() => expect(driver.echoFlushes()).toBe(1));

    expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(0);
    await expect(driver.press()).resolves.toBe("ignored_busy");
    flushTerminal.resolve(undefined);
    await vi.waitFor(() => expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(1));
    expect(driver.echoFlushes()).toBe(1);
    await driver.runtime.stop();
  });

  it("closes farewell cancellation admission before releasing the ending generation", async () => {
    vi.useFakeTimers();
    const audit = createStructuredAuditLog();
    const flushTerminal = createGate<undefined>();
    let boundaryCancellation: ReturnType<Driver["cancel"]> | undefined;
    const driver = createDriver({
      audit,
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      beforeSessionRemove: () => {
        boundaryCancellation ??= driver.cancel();
      },
      echoFlush: () => flushTerminal.promise
    });

    await completeHold(driver, "farewell-closed-cancellation-admission");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(boundaryCancellation).toBeDefined());
    await expect(boundaryCancellation).resolves.toBe("noop");
    await vi.waitFor(() => expect(voiceStageEvents(audit, "interaction_end")).toHaveLength(1));

    expect(driver.echoFlushes()).toBe(0);
    await expect(driver.press()).resolves.toBe("accepted");
    await expect(driver.cancel()).resolves.toBe("accepted");
    await vi.waitFor(() => expect(driver.echoFlushes()).toBe(1));
    flushTerminal.resolve(undefined);
    await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
    await driver.runtime.stop();
  });

  it("does not start later farewell chunks after interaction ending is cancelled", async () => {
    vi.useFakeTimers();
    const firstFarewellChunkGate = createGate<undefined>();
    let playbackCount = 0;
    let synthesisCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      ttsResponse: () => {
        synthesisCount += 1;
        const synthesis = successfulSynthesis();

        if (synthesisCount === 1) {
          return Promise.resolve(synthesis);
        }

        const first = synthesis.chunks[0];

        if (first === undefined) {
          throw new Error("expected a synthesis chunk");
        }

        return Promise.resolve({
          ...synthesis,
          chunks: [first, { ...first, sentenceIndex: 1, text: "二つ目の挨拶" }],
          totalDurationMs: first.durationMs * 2
        });
      },
      playbackCompletion: () => {
        playbackCount += 1;
        return playbackCount === 2 ? firstFarewellChunkGate.promise : Promise.resolve();
      }
    });

    await completeHold(driver, "multi-chunk-farewell-cancel");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(2));
    expect(await driver.cancel()).toBe("accepted");
    firstFarewellChunkGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));

    expect(driver.playedChunks).toHaveLength(2);
    expect(driver.echoFarEndReferences()).toBe(2);
    expect(driver.echoFlushes()).toBe(1);
    await driver.runtime.stop();
  });

  it("finishes session cleanup before surfacing farewell playback infrastructure failure", async () => {
    vi.useFakeTimers();
    const farewellPlaybackGate = createGate<undefined>();
    let playbackCount = 0;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      playbackStopError: new Error("speaker stop failed"),
      playbackCompletion: () => {
        playbackCount += 1;
        return playbackCount === 1 ? Promise.resolve() : farewellPlaybackGate.promise;
      }
    });
    const completionFailure = driver.runtime.completion.then(
      () => undefined,
      (error: unknown) => error
    );

    await completeHold(driver, "farewell-cancel-cleanup-failure");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.playedChunks).toHaveLength(2));
    expect(await driver.cancel()).toBe("accepted");
    farewellPlaybackGate.resolve(undefined);
    await vi.waitFor(() => expect(driver.disposedSessions).toEqual(["session-1"]));

    expect(driver.disposedSessions).toEqual(["session-1"]);
    const expected = new Error(
      "pico resident voice playback infrastructure failed during cancellation: playback_stop_failed"
    );
    await expect(driver.runtime.stop()).rejects.toThrow(expected.message);
    await expect(completionFailure).resolves.toEqual(expected);
  });

  it("runs normal interaction ending before shared-owner shutdown", async () => {
    vi.useFakeTimers();
    const lifecycleEvents: string[] = [];
    const driver = createDriver({ farewellEnabled: true, lifecycleEvents });

    await completeHold(driver, "shutdown");
    await driver.runtime.stop();

    expect(driver.piRequests).toHaveLength(2);
    expect(driver.piRequests[1]?.text).toContain("voice session is ending");
    expect(driver.playedChunks).toHaveLength(2);
    expect(driver.disposedSessions).toEqual(["session-1"]);
    expect(lifecycleEvents).toEqual(["cancel_session", "dispose_all", "wait_idle"]);
  });

  it("aborts an existing inactivity farewell when shutdown starts", async () => {
    vi.useFakeTimers();
    const farewellGate = createGate<{ readonly text: string }>();
    let promptCount = 0;
    let farewellSignal: AbortSignal | undefined;
    const driver = createDriver({
      farewellEnabled: true,
      sessionDurationMs: 1_000,
      piResponse: (signal) => {
        promptCount += 1;

        if (promptCount === 1) {
          return Promise.resolve({ text: "通常の応答" });
        }

        farewellSignal = signal;
        return farewellGate.promise;
      }
    });

    await completeHold(driver, "shutdown-existing-farewell");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(driver.piRequests).toHaveLength(2));
    const stopping = driver.runtime.stop();

    try {
      expect(farewellSignal?.aborted).toBe(true);
    } finally {
      farewellGate.resolve({ text: "遅い終了の挨拶" });
      await stopping;
    }

    expect(driver.playedChunks).toHaveLength(1);
    expect(driver.disposedSessions).toEqual(["session-1"]);
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

  it("settles completion when shutdown owner cleanup fails", async () => {
    const driver = createDriver({ playbackStopError: new Error("speaker stop failed") });
    const completionFailure = driver.runtime.completion.then(
      () => undefined,
      (error: unknown) => error
    );

    await expect(driver.runtime.stop()).rejects.toThrow("speaker stop failed");
    await expect(completionFailure).resolves.toEqual(new Error("speaker stop failed"));
    expect(driver.runtime.state()).toBe("stopped");
  });

  it("settles active cancellation cleanup failure through stop and completion", async () => {
    const cancellationFailure = new Error("echo flush failed during cancellation");
    let rejectCancellationFlush: (error: Error) => void = () => undefined;
    const cancellationFlush = new Promise<void>((_resolve, reject) => {
      rejectCancellationFlush = reject;
    });
    let flushCount = 0;
    const driver = createDriver({
      echoFlush: () => {
        flushCount += 1;
        return flushCount === 1 ? cancellationFlush : Promise.resolve();
      }
    });
    const completionFailure = driver.runtime.completion.then(
      () => undefined,
      (error: unknown) => error
    );

    await driver.press();
    await driver.cancel();
    await vi.waitFor(() => expect(flushCount).toBe(1));
    const stopFailure = driver.runtime.stop().then(
      () => undefined,
      (error: unknown) => error
    );
    rejectCancellationFlush(cancellationFailure);

    await expect(stopFailure).resolves.toBe(cancellationFailure);
    await expect(completionFailure).resolves.toBe(cancellationFailure);
    expect(flushCount).toBe(2);
  });

  it("preserves the first shutdown failure across later cancellation failure", async () => {
    vi.useFakeTimers();
    const shutdownFailure = new Error("deferred cancellation failed during shutdown");
    const laterCancellationFailure = new Error("echo flush failed after shutdown started");
    let rejectCancellationFlush: (error: Error) => void = () => undefined;
    const cancellationFlush = new Promise<void>((_resolve, reject) => {
      rejectCancellationFlush = reject;
    });
    let flushCount = 0;
    let deferredCancellationCount = 0;
    const driver = createDriver({
      echoFlush: () => {
        flushCount += 1;
        return flushCount === 1 ? cancellationFlush : Promise.resolve();
      },
      cancelDeferred: () => {
        deferredCancellationCount += 1;

        if (deferredCancellationCount === 1) {
          throw shutdownFailure;
        }
      }
    });

    await completeHold(driver, "shutdown-first-failure");
    await driver.press();
    await driver.cancel();
    await vi.waitFor(() => expect(flushCount).toBe(1));
    const completionFailure = driver.runtime.completion.then(
      () => undefined,
      (error: unknown) => error
    );
    const stopFailure = driver.runtime.stop().then(
      () => undefined,
      (error: unknown) => error
    );
    rejectCancellationFlush(laterCancellationFailure);

    const stopError = await stopFailure;
    const completionError = await completionFailure;
    expect(stopError).toBe(shutdownFailure);
    expect(completionError).toBe(stopError);
    expect(deferredCancellationCount).toBe(2);
  });
});

type Driver = ReturnType<typeof createDriver>;

// The driver keeps all independently injectable runtime boundaries in one deterministic fixture.
// eslint-disable-next-line complexity
function createDriver(
  options: {
    readonly speechDetected?: boolean;
    readonly sttResponse?: (signal: AbortSignal | undefined) => Promise<SttTranscriptionResult>;
    readonly piResponse?: (signal: AbortSignal | undefined) => Promise<{ readonly text: string }>;
    readonly ttsResponse?: (signal: AbortSignal | undefined) => Promise<TtsSynthesisResult>;
    readonly ttsEvents?: (signal: AbortSignal | undefined) => AsyncIterable<TtsSynthesisEvent>;
    readonly playbackCompletion?: (signal: AbortSignal | undefined) => Promise<void>;
    readonly playbackStopCompletion?: () => Promise<void>;
    readonly disposalCompletion?: () => Promise<void>;
    readonly beforeSessionRemove?: (sessionId: string) => void;
    readonly playbackStopError?: Error;
    readonly echoFlush?: () => Promise<void>;
    readonly echoControl?: EchoControlProvider;
    readonly cancelDeferred?: () => void;
    readonly lifecycleEvents?: string[];
    readonly nearEndGate?: Promise<void>;
    readonly processedFrameIds?: string[];
    readonly farewellEnabled?: boolean;
    readonly sessionDurationMs?: number;
    readonly deferredResults?: readonly DeferredToolDeliverableResult[];
    readonly audit?: ReturnType<typeof createStructuredAuditLog>;
    readonly monotonicNow?: () => number;
    readonly validationEvents?: ResidentVoiceValidationEvent[];
  } = {}
) {
  const capture = createControlledCapture();
  const sttRequests: Array<Parameters<SttClient["transcribe"]>[0]> = [];
  const piRequests: Array<Parameters<PiAgentTurnClient["prompt"]>[0]> = [];
  const playedChunks: Array<Parameters<VoicePlaybackSession["write"]>[0]> = [];
  const disposedSessions: string[] = [];
  const deferredAcknowledgements: string[][] = [];
  const sessionRefreshes: string[] = [];
  let playbackOpenCount = 0;
  let playbackStopCount = 0;
  let playbackCloseCount = 0;
  let echoFlushCount = 0;
  let echoFarEndReferenceCount = 0;
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
      return options.disposalCompletion?.();
    },
    disposeAll() {
      options.lifecycleEvents?.push("dispose_all");
    }
  };
  const tts: TtsClient = {
    async *synthesize(request) {
      if (options.ttsEvents !== undefined) {
        yield* options.ttsEvents(request.signal);
        return;
      }

      const result = await (options.ttsResponse?.(request.signal) ??
        Promise.resolve(successfulSynthesis()));

      if (!result.ok) {
        yield { kind: "failed", failure: result };
        return;
      }

      for (const chunk of result.chunks) {
        yield { kind: "chunk", chunk };
      }

      yield {
        kind: "completed",
        chunkCount: result.chunks.length,
        totalDurationMs: result.totalDurationMs,
        source: result.source
      };
    }
  };
  const playback: VoicePlaybackSink = {
    open(_firstChunk, signal) {
      playbackOpenCount += 1;
      return {
        async write(chunk) {
          playedChunks.push(chunk);
          await options.playbackCompletion?.(signal);
        },
        finish() {
          return Promise.resolve();
        }
      };
    },
    stop() {
      playbackStopCount += 1;
      if (options.playbackStopError !== undefined) {
        return Promise.reject(options.playbackStopError);
      }
      return options.playbackStopCompletion?.() ?? Promise.resolve();
    },
    close() {
      playbackCloseCount += 1;
      return Promise.resolve();
    }
  };
  const baseSessionLifecycle = createSessionLifecycle({
    ending: { mode: "timed", durationMs: options.sessionDurationMs ?? 60_000 }
  });
  const sessionLifecycle = {
    ...baseSessionLifecycle,
    refreshActivity(sessionId: string) {
      sessionRefreshes.push(sessionId);
      return baseSessionLifecycle.refreshActivity(sessionId);
    },
    remove(sessionId: string) {
      options.beforeSessionRemove?.(sessionId);
      baseSessionLifecycle.remove(sessionId);
    }
  };
  const echoControl =
    options.echoControl ??
    ({
      describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "half_duplex",
          mode: "half_duplex",
          engine: "test"
        }),
      acceptFarEndReference: () => {
        echoFarEndReferenceCount += 1;
        return Promise.resolve({ status: "applied" });
      },
      processNearEnd: async (input) => {
        options.processedFrameIds?.push(input.id);
        await options.nearEndGate;

        return {
          action: "pass",
          reason: "no_far_end_tail",
          frame: input,
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 0,
            voiceActivity: options.speechDetected ?? true
          }
        };
      },
      flush: async () => {
        echoFlushCount += 1;
        await options.echoFlush?.();
        return { status: "reset" };
      }
    } satisfies EchoControlProvider);
  const runtime = createVoiceResidentRuntime({
    audioCapture: capture.provider,
    sessionLifecycle,
    echoControl,
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
    ...(options.farewellEnabled === undefined
      ? {}
      : { farewell: { enabled: options.farewellEnabled } }),
    ...(options.lifecycleEvents === undefined &&
    options.cancelDeferred === undefined &&
    options.deferredResults === undefined
      ? {}
      : {
          deferredTools: {
            collectDeliverableResults: () => options.deferredResults ?? [],
            acknowledgeDelivered: (jobIds: readonly string[]) => {
              deferredAcknowledgements.push([...jobIds]);
            },
            cancelSession: () => {
              options.lifecycleEvents?.push("cancel_session");
              options.cancelDeferred?.();
            },
            waitForIdle: () => {
              options.lifecycleEvents?.push("wait_idle");
              return Promise.resolve();
            }
          }
        }),
    ...(options.audit === undefined ? {} : { probe: { audit: options.audit } }),
    validation: { record: (event) => options.validationEvents?.push(event) },
    now: () => "2026-07-17T00:00:00.000Z",
    monotonicNow: options.monotonicNow ?? (() => 0)
  });

  return {
    runtime,
    capture,
    sttRequests,
    piRequests,
    playedChunks,
    disposedSessions,
    deferredAcknowledgements: () => deferredAcknowledgements,
    sessionRefreshes: () => sessionRefreshes,
    playbackOpens: () => playbackOpenCount,
    playbackStops: () => playbackStopCount,
    playbackCloses: () => playbackCloseCount,
    echoFlushes: () => echoFlushCount,
    echoFarEndReferences: () => echoFarEndReferenceCount,
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
  readonly fail: (error: Error) => void;
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
    },
    fail(error) {
      if (active === undefined) {
        throw new Error("capture is not active");
      }

      active.fail(error);
    }
  };
}

function createFrameChannel(): {
  readonly frames: AsyncIterable<VoicePcmFrame>;
  readonly emit: (frame: VoicePcmFrame) => void;
  readonly end: () => void;
  readonly fail: (error: Error) => void;
} {
  const queued: VoicePcmFrame[] = [];
  const waiters: Array<{
    readonly resolve: (result: IteratorResult<VoicePcmFrame>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let ended = false;
  let failure: Error | undefined;

  return {
    frames: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (failure !== undefined) {
              return Promise.reject(failure);
            }

            const value = queued.shift();

            if (value !== undefined) {
              return Promise.resolve({ value, done: false });
            }

            if (ended) {
              return Promise.resolve({ value: undefined, done: true });
            }

            return new Promise<IteratorResult<VoicePcmFrame>>((resolve, reject) => {
              waiters.push({ resolve, reject });
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

      waiter.resolve({ value, done: false });
    },
    end() {
      ended = true;

      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    },
    fail(error) {
      failure = error;

      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
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

function successfulTranscript(text: string, durationMs = 10): SttTranscriptionResult {
  return {
    ok: true,
    text,
    language: "ja-JP",
    confidence: 1,
    durationMs,
    segments: [],
    source: {
      sidecarId: "test-stt",
      provider: "apple-speech",
      language: "ja-JP"
    }
  };
}

function successfulSynthesis(durationMs = 10): TtsSynthesisSuccess {
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
        durationMs,
        source: {
          serviceId: "test-tts",
          provider: "aivis-speech",
          speakerId: 1
        }
      }
    ],
    totalDurationMs: durationMs,
    source: {
      serviceId: "test-tts",
      provider: "aivis-speech",
      speakerId: 1
    }
  };
}

function chunkEvent(sentenceIndex: number): TtsSynthesisEvent {
  const synthesis = successfulSynthesis();
  const chunk = synthesis.chunks[0];

  if (chunk === undefined) {
    throw new Error("expected a synthesis chunk");
  }

  return {
    kind: "chunk",
    chunk: { ...chunk, sentenceIndex, text: `Picoの応答${String(sentenceIndex)}` }
  };
}

function completedEvent(chunkCount: number): TtsSynthesisEvent {
  const synthesis = successfulSynthesis();
  return {
    kind: "completed",
    chunkCount,
    totalDurationMs: synthesis.totalDurationMs * chunkCount,
    source: synthesis.source
  };
}

function failedSynthesis(reason: TtsSynthesisFailure["reason"]): TtsSynthesisFailure {
  return {
    ok: false,
    reason,
    message: `TTS ${reason}`,
    sentenceIndex: 0,
    source: {
      serviceId: "test-tts",
      provider: "aivis-speech",
      speakerId: 1
    }
  };
}

function failedEvent(reason: TtsSynthesisFailure["reason"]): TtsSynthesisEvent {
  return { kind: "failed", failure: failedSynthesis(reason) };
}

function deferredResult(jobId: string): DeferredToolDeliverableResult {
  return {
    jobId,
    kind: "camera_scene_description",
    status: "completed",
    capturedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:01.000Z",
    summary: `result for ${jobId}`
  };
}

function failingFarEndEchoControl(): EchoControlProvider {
  return {
    describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
    checkHealth: () =>
      Promise.resolve({
        ok: true,
        provider: "half_duplex",
        mode: "half_duplex",
        engine: "test"
      }),
    acceptFarEndReference: () => Promise.reject(new Error("echo registration failed")),
    processNearEnd: (input) => Promise.resolve(passingNearEnd(input)),
    flush: () => Promise.resolve({ status: "reset" })
  };
}

function echoControlPassResponse(): Response {
  return Response.json({
    action: "pass",
    audioBase64: Buffer.from([1, 0]).toString("base64"),
    diagnostics: { residualEchoProbability: 0, voiceActivity: true }
  });
}

function passingNearEnd(frame: VoicePcmFrame) {
  return {
    action: "pass",
    reason: "no_far_end_tail",
    frame,
    diagnostics: {
      provider: "half_duplex",
      residualEchoProbability: 0,
      voiceActivity: true
    }
  } as const;
}

function voiceStageEvent(audit: ReturnType<typeof createStructuredAuditLog>, stage: string) {
  const events = voiceStageEvents(audit, stage);
  expect(events).toHaveLength(1);
  return events[0];
}

function voiceStageEvents(audit: ReturnType<typeof createStructuredAuditLog>, stage: string) {
  return audit.entries().filter((event) => event.attributes["pico.voice.stage"] === stage);
}

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolveGate: (value: T) => void = () => undefined;
  let rejectGate: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });

  return { promise, resolve: resolveGate, reject: rejectGate };
}
