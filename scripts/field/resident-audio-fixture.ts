import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { defineVoicePcmFrame, type VoicePcmFrame } from "../../src/modules/voice/echo-control.js";
import type {
  ResidentAudioCapture,
  ResidentCaptureSession
} from "../../src/runtime/resident-audio-io.js";

export type ResidentAudioFixtureOptions = {
  readonly path: string;
  readonly expectedSampleRateHz: number;
  readonly expectedChannels: number;
  readonly frameMs: number;
  readonly maximumBytes?: number;
  readonly now?: () => string;
};

type LoadedAudioFixture = {
  readonly audio: Uint8Array;
  readonly sampleRateHz: number;
  readonly channels: number;
};

const defaultMaximumBytes = 32 * 1024 * 1024;

export function createResidentAudioFixtureCapture(
  options: ResidentAudioFixtureOptions
): ResidentAudioCapture {
  const fixture = loadAudioFixture(options);
  const frameByteLength = alignedFrameByteLength(
    fixture.sampleRateHz,
    fixture.channels,
    options.frameMs
  );
  const now = options.now ?? (() => new Date().toISOString());
  let active: ResidentCaptureSession | undefined;

  return {
    start(signal) {
      if (active !== undefined) {
        throw new Error("pico resident audio fixture capture is already active");
      }

      signal.throwIfAborted();
      const startedAt = now();
      const session: ResidentCaptureSession = {
        frames: createFixtureFrames(
          fixture,
          frameByteLength,
          options.frameMs,
          startedAt,
          signal,
          () => {
            if (active === session) {
              active = undefined;
            }
          }
        ),
        stop() {
          if (active === session) {
            active = undefined;
          }
          return Promise.resolve();
        }
      };
      active = session;
      return session;
    },
    async close() {
      await active?.stop();
    }
  };
}

async function* createFixtureFrames(
  fixture: LoadedAudioFixture,
  frameByteLength: number,
  frameMs: number,
  startedAt: string,
  signal: AbortSignal,
  release: () => void
): AsyncIterable<VoicePcmFrame> {
  try {
    for (let offset = 0, index = 0; offset < fixture.audio.byteLength; index += 1) {
      signal.throwIfAborted();
      await Promise.resolve();
      const end = Math.min(offset + frameByteLength, fixture.audio.byteLength);
      const audio = fixture.audio.slice(offset, end);
      const sampleCount = audio.byteLength / (fixture.channels * 2);
      const durationMs = Math.max(1, Math.round((sampleCount / fixture.sampleRateHz) * 1_000));
      yield defineVoicePcmFrame({
        id: `fixture-${String(index)}`,
        direction: "near_end",
        audio,
        encoding: "pcm16le",
        sampleRateHz: fixture.sampleRateHz,
        channels: fixture.channels,
        capturedAt: addMilliseconds(startedAt, index * frameMs),
        durationMs
      });
      offset = end;
    }
  } finally {
    release();
  }
}

// Fixture loading validates size, container, and the resident PCM contract in one boundary.
// eslint-disable-next-line complexity
function loadAudioFixture(options: ResidentAudioFixtureOptions): LoadedAudioFixture {
  const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("pico resident audio fixture maximumBytes must be a positive integer");
  }

  const file = readFileSync(options.path);
  if (file.byteLength === 0 || file.byteLength > maximumBytes) {
    throw new Error(`pico resident audio fixture must contain 1..${String(maximumBytes)} bytes`);
  }

  const fixture =
    extname(options.path).toLowerCase() === ".wav"
      ? readPcm16Wave(file)
      : {
          audio: new Uint8Array(file),
          sampleRateHz: options.expectedSampleRateHz,
          channels: options.expectedChannels
        };

  if (fixture.sampleRateHz !== options.expectedSampleRateHz) {
    throw new Error(
      `pico resident audio fixture sample rate must be ${String(options.expectedSampleRateHz)} Hz`
    );
  }

  if (fixture.channels !== options.expectedChannels) {
    throw new Error(
      `pico resident audio fixture channels must be ${String(options.expectedChannels)}`
    );
  }

  if (fixture.audio.byteLength % (fixture.channels * 2) !== 0) {
    throw new Error("pico resident audio fixture PCM16 payload is not sample-aligned");
  }

  return fixture;
}

// RIFF chunk traversal must tolerate optional chunks while requiring one PCM format and data chunk.
// eslint-disable-next-line complexity
function readPcm16Wave(file: Uint8Array): LoadedAudioFixture {
  if (file.byteLength < 44 || ascii(file, 0, 4) !== "RIFF" || ascii(file, 8, 4) !== "WAVE") {
    throw new Error("pico resident audio fixture WAV header is invalid");
  }

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let format: { readonly sampleRateHz: number; readonly channels: number } | undefined;
  let audio: Uint8Array | undefined;
  let offset = 12;

  while (offset + 8 <= file.byteLength) {
    const chunkName = ascii(file, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const contentOffset = offset + 8;
    const contentEnd = contentOffset + chunkLength;
    if (contentEnd > file.byteLength) {
      throw new Error("pico resident audio fixture WAV chunk is truncated");
    }

    if (chunkName === "fmt ") {
      if (chunkLength < 16 || view.getUint16(contentOffset, true) !== 1) {
        throw new Error("pico resident audio fixture WAV must use linear PCM");
      }
      const bitsPerSample = view.getUint16(contentOffset + 14, true);
      if (bitsPerSample !== 16) {
        throw new Error("pico resident audio fixture WAV must use PCM16");
      }
      format = {
        channels: view.getUint16(contentOffset + 2, true),
        sampleRateHz: view.getUint32(contentOffset + 4, true)
      };
    } else if (chunkName === "data") {
      audio = file.slice(contentOffset, contentEnd);
    }

    offset = contentEnd + (chunkLength % 2);
  }

  if (format === undefined || audio === undefined || audio.byteLength === 0) {
    throw new Error("pico resident audio fixture WAV requires fmt and non-empty data chunks");
  }

  return { ...format, audio };
}

function alignedFrameByteLength(sampleRateHz: number, channels: number, frameMs: number): number {
  if (!Number.isFinite(frameMs) || frameMs <= 0) {
    throw new Error("pico resident audio fixture frameMs must be positive");
  }

  const sampleBytes = channels * 2;
  const requested = Math.round((sampleRateHz * sampleBytes * frameMs) / 1_000);
  return Math.max(sampleBytes, requested - (requested % sampleBytes));
}

function ascii(value: Uint8Array, offset: number, length: number): string {
  return Buffer.from(value.subarray(offset, offset + length)).toString("ascii");
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
