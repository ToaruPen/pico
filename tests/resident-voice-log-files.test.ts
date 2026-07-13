import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createResidentVoiceCompositeConsoleSink,
  createResidentVoiceFileLogSink,
  resolveResidentVoiceLogPaths
} from "../src/runtime/resident-voice-log-files.js";
import type { VoiceResidentConsoleEvent } from "../src/runtime/voice-resident.js";

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
    } as VoiceResidentConsoleEvent);

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
        "pico.voice.suppressed_frame_count": 4
      }
    });

    const paths = resolveResidentVoiceLogPaths({
      homeDirectory,
      runMode: "development",
      runId: "run-1",
      occurredAt: "2026-06-22T01:02:03.000Z"
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
          "pico.voice.suppressed_frame_count": 4
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
    ).toContain("/.pico/resident-voice/development/processes/2026-06-22");
    expect(
      resolveResidentVoiceLogPaths({
        homeDirectory,
        runMode: "normal",
        runId: "run-2",
        occurredAt: "2026-06-22T01:02:04.000Z"
      }).dayDirectory
    ).toContain("/.pico/resident-voice/normal/processes/2026-06-22");
  });

  it("composes multiple console sinks without changing event payloads", () => {
    const events: unknown[] = [];
    const sink = createResidentVoiceCompositeConsoleSink([
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

  it("continues composite console fan-out when one sink fails", () => {
    const events: unknown[] = [];
    const sink = createResidentVoiceCompositeConsoleSink([
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
