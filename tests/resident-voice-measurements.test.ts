import { describe, expect, it } from "vitest";

import {
  compareResidentVoiceRuns,
  type ResidentVoiceRunMeasurement,
  requireSingleResidentVoiceRun,
  summarizeResidentVoiceMetricsJsonl
} from "../src/runtime/resident-voice-measurements.js";

describe("resident voice measurements", () => {
  it("summarizes audit-safe voice stage metrics without contentful text", () => {
    const summary = summarizeResidentVoiceMetricsJsonl(
      [
        JSON.stringify(stageEvent("run-a", "stt", "ok", 100)),
        JSON.stringify(stageEvent("run-a", "stt", "ok", 200)),
        JSON.stringify(stageEvent("run-a", "pi_turn", "error", 500, "pi_agent_prompt_failed")),
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-a",
          kind: "staff_transcript",
          text: "この本文は計測結果に出してはいけない"
        })
      ].join("\n")
    );

    expect(summary).toEqual({
      schemaVersion: 1,
      eventCount: 3,
      invalidLineCount: 0,
      skippedLineCount: 1,
      runs: [
        {
          runId: "run-a",
          stages: [
            {
              stage: "pi_turn",
              status: "error",
              count: 1,
              errorCount: 1,
              durationMs: {
                avg: 500,
                max: 500,
                min: 500,
                p50: 500,
                p95: 500
              },
              errorCodes: ["pi_agent_prompt_failed"]
            },
            {
              stage: "stt",
              status: "ok",
              count: 2,
              errorCount: 0,
              durationMs: {
                avg: 150,
                max: 200,
                min: 100,
                p50: 100,
                p95: 200
              },
              errorCodes: []
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(summary)).not.toContain("この本文");
  });

  it("reports malformed JSONL lines instead of silently dropping them", () => {
    const summary = summarizeResidentVoiceMetricsJsonl(
      `${JSON.stringify(stageEvent("run-a", "stt", "ok", 100))}\n{not-json}\n`
    );

    expect(summary.eventCount).toBe(1);
    expect(summary.invalidLineCount).toBe(1);
  });

  it("compares matching stages across two runs", () => {
    const baseline = summarizeResidentVoiceMetricsJsonl(
      [
        JSON.stringify(stageEvent("baseline", "stt", "ok", 100)),
        JSON.stringify(stageEvent("baseline", "stt", "ok", 300)),
        JSON.stringify(stageEvent("baseline", "tts_synthesize", "ok", 400))
      ].join("\n")
    );
    const candidate = summarizeResidentVoiceMetricsJsonl(
      [
        JSON.stringify(stageEvent("candidate", "stt", "ok", 80)),
        JSON.stringify(stageEvent("candidate", "stt", "ok", 120)),
        JSON.stringify(stageEvent("candidate", "tts_synthesize", "ok", 500))
      ].join("\n")
    );
    const baselineRun = requireRun(baseline.runs[0]);
    const candidateRun = requireRun(candidate.runs[0]);

    expect(compareResidentVoiceRuns(baselineRun, candidateRun)).toEqual([
      {
        stage: "stt",
        status: "ok",
        baselineCount: 2,
        candidateCount: 2,
        avgDeltaMs: -100,
        p95DeltaMs: -180
      },
      {
        stage: "tts_synthesize",
        status: "ok",
        baselineCount: 1,
        candidateCount: 1,
        avgDeltaMs: 100,
        p95DeltaMs: 100
      }
    ]);
  });

  it("requires exactly one run for pairwise comparisons", () => {
    const summary = summarizeResidentVoiceMetricsJsonl(
      [
        JSON.stringify(stageEvent("run-a", "stt", "ok", 100)),
        JSON.stringify(stageEvent("run-b", "stt", "ok", 200))
      ].join("\n")
    );

    expect(() => requireSingleResidentVoiceRun(summary, "baseline")).toThrow(
      "resident voice metrics comparison requires exactly one run in baseline input"
    );
  });
});

function stageEvent(
  runId: string,
  stage: string,
  status: string,
  durationMs: number,
  errorCode?: string
) {
  return {
    schemaVersion: 1,
    runMode: "development",
    runId,
    category: "transport_event",
    name: "voice.runtime.stage",
    severity: status === "error" ? "warn" : "info",
    occurredAt: "2026-06-22T01:02:04.000Z",
    summary: "Pico voice runtime stage completed.",
    attributes: {
      "pico.voice.stage": stage,
      "pico.voice.stage_status": status,
      "pico.voice.stage_duration_ms": durationMs,
      ...(errorCode === undefined ? {} : { "pico.voice.error_code": errorCode })
    }
  };
}

function requireRun(run: ResidentVoiceRunMeasurement | undefined): ResidentVoiceRunMeasurement {
  if (run === undefined) {
    throw new Error("expected resident voice measurement run");
  }

  return run;
}
