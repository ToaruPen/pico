import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TtsAudioChunk } from "../src/modules/voice/index.js";
import {
  assertResidentPlaybackReadiness,
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

describe("resident continuous audio playback", () => {
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
        "-ac",
        "1",
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
