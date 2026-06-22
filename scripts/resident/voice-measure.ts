import { readFile } from "node:fs/promises";

import {
  compareResidentVoiceRuns,
  requireSingleResidentVoiceRun,
  summarizeResidentVoiceMetricsJsonl
} from "../../src/runtime/resident-voice-measurements.js";

const [firstPath, secondPath] = process.argv.slice(2);

if (firstPath === undefined) {
  throw new Error("usage: npm run resident:voice:metrics -- <metrics.jsonl> [candidate.jsonl]");
}

const first = summarizeResidentVoiceMetricsJsonl(await readFile(firstPath, "utf8"));

if (secondPath === undefined) {
  process.stdout.write(`${JSON.stringify(first, undefined, 2)}\n`);
} else {
  const second = summarizeResidentVoiceMetricsJsonl(await readFile(secondPath, "utf8"));
  const baselineRun = requireSingleResidentVoiceRun(first, "baseline");
  const candidateRun = requireSingleResidentVoiceRun(second, "candidate");

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        baselineRunId: baselineRun.runId,
        candidateRunId: candidateRun.runId,
        baselineInvalidLineCount: first.invalidLineCount,
        candidateInvalidLineCount: second.invalidLineCount,
        comparisons: compareResidentVoiceRuns(baselineRun, candidateRun)
      },
      undefined,
      2
    )}\n`
  );
}
