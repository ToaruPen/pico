import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createResidentVoiceCompositeConsoleSink,
  createResidentVoiceFileLogSink,
  resolveResidentVoiceLogPaths
} from "../src/runtime/resident-voice-log-files.js";

describe("resident voice file logs", () => {
  it("writes process and session logs under the user pico directory by mode, date, and session id", async () => {
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
    });

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
    await expect(readFile(paths.sessionTextLogPath ?? "", "utf8")).resolves.toBe(
      "[pico voice] 2026-06-22T01:02:04.000Z pi_agent session=session-1 duration_ms=1234\n  text:\n    はい。\n    聞いています。\n"
    );
    await expect(readFile(paths.sessionJsonlPath ?? "", "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        runMode: "development",
        runId: "run-1",
        kind: "pi_agent_response",
        occurredAt: "2026-06-22T01:02:04.000Z",
        sessionId: "session-1",
        durationMs: 1234,
        text: "はい。\n聞いています。"
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
        durationMs: 1234,
        text: "はい。\n聞いています。"
      })}\n`
    );
    expect((await stat(join(homeDirectory, ".pico"))).mode & 0o777).toBe(0o700);
    expect((await stat(paths.sessionJsonlPath ?? "")).mode & 0o777).toBe(0o600);
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
      kind: "staff_transcript" as const,
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1",
      text: "こんにちは"
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
      kind: "staff_transcript" as const,
      occurredAt: "2026-06-22T01:02:04.000Z",
      sessionId: "session-1",
      text: "こんにちは"
    };

    expect(() => {
      sink.record(event);
    }).not.toThrow();
    expect(events).toEqual([["second", event]]);
  });
});
