import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createInProcessTelemetryCapture } from "../scripts/field/in-process-telemetry.js";
import {
  formatResidentVoicePseudoAudioHelp,
  readResidentVoicePseudoAudioArguments,
  resolveResidentVoicePseudoAudioAgentSettings,
  withResidentVoicePseudoAudioOwners
} from "../scripts/field/resident-voice-pseudo-audio.js";
import { definePicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type { PicoTelemetry } from "../src/modules/telemetry/index.js";
import type { PrivateResidentVoiceValidationSink } from "../src/runtime/resident-voice-validation.js";

describe("resident voice pseudo-audio field contract", () => {
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
