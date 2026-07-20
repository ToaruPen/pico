import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import type { TtsAudioChunk } from "../src/modules/voice/index.js";
import {
  assertResidentPlaybackReadiness,
  createResidentAudioOutputPlan,
  createResidentContinuousPlaybackSink,
  type ResidentAudioOutputPlan,
  runPlaybackCommandProbe
} from "../src/runtime/resident-audio-playback.js";

const ffplayPlan = {
  provider: "ffplay",
  command: "ffplay",
  route: "system_default"
} as const satisfies ResidentAudioOutputPlan;
const alsaPlan = {
  provider: "alsa",
  command: "aplay",
  device: "hw:0,0"
} as const satisfies ResidentAudioOutputPlan;

afterEach(() => {
  vi.useRealTimers();
});

describe("resident audio output plans", () => {
  it("maps macOS ffplay config to the continuous playback command", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: { provider: "avaudioengine", deviceUid: "BuiltInMicrophoneDevice" },
          audioOutput: { provider: "ffplay", route: "system_default" }
        }
      }
    });

    expect(createResidentAudioOutputPlan(config, "darwin")).toEqual(ffplayPlan);
  });

  it("maps Linux ALSA config to aplay with the configured device", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: { provider: "alsa", device: "hw:1,0" },
          audioOutput: { provider: "alsa", device: "hw:0,0" }
        }
      }
    });

    expect(createResidentAudioOutputPlan(config, "linux")).toEqual(alsaPlan);
  });

  it("rejects output providers configured for another platform before playback spawn", () => {
    const ffplayConfig = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: { provider: "avaudioengine", deviceUid: "BuiltInMicrophoneDevice" },
          audioOutput: { provider: "ffplay", route: "system_default" }
        }
      }
    });
    const alsaConfig = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: { provider: "alsa", device: "hw:1,0" },
          audioOutput: { provider: "alsa", device: "hw:0,0" }
        }
      }
    });

    expect(() => createResidentAudioOutputPlan(ffplayConfig, "linux")).toThrow(
      "pico resident voice ffplay output requires macOS"
    );
    expect(() => createResidentAudioOutputPlan(alsaConfig, "darwin")).toThrow(
      "pico resident voice ALSA output requires Linux"
    );
  });
});

describe("resident continuous audio playback", () => {
  it("writes one aligned final PCM silence margin before ending ffplay input", async () => {
    const audioProcess = createAudioProcess();
    const end = vi.spyOn(audioProcess.stdin, "end");
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child, {
      finalSilenceMs: 300
    });
    const session = sink.open(chunk(0, [1, 0]));

    await session.write(chunk(0, [1, 0]));
    expect(audioProcess.stdinBytes()).toEqual([1, 0]);

    const firstFinish = session.finish();
    const secondFinish = session.finish();
    await vi.waitFor(() => expect(audioProcess.stdinBytes()).toHaveLength(2 + 14_400));
    expect(secondFinish).toBe(firstFinish);
    expect(audioProcess.stdinBytes().slice(2)).toEqual(new Array<number>(14_400).fill(0));
    expect(end).toHaveBeenCalledTimes(1);

    audioProcess.emitClose(0);
    await firstFinish;
  });

  it("waits for final-silence backpressure before ending stdin", async () => {
    const audioProcess = createAudioProcess();
    const end = vi.spyOn(audioProcess.stdin, "end");
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child, {
      finalSilenceMs: 300
    });
    const session = sink.open(chunk(0, [1, 0]));

    await session.write(chunk(0, [1, 0]));
    audioProcess.applyBackpressureOnce();
    const finishing = session.finish();
    await vi.waitFor(() => expect(audioProcess.stdin.listenerCount("drain")).toBe(1));
    expect(end).not.toHaveBeenCalled();

    audioProcess.stdin.emit("drain");
    await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    audioProcess.emitClose(0);
    await finishing;
  });

  it("does not write final silence after playback cancellation", async () => {
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child, {
      finalSilenceMs: 300
    });
    const session = sink.open(chunk(0, [1, 0]));

    await session.write(chunk(0, [1, 0]));
    const stopping = sink.stop();
    const finishing = session.finish();
    audioProcess.emitClose(undefined, "SIGTERM");

    await stopping;
    await expect(finishing).rejects.toThrow("playback was stopped");
    expect(audioProcess.stdinBytes()).toEqual([1, 0]);
  });

  it("writes every sentence to one ffplay process in order", async () => {
    const audioProcess = createAudioProcess();
    const spawn = vi.fn(() => audioProcess.child);
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, spawn);
    const first = chunk(0, [1, 0]);
    const session = sink.open(first);

    await session.write(first);
    await session.write(chunk(1, [2, 0]));
    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(audioProcess.stdinBytes()).toEqual([1, 0, 2, 0]);
    expect(spawn).toHaveBeenCalledWith(
      "ffplay",
      [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ch_layout",
        "1c",
        "-i",
        "pipe:0"
      ],
      { stdio: ["pipe", "ignore", "inherit"] }
    );
  });

  it("uses the exact aplay arguments and writes raw bytes without prepending the first chunk", async () => {
    const audioProcess = createAudioProcess();
    const spawn = vi.fn(() => audioProcess.child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const first = chunk(0, [1, 0, 0, 0], { sampleRateHz: 16_000, channels: 2 });
    const session = sink.open(first);

    await session.write(first);
    await session.write(chunk(1, [2, 0, 0, 0], { sampleRateHz: 16_000, channels: 2 }));
    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;

    expect(spawn).toHaveBeenCalledWith(
      "aplay",
      ["-q", "-f", "S16_LE", "-r", "16000", "-c", "2", "-t", "raw", "-D", "hw:0,0"],
      { stdio: ["pipe", "ignore", "inherit"] }
    );
    expect(audioProcess.stdinBytes()).toEqual([1, 0, 0, 0, 2, 0, 0, 0]);
  });

  it("serializes writes and waits for drain when stdin applies backpressure", async () => {
    const audioProcess = createAudioProcess();
    audioProcess.applyBackpressureOnce();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );

    const firstWrite = session.write(chunk(0, [1, 0]));
    const secondWrite = session.write(chunk(1, [2, 0]));
    await Promise.resolve();
    expect(audioProcess.stdin.listenerCount("drain")).toBe(1);
    expect(audioProcess.stdinBytes()).toEqual([1, 0]);

    audioProcess.stdin.emit("drain");
    await Promise.all([firstWrite, secondWrite]);
    expect(audioProcess.stdinBytes()).toEqual([1, 0, 2, 0]);
    expect(audioProcess.stdin.listenerCount("drain")).toBe(0);

    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;
  });

  it("finishes after all writes that were accepted before finish", async () => {
    const audioProcess = createAudioProcess();
    audioProcess.applyBackpressureOnce();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );

    const firstWrite = session.write(chunk(0, [1, 0]));
    const secondWrite = session.write(chunk(1, [2, 0]));
    const finishing = session.finish();
    await vi.waitFor(() => expect(audioProcess.stdin.listenerCount("drain")).toBe(1));
    audioProcess.stdin.emit("drain");
    await Promise.all([firstWrite, secondWrite]);
    audioProcess.emitClose(0);

    await expect(finishing).resolves.toBeUndefined();
    expect(audioProcess.stdinBytes()).toEqual([1, 0, 2, 0]);
  });

  it("rejects a queued write and finish with one Error when close wins before stdin end", async () => {
    const audioProcess = createAudioProcess();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );
    const writing = session.write(chunk(0, [1, 0]));
    const finishing = session.finish();
    const failures = Promise.all([operationFailure(writing), operationFailure(finishing)]);

    audioProcess.emitClose(0);
    const [writeError, finishError] = await failures;

    expect(writeError).toBeInstanceOf(Error);
    expect(finishError).toBe(writeError);
    expect(audioProcess.stdinBytes()).toEqual([]);
  });

  it("rejects backpressure write and finish together when close arrives before drain", async () => {
    const audioProcess = createAudioProcess();
    audioProcess.applyBackpressureOnce();
    const controller = new AbortController();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0]),
      controller.signal
    );
    const writing = session.write(chunk(0, [1, 0]));
    await vi.waitFor(() => expect(audioProcess.stdin.listenerCount("drain")).toBe(1));
    const finishing = session.finish();
    const failures = Promise.all([operationFailure(writing), operationFailure(finishing)]);

    audioProcess.emitClose(0);
    const outcome = await Promise.race([
      failures,
      new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)))
    ]);

    expect(outcome).toBeDefined();
    const [writeError, finishError] = requireFailurePair(outcome);
    expect(writeError).toBeInstanceOf(Error);
    expect(finishError).toBe(writeError);
    expect(audioProcess.stdin.listenerCount("drain")).toBe(0);
    expect(audioProcess.stdin.listenerCount("error")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("ends stdin once after queued writes complete and then finishes on close", async () => {
    const audioProcess = createAudioProcess();
    const end = vi.spyOn(audioProcess.stdin, "end");
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );
    const firstWrite = session.write(chunk(0, [1, 0]));
    const secondWrite = session.write(chunk(1, [2, 0]));
    const finishing = session.finish();

    await Promise.all([firstWrite, secondWrite]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(audioProcess.stdinBytes()).toEqual([1, 0, 2, 0]);
    audioProcess.emitClose(0);

    await expect(finishing).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("removes backpressure listeners when active playback is cancelled", async () => {
    const audioProcess = createAudioProcess();
    audioProcess.applyBackpressureOnce();
    const controller = new AbortController();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]), controller.signal);
    const writing = session.write(chunk(0, [1, 0]));
    await Promise.resolve();

    controller.abort(new Error("cancelled"));
    await expect(writing).rejects.toThrow("playback was stopped");
    expect(audioProcess.stdin.listenerCount("drain")).toBe(0);
    expect(audioProcess.stdin.listenerCount("error")).toBe(1);
    expect(audioProcess.kill).toHaveBeenCalledWith("SIGTERM");

    audioProcess.emitClose(undefined, "SIGTERM");
    await expect(sink.stop()).resolves.toBeUndefined();
    expect(audioProcess.stdin.listenerCount("error")).toBe(0);
  });

  it.each([
    ["encoding", { encoding: "wav" }],
    ["sample rate", { sampleRateHz: 48_000 }],
    ["channels", { channels: 2 }]
  ] as const)("rejects a %s mismatch without an extra write", async (_name, changes) => {
    const audioProcess = createAudioProcess();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );
    await session.write(chunk(0, [1, 0]));

    await expect(
      session.write({ ...chunk(1, [2, 0]), ...changes } as TtsAudioChunk)
    ).rejects.toThrow("format does not match");
    expect(audioProcess.stdinBytes()).toEqual([1, 0]);

    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;
  });

  it.each([
    ["empty PCM", { audio: new Uint8Array() }],
    ["odd PCM byte length", { audio: new Uint8Array([1]) }],
    ["unaligned stereo PCM", { audio: new Uint8Array([1, 0]), channels: 2 }],
    ["invalid sample rate", { sampleRateHz: 0 }],
    ["invalid channel count", { channels: 0 }],
    ["invalid duration", { durationMs: 0 }]
  ] as const)("rejects %s without spawning or writing", (_name, changes) => {
    const spawn = vi.fn(() => createAudioProcess().child);
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, spawn);
    const malformed = { ...chunk(0, [1, 0]), ...changes } as TtsAudioChunk;

    expect(() => sink.open(malformed)).toThrow("invalid PCM chunk");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("retains ownership after stdin failure and shares that Error through child close", async () => {
    const firstProcess = createAudioProcess();
    const secondProcess = createAudioProcess();
    const processes = [firstProcess, secondProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const session = sink.open(chunk(0, [1, 0]));
    const failure = new Error("pipe failed");

    firstProcess.stdin.emit("error", failure);
    await expect(session.write(chunk(0, [1, 0]))).rejects.toBe(failure);
    expect(() => sink.open(chunk(1, [2, 0]))).toThrow("already active");
    const finishing = session.finish();
    firstProcess.emitClose(1);
    await expect(finishing).rejects.toBe(failure);

    const next = sink.open(chunk(1, [2, 0]));
    expect(spawn).toHaveBeenCalledTimes(2);
    const nextFinishing = next.finish();
    secondProcess.emitClose(0);
    await nextFinishing;
  });

  it("shares a spawn Error while retaining ownership until close", async () => {
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]));
    const failure = new Error("spawn ffplay ENOENT");
    const finishing = session.finish();

    audioProcess.emitError(failure);
    await expect(session.write(chunk(0, [1, 0]))).rejects.toBe(failure);
    expect(() => sink.open(chunk(1, [2, 0]))).toThrow("already active");
    audioProcess.emitClose(-2);
    await expect(finishing).rejects.toBe(failure);
  });

  it.each([
    ["non-zero exit", 3, undefined],
    ["signal exit", undefined, "SIGSEGV"]
  ] as const)("uses one terminal Error for %s across exit and close", async (_name, code, signal) => {
    const audioProcess = createAudioProcess();
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );
    const finishing = session.finish();

    audioProcess.emitExit(code, signal);
    const writeFailure = await session.write(chunk(1, [2, 0])).catch((error: unknown) => error);
    audioProcess.emitClose(code, signal);
    const finishFailure = await finishing.catch((error: unknown) => error);

    expect(writeFailure).toBeInstanceOf(Error);
    expect(finishFailure).toBe(writeFailure);
  });

  it("settles a close-only child and preserves the exit failure when close disagrees", async () => {
    const closeOnlyProcess = createAudioProcess();
    const first = createResidentContinuousPlaybackSink(
      ffplayPlan,
      () => closeOnlyProcess.child
    ).open(chunk(0, [1, 0]));
    const closeOnlyFinish = first.finish();
    closeOnlyProcess.emitClose(0);
    await expect(closeOnlyFinish).resolves.toBeUndefined();

    const orderedProcess = createAudioProcess();
    const second = createResidentContinuousPlaybackSink(
      ffplayPlan,
      () => orderedProcess.child
    ).open(chunk(0, [1, 0]));
    const orderedFinish = second.finish();
    orderedProcess.emitExit(7);
    const exitFailure = await second.write(chunk(1, [2, 0])).catch((error: unknown) => error);
    orderedProcess.emitClose(0);
    await expect(orderedFinish).rejects.toBe(exitFailure);
  });

  it("keeps an exit-only child active until close", async () => {
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]));
    const finishing = session.finish();

    audioProcess.emitExit(0);
    await expect(settledAfterImmediate(finishing)).resolves.toBe(false);
    expect(() => sink.open(chunk(1, [2, 0]))).toThrow("already active");
    audioProcess.emitClose(0);
    await finishing;
  });

  it("ends stdin once and returns one finish Promise", async () => {
    const audioProcess = createAudioProcess();
    const end = vi.spyOn(audioProcess.stdin, "end");
    const session = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child).open(
      chunk(0, [1, 0])
    );

    const first = session.finish();
    const second = session.finish();
    expect(second).toBe(first);
    expect(end).toHaveBeenCalledTimes(1);
    await expect(session.write(chunk(1, [2, 0]))).rejects.toThrow("input has ended");

    audioProcess.emitClose(0);
    await Promise.all([first, second]);
  });

  it("rejects reopen while active and permits it after normal close", async () => {
    const firstProcess = createAudioProcess();
    const secondProcess = createAudioProcess();
    const processes = [firstProcess, secondProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, spawn);
    const first = sink.open(chunk(0, [1, 0]));

    expect(() => sink.open(chunk(1, [2, 0]))).toThrow("already active");
    const firstFinish = first.finish();
    firstProcess.emitClose(0);
    await firstFinish;

    const second = sink.open(chunk(1, [2, 0]));
    const secondFinish = second.finish();
    secondProcess.emitClose(0);
    await secondFinish;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("shares an idempotent stop and escalates SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(alsaPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]));
    const finishing = session.finish();
    const firstStop = sink.stop();
    const secondStop = sink.stop();

    expect(secondStop).toBe(firstStop);
    expect(audioProcess.kill).toHaveBeenCalledTimes(1);
    expect(audioProcess.kill).toHaveBeenLastCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(audioProcess.kill).toHaveBeenLastCalledWith("SIGKILL");
    audioProcess.emitClose(undefined, "SIGKILL");

    await expect(firstStop).resolves.toBeUndefined();
    await expect(finishing).rejects.toThrow("playback was stopped");
  });

  it("shares the final stop timeout Error with the session", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(alsaPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]));
    const finishing = session.finish();
    const firstStop = sink.stop();
    const secondStop = sink.stop();
    const stopFailure = firstStop.catch((error: unknown) => error);
    const finishFailure = finishing.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    const stopError = await stopFailure;
    const sessionError = await finishFailure;

    expect(secondStop).toBe(firstStop);
    expect(stopError).toEqual(
      new Error("pico resident voice alsa output did not stop after SIGKILL")
    );
    expect(sessionError).toBe(stopError);
    expect(audioProcess.listenerCount("close")).toBe(0);
    expect(audioProcess.listenerCount("exit")).toBe(0);
    expect(audioProcess.listenerCount("error")).toBe(0);
    expect(audioProcess.stdin.listenerCount("error")).toBe(0);
  });

  it("does not spawn for an already-aborted signal", () => {
    const spawn = vi.fn(() => createAudioProcess().child);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before open"));
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, spawn);

    expect(() => sink.open(chunk(0, [1, 0]), controller.signal)).toThrow(
      "was aborted before startup"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("closes idempotently, safely stops the active child, and rejects future opens", async () => {
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 0]));
    const finishing = session.finish();
    const firstClose = sink.close();
    const secondClose = sink.close();

    expect(secondClose).toBe(firstClose);
    expect(audioProcess.kill).toHaveBeenCalledWith("SIGTERM");
    audioProcess.emitClose(undefined, "SIGTERM");
    await firstClose;
    await expect(finishing).rejects.toThrow("playback was stopped");
    expect(() => sink.open(chunk(1, [2, 0]))).toThrow("playback sink is closed");
    await expect(sink.stop()).resolves.toBeUndefined();
  });

  it("plays ALSA PCM using the TTS chunk sample format", async () => {
    const audioProcess = createAudioProcess();
    const spawn = vi.fn(() => audioProcess.child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const first = chunk(0, [1, 2, 3, 4], { sampleRateHz: 24_000, channels: 2 });
    const session = sink.open(first);

    await session.write(first);
    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;

    expect(spawn).toHaveBeenCalledWith(
      "aplay",
      ["-q", "-f", "S16_LE", "-r", "24000", "-c", "2", "-t", "raw", "-D", "hw:0,0"],
      { stdio: ["pipe", "ignore", "inherit"] }
    );
    expect(audioProcess.stdinBytes()).toEqual([1, 2, 3, 4]);
  });

  it("rejects ALSA playback when the PCM stdin stream fails", async () => {
    const audioProcess = createAudioProcess();
    const session = createResidentContinuousPlaybackSink(alsaPlan, () => audioProcess.child).open(
      chunk(0, [1, 2])
    );
    const failure = new Error("pipe failed");

    audioProcess.stdin.emit("error", failure);
    await expect(session.write(chunk(0, [1, 2]))).rejects.toBe(failure);
    const finishing = session.finish();
    audioProcess.emitClose(1);
    await expect(finishing).rejects.toBe(failure);
  });

  it("retains playback ownership after a PCM stdin failure until the child exits", async () => {
    const firstProcess = createAudioProcess();
    const secondProcess = createAudioProcess();
    const processes = [firstProcess, secondProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const first = sink.open(chunk(0, [1, 2]));
    const failure = new Error("pipe failed");

    firstProcess.stdin.emit("error", failure);
    await expect(first.write(chunk(0, [1, 2]))).rejects.toBe(failure);
    expect(() => sink.open(chunk(1, [3, 4]))).toThrow("already active");

    const firstFinish = first.finish();
    firstProcess.emitClose(1);
    await expect(firstFinish).rejects.toBe(failure);

    const second = sink.open(chunk(1, [3, 4]));
    const secondFinish = second.finish();
    secondProcess.emitClose(0);
    await secondFinish;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("releases playback ownership after a spawn failure closes the child", async () => {
    const failedProcess = createAudioProcess();
    const nextProcess = createAudioProcess();
    const processes = [failedProcess, nextProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const failed = sink.open(chunk(0, [1, 2]));
    const failure = new Error("spawn aplay EACCES");

    failedProcess.emitError(failure);
    await expect(failed.write(chunk(0, [1, 2]))).rejects.toBe(failure);
    expect(() => sink.open(chunk(1, [3, 4]))).toThrow("already active");
    const failedFinish = failed.finish();
    failedProcess.emitClose(-13);
    await expect(failedFinish).rejects.toBe(failure);

    const next = sink.open(chunk(1, [3, 4]));
    const nextFinish = next.finish();
    nextProcess.emitClose(0);
    await nextFinish;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("fails before spawning when ALSA playback has an already-aborted signal", () => {
    const spawn = vi.fn(() => createAudioProcess().child);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before playback"));
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);

    expect(() => sink.open(chunk(0, [1, 2]), controller.signal)).toThrow(
      "pico resident voice alsa output was aborted before startup"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops only the current owned playback process and is idempotent", async () => {
    const firstProcess = createAudioProcess();
    const secondProcess = createAudioProcess();
    const processes = [firstProcess, secondProcess];
    const sink = createResidentContinuousPlaybackSink(
      alsaPlan,
      () => requireAudioProcess(processes.shift()).child
    );
    const first = sink.open(chunk(0, [1, 2]));
    const firstFinish = first.finish();

    const firstStop = sink.stop();
    const secondStop = sink.stop();
    expect(secondStop).toBe(firstStop);
    expect(firstProcess.kill).toHaveBeenCalledTimes(1);
    firstProcess.emitClose(undefined, "SIGTERM");
    await firstStop;
    await expect(firstFinish).rejects.toThrow("playback was stopped");

    const second = sink.open(chunk(1, [3, 4]));
    const secondFinish = second.finish();
    secondProcess.emitClose(0);
    await secondFinish;
    expect(secondProcess.kill).not.toHaveBeenCalled();
  });

  it("escalates a stalled playback process from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(alsaPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 2]));
    const finishing = session.finish();
    const stopped = sink.stop();

    expect(audioProcess.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(audioProcess.kill).toHaveBeenLastCalledWith("SIGKILL");
    audioProcess.emitClose(undefined, "SIGKILL");

    await stopped;
    await expect(finishing).rejects.toThrow("playback was stopped");
  });

  it("releases playback ownership after the final termination timeout", async () => {
    vi.useFakeTimers();
    const firstProcess = createAudioProcess();
    const nextProcess = createAudioProcess();
    const processes = [firstProcess, nextProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const first = sink.open(chunk(0, [1, 2]));
    const finishing = first.finish();
    const stopped = sink.stop();
    const stopFailure = operationFailure(stopped);
    const finishFailure = operationFailure(finishing);

    await vi.advanceTimersByTimeAsync(2_000);
    const stopError = await stopFailure;
    const finishError = await finishFailure;
    expect(stopError).toEqual(
      new Error("pico resident voice alsa output did not stop after SIGKILL")
    );
    expect(finishError).toBe(stopError);

    const next = sink.open(chunk(1, [3, 4]));
    const nextFinish = next.finish();
    nextProcess.emitClose(0);
    await nextFinish;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("preserves a final timeout after playback exits successfully without closing", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(alsaPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [1, 2]));
    const finishing = session.finish();

    audioProcess.emitExit(0);
    const stopped = sink.stop();
    const stopFailure = operationFailure(stopped);
    const finishFailure = operationFailure(finishing);
    await vi.advanceTimersByTimeAsync(2_000);

    const stopError = await stopFailure;
    expect(stopError).toEqual(
      new Error("pico resident voice alsa output did not stop after SIGKILL")
    );
    await expect(finishFailure).resolves.toBe(stopError);
  });

  it("waits for playback close before admitting the next chunk", async () => {
    const firstProcess = createAudioProcess();
    const nextProcess = createAudioProcess();
    const processes = [firstProcess, nextProcess];
    const spawn = vi.fn(() => requireAudioProcess(processes.shift()).child);
    const sink = createResidentContinuousPlaybackSink(alsaPlan, spawn);
    const first = sink.open(chunk(0, [1, 2]));
    const firstFinish = first.finish();

    firstProcess.emitExit(0);
    await expect(settledAfterImmediate(firstFinish)).resolves.toBe(false);
    expect(() => sink.open(chunk(1, [3, 4]))).toThrow("already active");
    firstProcess.emitClose(0);
    await firstFinish;

    const next = sink.open(chunk(1, [3, 4]));
    const nextFinish = next.finish();
    nextProcess.emitClose(0);
    await nextFinish;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("preserves a ffplay final timeout after an exit-only cancellation", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, () => audioProcess.child);
    const session = sink.open(chunk(0, [0, 0, 1, 0]));
    const finishing = session.finish();

    audioProcess.emitExit(0);
    const stopped = sink.stop();
    const stopFailure = operationFailure(stopped);
    const finishFailure = operationFailure(finishing);
    await vi.advanceTimersByTimeAsync(2_000);

    const stopError = await stopFailure;
    expect(stopError).toEqual(
      new Error("pico resident voice ffplay output did not stop after SIGKILL")
    );
    await expect(finishFailure).resolves.toBe(stopError);
  });

  it("streams ffplay directly without creating a temporary WAV file", async () => {
    const audioProcess = createAudioProcess();
    const spawn = vi.fn(() => audioProcess.child);
    const sink = createResidentContinuousPlaybackSink(ffplayPlan, spawn);
    const first = chunk(0, [0, 0, 1, 0]);
    const session = sink.open(first);

    await session.write(first);
    const finishing = session.finish();
    audioProcess.emitClose(0);
    await finishing;

    const calls = spawn.mock.calls as unknown as Array<[string, readonly string[], unknown]>;
    const arguments_ = calls[0]?.[1];
    expect(arguments_).toContain("pipe:0");
    expect(arguments_).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.wav$/u)]));
    expect(audioProcess.stdinBytes()).toEqual([0, 0, 1, 0]);
  });
});

describe("resident playback readiness", () => {
  it.each([
    [ffplayPlan, ["-version"]],
    [alsaPlan, ["--version"]]
  ] as const)("probes $provider exactly once", async (plan, arguments_) => {
    const calls: Array<readonly [string, readonly string[], number]> = [];
    await assertResidentPlaybackReadiness(plan, (command, receivedArguments, timeoutMs) => {
      calls.push([command, receivedArguments, timeoutMs]);
      return Promise.resolve();
    });

    expect(calls).toEqual([[plan.command, arguments_, 5_000]]);
  });

  it("classifies a missing command without trying a fallback", async () => {
    const audioProcess = createAudioProcess();
    const spawn = vi.fn(() => audioProcess.child);
    const probing = runPlaybackCommandProbe("ffplay", ["-version"], 5_000, spawn);

    audioProcess.emitError(new Error("spawn ffplay ENOENT"));
    await expect(probing).rejects.toThrow("pico resident playback command ffplay is unavailable");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(audioProcess.listenerCount("close")).toBe(0);
  });

  it.each([
    ["non-zero", 2, undefined],
    ["signal", undefined, "SIGTERM"]
  ] as const)("classifies a %s readiness exit", async (_name, code, signal) => {
    const audioProcess = createAudioProcess();
    const probing = runPlaybackCommandProbe(
      "aplay",
      ["--version"],
      5_000,
      () => audioProcess.child
    );

    audioProcess.emitClose(code, signal);
    await expect(probing).rejects.toThrow(
      `pico resident playback command aplay exited with code ${String(code)} signal ${String(signal)}`
    );
  });

  it("times out after five seconds and bounds child termination", async () => {
    vi.useFakeTimers();
    const audioProcess = createAudioProcess();
    const probing = runPlaybackCommandProbe(
      "ffplay",
      ["-version"],
      5_000,
      () => audioProcess.child
    );
    const failure = probing.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(audioProcess.kill).toHaveBeenLastCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(audioProcess.kill).toHaveBeenLastCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(failure).resolves.toEqual(
      new Error("pico resident playback command ffplay timed out after 5000ms")
    );
    expect(audioProcess.listenerCount("close")).toBe(0);
    expect(audioProcess.listenerCount("error")).toBe(0);
  });
});

function chunk(
  sentenceIndex: number,
  audio: readonly number[],
  options: { readonly sampleRateHz?: number; readonly channels?: number } = {}
): TtsAudioChunk {
  return {
    sentenceIndex,
    text: `sentence-${String(sentenceIndex)}`,
    audio: Uint8Array.from(audio),
    encoding: "pcm16le",
    sampleRateHz: options.sampleRateHz ?? 24_000,
    channels: options.channels ?? 1,
    durationMs: 10,
    source: {
      serviceId: "local-tts",
      provider: "aivis-speech",
      speakerId: 1
    }
  };
}

type SpawnedAudioProcess = {
  readonly child: ChildProcessByStdio<Writable, Readable | null, null>;
  readonly stdin: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly applyBackpressureOnce: () => void;
  readonly emitClose: (code: number | null | undefined, signal?: NodeJS.Signals) => void;
  readonly emitError: (error: Error) => void;
  readonly emitExit: (code: number | null | undefined, signal?: NodeJS.Signals) => void;
  readonly listenerCount: (event: "close" | "error" | "exit") => number;
  readonly stdinBytes: () => readonly number[];
};

function createAudioProcess(): SpawnedAudioProcess {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const bytes: number[] = [];
  stdin.on("data", (value: Buffer) => bytes.push(...value));
  const kill = vi.fn(() => true);
  const child = Object.assign(events, { stdin, kill }) as unknown as ChildProcessByStdio<
    Writable,
    Readable | null,
    null
  >;

  return {
    child,
    stdin,
    kill,
    applyBackpressureOnce() {
      const write = stdin.write.bind(stdin);
      vi.spyOn(stdin, "write").mockImplementationOnce(((
        ...values: Parameters<typeof stdin.write>
      ) => {
        write(...values);
        return false;
      }) as typeof stdin.write);
    },
    emitClose(code, signal) {
      events.emit("close", code, signal);
    },
    emitError(error) {
      events.emit("error", error);
    },
    emitExit(code, signal) {
      events.emit("exit", code, signal);
    },
    listenerCount: (event) => events.listenerCount(event),
    stdinBytes: () => bytes
  };
}

async function settledAfterImmediate(operation: Promise<void>): Promise<boolean> {
  return Promise.race([
    operation.then(
      () => true,
      () => true
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false)))
  ]);
}

function requireAudioProcess(audioProcess: SpawnedAudioProcess | undefined): SpawnedAudioProcess {
  if (audioProcess === undefined) throw new Error("audio process fixture was exhausted");
  return audioProcess;
}

function operationFailure(operation: Promise<void>): Promise<Error | undefined> {
  return operation.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );
}

function requireFailurePair(
  pair: readonly [Error | undefined, Error | undefined] | undefined
): readonly [Error | undefined, Error | undefined] {
  if (pair === undefined) throw new Error("playback operations did not settle");
  return pair;
}
