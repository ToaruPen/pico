import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { recordVoiceStageProbe } from "../src/runtime/voice-stage-probe.js";

describe("voice stage probe", () => {
  it("records bounded voice runtime stage events", () => {
    const audit = createStructuredAuditLog();

    recordVoiceStageProbe(
      { audit },
      {
        stage: "stt",
        status: "ok",
        startedAt: "2026-06-18T00:00:00.000Z",
        durationMs: 12,
        attributes: {
          "pico.voice.frame_count": 1,
          "pico.voice.sample_rate_hz": 16_000,
          "pico.voice.triggered": true
        }
      }
    );

    expect(audit.entries()).toEqual([
      expect.objectContaining({
        category: "transport_event",
        name: "voice.runtime.stage",
        severity: "info",
        occurredAt: "2026-06-18T00:00:00.012Z",
        summary: "Pico voice runtime stage completed.",
        attributes: {
          "pico.voice.stage": "stt",
          "pico.voice.stage_status": "ok",
          "pico.voice.stage_duration_ms": 12,
          "pico.voice.frame_count": 1,
          "pico.voice.sample_rate_hz": 16_000,
          "pico.voice.triggered": true
        }
      })
    ]);
  });

  it("accepts fractional stage durations from provider timing measurements", () => {
    const audit = createStructuredAuditLog();

    recordVoiceStageProbe(
      { audit },
      {
        stage: "stt",
        status: "ok",
        startedAt: "2026-06-18T00:00:00.000Z",
        durationMs: 1007.515792036429
      }
    );

    const event = audit.entries()[0];

    expect(event?.occurredAt).toBe("2026-06-18T00:00:01.007Z");
    expect(event?.attributes["pico.voice.stage_duration_ms"]).toBe(1007.515792036429);
  });

  it("drops non-finite diagnostic attributes without dropping the stage event", () => {
    const audit = createStructuredAuditLog();

    recordVoiceStageProbe(
      { audit },
      {
        stage: "speech_gate",
        status: "suppressed",
        startedAt: "2026-06-18T00:00:00.000Z",
        durationMs: 0,
        attributes: {
          "pico.voice.frame_count": 1,
          "pico.voice.rms_db": Number.NEGATIVE_INFINITY,
          "pico.voice.speech_detected": false
        }
      }
    );

    expect(audit.entries()).toEqual([
      expect.objectContaining({
        attributes: {
          "pico.voice.stage": "speech_gate",
          "pico.voice.stage_status": "suppressed",
          "pico.voice.stage_duration_ms": 0,
          "pico.voice.frame_count": 1,
          "pico.voice.speech_detected": false
        }
      })
    ]);
  });

  it("rejects non-finite or oversized stage durations", () => {
    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: Number.POSITIVE_INFINITY
        }
      )
    ).toThrow("pico voice stage probe durationMs must be a non-negative number <= 2147483647");

    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 2_147_483_648
        }
      )
    ).toThrow("pico voice stage probe durationMs must be a non-negative number <= 2147483647");
  });

  it("rejects raw transcript and prompt-like probe attributes before audit recording", () => {
    const audit = createStructuredAuditLog();

    expect(() =>
      recordVoiceStageProbe(
        { audit },
        {
          stage: "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 12,
          attributes: {
            transcript: "raw text"
          }
        }
      )
    ).toThrow("pico voice stage probe attribute is not allowed");
    expect(audit.entries()).toEqual([]);
  });

  it("rejects unknown stages to keep probe cardinality bounded", () => {
    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "arbitrary_stage" as "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 1
        }
      )
    ).toThrow("pico voice runtime stage is invalid");
  });

  it("rejects the removed memory cutoff stage", () => {
    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "session_cutoff_memory" as "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 1
        }
      )
    ).toThrow("pico voice runtime stage is invalid");
  });
});
