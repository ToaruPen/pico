import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  executeResidentLaunchdOperation,
  readResidentLaunchdArguments
} from "../scripts/resident/launchd.js";

const capturedCommandClosePattern =
  /function runCapturedCommand[\s\S]*?child\.once\("close", \(code\) =>/u;

describe("resident launchd script", () => {
  it("waits for captured stdout to close before resolving status output", async () => {
    const source = await readFile(join(process.cwd(), "scripts/resident/launchd.ts"), "utf8");

    expect(source).toMatch(capturedCommandClosePattern);
  });

  it("reads the selected service independently of argument order", () => {
    expect(readResidentLaunchdArguments(["status", "--service=memory"])).toEqual({
      operation: "status",
      serviceKind: "memory"
    });
    expect(readResidentLaunchdArguments(["--service=voice", "restart"])).toEqual({
      operation: "restart",
      serviceKind: "voice"
    });
    expect(readResidentLaunchdArguments(["status"])).toEqual({
      operation: "status",
      serviceKind: "voice"
    });
  });

  it("rejects unknown service selectors", () => {
    expect(() => readResidentLaunchdArguments(["status", "--service=other"])).toThrow(
      "resident launchd service"
    );
  });

  it("captures and sanitizes launchctl status before writing output", async () => {
    const output: string[] = [];

    await executeResidentLaunchdOperation(
      [
        {
          kind: "status",
          command: "launchctl",
          args: ["print", "gui/501/dev.toarupen.pico.resident-memory"],
          allowedExitCodes: [0],
          serviceKind: "memory",
          configPath: "/repo/pico/config/pico.local.yaml"
        }
      ],
      {
        runStatusCommand: () =>
          Promise.resolve(
            "state = running\npid = 31880\nenvironment = { STACKCHAN_TOKEN => exposed-secret }"
          ),
        readMemoryQueueStatus: () => ({
          queueDepth: 3,
          oldestQueuedAgeMs: 60_000,
          deadLetterCount: 2
        }),
        writeOutput: (content) => output.push(content)
      }
    );

    expect(output).toEqual([
      `${JSON.stringify({
        state: "running",
        pid: 31880,
        queueDepth: 3,
        oldestQueuedAgeMs: 60_000,
        deadLetterCount: 2
      })}\n`
    ]);
    expect(output.join("\n")).not.toContain("STACKCHAN_TOKEN");
    expect(output.join("\n")).not.toContain("exposed-secret");
  });
});
