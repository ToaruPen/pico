#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { createSessionLifecycle } from "../../src/modules/session/index.js";
import {
  createHalfDuplexEchoControl,
  type VoicePcmFrame
} from "../../src/modules/voice/echo-control.js";
import type {
  SttClient,
  SttTranscriptionResult,
  TtsClient,
  TtsSynthesisResult
} from "../../src/modules/voice/index.js";
import {
  runVoiceResidentRuntime,
  type VoiceResidentLogEvent
} from "../../src/runtime/voice-resident.js";

export type ResidentVoicePseudoInputReport = {
  readonly status: "passed" | "failed";
  readonly expected: {
    readonly startedSessions: 1;
    readonly completedTurns: 1;
    readonly suppressedFrames: 1;
    readonly sttCalls: 2;
    readonly piAgentPrompts: readonly ["用件です"];
  };
  readonly observed: {
    readonly processedFrames: number;
    readonly startedSessions: number;
    readonly completedTurns: number;
    readonly suppressedFrames: number;
    readonly failedFrames: number;
    readonly failedTurns: number;
    readonly sttTranscriptsReturned: readonly string[];
    readonly sttAudioByteLengths: readonly number[];
    readonly piAgentPrompts: readonly string[];
    readonly ttsRequests: readonly string[];
    readonly playbackStarts: readonly string[];
    readonly injectedFrames: readonly InjectedFrameSummary[];
    readonly logEvents: readonly VoiceResidentLogEvent[];
  };
};

type InjectedFrameSummary = {
  readonly id: string;
  readonly capturedAt: string;
  readonly durationMs: number;
};

const baseTimestamp = "2026-06-18T00:00:00.000Z";

export async function runResidentVoicePseudoInputField(): Promise<ResidentVoicePseudoInputReport> {
  const sttTranscripts = ["ピコ", "用件です", "self-captured pico speech"];
  const sttTranscriptsReturned: string[] = [];
  const sttAudioByteLengths: number[] = [];
  const piAgentPrompts: string[] = [];
  const ttsRequests: string[] = [];
  const playbackStarts: string[] = [];
  const injectedFrameSummaries: InjectedFrameSummary[] = [];
  const logEvents: VoiceResidentLogEvent[] = [];

  const stt: SttClient = {
    warmup: () => {
      throw new Error("warmup is not part of resident pseudo input field");
    },
    transcribe: (request) => {
      sttAudioByteLengths.push(request.audio.byteLength);
      const text = sttTranscripts.shift() ?? "";
      sttTranscriptsReturned.push(text);

      return Promise.resolve(successfulTranscript(text));
    }
  };
  const tts: TtsClient = {
    synthesize: (request) => {
      ttsRequests.push(request.text);

      return Promise.resolve(successfulTts(request.text, 300));
    }
  };

  const result = await runVoiceResidentRuntime({
    now: fixedNow(),
    monotonicNow: sequenceNumber([1_000, 1_135, 1_200, 1_212]),
    frames: injectedFrames(
      [
        speechFrame("wake", 0),
        speechFrame("staff-turn", 100),
        speechFrame("self-captured-during-tts", 500)
      ],
      injectedFrameSummaries
    ),
    utteranceWindow: {
      minSpeechMs: 1,
      silenceMs: 1,
      maxUtteranceMs: 100,
      minRmsDb: -50
    },
    triggerPhrases: ["ピコ"],
    sessionLifecycle: createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    }),
    echoControl: createHalfDuplexEchoControl({
      tailMuteMs: 700
    }),
    stt,
    tts,
    playback: {
      play: (_chunk, startedAt) => {
        playbackStarts.push(startedAt);
        return Promise.resolve();
      }
    },
    piAgent: {
      prompt: (input) => {
        piAgentPrompts.push(input.text);
        return Promise.resolve({ text: "はい。" });
      }
    },
    log: {
      record: (event) => {
        logEvents.push(event);
      }
    }
  });

  const observed = {
    processedFrames: result.processedFrames,
    startedSessions: result.startedSessions,
    completedTurns: result.completedTurns,
    suppressedFrames: result.suppressedFrames,
    failedFrames: result.failedFrames,
    failedTurns: result.failedTurns,
    sttTranscriptsReturned,
    sttAudioByteLengths,
    piAgentPrompts,
    ttsRequests,
    playbackStarts,
    injectedFrames: injectedFrameSummaries,
    logEvents
  };
  const expected = {
    startedSessions: 1,
    completedTurns: 1,
    suppressedFrames: 1,
    sttCalls: 2,
    piAgentPrompts: ["用件です"] as const
  } satisfies ResidentVoicePseudoInputReport["expected"];

  return {
    status: matchesExpected(observed) ? "passed" : "failed",
    expected,
    observed
  };
}

function matchesExpected(observed: ResidentVoicePseudoInputReport["observed"]): boolean {
  const checks = [
    observed.startedSessions === 1 &&
      observed.completedTurns === 1 &&
      observed.suppressedFrames === 1,
    observed.failedFrames === 0 && observed.failedTurns === 0,
    observed.sttTranscriptsReturned.length === 2,
    observed.sttTranscriptsReturned[0] === "ピコ",
    observed.sttTranscriptsReturned[1] === "用件です",
    observed.piAgentPrompts.length === 1 && observed.piAgentPrompts[0] === "用件です"
  ];

  return checks.every(Boolean);
}

async function* injectedFrames(
  frames: readonly VoicePcmFrame[],
  summaries: InjectedFrameSummary[]
): AsyncIterable<VoicePcmFrame> {
  for (const frame of frames) {
    summaries.push({
      id: frame.id,
      capturedAt: frame.capturedAt,
      durationMs: frame.durationMs
    });
    await Promise.resolve();
    yield frame;
  }
}

function speechFrame(id: string, offsetMs: number): VoicePcmFrame {
  return {
    id,
    direction: "near_end",
    audio: constantPcm16le(3_000, 100),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt: addMilliseconds(baseTimestamp, offsetMs),
    durationMs: 100
  };
}

function constantPcm16le(sample: number, durationMs: number): Uint8Array {
  const sampleRateHz = 16_000;
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  const audio = new Uint8Array(sampleCount * 2);
  const view = new DataView(audio.buffer);

  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(index * 2, sample, true);
  }

  return audio;
}

function successfulTranscript(text: string): SttTranscriptionResult {
  return {
    ok: true,
    text,
    language: "ja-JP",
    confidence: 0.9,
    durationMs: 100,
    segments: [],
    source: {
      sidecarId: "pseudo-apple-speech",
      provider: "apple-speech",
      language: "ja-JP"
    }
  };
}

function successfulTts(text: string, durationMs: number): TtsSynthesisResult {
  return {
    ok: true,
    chunks: [
      {
        sentenceIndex: 0,
        text,
        audio: constantPcm16le(2_000, durationMs),
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        durationMs,
        source: {
          serviceId: "pseudo-aivis",
          provider: "aivis-speech",
          speakerId: 888_753_760
        }
      }
    ],
    totalDurationMs: durationMs,
    source: {
      serviceId: "pseudo-aivis",
      provider: "aivis-speech",
      speakerId: 888_753_760
    }
  };
}

function fixedNow(): () => string {
  return () => baseTimestamp;
}

function sequenceNumber(values: readonly number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] ?? values[0] ?? 0;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runResidentVoicePseudoInputField();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
