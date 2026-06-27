import { defineVoicePcmFrame, type VoicePcmFrame } from "../modules/voice/echo-control.js";

export type VoiceUtteranceWindowConfig = {
  readonly minSpeechMs: number;
  readonly silenceMs: number;
  readonly maxUtteranceMs: number;
  readonly minRmsDb: number;
};

export type TranscribedUtterance = {
  readonly frame: VoicePcmFrame;
  readonly frameCount: number;
};

export type VoiceUtteranceAssembler = {
  readonly accept: (
    frame: VoicePcmFrame,
    echoVoiceActivity: boolean
  ) => readonly TranscribedUtterance[];
  readonly flush: () => readonly TranscribedUtterance[];
  readonly reset: () => void;
};

export function createVoiceUtteranceAssembler(
  config: VoiceUtteranceWindowConfig
): VoiceUtteranceAssembler {
  return defineVoiceUtteranceAssembler(config);
}

function defineVoiceUtteranceAssembler(
  config: VoiceUtteranceWindowConfig
): VoiceUtteranceAssembler {
  const minSpeechMs = requirePositiveMilliseconds(
    config.minSpeechMs,
    "voice utterance minSpeechMs"
  );
  const silenceMs = requirePositiveMilliseconds(config.silenceMs, "voice utterance silenceMs");
  const maxUtteranceMs = requirePositiveMilliseconds(
    config.maxUtteranceMs,
    "voice utterance maxUtteranceMs"
  );
  const minRmsDatabase = requireFiniteNumber(config.minRmsDb, "voice utterance minRmsDb");
  const bufferedFrames: VoicePcmFrame[] = [];
  let bufferedSpeechMs = 0;
  let trailingSilenceMs = 0;

  return {
    accept(frame, echoVoiceActivity) {
      const normalized = defineVoicePcmFrame(frame);
      const isSpeech =
        echoVoiceActivity && calculatePcm16leRmsDatabase(normalized.audio) >= minRmsDatabase;

      if (!isSpeech) {
        if (bufferedFrames.length === 0) {
          return [];
        }

        bufferedFrames.push(normalized);
        trailingSilenceMs += normalized.durationMs;

        return trailingSilenceMs >= silenceMs || bufferedWindowMs() >= maxUtteranceMs
          ? flush()
          : [];
      }

      bufferedFrames.push(normalized);
      bufferedSpeechMs += normalized.durationMs;
      trailingSilenceMs = 0;

      return bufferedWindowMs() >= maxUtteranceMs ? flush() : [];
    },
    flush,
    reset
  };

  function reset(): void {
    bufferedFrames.splice(0, bufferedFrames.length);
    bufferedSpeechMs = 0;
    trailingSilenceMs = 0;
  }

  function flush(): readonly TranscribedUtterance[] {
    if (bufferedFrames.length === 0) {
      trailingSilenceMs = 0;
      return [];
    }

    const frames = bufferedFrames.splice(0, bufferedFrames.length);
    const speechMs = bufferedSpeechMs;
    bufferedSpeechMs = 0;
    trailingSilenceMs = 0;

    if (speechMs < minSpeechMs) {
      return [];
    }

    return [
      {
        frame: concatenateVoiceFrames(frames),
        frameCount: frames.length
      }
    ];
  }

  function bufferedWindowMs(): number {
    return bufferedFrames.reduce((total, frame) => total + frame.durationMs, 0);
  }
}

function concatenateVoiceFrames(frames: readonly VoicePcmFrame[]): VoicePcmFrame {
  const [first] = frames;

  if (first === undefined) {
    throw new Error("pico resident voice utterance requires at least one frame");
  }

  const byteLength = frames.reduce((total, frame) => {
    requireCompatibleVoiceFrame(first, frame);
    return total + frame.audio.byteLength;
  }, 0);
  const audio = new Uint8Array(byteLength);
  let offset = 0;

  for (const frame of frames) {
    audio.set(frame.audio, offset);
    offset += frame.audio.byteLength;
  }

  return defineVoicePcmFrame({
    id: `utterance:${first.id}:${frames.at(-1)?.id ?? first.id}`,
    direction: "near_end",
    audio,
    encoding: first.encoding,
    sampleRateHz: first.sampleRateHz,
    channels: first.channels,
    capturedAt: first.capturedAt,
    durationMs: frames.reduce((total, frame) => total + frame.durationMs, 0)
  });
}

function requireCompatibleVoiceFrame(reference: VoicePcmFrame, frame: VoicePcmFrame): void {
  if (
    frame.direction !== reference.direction ||
    frame.sampleRateHz !== reference.sampleRateHz ||
    frame.channels !== reference.channels
  ) {
    throw new Error("pico resident voice utterance frames must share audio format");
  }
}

function calculatePcm16leRmsDatabase(audio: Uint8Array): number {
  if (audio.byteLength < 2) {
    return Number.NEGATIVE_INFINITY;
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const sampleCount = Math.floor(audio.byteLength / 2);
  let squareSum = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    squareSum += sample * sample;
  }

  if (squareSum === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  return 20 * Math.log10(Math.sqrt(squareSum / sampleCount));
}

function requirePositiveMilliseconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function requireFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}
