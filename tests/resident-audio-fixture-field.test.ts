import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createResidentAudioFixtureCapture } from "../scripts/field/resident-audio-fixture.js";

describe("resident audio fixture capture", () => {
  it("reads a finite PCM16 WAV into configured frame-sized near-end chunks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-audio-fixture-"));
    const path = join(directory, "speech.wav");
    writeFileSync(path, createPcm16Wave(new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])));
    const capture = createResidentAudioFixtureCapture({
      path,
      expectedSampleRateHz: 16_000,
      expectedChannels: 1,
      frameMs: 0.125,
      now: () => "2026-07-19T02:00:00.000Z"
    });
    const session = capture.start(new AbortController().signal);
    const frames = [];

    for await (const frame of session.frames) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => Array.from(frame.audio))).toEqual([
      [1, 0, 2, 0],
      [3, 0, 4, 0]
    ]);
    expect(frames[0]).toMatchObject({
      direction: "near_end",
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      durationMs: 1
    });
    await session.stop();
    await capture.close();
  });

  it("rejects WAV audio whose format differs from the resident contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-audio-fixture-"));
    const path = join(directory, "speech.wav");
    writeFileSync(path, createPcm16Wave(new Uint8Array([1, 0]), 8_000));

    expect(() =>
      createResidentAudioFixtureCapture({
        path,
        expectedSampleRateHz: 16_000,
        expectedChannels: 1,
        frameMs: 10
      })
    ).toThrow("sample rate must be 16000 Hz");
  });
});

function createPcm16Wave(audio: Uint8Array, sampleRateHz = 16_000): Uint8Array {
  const output = new Uint8Array(44 + audio.byteLength);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, "RIFF");
  view.setUint32(4, 36 + audio.byteLength, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, audio.byteLength, true);
  output.set(audio, 44);
  return output;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  target.set(Buffer.from(value, "ascii"), offset);
}
