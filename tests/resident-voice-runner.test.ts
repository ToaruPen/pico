import { readFile } from "node:fs/promises";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { waitForDirectResidentVoiceRuntime } from "../src/runtime/resident-voice-runner.js";

describe("resident voice runner ownership", () => {
  it("keeps the direct harness lock until a timed-out runtime actually settles", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
      },
      unregisterShutdownCleanup: () => {
        events.push("unregister");
      }
    });

    abortController.abort();

    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");
    expect(events).toEqual(["unregister"]);

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["unregister", "release"]);
  });

  it("releases the direct harness lock once when the runtime rejects", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.reject(new Error("runtime failed")),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("runtime failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("reports a direct harness lock release failure", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.resolve(),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
          throw new Error("release failed");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("release failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("does not leak a late lock release failure after shutdown timeout", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
        throw new Error("late release failed");
      },
      unregisterShutdownCleanup: () => undefined
    });

    abortController.abort();
    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["release"]);
  });

  it("opens the memory worker after startup setup and before runtime handoff", async () => {
    const source = await readFile(
      new URL("../src/runtime/resident-voice-runner.ts", import.meta.url),
      "utf8"
    );
    const callNames = [
      "warmResidentVoiceStartupProviders",
      "createConfiguredActivation",
      "createResidentMemoryWorker",
      "createConfiguredSpeechActivityGate",
      "runVoiceResidentRuntime"
    ] as const;
    const orderedPositions = findFunctionCallPositions(
      source,
      "runResidentVoiceWithProviders",
      callNames
    );

    expect(orderedPositions).toEqual([...orderedPositions].sort((left, right) => left - right));
  });
});

function findFunctionCallPositions(
  source: string,
  functionName: string,
  callNames: readonly string[]
): readonly number[] {
  const sourceFile = ts.createSourceFile(
    "resident-voice-runner.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let target: ts.FunctionDeclaration | undefined;

  sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      target = node;
    }
  });

  if (target?.body === undefined) {
    throw new Error(`${functionName} function body was not found`);
  }

  const positions = new Map<string, number[]>();
  const names = new Set(callNames);
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callName = node.expression.text;

      if (names.has(callName)) {
        positions.set(callName, [...(positions.get(callName) ?? []), node.getStart(sourceFile)]);
      }
    }

    node.forEachChild(visit);
  };

  target.body.forEachChild(visit);

  return callNames.map((callName) => {
    const matches = positions.get(callName) ?? [];
    const position = matches[0];

    if (matches.length !== 1 || position === undefined) {
      throw new Error(`${callName} call count: expected 1, received ${matches.length}`);
    }

    return position;
  });
}
