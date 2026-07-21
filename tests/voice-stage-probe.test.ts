import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  recordVoiceStageProbe,
  voiceRuntimeStagePolicies
} from "../src/runtime/voice-stage-probe.js";

describe("voice stage probe", () => {
  it("assigns one persistence and summary policy to every accepted stage", () => {
    expect(voiceRuntimeStagePolicies).toEqual({
      mic_capture: { persisted: false, summary: false },
      resident_key_to_admission: { persisted: true, summary: false },
      resident_admission_to_gate: { persisted: true, summary: false },
      resident_gate_to_first_sample: { persisted: true, summary: false },
      resident_first_sample_to_dispatch: { persisted: true, summary: false },
      resident_release_to_tail_complete: { persisted: true, summary: false },
      resident_engine_start: { persisted: true, summary: false },
      resident_engine_restart: { persisted: true, summary: false },
      echo_control: { persisted: false, summary: false },
      speech_gate: { persisted: true, summary: false },
      stt: { persisted: true, summary: true },
      session_start: { persisted: true, summary: true },
      ptt_release_to_playback_start: { persisted: true, summary: true },
      pi_time_to_first_text: { persisted: true, summary: true },
      pi_session_resource_load: { persisted: true, summary: false },
      pi_session_create: { persisted: true, summary: false },
      pi_session_bind: { persisted: true, summary: false },
      pi_tool_execution: { persisted: true, summary: false },
      pi_session_dispose: { persisted: true, summary: false },
      interaction_end: { persisted: true, summary: true },
      pi_turn: { persisted: true, summary: true },
      tts_request_wall: { persisted: true, summary: true },
      tts_time_to_first_chunk: { persisted: true, summary: true },
      tts_audio_query: { persisted: true, summary: false },
      tts_synthesize: { persisted: true, summary: false },
      tts_playback: { persisted: true, summary: true },
      camera_capture: { persisted: true, summary: true },
      vlm_scene_description: { persisted: true, summary: true }
    });
  });

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
          "pico.voice.sample_rate_hz": 16_000
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
          "pico.voice.sample_rate_hz": 16_000
        }
      })
    ]);
  });

  it("notifies a best-effort observer with validated stage metadata", () => {
    const observations: unknown[] = [];

    expect(
      recordVoiceStageProbe(
        {
          observe: (observation) => observations.push(observation)
        },
        {
          stage: "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 12,
          attributes: { "pico.voice.frame_count": 1 }
        }
      )
    ).toBeUndefined();
    expect(observations).toEqual([
      {
        stage: "stt",
        status: "ok",
        startedAt: "2026-06-18T00:00:00.000Z",
        occurredAt: "2026-06-18T00:00:00.012Z",
        durationMs: 12,
        attributes: { "pico.voice.frame_count": 1 }
      }
    ]);
  });

  it("contains observer failures without dropping the audit event", () => {
    const audit = createStructuredAuditLog();

    expect(() =>
      recordVoiceStageProbe(
        {
          audit,
          observe: () => {
            throw new Error("display failed");
          }
        },
        {
          stage: "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 12
        }
      )
    ).not.toThrow();
    expect(audit.entries()).toHaveLength(1);
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

  it("accepts bounded numeric TTS pipeline attributes", () => {
    const audit = createStructuredAuditLog();

    recordVoiceStageProbe(
      { audit },
      {
        stage: "tts_synthesize",
        status: "error",
        startedAt: "2026-06-18T00:00:00.000Z",
        durationMs: 12,
        attributes: {
          "pico.voice.sentence_index": 2,
          "pico.voice.played_chunk_count": 1,
          "pico.voice.trailing_silence_ms": 125.5
        }
      }
    );

    expect(audit.entries()[0]?.attributes).toMatchObject({
      "pico.voice.sentence_index": 2,
      "pico.voice.played_chunk_count": 1,
      "pico.voice.trailing_silence_ms": 125.5
    });
  });

  it("rejects non-numeric TTS pipeline attributes", () => {
    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "tts_synthesize",
          status: "error",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 12,
          attributes: { "pico.voice.trailing_silence_ms": "1" }
        }
      )
    ).toThrow("pico voice stage probe numeric attribute is invalid");
  });

  it("rejects TTS body and audio attributes before audit recording", () => {
    for (const key of ["pico.voice.text", "pico.voice.audio", "pico.voice.http_body"]) {
      expect(() =>
        recordVoiceStageProbe(
          { audit: createStructuredAuditLog() },
          {
            stage: "tts_audio_query",
            status: "ok",
            startedAt: "2026-06-18T00:00:00.000Z",
            durationMs: 1,
            attributes: { [key]: "private" }
          }
        )
      ).toThrow("pico voice stage probe attribute is not allowed");
    }
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

  it("rejects the removed TTS audio duration stage", () => {
    expect(() =>
      recordVoiceStageProbe(
        { audit: createStructuredAuditLog() },
        {
          stage: "tts_audio_duration" as "stt",
          status: "ok",
          startedAt: "2026-06-18T00:00:00.000Z",
          durationMs: 1
        }
      )
    ).toThrow("pico voice runtime stage is invalid");
  });
});
