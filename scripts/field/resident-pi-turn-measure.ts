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
const turnDeadlineMs = 30_000;

export async function runResidentPiTurnMeasure(): Promise<ResidentPiTurnMeasureReport> {
  const lifecycle = createSessionLifecycle({
    ending: {
      mode: "timed",
      durationMs: 60_000
    }
  });
  const started = lifecycle.start({
    kind: "button_trigger",
    label: "hold_to_talk",
    source: "loopback_http"
  });
  const client = createPiAgentTurnClient({
    cwd: process.cwd()
  });
  const startedAt = performance.now();

  try {
    const response = await withDeadline(
      client.prompt({
        sessionId: started.id,
        text: prompt
      }),
      turnDeadlineMs
    );
    const violation = validateScriptedReply(response.text);

    if (violation !== undefined) {
      return {
        status: "failed",
        thinkingLevel: "medium",
        durationMs: Math.round(performance.now() - startedAt),
        reason: violation,
        sessionId: started.id
      };
    }

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
    closeStartedSessionQuietly(lifecycle, started.id);
    await client.disposeAll?.();
  }
}

function closeStartedSessionQuietly(
  lifecycle: ReturnType<typeof createSessionLifecycle>,
  sessionId: string
): void {
  try {
    const session = lifecycle.read(sessionId);

    if (session?.state === "active") {
      lifecycle.end(sessionId);
    }

    if (lifecycle.read(sessionId)?.state === "ended") {
      lifecycle.remove(sessionId);
    }
  } catch {
    return;
  }
}

async function withDeadline<T>(input: Promise<T>, deadlineMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      input,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("turn_timeout")), deadlineMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function validateScriptedReply(text: string): "reply_contract_violation" | undefined {
  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > 12) {
    return "reply_contract_violation";
  }

  const sentenceBoundaryCount = trimmed.match(/[.。！？!?]/gu)?.length ?? 0;

  return sentenceBoundaryCount > 1 ? "reply_contract_violation" : undefined;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runResidentPiTurnMeasure();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
