import { describe, expect, it } from "vitest";

import type { VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import { createVoiceUtteranceAssembler } from "../src/runtime/voice-utterance-window.js";

describe("voice utterance window", () => {
  it("flushes when the max utterance window duration is reached", () => {
    const assembler = createVoiceUtteranceAssembler({
      minSpeechMs: 10,
      silenceMs: 100,
      maxUtteranceMs: 30,
      minRmsDb: -50
    });

    expect(assembler.accept(speechFrame("speech-1", 0), true)).toEqual([]);
    expect(assembler.accept(speechFrame("speech-2", 10), true)).toEqual([]);
    const [utterance] = assembler.accept(speechFrame("speech-3", 20), true);

    expect(utterance?.frame.durationMs).toBe(30);
    expect(utterance?.frameCount).toBe(3);
  });

  it("keeps short in-utterance silence in the STT audio window", () => {
    const assembler = createVoiceUtteranceAssembler({
      minSpeechMs: 20,
      silenceMs: 20,
      maxUtteranceMs: 1_000,
      minRmsDb: -50
    });

    expect(assembler.accept(speechFrame("speech-1", 0), true)).toEqual([]);
    expect(assembler.accept(silenceFrame("pause-1", 10), false)).toEqual([]);
    expect(assembler.accept(speechFrame("speech-2", 20), true)).toEqual([]);
    expect(assembler.accept(silenceFrame("silence-1", 30), false)).toEqual([]);
    const [utterance] = assembler.accept(silenceFrame("silence-2", 40), false);

    expect(utterance?.frame.durationMs).toBe(50);
    expect(utterance?.frameCount).toBe(5);
  });

  it("uses elapsed window duration for max utterance cutoff", () => {
    const assembler = createVoiceUtteranceAssembler({
      minSpeechMs: 10,
      silenceMs: 100,
      maxUtteranceMs: 30,
      minRmsDb: -50
    });

    expect(assembler.accept(speechFrame("speech-1", 0), true)).toEqual([]);
    expect(assembler.accept(silenceFrame("pause-1", 10), false)).toEqual([]);
    const [utterance] = assembler.accept(speechFrame("speech-2", 20), true);

    expect(utterance?.frame.durationMs).toBe(30);
    expect(utterance?.frameCount).toBe(3);
  });

  it("drops speech that is shorter than the configured minimum", () => {
    const assembler = createVoiceUtteranceAssembler({
      minSpeechMs: 30,
      silenceMs: 20,
      maxUtteranceMs: 1_000,
      minRmsDb: -50
    });

    expect(assembler.accept(speechFrame("speech-1", 0), true)).toEqual([]);
    expect(assembler.accept(silenceFrame("silence-1", 10), false)).toEqual([]);
    expect(assembler.accept(silenceFrame("silence-2", 20), false)).toEqual([]);
    expect(assembler.flush()).toEqual([]);
  });
});

function speechFrame(id: string, offsetMs: number): VoicePcmFrame {
  return pcmFrame(id, offsetMs, 3_000);
}

function silenceFrame(id: string, offsetMs: number): VoicePcmFrame {
  return pcmFrame(id, offsetMs, 0);
}

function pcmFrame(id: string, offsetMs: number, sample: number): VoicePcmFrame {
  const sampleRateHz = 16_000;
  const durationMs = 10;
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  const audio = new Uint8Array(sampleCount * 2);

  for (let index = 0; index < audio.length; index += 2) {
    audio[index] = sample & 0xff;
    audio[index + 1] = (sample >> 8) & 0xff;
  }

  return {
    id,
    direction: "near_end",
    audio,
    encoding: "pcm16le",
    sampleRateHz,
    channels: 1,
    capturedAt: new Date(Date.parse("2026-06-18T00:00:00.000Z") + offsetMs).toISOString(),
    durationMs
  };
}
