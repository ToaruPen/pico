import type { TtsAudioChunk } from "../modules/voice/index.js";

export type VoicePlaybackSession = {
  readonly write: (chunk: TtsAudioChunk) => Promise<void>;
  readonly finish: () => Promise<void>;
};

export type VoicePlaybackSink = {
  readonly open: (firstChunk: TtsAudioChunk, signal?: AbortSignal) => VoicePlaybackSession;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
};
