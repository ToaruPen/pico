import { describe, expect, it } from "vitest";

import { createResidentVoiceAuditLog } from "../src/runtime/resident-voice-audit-log.js";

describe("resident voice audit log", () => {
  it("mirrors voice runtime summary stage events to stdout when enabled", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: true,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    const event = audit.record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-06-22T00:00:00.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "stt",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 123.4,
        "pico.voice.frame_count": 5
      }
    });

    expect(audit.entries()).toEqual([event]);
    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z stage=stt status=ok duration_ms=123.4 frame_count=5\n"
    ]);
  });

  it("suppresses high-volume successful frame stages in summary mode", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: true,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    audit.record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-06-22T00:00:00.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "echo_control",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 0,
        "pico.voice.frame_count": 1
      }
    });

    expect(audit.entries()).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("mirrors high-volume frame stages only in verbose mode", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: true,
      stdoutMode: "verbose",
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    audit.record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-06-22T00:00:00.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "echo_control",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 0,
        "pico.voice.frame_count": 1
      }
    });

    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z stage=echo_control status=ok duration_ms=0 frame_count=1\n"
    ]);
  });

  it("keeps stdout quiet unless explicitly enabled", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: false,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    audit.record({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-06-22T00:00:00.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "echo_control",
        "pico.voice.stage_status": "skipped",
        "pico.voice.stage_duration_ms": 0
      }
    });

    expect(writes).toEqual([]);
  });

  it("does not mirror the removed memory cutoff stage", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: true,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    for (const stage of ["session_cutoff_enqueue", "session_cutoff_memory"]) {
      audit.record({
        category: "transport_event",
        name: "voice.runtime.stage",
        severity: "info",
        occurredAt: "2026-06-22T00:00:00.000Z",
        summary: "Pico voice runtime stage completed.",
        attributes: {
          "pico.voice.stage": stage,
          "pico.voice.stage_status": "ok",
          "pico.voice.stage_duration_ms": 0
        }
      });
    }

    expect(writes).toEqual([]);
  });
});
