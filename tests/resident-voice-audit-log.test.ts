import { describe, expect, it } from "vitest";

import {
  createAuditEventFanout,
  createResidentVoiceAuditLog
} from "../src/runtime/resident-voice-audit-log.js";

describe("resident voice audit log", () => {
  it("fans events out in order and isolates sink failures", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: false,
      writeEvent: createAuditEventFanout([
        () => {
          writes.push("first");
          throw new Error("first sink unavailable");
        },
        (event) => {
          writes.push(event.name);
        }
      ])
    });

    expect(() =>
      audit.record({
        category: "session_lifecycle",
        name: "session.started",
        severity: "info",
        occurredAt: "2026-07-19T02:00:00.000Z",
        summary: "Pico interaction session started.",
        attributes: {}
      })
    ).not.toThrow();
    expect(writes).toEqual(["first", "session.started"]);
    expect(audit.entries()).toEqual([]);
  });

  it("fans out every normalized event without retaining resident history", () => {
    const writtenNames: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: false,
      writeEvent: (event) => {
        writtenNames.push(event.name);
      }
    });

    for (let index = 0; index < 1_000; index += 1) {
      audit.record({
        category: "transport_event",
        name: "voice.runtime.health",
        severity: "info",
        occurredAt: "2026-07-21T00:00:00.000Z",
        summary: "Resident voice health was observed.",
        attributes: { "pico.voice.restart_count": index }
      });
    }

    expect(writtenNames).toHaveLength(1_000);
    expect(audit.entries()).toEqual([]);
  });

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

    expect(event.name).toBe("voice.runtime.stage");
    expect(audit.entries()).toEqual([]);
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

    expect(audit.entries()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("applies the summary stage policy to error events", () => {
    const writes: string[] = [];
    const audit = createResidentVoiceAuditLog({
      stdoutEnabled: true,
      writeStdout: (line) => {
        writes.push(line);
      }
    });

    for (const stage of ["stt", "echo_control", "unknown_stage"]) {
      audit.record({
        category: "transport_event",
        name: "voice.runtime.stage",
        severity: "warn",
        occurredAt: "2026-06-22T00:00:00.000Z",
        summary: "Pico voice runtime stage failed.",
        attributes: {
          "pico.voice.stage": stage,
          "pico.voice.stage_status": "error",
          "pico.voice.stage_duration_ms": 123.4,
          "pico.voice.error_code": "stage_failed"
        }
      });
    }

    expect(writes).toEqual([
      "[pico voice] 2026-06-22T00:00:00.000Z stage=stt status=error duration_ms=123.4 error=stage_failed\n"
    ]);
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
