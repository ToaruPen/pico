import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type { SttClient, TtsClient } from "../modules/voice/index.js";

export type LiveVoiceTurnInput = {
  readonly now: () => string;
  readonly tts: TtsClient;
  readonly stt: SttClient;
  readonly echoControl: EchoControlProvider;
  readonly text: string;
  readonly micFrames: readonly VoicePcmFrame[];
  readonly triggerPhrases: readonly string[];
};

export type LiveVoiceTurnResult = {
  readonly status: "completed";
  readonly transcripts: readonly string[];
  readonly triggered: boolean;
  readonly suppressedFrames: number;
};

export async function runLiveVoiceTurn(input: LiveVoiceTurnInput): Promise<LiveVoiceTurnResult> {
  try {
    const health = await input.echoControl.checkHealth();

    if (!health.ok) {
      throw new Error(`pico live voice echo-control provider is unhealthy: ${health.message}`);
    }

    const ttsResult = await input.tts.synthesize({ text: input.text });

    if (!ttsResult.ok) {
      throw new Error(`pico live voice TTS failed: ${ttsResult.reason}: ${ttsResult.message}`);
    }

    const playbackStartedAt = input.now();
    let playbackOffsetMs = 0;

    for (const chunk of ttsResult.chunks) {
      await input.echoControl.acceptFarEndReference(
        defineVoicePcmFrame({
          id: `tts-${chunk.sentenceIndex}`,
          direction: "far_end",
          audio: chunk.audio,
          encoding: chunk.encoding,
          sampleRateHz: chunk.sampleRateHz,
          channels: chunk.channels,
          capturedAt: addMilliseconds(playbackStartedAt, playbackOffsetMs),
          durationMs: chunk.durationMs
        })
      );
      playbackOffsetMs += chunk.durationMs;
    }

    const transcripts: string[] = [];
    let suppressedFrames = 0;

    for (const micFrame of input.micFrames) {
      const echoResult = await input.echoControl.processNearEnd(defineVoicePcmFrame(micFrame));

      if (echoResult.action === "suppress") {
        suppressedFrames += 1;
        continue;
      }

      const sttResult = await input.stt.transcribe({
        audio: echoResult.frame.audio,
        encoding: echoResult.frame.encoding,
        sampleRateHz: echoResult.frame.sampleRateHz,
        channels: echoResult.frame.channels
      });

      if (!sttResult.ok) {
        throw new Error(`pico live voice STT failed: ${sttResult.reason}: ${sttResult.message}`);
      }

      transcripts.push(sttResult.text);
    }

    return {
      status: "completed",
      transcripts,
      triggered: transcriptsContainTriggerPhrase(transcripts, input.triggerPhrases),
      suppressedFrames
    };
  } finally {
    await input.echoControl.flush();
  }
}

function includesTriggerPhrase(transcript: string, triggerPhrases: readonly string[]): boolean {
  const normalizedTranscript = transcript.toLowerCase();

  return triggerPhrases.some((phrase) => {
    const normalizedPhrase = phrase.trim().toLowerCase();

    return normalizedPhrase !== "" && normalizedTranscript.includes(normalizedPhrase);
  });
}

function transcriptsContainTriggerPhrase(
  transcripts: readonly string[],
  triggerPhrases: readonly string[]
): boolean {
  return (
    transcripts.some((transcript) => includesTriggerPhrase(transcript, triggerPhrases)) ||
    includesTriggerPhrase(transcripts.join(""), triggerPhrases) ||
    includesTriggerPhrase(transcripts.join(" "), triggerPhrases)
  );
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
