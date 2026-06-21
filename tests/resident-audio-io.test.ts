import type { ChildProcessByStdio } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import type { VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import {
  createResidentAudioInputPlan,
  createResidentAudioOutputPlan,
  createResidentPcmFrameSource,
  createResidentPlaybackSink,
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
    const config = avfoundationResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = measureResidentAudioInputLevel(
      config,
      {
        captureMs: 20,
        minimumRmsDb: -55
      },
      spawn,
      "darwin"
    );

    process.stdout.write(pcm16le([8_192, -8_192, 8_192, -8_192], 80));
    process.stdout.end();
    process.emitClose(0, undefined);

    await expect(capture).resolves.toMatchObject({
      provider: "avfoundation",
      sampleRateHz: 16000,
      channels: 1,
      capturedMs: 20,
      sampleCount: 320,
      signalDetected: true
    });
    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-t",
        "1.02",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1"
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("accepts a finite input level capture that ends within device timing tolerance", async () => {
    const config = avfoundationResidentAudioConfig({ frameMs: 10 });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const capture = measureResidentAudioInputLevel(
      config,
      {
        captureMs: 20,
        minimumRmsDb: -55
      },
      spawn,
      "darwin"
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

  it("builds explicit macOS AVFoundation input and afplay output plans", () => {
    const config = avfoundationResidentAudioConfig({ frameMs: 20 });

    expect(createResidentAudioInputPlan(config, "darwin")).toEqual({
      provider: "avfoundation",
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1"
      ],
      frameByteLength: 640,
      frameIdPrefix: "avfoundation-mic"
    });
    expect(createResidentAudioOutputPlan(config, "darwin")).toEqual({
      provider: "afplay",
      command: "afplay",
      route: "system_default"
    });
  });

  it("builds explicit Linux ALSA input and output plans", () => {
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
    expect(createResidentAudioOutputPlan(config, "linux")).toEqual({
      provider: "alsa",
      command: "aplay",
      device: "hw:0,0"
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

  it("fails closed when a configured provider is used on the wrong platform", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avfoundation",
            device: ":0"
          },
          audioOutput: {
            provider: "afplay",
            route: "system_default"
          }
        }
      }
    });

    expect(() => createResidentAudioInputPlan(config, "linux")).toThrow(
      "pico resident voice AVFoundation input requires macOS"
    );
    expect(() => createResidentAudioOutputPlan(config, "linux")).toThrow(
      "pico resident voice afplay output requires macOS"
    );
  });

  it("turns AVFoundation PCM stdout into bounded voice frames", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avfoundation",
            device: ":0"
          },
          audioOutput: {
            provider: "afplay",
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
    const iterator: AsyncIterator<VoicePcmFrame> = createResidentPcmFrameSource(
      config,
      abortController.signal,
      spawn,
      "darwin"
    )[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    const secondFrame = iterator.next();

    process.stdout.write(Buffer.alloc(640, 7));

    const first = await firstFrame;
    const second = await secondFrame;

    if (first.done === true || second.done === true) {
      throw new Error("expected two AVFoundation PCM frames");
    }

    expect(first).toMatchObject({
      value: {
        id: "avfoundation-mic-1",
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
        id: "avfoundation-mic-2",
        direction: "near_end",
        encoding: "pcm16le",
        sampleRateHz: 16000,
        channels: 1,
        durationMs: 10
      },
      done: false
    });
    expect(second.value.audio.byteLength).toBe(320);

    abortController.abort();
    process.stdout.end();
    process.emitClose(0, undefined);
    await iterator.return?.();

    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1"
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails before spawning when the input signal is already aborted", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avfoundation",
            device: ":0"
          },
          audioOutput: {
            provider: "afplay",
            route: "system_default"
          }
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const abortController = new AbortController();

    abortController.abort();

    const iterator = createResidentPcmFrameSource(config, abortController.signal, spawn, "darwin")[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).rejects.toThrow(
      "pico resident voice avfoundation input was aborted before startup"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("plays ALSA PCM using the TTS chunk sample format", async () => {
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
    const process = createAudioProcess({ stdin: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const playback = createResidentPlaybackSink(config, spawn, "linux");
    const done = playback.play(
      {
        sentenceIndex: 0,
        text: "hello",
        audio: new Uint8Array([1, 2, 3, 4]),
        encoding: "pcm16le",
        sampleRateHz: 24000,
        channels: 2,
        durationMs: 1,
        source: {
          serviceId: "test-aivis",
          provider: "aivis-speech",
          speakerId: 1
        }
      },
      "2026-06-20T00:00:00.000Z"
    );

    process.emitExit(0);

    await expect(done).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(
      "aplay",
      ["-q", "-f", "S16_LE", "-r", "24000", "-c", "2", "-t", "raw", "-D", "hw:0,0"],
      { stdio: ["pipe", "ignore", "inherit"] }
    );
  });

  it("rejects ALSA playback when the PCM stdin stream fails", async () => {
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
        }
      }
    });
    const process = createAudioProcess({ stdin: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const done = createResidentPlaybackSink(config, spawn, "linux").play(
      {
        sentenceIndex: 0,
        text: "hello",
        audio: new Uint8Array([1, 2, 3, 4]),
        encoding: "pcm16le",
        sampleRateHz: 24000,
        channels: 1,
        durationMs: 1,
        source: {
          serviceId: "test-aivis",
          provider: "aivis-speech",
          speakerId: 1
        }
      },
      "2026-06-20T00:00:00.000Z"
    );

    process.stdin.emit("error", new Error("pipe failed"));

    await expect(done).rejects.toThrow("pipe failed");
  });

  it("removes the afplay temporary directory after playback", async () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avfoundation",
            device: ":0"
          },
          audioOutput: {
            provider: "afplay",
            route: "system_default"
          }
        }
      }
    });
    const process = createAudioProcess({ stdout: new PassThrough() });
    const spawn = vi.fn(() => process.child);
    const playback = createResidentPlaybackSink(config, spawn, "darwin");
    const done = playback.play(
      {
        sentenceIndex: 0,
        text: "hello",
        audio: new Uint8Array([0, 0, 1, 0]),
        encoding: "pcm16le",
        sampleRateHz: 16000,
        channels: 1,
        durationMs: 1,
        source: {
          serviceId: "test-aivis",
          provider: "aivis-speech",
          speakerId: 1
        }
      },
      "2026-06-20T00:00:00.000Z"
    );

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const calls = spawn.mock.calls as unknown as Array<[string, readonly string[], unknown]>;
    const wavPath = calls[0]?.[1][0];

    expect(typeof wavPath).toBe("string");
    process.emitExit(0);
    await expect(done).resolves.toBeUndefined();
    await expect(access(dirname(wavPath as string))).rejects.toThrow();
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
  readonly emitExit: (code: number) => void;
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
    }
  } as unknown as ChildProcessByStdio<Writable | null, Readable | null, null>;

  return {
    child,
    stdout,
    stdin,
    kill,
    emitClose(code, signal) {
      listeners.close?.(code, signal);
    },
    emitExit(code) {
      listeners.exit?.(code);
    }
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

function avfoundationResidentAudioConfig(input: { readonly frameMs: number }) {
  return definePicoConfig({
    voice: {
      resident: {
        enabled: true,
        audioInput: {
          provider: "avfoundation",
          device: ":0"
        },
        audioOutput: {
          provider: "afplay",
          route: "system_default"
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
