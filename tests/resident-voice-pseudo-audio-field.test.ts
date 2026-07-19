import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createInProcessTelemetryCapture } from "../scripts/field/in-process-telemetry.js";
import {
  createResidentVoicePseudoAudioPlaybackMeasurement,
  createResidentVoicePseudoAudioTts,
  evaluateResidentVoicePseudoAudioEvidence,
  formatResidentVoicePseudoAudioHelp,
  readResidentVoicePseudoAudioArguments,
  resolveResidentVoicePseudoAudioAgentSettings,
  withResidentVoicePseudoAudioOwners
} from "../scripts/field/resident-voice-pseudo-audio.js";
import { definePicoConfig } from "../src/config/index.js";
import { type AuditEvent, createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { PicoTelemetry } from "../src/modules/telemetry/index.js";
import type { TtsAudioChunk, TtsSynthesisEvent } from "../src/modules/voice/index.js";
import { createResidentVoiceAuditLog } from "../src/runtime/resident-voice-audit-log.js";
import type {
  PrivateResidentVoiceValidationSink,
  ResidentVoiceValidationEvent
} from "../src/runtime/resident-voice-validation.js";
import type { VoicePlaybackSink } from "../src/runtime/voice-playback.js";

describe("resident voice pseudo-audio field contract", () => {
  it("records Aivis substages through the field audit without exporting content", async () => {
    const capture = createInProcessTelemetryCapture();
    const auditEvents: unknown[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: false,
      writeEvent(event) {
        auditEvents.push(event);
        capture.telemetry.record(event);
      }
    });
    const tts = createResidentVoicePseudoAudioTts(
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              id: "local-aivis",
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: 1,
              timeoutMs: 250
            }
          }
        }
      }),
      audit,
      {
        fetch: (input) =>
          Promise.resolve(
            requestPath(input) === "/audio_query"
              ? new Response(JSON.stringify({ privateQuery: "do-not-export" }))
              : wavResponse()
          ),
        now: () => "2026-07-19T02:00:00.000Z",
        monotonicNow: () => 0
      }
    );

    await collectEvents(tts.synthesize({ text: "field private assistant text。" }));
    await capture.telemetry.forceFlush();

    expect(
      auditEvents.map(
        (event) =>
          (event as { readonly attributes: Record<string, unknown> }).attributes["pico.voice.stage"]
      )
    ).toEqual(["tts_audio_query", "tts_synthesize"]);
    expect(capture.inspection()).toEqual({ logRecordCount: 2, metricDataPointCount: 4 });
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain("field private assistant text");
    expect(serialized).not.toContain("privateQuery");
    expect(serialized).not.toContain("do-not-export");
    expect(serialized).not.toContain("UklGR");
    await capture.telemetry.shutdown();
  });

  it("requires explicit fixture and contentful private-artifact paths", () => {
    expect(
      readResidentVoicePseudoAudioArguments([
        "--audio-fixture",
        "/tmp/pico-ja.wav",
        "--validation-output",
        "/tmp/pico-validation.jsonl",
        "--timeout-ms",
        "90000"
      ])
    ).toEqual({
      audioFixturePath: "/tmp/pico-ja.wav",
      validationOutputPath: "/tmp/pico-validation.jsonl",
      timeoutMs: 90_000,
      help: false
    });
    expect(() =>
      readResidentVoicePseudoAudioArguments(["--audio-fixture", "/tmp/pico-ja.wav"])
    ).toThrow("--validation-output");
    expect(formatResidentVoicePseudoAudioHelp()).toContain("contentful");
  });

  it("accepts an explicit tool that must succeed during validation", () => {
    expect(
      readResidentVoicePseudoAudioArguments([
        "--audio-fixture",
        "/tmp/pico-ja.wav",
        "--validation-output",
        "/tmp/private/events.jsonl",
        "--required-tool-name",
        "stackchan_get_status"
      ])
    ).toMatchObject({ requiredToolName: "stackchan_get_status" });
  });

  it.each([
    {
      name: "blank staff transcript",
      validationEvents: validValidationEvents().map((event) =>
        event.kind === "staff_transcript" ? { ...event, text: " \n " } : event
      )
    },
    {
      name: "blank final Pi response",
      validationEvents: [...validValidationEvents(), validationTextEvent("pi_response", " \t ")]
    }
  ])("fails evidence evaluation for $name", ({ validationEvents }) => {
    expect(
      evaluateResidentVoicePseudoAudioEvidence({
        validationEvents,
        auditEvents: validStageEvents(),
        requiredToolName: "stackchan_get_status",
        playbackSinkOpenCount: 1
      }).passed
    ).toBe(false);
  });

  it.each([
    {
      name: "an unmatched tool result",
      validationEvents: validValidationEvents().map((event) =>
        event.kind === "tool_execution_end" ? { ...event, toolCallId: "unmatched" } : event
      )
    },
    {
      name: "two executions of the required tool",
      validationEvents: [
        ...validValidationEvents(),
        toolStartEvent("tool-2"),
        toolEndEvent("tool-2", false)
      ]
    },
    {
      name: "a failed required tool",
      validationEvents: validValidationEvents().map((event) =>
        event.kind === "tool_execution_end" ? { ...event, isError: true } : event
      )
    }
  ])("fails evidence evaluation for $name", ({ validationEvents }) => {
    expect(
      evaluateResidentVoicePseudoAudioEvidence({
        validationEvents,
        auditEvents: validStageEvents(),
        requiredToolName: "stackchan_get_status",
        playbackSinkOpenCount: 1
      }).passed
    ).toBe(false);
  });

  it.each([
    { name: "a missing required stage", auditEvents: validStageEvents().slice(1) },
    {
      name: "an unsuccessful required stage",
      auditEvents: validStageEvents().map((event) =>
        event.attributes["pico.voice.stage"] === "tts_synthesize"
          ? stageEvent("tts_synthesize", "error")
          : event
      )
    },
    {
      name: "a later unsuccessful repeated stage",
      auditEvents: [...validStageEvents(), stageEvent("tts_audio_query", "error")]
    }
  ])("fails evidence evaluation for $name", ({ auditEvents }) => {
    expect(
      evaluateResidentVoicePseudoAudioEvidence({
        validationEvents: validValidationEvents(),
        auditEvents,
        requiredToolName: "stackchan_get_status",
        playbackSinkOpenCount: 1
      }).passed
    ).toBe(false);
  });

  it.each([0, 2])("fails evidence evaluation when playback opens %i times", (openCount) => {
    expect(
      evaluateResidentVoicePseudoAudioEvidence({
        validationEvents: validValidationEvents(),
        auditEvents: validStageEvents(),
        requiredToolName: "stackchan_get_status",
        playbackSinkOpenCount: openCount
      }).passed
    ).toBe(false);
  });

  it("reports only content presence, paired tool metadata, and allowlisted stage metadata", () => {
    const evidence = evaluateResidentVoicePseudoAudioEvidence({
      validationEvents: validValidationEvents(),
      auditEvents: validStageEvents(),
      requiredToolName: "stackchan_get_status",
      playbackSinkOpenCount: 1
    });

    expect(evidence).toMatchObject({
      passed: true,
      validationEventCount: 4,
      validation: {
        staffTranscriptPresent: true,
        finalPiResponsePresent: true
      },
      toolExecutions: [{ toolName: "stackchan_get_status", isError: false, durationMs: 12 }],
      playback: { sinkOpenCount: 1 }
    });
    expect(evidence.stages.find(({ stage }) => stage === "tts_request_wall")).toEqual({
      stage: "tts_request_wall",
      status: "ok",
      durationMs: 20,
      sentenceIndex: 0,
      chunkCount: 2,
      playedChunkCount: 2
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("known private transcript");
    expect(serialized).not.toContain("private final response");
    expect(serialized).not.toContain("private-tool-argument");
    expect(serialized).not.toContain("private-tool-result");
    expect(serialized).not.toContain("queue_depth");
  });

  it("counts field playback sink opens while preserving the playback contract", async () => {
    const session = {
      write: vi.fn(() => Promise.resolve()),
      finish: vi.fn(() => Promise.resolve())
    };
    const delegate: VoicePlaybackSink = {
      open: vi.fn(() => session),
      stop: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve())
    };
    const measurement = createResidentVoicePseudoAudioPlaybackMeasurement(delegate);
    const firstChunk = playbackChunk();

    expect(measurement.openCount()).toBe(0);
    expect(measurement.playback.open(firstChunk)).toBe(session);
    expect(measurement.openCount()).toBe(1);
    expect(delegate.open).toHaveBeenCalledWith(firstChunk, undefined);
    await measurement.playback.stop();
    await measurement.playback.close();
    expect(delegate.stop).toHaveBeenCalledOnce();
    expect(delegate.close).toHaveBeenCalledOnce();
  });

  it("captures OTel Logs and Metrics in-process when no Collector is configured", async () => {
    const capture = createInProcessTelemetryCapture();
    const event = createStructuredAuditLog().record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-07-19T02:00:00.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "stt",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 125
      }
    });

    capture.telemetry.record(event);
    await capture.telemetry.forceFlush();

    expect(capture.inspection()).toEqual({
      logRecordCount: 1,
      metricDataPointCount: 2
    });
    await capture.telemetry.shutdown();
  });

  it("resolves the exact YAML model and thinking level for the measured turn", () => {
    const config = definePicoConfig({
      pico: {
        model: { provider: "anthropic", id: "configured-model", thinkingLevel: "medium" }
      }
    });
    const model = {
      provider: "anthropic",
      id: "configured-model"
    } as NonNullable<ExtensionContext["model"]>;
    const findModel = vi.fn(() => model);

    expect(resolveResidentVoicePseudoAudioAgentSettings(config, findModel)).toEqual({
      model,
      thinkingLevel: "medium"
    });
    expect(findModel).toHaveBeenCalledWith("anthropic", "configured-model");
  });

  it("fails closed when the YAML model is absent or unavailable", () => {
    expect(() =>
      resolveResidentVoicePseudoAudioAgentSettings(definePicoConfig(undefined), () => undefined)
    ).toThrow("requires pico.model");
    expect(() =>
      resolveResidentVoicePseudoAudioAgentSettings(
        definePicoConfig({
          pico: { model: { provider: "anthropic", id: "missing", thinkingLevel: "medium" } }
        }),
        () => undefined
      )
    ).toThrow("configured Pico model is unavailable");
  });

  it("cleans telemetry when validation owner creation fails", async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const telemetry = telemetryWithShutdown(shutdown);

    await expect(
      withResidentVoicePseudoAudioOwners({
        telemetry,
        createValidation: () => {
          throw new Error("validation creation failed");
        },
        run: () => Promise.resolve(undefined)
      })
    ).rejects.toThrow("validation creation failed");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("closes validation and telemetry when the measured run fails", async () => {
    const close = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve());

    await expect(
      withResidentVoicePseudoAudioOwners({
        telemetry: telemetryWithShutdown(shutdown),
        createValidation: () =>
          ({ record: () => undefined, close }) satisfies PrivateResidentVoiceValidationSink,
        run: () => Promise.reject(new Error("measured run failed"))
      })
    ).rejects.toThrow("measured run failed");
    expect(close).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

function telemetryWithShutdown(shutdown: () => Promise<void>): PicoTelemetry {
  return {
    record: () => undefined,
    forceFlush: () => Promise.resolve(),
    shutdown,
    health: () => ({
      logs: { consecutiveFailures: 0 },
      metrics: { consecutiveFailures: 0 }
    })
  };
}

async function collectEvents(events: AsyncIterable<TtsSynthesisEvent>): Promise<void> {
  for await (const event of events) {
    if (event.kind !== "chunk") return;
  }
}

function requestPath(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).pathname;
}

function wavResponse(): Response {
  const samples = Buffer.from([1, 0]);
  const wav = Buffer.alloc(44 + samples.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.byteLength, 40);
  samples.copy(wav, 44);
  return new Response(wav);
}

const requiredStages = [
  "tts_time_to_first_chunk",
  "tts_audio_query",
  "tts_synthesize",
  "tts_request_wall",
  "ptt_release_to_playback_start",
  "tts_playback"
] as const;

function validValidationEvents(): ResidentVoiceValidationEvent[] {
  return [
    validationTextEvent("staff_transcript", "known private transcript"),
    toolStartEvent("tool-1"),
    toolEndEvent("tool-1", false),
    validationTextEvent("pi_response", "private final response")
  ];
}

function validationTextEvent(
  kind: "staff_transcript" | "pi_response",
  text: string
): ResidentVoiceValidationEvent {
  return {
    kind,
    occurredAt: "2026-07-20T00:00:00.000Z",
    sessionId: "session-1",
    text
  };
}

function toolStartEvent(toolCallId: string): ResidentVoiceValidationEvent {
  return {
    kind: "tool_execution_start",
    occurredAt: "2026-07-20T00:00:01.000Z",
    sessionId: "session-1",
    toolCallId,
    toolName: "stackchan_get_status",
    args: { value: "private-tool-argument" }
  };
}

function toolEndEvent(toolCallId: string, isError: boolean): ResidentVoiceValidationEvent {
  return {
    kind: "tool_execution_end",
    occurredAt: "2026-07-20T00:00:01.012Z",
    sessionId: "session-1",
    toolCallId,
    toolName: "stackchan_get_status",
    result: { value: "private-tool-result" },
    isError,
    durationMs: 12
  };
}

function validStageEvents(): AuditEvent[] {
  return requiredStages.map((stage) => stageEvent(stage, "ok"));
}

function stageEvent(stage: (typeof requiredStages)[number], status: string): AuditEvent {
  return {
    category: "transport_event",
    name: "voice.runtime.stage",
    severity: status === "ok" ? "info" : "warn",
    occurredAt: "2026-07-20T00:00:02.000Z",
    summary: "Pico voice runtime stage completed.",
    attributes: {
      "pico.voice.stage": stage,
      "pico.voice.stage_status": status,
      "pico.voice.stage_duration_ms": 20,
      "pico.voice.sentence_index": 0,
      "pico.voice.chunk_count": 2,
      "pico.voice.played_chunk_count": 2,
      "pico.voice.queue_depth": 99
    },
    traceId: undefined,
    spanId: undefined
  };
}

function playbackChunk(): TtsAudioChunk {
  return {
    sentenceIndex: 0,
    text: "private playback text",
    audio: Uint8Array.from([1, 0]),
    encoding: "pcm16le",
    sampleRateHz: 24_000,
    channels: 1,
    durationMs: 1,
    source: {
      serviceId: "local-aivis",
      provider: "aivis-speech",
      speakerId: 1
    }
  };
}
