#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  createDeferredToolCoordinator,
  type DeferredToolDeliverableResult
} from "../../src/runtime/deferred-tool-coordinator.js";
import { createPicoCameraSceneDescriptionDeferredTool } from "../../src/runtime/perception-tool.js";
import {
  runVoiceResidentRuntime,
  type VoiceResidentConsoleEvent
} from "../../src/runtime/voice-resident.js";

export type ResidentVoiceDeferredRalliesReport = {
  readonly status: "passed" | "failed";
  readonly expected: {
    readonly startedSessions: 1;
    readonly completedTurns: 3;
    readonly queuedDeferredJobs: readonly ["deferred-job-1", "deferred-job-2"];
    readonly deliveredDeferredJobs: readonly ["deferred-job-1", "deferred-job-2"];
    readonly acknowledgedDeferredJobs: readonly ["deferred-job-1", "deferred-job-2"];
  };
  readonly observed: {
    readonly processedFrames: number;
    readonly startedSessions: number;
    readonly completedTurns: number;
    readonly failedFrames: number;
    readonly failedTurns: number;
    readonly sttTranscriptsReturned: readonly string[];
    readonly piAgentPrompts: readonly string[];
    readonly piAgentDeferredResultSummaries: readonly string[];
    readonly piAgentResponses: readonly string[];
    readonly queuedDeferredJobs: readonly string[];
    readonly deliveredDeferredJobs: readonly string[];
    readonly acknowledgedDeferredJobs: readonly string[];
    readonly sceneDescriptions: readonly string[];
    readonly ttsRequests: readonly string[];
    readonly consoleEvents: readonly VoiceResidentConsoleEvent[];
  };
};

type QueuedToolResult = {
  readonly tool: "pico_camera_scene_description_deferred";
  readonly result: {
    readonly status: "queued" | "rejected";
    readonly jobId?: string;
  };
};

const baseTimestamp = "2026-06-23T00:00:00.000Z";

export async function runResidentVoiceDeferredRalliesField(): Promise<ResidentVoiceDeferredRalliesReport> {
  const sttTranscripts = [
    "ピコ",
    "教室を見て。",
    "結果を教えて。もう一度見て。",
    "二回目の結果は？"
  ];
  const sttTranscriptsReturned: string[] = [];
  const piAgentPrompts: string[] = [];
  const piAgentDeferredResultSummaries: string[] = [];
  const piAgentResponses: string[] = [];
  const queuedDeferredJobs: string[] = [];
  const deliveredDeferredJobs: string[] = [];
  const acknowledgedDeferredJobs: string[] = [];
  const sceneDescriptions: string[] = [];
  const ttsRequests: string[] = [];
  const consoleEvents: VoiceResidentConsoleEvent[] = [];
  const coordinator = createDeferredToolCoordinator({
    maxResultAgeMs: 60_000
  });
  const deferredTools = {
    enqueue: coordinator.enqueue,
    collectDeliverableResults: (
      input: Parameters<typeof coordinator.collectDeliverableResults>[0]
    ) => {
      const results = coordinator.collectDeliverableResults(input);
      deliveredDeferredJobs.push(...results.map((result) => result.jobId));

      return results;
    },
    acknowledgeDelivered: (jobIds: readonly string[]) => {
      acknowledgedDeferredJobs.push(...jobIds);
      coordinator.acknowledgeDelivered(jobIds);
    },
    cancelSession: coordinator.cancelSession
  };
  const deferredTool = createPicoCameraSceneDescriptionDeferredTool({
    sessionId: "session-1",
    coordinator: deferredTools,
    service: {
      captureSceneSnapshot: () => Promise.reject(new Error("unused")),
      detectPeople: () => Promise.reject(new Error("unused")),
      describeCameraScene: async () => {
        await delay(5);
        const sceneDescription =
          sceneDescriptions.length === 0
            ? "1回目: 机の上に教材が見えます。"
            : "2回目: 入口付近は落ち着いています。";
        sceneDescriptions.push(sceneDescription);

        return {
          status: "passed",
          sourceId: "pseudo-tapo-main",
          streamPurpose: "scene",
          frameBytes: 4,
          vlmFrameBytes: 4,
          mimeType: "image/jpeg",
          capturedAt: addMilliseconds(baseTimestamp, sceneDescriptions.length * 1_000),
          scene: {
            summary: sceneDescription,
            observedPeople: [],
            environment: [],
            humanAttention: [],
            uncertainty: ["pseudo field harness"],
            source: {
              endpointId: "pseudo-vlm",
              model: "qwen3.5:9b",
              purpose: "staff_requested_snapshot"
            }
          }
        };
      }
    }
  });

  const result = await runVoiceResidentRuntime({
    now: fixedNow(),
    monotonicNow: sequenceNumber([1_000, 1_120, 1_240, 1_360, 1_480, 1_600, 1_720, 1_840]),
    frames: injectedFrames([
      speechFrame("wake", 0),
      speechFrame("staff-tool-1", 1_000),
      speechFrame("staff-result-and-tool-2", 2_000),
      speechFrame("staff-result-2", 3_000)
    ]),
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
      tailMuteMs: 0
    }),
    stt: createScriptedStt(sttTranscripts, sttTranscriptsReturned),
    tts: createRecordingTts(ttsRequests),
    playback: {
      play: () => Promise.resolve()
    },
    piAgent: {
      prompt: async (input) => {
        piAgentPrompts.push(input.text);
        const deferredResults = input.deferredToolResults ?? [];
        piAgentDeferredResultSummaries.push(...deferredResults.map((result) => result.summary));
        const response = await respondAsToolCallingAgent(input.text, deferredResults, deferredTool);
        piAgentResponses.push(response.text);

        if (response.queuedJobId !== undefined) {
          queuedDeferredJobs.push(response.queuedJobId);
        }

        return {
          text: response.text
        };
      }
    },
    deferredTools,
    console: {
      record: (event) => {
        consoleEvents.push(event);
      }
    }
  });
  await coordinator.waitForIdle();

  const expected = {
    startedSessions: 1,
    completedTurns: 3,
    queuedDeferredJobs: ["deferred-job-1", "deferred-job-2"],
    deliveredDeferredJobs: ["deferred-job-1", "deferred-job-2"],
    acknowledgedDeferredJobs: ["deferred-job-1", "deferred-job-2"]
  } as const;
  const observed = {
    processedFrames: result.processedFrames,
    startedSessions: result.startedSessions,
    completedTurns: result.completedTurns,
    failedFrames: result.failedFrames,
    failedTurns: result.failedTurns,
    sttTranscriptsReturned,
    piAgentPrompts,
    piAgentDeferredResultSummaries,
    piAgentResponses,
    queuedDeferredJobs,
    deliveredDeferredJobs,
    acknowledgedDeferredJobs,
    sceneDescriptions,
    ttsRequests,
    consoleEvents
  };

  return {
    status: matchesExpected(expected, observed) ? "passed" : "failed",
    expected,
    observed
  };
}

async function respondAsToolCallingAgent(
  prompt: string,
  deferredResults: readonly DeferredToolDeliverableResult[],
  deferredTool: ReturnType<typeof createPicoCameraSceneDescriptionDeferredTool>
): Promise<{
  readonly text: string;
  readonly queuedJobId?: string;
}> {
  if (prompt === "教室を見て。") {
    return queueDeferredSceneCheck(deferredTool, "tool-call-1", "確認します。");
  }

  if (
    deferredResults.some((result) => result.summary.includes("1回目: 机の上に教材が見えます。")) &&
    prompt.startsWith("結果を教えて。もう一度見て。")
  ) {
    return queueDeferredSceneCheck(
      deferredTool,
      "tool-call-2",
      "1回目は教材が見えました。もう一度確認します。"
    );
  }

  if (
    deferredResults.some((result) => result.summary.includes("2回目: 入口付近は落ち着いています。"))
  ) {
    return {
      text: "2回目は入口付近が落ち着いています。"
    };
  }

  return {
    text: "はい。"
  };
}

async function queueDeferredSceneCheck(
  deferredTool: ReturnType<typeof createPicoCameraSceneDescriptionDeferredTool>,
  toolCallId: string,
  text: string
): Promise<{
  readonly text: string;
  readonly queuedJobId?: string;
}> {
  const result = await deferredTool.execute(
    toolCallId,
    {},
    undefined,
    undefined,
    {} as ExtensionContext
  );
  const toolResult = extractQueuedToolResult(result);

  return {
    text,
    ...(toolResult.result.jobId === undefined ? {} : { queuedJobId: toolResult.result.jobId })
  };
}

function extractQueuedToolResult(result: unknown): QueuedToolResult {
  const content = (result as { content?: readonly { type: string; text?: string }[] }).content;
  const text = content?.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    throw new Error("deferred tool did not return text content");
  }

  return JSON.parse(text) as QueuedToolResult;
}

function createScriptedStt(transcripts: string[], returned: string[]): SttClient {
  return {
    warmup: () => {
      throw new Error("warmup is not part of deferred rallies field");
    },
    transcribe: () => {
      const text = transcripts.shift() ?? "";
      returned.push(text);

      return Promise.resolve(successfulTranscript(text));
    }
  };
}

function createRecordingTts(requests: string[]): TtsClient {
  return {
    synthesize: (request) => {
      requests.push(request.text);

      return Promise.resolve(successfulTts(request.text, 80));
    }
  };
}

function matchesExpected(
  expected: ResidentVoiceDeferredRalliesReport["expected"],
  observed: ResidentVoiceDeferredRalliesReport["observed"]
): boolean {
  const checks = [
    observed.startedSessions === expected.startedSessions,
    observed.completedTurns === expected.completedTurns,
    observed.failedFrames === 0,
    observed.failedTurns === 0,
    arraysEqual(observed.queuedDeferredJobs, expected.queuedDeferredJobs),
    arraysEqual(observed.deliveredDeferredJobs, expected.deliveredDeferredJobs),
    arraysEqual(observed.acknowledgedDeferredJobs, expected.acknowledgedDeferredJobs),
    arraysEqual(observed.sceneDescriptions, [
      "1回目: 机の上に教材が見えます。",
      "2回目: 入口付近は落ち着いています。"
    ]),
    arraysEqual(observed.piAgentDeferredResultSummaries, [
      "1回目: 机の上に教材が見えます。",
      "2回目: 入口付近は落ち着いています。"
    ]),
    arraysEqual(observed.ttsRequests, [
      "確認します。",
      "1回目は教材が見えました。もう一度確認します。",
      "2回目は入口付近が落ち着いています。"
    ])
  ];

  return checks.every(Boolean);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function* injectedFrames(frames: readonly VoicePcmFrame[]): AsyncIterable<VoicePcmFrame> {
  for (const frame of frames) {
    await delay(10);
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
    language: "ja",
    confidence: 0.9,
    durationMs: 100,
    segments: [],
    source: {
      sidecarId: "pseudo-mlx-whisper",
      provider: "mlx-whisper",
      modelRepo: "mlx-community/whisper-large-v3-turbo"
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runResidentVoiceDeferredRalliesField();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
