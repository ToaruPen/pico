import type { ChildProcessByStdio } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import {
  createResidentAudioCapture,
  createResidentAudioInputPlan,
  measurePcm16leAudioLevel,
  measureResidentAudioInputLevel
} from "../src/runtime/resident-audio-io.js";

describe("resident audio I/O plans", () => {
  it("measures PCM16LE RMS and peak levels without retaining audio payloads", () => {
    const audio = pcm16le([0, 16_384, -16_384, 0]);
    const level = measurePcm16leAudioLevel(audio, 16_000, 1);

    expect(level).toMatchObject({
      sampleCount: 4,
      durationMs: 0.25
    });
    expect(level.rmsDb).toBeCloseTo(-9.03, 2);
    expect(level.peakDb).toBeCloseTo(-6.02, 2);
  });

  it("captures bounded resident input level from the configured audio source", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = measureResidentAudioInputLevel(
      config,
      {
        captureMs: 20,
        minimumRmsDb: -55
      },
      spawn,
      "linux"
    );

    process.stdout.write(pcm16le([8_192, -8_192, 8_192, -8_192], 80));
    process.stdout.end();
    process.emitClose(0, undefined);

    await expect(capture).resolves.toMatchObject({
      provider: "alsa",
      sampleRateHz: 16000,
      channels: 1,
      capturedMs: 20,
      sampleCount: 320,
      signalDetected: true
    });
    expect(spawn).toHaveBeenCalledWith(
      "arecord",
      ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-D", "hw:1,0", "-d", "1"],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("accepts a finite input level capture that ends within device timing tolerance", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = measureResidentAudioInputLevel(
      config,
      {
        captureMs: 20,
        minimumRmsDb: -55
      },
      spawn,
      "linux"
    );

    process.stdout.write(pcm16le([8_192, -8_192], 152));
    process.stdout.end();
    process.emitClose(0, undefined);

    await expect(capture).resolves.toMatchObject({
      capturedMs: 19,
      sampleCount: 304,
      signalDetected: true
    });
  });

  it("builds an explicit Linux ALSA input plan at the configured frame size", () => {
    const config = alsaResidentAudioConfig({ frameMs: 20 });

    expect(createResidentAudioInputPlan(config, "linux")).toEqual({
      provider: "alsa",
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-D", "hw:1,0"],
      frameByteLength: 640,
      frameIdPrefix: "alsa-mic"
    });
  });

  it("builds an explicit Linux ALSA input plan", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "alsa",
            device: "hw:1,0"
          },
          audioOutput: {
            provider: "alsa",
            device: "hw:0,0"
          }
        },
        echoControl: {
          sampleRateHz: 16000,
          channels: 1,
          frameMs: 10
        }
      }
    });

    expect(createResidentAudioInputPlan(config, "linux")).toEqual({
      provider: "alsa",
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-D", "hw:1,0"],
      frameByteLength: 320,
      frameIdPrefix: "alsa-mic"
    });
  });

  it("requires explicit ALSA input and output devices", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            enabled: true,
            audioInput: {
              provider: "alsa"
            },
            audioOutput: {
              provider: "alsa",
              device: "hw:0,0"
            }
          }
        }
      })
    ).toThrow(
      "pico config voice.resident.audioInput.device is required when voice.resident.audioInput is set"
    );

    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            enabled: true,
            audioInput: {
              provider: "alsa",
              device: "hw:1,0"
            },
            audioOutput: {
              provider: "alsa"
            }
          }
        }
      })
    ).toThrow(
      "pico config voice.resident.audioOutput.device is required when voice.resident.audioOutput is set"
    );
  });

  it("keeps AVAudioEngine ownership out of the command-spawn capture path", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avaudioengine",
            deviceUid: "BuiltInMicrophoneDevice"
          },
          audioOutput: {
            provider: "ffplay",
            route: "system_default"
          }
        }
      }
    });

    expect(() => createResidentAudioInputPlan(config, "darwin")).toThrow(
      "pico resident AVAudioEngine input is owned by the macOS resident I/O sidecar"
    );
  });

  it("turns ALSA PCM stdout into bounded voice frames", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "alsa",
            device: "hw:1,0"
          },
          audioOutput: {
            provider: "ffplay",
            route: "system_default"
          }
        },
        echoControl: {
          sampleRateHz: 16000,
          channels: 1,
          frameMs: 10
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const abortController = new AbortController();
    const capture = createResidentAudioCapture(config, spawn, "linux");
    const session = capture.start(abortController.signal);
    const iterator = session.frames[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    const secondFrame = iterator.next();

    process.stdout.write(Buffer.alloc(640, 7));

    const first = await firstFrame;
    const second = await secondFrame;

    if (first.done === true || second.done === true) {
      throw new Error("expected two ALSA PCM frames");
    }

    expect(first).toMatchObject({
      value: {
        id: "alsa-mic-1",
        direction: "near_end",
        encoding: "pcm16le",
        sampleRateHz: 16000,
        channels: 1,
        durationMs: 10
      },
      done: false
    });
    expect(first.value.audio.byteLength).toBe(320);
    expect(second).toMatchObject({
      value: {
        id: "alsa-mic-2",
        direction: "near_end",
        encoding: "pcm16le",
        sampleRateHz: 16000,
        channels: 1,
        durationMs: 10
      },
      done: false
    });
    expect(second.value.audio.byteLength).toBe(320);

    const stopped = session.stop();
    process.stdout.end();
    process.emitClose(0, undefined);
    await stopped;
    await iterator.return?.();

    expect(spawn).toHaveBeenCalledWith(
      "arecord",
      ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-D", "hw:1,0"],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("timestamps captured frames from the audio clock instead of delayed reads", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "alsa",
            device: "hw:1,0"
          },
          audioOutput: {
            provider: "ffplay",
            route: "system_default"
          }
        },
        echoControl: {
          sampleRateHz: 16000,
          channels: 1,
          frameMs: 10
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const abortController = new AbortController();
    const capture = createResidentAudioCapture(
      config,
      spawn,
      "linux",
      sequenceNow([
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:05.000Z",
        "2026-06-18T00:00:10.000Z"
      ])
    );
    const session = capture.start(abortController.signal);
    const iterator = session.frames[Symbol.asyncIterator]();
    try {
      const firstFrame = iterator.next();
      const secondFrame = iterator.next();

      process.stdout.write(Buffer.alloc(640, 7));

      const first = await firstFrame;
      const second = await secondFrame;

      if (first.done === true || second.done === true) {
        throw new Error("expected two ALSA PCM frames");
      }

      expect(first.value.capturedAt).toBe("2026-06-18T00:00:00.000Z");
      expect(second.value.capturedAt).toBe("2026-06-18T00:00:00.010Z");
    } finally {
      const stopped = session.stop();
      process.stdout.end();
      process.emitClose(0, undefined);
      await stopped;
      await iterator.return?.();
    }
  });

  it("fails clearly when the capture clock returns an invalid timestamp", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "alsa",
            device: "hw:1,0"
          },
          audioOutput: {
            provider: "ffplay",
            route: "system_default"
          }
        },
        echoControl: {
          sampleRateHz: 16000,
          channels: 1,
          frameMs: 10
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const abortController = new AbortController();
    const capture = createResidentAudioCapture(
      config,
      spawn,
      "linux",
      () => "not-an-iso-timestamp"
    );
    const session = capture.start(abortController.signal);
    const iterator = session.frames[Symbol.asyncIterator]();
    const firstFrame = iterator.next();

    process.stdout.write(Buffer.alloc(320, 7));

    await expect(firstFrame).rejects.toThrow(
      "pico resident voice capture clock returned an invalid ISO timestamp"
    );

    const stopped = session.stop();
    process.stdout.end();
    process.emitClose(0, undefined);
    await stopped;
    await iterator.return?.();
  });

  it("fails before spawning when the input signal is already aborted", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "alsa",
            device: "hw:1,0"
          },
          audioOutput: {
            provider: "ffplay",
            route: "system_default"
          }
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const abortController = new AbortController();

    abortController.abort();

    const capture = createResidentAudioCapture(config, spawn, "linux");

    expect(() => capture.start(abortController.signal)).toThrow(
      "pico resident voice alsa input was aborted before startup"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("owns microphone capture only between explicit start and stop", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = createResidentAudioCapture(config, spawn, "linux");

    expect(spawn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const session = capture.start(controller.signal);
    const firstFrame = session.frames[Symbol.asyncIterator]().next();

    expect(spawn).toHaveBeenCalledTimes(1);
    process.stdout.write(Buffer.alloc(320, 7));
    await expect(firstFrame).resolves.toMatchObject({ done: false });

    const stopped = session.stop();
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    process.stdout.end();
    process.emitClose(0, "SIGTERM");
    await expect(stopped).resolves.toBeUndefined();
    await expect(capture.close()).resolves.toBeUndefined();
  });

  it("escalates a stalled capture process from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const capture = createResidentAudioCapture(
      config,
      vi.fn(() => process.child),
      "linux"
    );
    const session = capture.start(new AbortController().signal);
    const stopped = session.stop();

    try {
      expect(process.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      process.stdout.end();
      process.emitClose(0, "SIGKILL");
      await stopped;
      vi.useRealTimers();
    }
  });

  it("rejects capture stop when the process remains unsettled after SIGKILL", async () => {
    vi.useFakeTimers();
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const nextProcess = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(process.child).mockReturnValueOnce(nextProcess.child);
    const capture = createResidentAudioCapture(config, spawn, "linux");
    const session = capture.start(new AbortController().signal);
    const collection = (async (): Promise<void> => {
      for await (const frame of session.frames) {
        void frame;
      }
    })();
    const stopped = session.stop();
    const stopFailure = expect(stopped).rejects.toThrow(
      "pico resident voice alsa input did not stop after SIGKILL"
    );
    const collectionFailure = expect(collection).rejects.toThrow(
      "pico resident voice alsa input did not stop after SIGKILL"
    );
    void stopFailure.catch(() => undefined);
    void collectionFailure.catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await stopFailure;
      await collectionFailure;
      expect(process.listenerCount("close")).toBe(0);
      expect(process.listenerCount("error")).toBe(0);

      const nextSession = capture.start(new AbortController().signal);
      expect(spawn).toHaveBeenCalledTimes(2);
      const nextStopped = nextSession.stop();
      nextProcess.stdout.end();
      nextProcess.emitClose(0, "SIGTERM");
      await nextStopped;
    } finally {
      process.emitClose(0, "SIGKILL");
      await capture.close();
      vi.useRealTimers();
    }
  });

  it("retains an unexpected capture failure that races an explicit stop", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const capture = createResidentAudioCapture(
      config,
      vi.fn(() => process.child),
      "linux"
    );
    const session = capture.start(new AbortController().signal);
    const collection = (async (): Promise<void> => {
      for await (const frame of session.frames) {
        void frame;
      }
    })();

    const stopped = session.stop();
    process.stdout.end();
    process.emitClose(1, undefined);

    await expect(stopped).resolves.toBeUndefined();
    await expect(collection).rejects.toThrow(
      "pico resident voice alsa input exited with code 1 signal undefined"
    );
    await expect(capture.close()).resolves.toBeUndefined();
  });

  it("reports a nonzero ALSA exit even when it races an explicit stop", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const capture = createResidentAudioCapture(
      config,
      vi.fn(() => process.child),
      "linux"
    );
    const session = capture.start(new AbortController().signal);
    const collection = (async (): Promise<void> => {
      for await (const frame of session.frames) {
        void frame;
      }
    })();

    const stopped = session.stop();
    process.stdout.end();
    process.emitClose(255, undefined);

    await expect(stopped).resolves.toBeUndefined();
    await expect(collection).rejects.toThrow(
      "pico resident voice alsa input exited with code 255 signal undefined"
    );
    await expect(capture.close()).resolves.toBeUndefined();
  });

  it("rejects overlapping microphone capture sessions", async () => {
    const config = alsaResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = createResidentAudioCapture(config, spawn, "linux");
    const first = capture.start(new AbortController().signal);

    expect(() => capture.start(new AbortController().signal)).toThrow(
      "pico resident voice capture is already active"
    );

    const stopped = first.stop();
    process.stdout.end();
    process.emitClose(0, "SIGTERM");
    await stopped;
  });
});

function createAudioProcess(streams: {
  readonly stdout?: PassThrough;
  readonly stdin?: PassThrough;
}): {
  readonly child: ChildProcessByStdio<Writable | null, Readable | null, null>;
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly emitClose: (code: number, signal: NodeJS.Signals | undefined) => void;
  readonly emitError: (error: Error) => void;
  readonly emitExit: (code: number) => void;
  readonly emitExitOnly: (code: number) => void;
  readonly listenerCount: (event: "close" | "exit" | "error") => number;
} {
  const stdout = streams.stdout ?? new PassThrough();
  const stdin = streams.stdin ?? new PassThrough();
  const kill = vi.fn();
  const listeners: Partial<{
    close: (code: number, signal: NodeJS.Signals | undefined) => void;
    exit: (code: number) => void;
    error: (error: Error) => void;
  }> = {};
  const child = {
    stdout,
    stdin,
    kill,
    once(event: "close" | "exit" | "error", listener: (...arguments_: never[]) => void) {
      listeners[event] = listener as never;

      return child;
    },
    removeListener(event: "close" | "exit" | "error", listener: (...arguments_: never[]) => void) {
      if (listeners[event] === listener) {
        switch (event) {
          case "close":
            delete listeners.close;
            break;
          case "exit":
            delete listeners.exit;
            break;
          case "error":
            delete listeners.error;
            break;
        }
      }

      return child;
    }
  } as unknown as ChildProcessByStdio<Writable | null, Readable | null, null>;

  return {
    child,
    stdout,
    stdin,
    kill,
    emitClose(code, signal) {
      const listener = listeners.close;
      delete listeners.close;
      listener?.(code, signal);
    },
    emitError(error) {
      const listener = listeners.error;
      delete listeners.error;
      listener?.(error);
    },
    emitExit(code) {
      const exitListener = listeners.exit;
      const closeListener = listeners.close;
      delete listeners.exit;
      delete listeners.close;
      exitListener?.(code);
      closeListener?.(code, undefined);
    },
    emitExitOnly(code) {
      const listener = listeners.exit;
      delete listeners.exit;
      listener?.(code);
    },
    listenerCount: (event) => (listeners[event] === undefined ? 0 : 1)
  };
}

function pcm16le(samples: readonly number[], repeat = 1): Uint8Array {
  const audio = new Uint8Array(samples.length * repeat * 2);
  const view = new DataView(audio.buffer);
  let offset = 0;

  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const sample of samples) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }

  return audio;
}

function alsaResidentAudioConfig(input: { readonly frameMs: number }) {
  return definePicoConfig({
    voice: {
      resident: {
        enabled: true,
        audioInput: {
          provider: "alsa",
          device: "hw:1,0"
        },
        audioOutput: {
          provider: "alsa",
          device: "hw:0,0"
        }
      },
      echoControl: {
        sampleRateHz: 16_000,
        channels: 1,
        frameMs: input.frameMs
      }
    }
  });
}

function sequenceNow(timestamps: readonly string[]): () => string {
  let index = 0;

  return () => timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0] ?? "";
}
