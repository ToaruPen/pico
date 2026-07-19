import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createInProcessTelemetryCapture } from "../scripts/field/in-process-telemetry.js";
import {
  createResidentVoicePseudoAudioTts,
  formatResidentVoicePseudoAudioHelp,
  readResidentVoicePseudoAudioArguments,
  resolveResidentVoicePseudoAudioAgentSettings,
  withResidentVoicePseudoAudioOwners
} from "../scripts/field/resident-voice-pseudo-audio.js";
import { definePicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { PicoTelemetry } from "../src/modules/telemetry/index.js";
import type { TtsSynthesisEvent } from "../src/modules/voice/index.js";
import { createResidentVoiceAuditLog } from "../src/runtime/resident-voice-audit-log.js";
import type { PrivateResidentVoiceValidationSink } from "../src/runtime/resident-voice-validation.js";

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
