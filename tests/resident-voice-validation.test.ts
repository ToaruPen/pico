import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPrivateResidentVoiceValidationSink } from "../src/runtime/resident-voice-validation.js";

describe("resident voice explicit validation artifact", () => {
  it("writes contentful transcript, response, and tool evidence to a private JSONL file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const path = join(directory, "validation.jsonl");
    const sink = createPrivateResidentVoiceValidationSink({ path });

    sink.record({
      kind: "staff_transcript",
      occurredAt: "2026-07-19T02:00:00.000Z",
      sessionId: "session-1",
      text: "スタックチャンの状態を教えて"
    });
    sink.record({
      kind: "pi_response",
      occurredAt: "2026-07-19T02:00:01.000Z",
      sessionId: "session-1",
      text: "準備できています"
    });
    sink.record({
      kind: "tool_execution_end",
      occurredAt: "2026-07-19T02:00:00.800Z",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "stackchan_get_status",
      result: { status: "ready" },
      isError: false,
      durationMs: 125
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line) as unknown);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ text: "スタックチャンの状態を教えて" });
    expect(records[2]).toMatchObject({
      toolName: "stackchan_get_status",
      result: { status: "ready" },
      isError: false,
      durationMs: 125
    });
  });

  it("bounds non-JSON tool payloads instead of failing the validation run", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const path = join(directory, "validation.jsonl");
    const sink = createPrivateResidentVoiceValidationSink({ path, maximumPayloadBytes: 64 });
    const circular: Record<string, unknown> = { value: 1n };
    circular.self = circular;

    expect(() =>
      sink.record({
        kind: "tool_execution_start",
        occurredAt: "2026-07-19T02:00:00.000Z",
        sessionId: "session-1",
        toolCallId: "call-1",
        toolName: "example",
        args: circular
      })
    ).not.toThrow();
    expect(readFileSync(path, "utf8")).toContain('"payloadEncoding":"bounded_inspection"');
  });

  it("refuses to append to an existing artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const path = join(directory, "validation.jsonl");
    writeFileSync(path, "prior-run\n", { mode: 0o600 });

    expect(() => createPrivateResidentVoiceValidationSink({ path })).toThrow(
      "validation output must not already exist"
    );
    expect(readFileSync(path, "utf8")).toBe("prior-run\n");
  });

  it("refuses a symbolic-link artifact path", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const target = join(directory, "target.jsonl");
    const path = join(directory, "validation.jsonl");
    writeFileSync(target, "do-not-touch\n", { mode: 0o600 });
    symlinkSync(target, path);

    expect(() => createPrivateResidentVoiceValidationSink({ path })).toThrow(
      "validation output must not already exist"
    );
    expect(readFileSync(target, "utf8")).toBe("do-not-touch\n");
  });

  it("rejects an artifact parent that is not private", () => {
    const outerDirectory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const directory = join(outerDirectory, "shared");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);

    expect(() =>
      createPrivateResidentVoiceValidationSink({ path: join(directory, "validation.jsonl") })
    ).toThrow("validation output directory must have 0700 permissions");
  });

  it("rejects a symbolic-link artifact parent", () => {
    const outerDirectory = mkdtempSync(join(tmpdir(), "pico-voice-validation-"));
    const target = join(outerDirectory, "target");
    const directory = join(outerDirectory, "linked");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory);

    expect(() =>
      createPrivateResidentVoiceValidationSink({ path: join(directory, "validation.jsonl") })
    ).toThrow("validation output directory must be a real directory");
  });
});
