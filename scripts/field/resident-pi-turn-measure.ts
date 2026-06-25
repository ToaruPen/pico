#!/usr/bin/env jiti
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { createSessionLifecycle } from "../../src/modules/session/index.js";
import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";

export type ResidentPiTurnMeasureReport =
  | {
      readonly status: "passed";
      readonly thinkingLevel: "medium";
      readonly durationMs: number;
      readonly responseLength: number;
      readonly sessionId: string;
    }
  | {
      readonly status: "failed";
      readonly thinkingLevel: "medium";
      readonly durationMs: number;
      readonly reason: string;
      readonly sessionId?: string;
    };

const prompt =
  "Reply in Japanese with exactly one short sentence of 12 characters or fewer. Do not use tools.";

export async function runResidentPiTurnMeasure(): Promise<ResidentPiTurnMeasureReport> {
  const lifecycle = createSessionLifecycle({
    ending: {
      mode: "timed",
      durationMs: 60_000
    }
  });
  const started = lifecycle.start({
    kind: "wake_name",
    label: "ピコ",
    source: "voice"
  });
  const client = createPiAgentTurnClient({
    cwd: process.cwd(),
    sessionLifecycle: lifecycle
  });
  const startedAt = performance.now();

  try {
    const response = await client.prompt({
      sessionId: started.id,
      text: prompt
    });

    return {
      status: "passed",
      thinkingLevel: "medium",
      durationMs: Math.round(performance.now() - startedAt),
      responseLength: response.text.length,
      sessionId: started.id
    };
  } catch (error) {
    return {
      status: "failed",
      thinkingLevel: "medium",
      durationMs: Math.round(performance.now() - startedAt),
      reason: error instanceof Error ? error.message : String(error),
      sessionId: started.id
    };
  } finally {
    await client.disposeAll?.();
  }
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runResidentPiTurnMeasure();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
