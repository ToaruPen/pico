import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  type MacOSResidentIoProcess,
  resolveMacOSResidentIoExecutablePath,
  startMacOSResidentIoBridge
} from "../src/runtime/macos-resident-io-bridge.js";
import {
  encodeResidentIoMessage,
  ResidentIoDecoder,
  type ResidentIoMessage
} from "../src/runtime/resident-io-protocol.js";

describe("managed macOS resident I/O bridge", () => {
  it("rejects unsupported platforms before spawning", async () => {
    let launches = 0;

    await expect(
      startMacOSResidentIoBridge({
        input: residentInput(),
        platform: "linux",
        handleControl: () => ({ result: "ignored_busy" }),
        handleTailComplete: () => undefined,
        spawnProcess: () => {
          launches += 1;
          return new ControlledProcess();
        }
      })
    ).rejects.toThrow("pico macOS resident I/O bridge requires macOS");
    expect(launches).toBe(0);
  });

  it("reports a bounded diagnostic when the child exits before ready", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });

    process.stderr.write("Input Monitoring permission is required\n");
    process.exit(1);

    await expect(starting).rejects.toThrow(
      "pico macOS resident I/O exited unexpectedly (code 1): Input Monitoring permission is required"
    );
  });

  it("starts the continuously running engine with stable device and PCM metadata", async () => {
    const process = new ControlledProcess();
    const launches: Array<{ executable: string; arguments_: readonly string[] }> = [];
    const controls: Array<{ kind: string; physicalTimestampNanoseconds: string }> = [];
    const timings: unknown[] = [];
    const tails: number[] = [];
    const invalidations: number[] = [];
    const starting = startMacOSResidentIoBridge({
      input: {
        deviceUid: "BuiltInMicrophoneDevice",
        sampleRateHz: 16_000,
        channels: 1,
        frameMs: 10,
        releaseTailMs: 250,
        talkKey: "F13",
        cancelKey: "F14"
      },
      platform: "darwin",
      handleControl: (event) => {
        controls.push(event);
        return { result: "accepted", generation: 1 };
      },
      handleTailComplete: (generation) => {
        tails.push(generation);
      },
      handleCaptureInvalidated: (generation) => {
        invalidations.push(generation);
      },
      observeTiming: (event) => timings.push(event),
      spawnProcess: (executable, arguments_) => {
        launches.push({ executable, arguments_ });
        return process;
      }
    });

    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    expect(launches).toEqual([
      {
        executable: resolveMacOSResidentIoExecutablePath(),
        arguments_: [
          "--device-uid",
          "BuiltInMicrophoneDevice",
          "--sample-rate-hz",
          "16000",
          "--channels",
          "1",
          "--frame-ms",
          "10",
          "--release-tail-ms",
          "250",
          "--talk-key",
          "F13",
          "--cancel-key",
          "F14"
        ]
      }
    ]);

    const capture = bridge.audioCapture.start(new AbortController().signal, 1);
    const frames = capture.frames[Symbol.asyncIterator]();
    process.send({
      kind: "control_event",
      sequence: 7,
      controlKind: "talk_pressed",
      eventTimestampNanoseconds: "12345"
    });
    await process.waitForInputMessage("control_result");
    expect(controls).toEqual([{ kind: "talk_pressed", physicalTimestampNanoseconds: "12345" }]);
    expect(process.inputMessages()).toContainEqual({
      kind: "control_result",
      sequence: 7,
      result: "accepted",
      generation: 1
    });
    process.send({
      kind: "timing_event",
      stage: "key_to_admission",
      durationMs: 1.25,
      controlResult: "ignored_busy"
    });
    await vi.waitFor(() =>
      expect(timings).toEqual([
        {
          kind: "timing_event",
          stage: "key_to_admission",
          durationMs: 1.25,
          controlResult: "ignored_busy"
        }
      ])
    );

    process.send({
      kind: "pcm_frame",
      generation: 1,
      sampleHostTimeNanoseconds: "20000",
      sampleRateHz: 16_000,
      channels: 1,
      frameCount: 2,
      audio: Buffer.from([1, 0, 2, 0])
    });
    await expect(frames.next()).resolves.toMatchObject({
      done: false,
      value: {
        direction: "near_end",
        audio: new Uint8Array([1, 0, 2, 0]),
        sampleRateHz: 16_000,
        channels: 1,
        durationMs: 0.125
      }
    });

    process.send({
      kind: "tail_complete",
      generation: 1,
      releaseEventTimestampNanoseconds: "30000"
    });
    await expect(frames.next()).resolves.toEqual({ done: true, value: undefined });
    await new Promise((resolve) => setImmediate(resolve));
    expect(tails).toEqual([1]);

    process.send({ kind: "cancel_generation", generation: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(invalidations).toEqual([1]);

    const closing = bridge.close();
    await process.waitForInputMessage("shutdown");
    process.exit(0, "SIGTERM");
    await expect(closing).resolves.toBeUndefined();
  });

  it("reports PCM received without a matching active generation without exposing content", async () => {
    const process = new ControlledProcess();
    let unexpectedFrames = 0;
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      observeUnexpectedPcmFrame: () => {
        unexpectedFrames += 1;
      },
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    process.send({
      kind: "pcm_frame",
      generation: 9,
      sampleHostTimeNanoseconds: "20000",
      sampleRateHz: 16_000,
      channels: 1,
      frameCount: 1,
      audio: Buffer.from([1, 0])
    });
    await immediate(undefined);
    expect(unexpectedFrames).toBe(1);

    const closing = bridge.close();
    await process.waitForInputMessage("shutdown");
    process.exit(0, "SIGTERM");
    await closing;
  });

  it("fails closed when more than 128 native PCM frames wait for a consumer", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;
    const capture = bridge.audioCapture.start(new AbortController().signal, 1);

    for (let index = 0; index < 129; index += 1) {
      process.send({
        kind: "pcm_frame",
        generation: 1,
        sampleHostTimeNanoseconds: String(index),
        sampleRateHz: 16_000,
        channels: 1,
        frameCount: 160,
        audio: Buffer.alloc(320)
      });
    }
    await immediate(undefined);
    await immediate(undefined);

    expect(process.signals).toContain("SIGTERM");
    await expect(capture.frames[Symbol.asyncIterator]().next()).rejects.toThrow(
      "resident_pcm_backlog"
    );
    process.exit(1, "SIGTERM");
    await expect(bridge.completion).rejects.toThrow("resident_pcm_backlog");
  });

  it("suppresses and resumes capture only after matching sidecar acknowledgements", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    const suppressing = bridge.suppressCapture();
    const suppress = await process.waitForInputMessage("suppress_capture");
    expect(await Promise.race([suppressing.then(() => "done"), immediate("pending")])).toBe(
      "pending"
    );
    process.send(suppress);
    await expect(suppressing).resolves.toBeUndefined();

    const resuming = bridge.resumeCapture();
    const resume = await process.waitForInputMessage("resume_capture");
    process.send(resume);
    await expect(resuming).resolves.toBeUndefined();

    const closing = bridge.close();
    await process.waitForInputMessage("shutdown");
    process.exit(0, "SIGTERM");
    await closing;
  });

  it("ignores a matching late acknowledgement after its capture boundary timed out", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      commandTimeoutMs: 5,
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    const suppressing = bridge.suppressCapture();
    const suppress = await process.waitForInputMessage("suppress_capture");
    await expect(suppressing).rejects.toThrow("suppress_capture acknowledgement timed out");

    process.send(suppress);
    await immediate(undefined);
    expect(process.signals).not.toContain("SIGTERM");

    const closing = bridge.close();
    await process.waitForInputMessage("shutdown");
    process.exit(0, "SIGTERM");
    await expect(closing).resolves.toBeUndefined();
  });

  it("fails closed before native admission timeout when control result delivery stalls", async () => {
    const process = new ControlledProcess(true);
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      controlResultTimeoutMs: 5,
      handleControl: () => ({ result: "accepted", generation: 1 }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    process.send({
      kind: "control_event",
      sequence: 1,
      controlKind: "talk_pressed",
      eventTimestampNanoseconds: "1"
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(process.signals).toContain("SIGTERM");
    process.exit(1, "SIGTERM");
    await expect(bridge.completion).rejects.toThrow("control result write timed out");
  });

  it("fails closed on a native fatal event instead of selecting another provider", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    process.send({ kind: "fatal", code: "recovery_exhausted" });
    process.exit(1);

    await expect(bridge.completion).rejects.toThrow(
      "pico macOS resident I/O failed: recovery_exhausted"
    );
  });

  it("rejects an outstanding capture boundary when the sidecar exits", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;

    const suppressing = bridge.suppressCapture();
    await process.waitForInputMessage("suppress_capture");
    process.exit(1);

    await expect(suppressing).rejects.toThrow("pico macOS resident I/O exited unexpectedly");
    await expect(bridge.completion).rejects.toThrow("pico macOS resident I/O exited unexpectedly");
  });

  it("escalates shutdown to SIGKILL when the child does not exit", async () => {
    vi.useFakeTimers();
    const process = new ControlledProcess();
    const starting = startMacOSResidentIoBridge({
      input: residentInput(),
      platform: "darwin",
      handleControl: () => ({ result: "ignored_busy" }),
      handleTailComplete: () => undefined,
      spawnProcess: () => process
    });
    process.send({ kind: "ready", engineGeneration: 1, sampleRateHz: 16_000, channels: 1 });
    const bridge = await starting;
    const closing = bridge.close();
    const failure = expect(closing).rejects.toThrow(
      "pico macOS resident I/O did not stop after SIGKILL"
    );
    void failure.catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
    } finally {
      process.exit(0, "SIGKILL");
      vi.useRealTimers();
    }
  });
});

function residentInput() {
  return {
    deviceUid: "BuiltInMicrophoneDevice",
    sampleRateHz: 16_000,
    channels: 1,
    frameMs: 10,
    releaseTailMs: 250,
    talkKey: "F13",
    cancelKey: "F14"
  } as const;
}

function immediate<T>(value: T): Promise<T> {
  return new Promise((resolve) => setImmediate(() => resolve(value)));
}

class ControlledProcess extends EventEmitter implements MacOSResidentIoProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly #inputDecoder = new ResidentIoDecoder();
  readonly #input: ResidentIoMessage[] = [];

  constructor(stallInput = false) {
    super();
    this.stdin = stallInput
      ? new Writable({
          write() {
            // Intentionally leave the write pending to exercise the bounded production timeout.
          }
        })
      : new PassThrough();
    if (!(this.stdin instanceof PassThrough)) return;
    this.stdin.on("data", (chunk: Buffer) => {
      this.#inputDecoder.append(chunk);
      for (
        let message = this.#inputDecoder.next();
        message !== undefined;
        message = this.#inputDecoder.next()
      ) {
        this.#input.push(message);
        this.emit(`input:${message.kind}`, message);
      }
    });
  }

  send(message: ResidentIoMessage): void {
    this.stdout.write(encodeResidentIoMessage(message));
  }

  inputMessages(): readonly ResidentIoMessage[] {
    return this.#input;
  }

  async waitForInputMessage(kind: ResidentIoMessage["kind"]): Promise<ResidentIoMessage> {
    const existing = this.#input.find((message) => message.kind === kind);
    if (existing !== undefined) {
      return existing;
    }
    return new Promise((resolve) => {
      this.once(`input:${kind}`, (message: ResidentIoMessage) => resolve(message));
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code?: number, signal: NodeJS.Signals = "SIGTERM"): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}
