import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createResidentVoiceCompositeLogSink,
  createResidentVoiceFileLogSink,
  resolveResidentVoiceLogPaths
} from "../src/runtime/resident-voice-log-files.js";
import type { VoiceResidentLogEvent } from "../src/runtime/voice-resident.js";

describe("resident voice file logs", () => {
  it("writes metadata-only daily and session events under the user pico directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "development",
      runId: "run-1",
      now: () => "2026-06-22T01:02:03.000Z"
    });

    log.writeProcessLine("[pico voice] process event\n");
    log.record({
      kind: "pi_agent_response",
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1",
      durationMs: 1234,
      text: "はい。\n聞いています。"
    } as VoiceResidentLogEvent);
    await log.close();

    const paths = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "development",
      runId: "run-1",
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1"
    });

    await expect(readFile(paths.processLogPath, "utf8")).resolves.toBe(
      "[pico voice] process event\n"
    );
    expect(paths).not.toHaveProperty("sessionTextLogPath");
    await expect(readFile(paths.sessionJsonlPath ?? "", "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        runMode: "development",
        runId: "run-1",
        kind: "pi_agent_response",
        occurredAt: "2026-06-22T01:02:04.000Z",
        sessionId: "session-1",
        durationMs: 1234
      })}\n`
    );
    await expect(readFile(paths.dailyEventsJsonlPath, "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        runMode: "development",
        runId: "run-1",
        kind: "pi_agent_response",
        occurredAt: "2026-06-22T01:02:04.000Z",
        sessionId: "session-1",
        durationMs: 1234
      })}\n`
    );
    expect(await readFile(paths.sessionJsonlPath ?? "", "utf8")).not.toContain("はい。");
    expect(await readFile(paths.dailyEventsJsonlPath, "utf8")).not.toContain("はい。");
    expect(await readFile(paths.dailyEventsJsonlPath, "utf8")).not.toContain('"text"');
    expect((await stat(join(homeDirectory, ".pico"))).mode & 0o777).toBe(0o700);
    expect((await stat(paths.sessionJsonlPath ?? "")).mode & 0o777).toBe(0o600);
  });

  it("writes audit-safe voice metrics separately from metadata-only interaction logs", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "development",
      runId: "run-1",
      now: () => "2026-06-22T01:02:03.000Z"
    });

    log.writeAuditEvent({
      category: "transport_event",
      name: "voice.runtime.stage",
      severity: "info",
      occurredAt: "2026-06-23T01:02:04.000Z",
      summary: "Pico voice runtime stage completed.",
      attributes: {
        "pico.voice.stage": "stt",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 123.4,
        "pico.voice.queue_depth": 1,
        "pico.voice.sample_rate_hz": 16_000,
        "pico.voice.channels": 1,
        "pico.voice.suppressed_frame_count": 4,
        "pico.voice.trailing_silence_ms": 267.6
      }
    });
    await log.close();

    const paths = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "development",
      runId: "run-1",
      occurredAt: "2026-06-23T01:02:04.000Z"
    });

    await expect(readFile(paths.metricsJsonlPath, "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        runMode: "development",
        runId: "run-1",
        name: "voice.runtime.stage",
        occurredAt: "2026-06-23T01:02:04.000Z",
        attributes: {
          "pico.voice.stage": "stt",
          "pico.voice.stage_status": "ok",
          "pico.voice.stage_duration_ms": 123.4,
          "pico.voice.queue_depth": 1,
          "pico.voice.sample_rate_hz": 16_000,
          "pico.voice.channels": 1,
          "pico.voice.suppressed_frame_count": 4,
          "pico.voice.trailing_silence_ms": 267.6
        }
      })}\n`
    );
    expect((await stat(paths.metricsJsonlPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps development and normal run modes in separate directories", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));

    expect(
      resolveResidentVoiceLogPaths({
        homeDirectory,
        runMode: "development",
        runId: "run-1",
        occurredAt: "2026-06-22T01:02:04.000Z"
      }).dayDirectory
    ).toContain("/.pico/resident-voice/managed/development/processes/2026-06-22");
    expect(
      resolveResidentVoiceLogPaths({
        homeDirectory,
        runMode: "normal",
        runId: "run-2",
        occurredAt: "2026-06-22T01:02:04.000Z"
      }).dayDirectory
    ).toContain("/.pico/resident-voice/managed/normal/processes/2026-06-22");
  });

  it("rolls process and metric output by each record timestamp", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    let processTimestamp = "2026-06-22T23:59:59.000Z";
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "midnight-run",
      now: () => processTimestamp
    });

    log.writeProcessLine("before midnight\n");
    processTimestamp = "2026-06-23T00:00:01.000Z";
    log.writeProcessLine("after midnight\n");
    for (const occurredAt of ["2026-06-22T23:59:59.000Z", "2026-06-23T00:00:01.000Z"]) {
      log.writeAuditEvent({
        category: "transport_event",
        name: "voice.runtime.stage",
        severity: "info",
        occurredAt,
        summary: "Pico voice runtime stage completed.",
        attributes: {
          "pico.voice.stage": "stt",
          "pico.voice.stage_status": "ok",
          "pico.voice.stage_duration_ms": 1
        }
      });
    }
    await log.close();

    const first = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "midnight-run",
      occurredAt: "2026-06-22T23:59:59.000Z"
    });
    const second = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "midnight-run",
      occurredAt: "2026-06-23T00:00:01.000Z"
    });

    await expect(readFile(first.processLogPath, "utf8")).resolves.toBe("before midnight\n");
    await expect(readFile(second.processLogPath, "utf8")).resolves.toBe("after midnight\n");
    await expect(readFile(first.metricsJsonlPath, "utf8")).resolves.toContain(
      "2026-06-22T23:59:59.000Z"
    );
    await expect(readFile(second.metricsJsonlPath, "utf8")).resolves.toContain(
      "2026-06-23T00:00:01.000Z"
    );
  });

  it("drains accepted records in FIFO order when closed", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "fifo-run",
      now: () => "2026-06-22T01:02:03.000Z"
    });

    await log.ready;
    for (const line of ["first\n", "second\n", "third\n"]) log.writeProcessLine(line);
    await log.close();

    const path = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "fifo-run",
      occurredAt: "2026-06-22T01:02:03.000Z"
    }).processLogPath;
    await expect(readFile(path, "utf8")).resolves.toBe("first\nsecond\nthird\n");
    expect(log.droppedRecordCount()).toBe(0);
  });

  it("drops the newest record when the one-megabyte queue is full", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const diagnostics: unknown[] = [];
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "bounded-run",
      now: () => "2026-06-22T01:02:03.000Z",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const accepted = "a".repeat(700_000);

    log.writeProcessLine(accepted);
    log.writeProcessLine("b".repeat(700_000));
    expect(log.droppedRecordCount()).toBe(1);
    await log.close();

    const path = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "bounded-run",
      occurredAt: "2026-06-22T01:02:03.000Z"
    }).processLogPath;
    await expect(readFile(path, "utf8")).resolves.toBe(accepted);
    expect(log.droppedRecordCount()).toBe(1);
    expect(diagnostics).toEqual([
      { code: "queue_capacity_exceeded", droppedRecordCount: 1 }
    ]);
  });

  it("prunes the oldest recognized closed file to preserve the mode cap", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const oldPath = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "old-run",
      occurredAt: "2026-06-20T00:00:00.000Z"
    }).processLogPath;
    const recentPath = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "recent-run",
      occurredAt: "2026-06-21T00:00:00.000Z"
    }).metricsJsonlPath;
    await createSparseFile(oldPath, 70 * 1024 * 1024);
    await createSparseFile(recentPath, 70 * 1024 * 1024);
    await utimes(oldPath, new Date("2026-06-20T00:00:00.000Z"), new Date("2026-06-20T00:00:00.000Z"));
    await utimes(
      recentPath,
      new Date("2026-06-21T00:00:00.000Z"),
      new Date("2026-06-21T00:00:00.000Z")
    );
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "active-run",
      now: () => "2026-06-22T00:00:00.000Z"
    });

    log.writeProcessLine("active\n");
    await log.close();

    await expect(stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(recentPath)).resolves.toMatchObject({ size: 70 * 1024 * 1024 });
  });

  it("retains active files and drops new records when no closed capacity is available", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const activePath = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "active-run",
      occurredAt: "2026-06-22T00:00:00.000Z"
    }).processLogPath;
    await createSparseFile(activePath, 128 * 1024 * 1024);
    const diagnostics: unknown[] = [];
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "active-run",
      now: () => "2026-06-22T00:00:00.000Z",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    log.writeProcessLine("must be dropped\n");
    await log.close();

    await expect(stat(activePath)).resolves.toMatchObject({ size: 128 * 1024 * 1024 });
    expect(log.droppedRecordCount()).toBe(1);
    expect(diagnostics).toEqual([
      { code: "mode_capacity_exceeded", droppedRecordCount: 1 }
    ]);
  });

  it("does not remove or count unknown managed files as owned diagnostics", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const paths = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "active-run",
      occurredAt: "2026-06-22T00:00:00.000Z"
    });
    const unknownPath = join(paths.modeDirectory, "operator-notes.bin");
    await createSparseFile(unknownPath, 130 * 1024 * 1024);
    const before = await stat(unknownPath);
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "active-run",
      now: () => "2026-06-22T00:00:00.000Z"
    });

    log.writeProcessLine("owned\n");
    await log.close();

    await expect(readFile(paths.processLogPath, "utf8")).resolves.toBe("owned\n");
    const after = await stat(unknownPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects a symlinked managed root", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "pico-outside-"));
    const residentRoot = join(homeDirectory, ".pico", "resident-voice");
    await mkdir(residentRoot, { recursive: true });
    await symlink(outsideDirectory, join(residentRoot, "managed"));

    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "symlink-root",
      now: () => "2026-06-22T00:00:00.000Z"
    });

    await expect(log.ready).rejects.toThrow("resident voice managed log path must not be symlinked");
  });

  it("does not follow a symlinked log target", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const outsidePath = join(await mkdtemp(join(tmpdir(), "pico-outside-")), "outside.log");
    await writeFile(outsidePath, "outside\n", { mode: 0o600 });
    const paths = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "normal",
      runId: "symlink-target",
      occurredAt: "2026-06-22T00:00:00.000Z"
    });
    await mkdir(paths.dayDirectory, { recursive: true });
    await symlink(outsidePath, paths.processLogPath);
    const diagnostics: unknown[] = [];
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "symlink-target",
      now: () => "2026-06-22T00:00:00.000Z",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    log.writeProcessLine("must not escape\n");
    await log.close();

    await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside\n");
    expect(log.droppedRecordCount()).toBe(1);
    expect(diagnostics).toEqual([{ code: "write_failed", droppedRecordCount: 1 }]);
  });

  it("leaves legacy logs untouched and reports their presence once", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pico-home-"));
    const legacyPath = join(
      homeDirectory,
      ".pico",
      "resident-voice",
      "normal",
      "metrics",
      "legacy.jsonl"
    );
    await mkdir(join(legacyPath, ".."), { recursive: true });
    await writeFile(legacyPath, "legacy bytes\n", { mode: 0o600 });
    const legacyTime = new Date("2026-06-01T00:00:00.000Z");
    await utimes(legacyPath, legacyTime, legacyTime);
    const before = await stat(legacyPath);
    const diagnostics: unknown[] = [];
    const log = createResidentVoiceFileLogSink({
      homeDirectory,
      runMode: "normal",
      runId: "managed-run",
      now: () => "2026-06-22T00:00:00.000Z",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    await log.close();

    await expect(readFile(legacyPath, "utf8")).resolves.toBe("legacy bytes\n");
    const after = await stat(legacyPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(diagnostics).toEqual([
      { code: "legacy_resident_logs_detected", droppedRecordCount: 0 }
    ]);
  });

  it("composes multiple log sinks without changing event payloads", () => {
    const events: unknown[] = [];
    const sink = createResidentVoiceCompositeLogSink([
      {
        record: (event) => {
          events.push(["first", event]);
        }
      },
      {
        record: (event) => {
          events.push(["second", event]);
        }
      }
    ]);
    const event = {
      kind: "staff_input" as const,
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1"
    };

    sink.record(event);

    expect(events).toEqual([
      ["first", event],
      ["second", event]
    ]);
  });

  it("continues composite log fan-out when one sink fails", () => {
    const events: unknown[] = [];
    const sink = createResidentVoiceCompositeLogSink([
      {
        record: () => {
          throw new Error("stdout unavailable");
        }
      },
      {
        record: (event) => {
          events.push(["second", event]);
        }
      }
    ]);
    const event = {
      kind: "staff_input" as const,
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1"
    };

    expect(() => {
      sink.record(event);
    }).not.toThrow();
    expect(events).toEqual([["second", event]]);
  });
});

async function createSparseFile(path: string, size: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const handle = await openFile(path, "w", 0o600);
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}
