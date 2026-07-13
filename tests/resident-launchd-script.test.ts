import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  executeResidentLaunchdOperation,
  readResidentLaunchdArguments
} from "../scripts/resident/launchd.js";

describe("resident launchd script", () => {
  it("waits for captured stdout to close before resolving status output", async () => {
    await withLaunchctlExecutable(
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const writer = spawn(
  process.execPath,
  ["-e", "setTimeout(() => process.stdout.write('pid = 31880\\\\n'), 50)"],
  { stdio: ["ignore", "inherit", "ignore"] }
);
writer.unref();
process.stdout.write("state = running\\n");
`,
      async () => {
        const output: string[] = [];

        await executeResidentLaunchdOperation(
          [
            {
              kind: "status",
              command: "launchctl",
              args: ["print", "gui/501/dev.toarupen.pico.resident-voice"],
              allowedExitCodes: [0],
              serviceKind: "voice"
            }
          ],
          { writeOutput: (content) => output.push(content) }
        );

        expect(output).toEqual([`${JSON.stringify({ state: "running", pid: 31880 })}\n`]);
      }
    );
  });

  it("kills and rejects a captured status command that does not close", async () => {
    vi.useFakeTimers();

    try {
      await withLaunchctlExecutable(
        `#!/usr/bin/env node
setInterval(() => undefined, 1_000);
`,
        async () => {
          const operation = executeResidentLaunchdOperation([
            {
              kind: "status",
              command: "launchctl",
              args: ["print", "gui/501/dev.toarupen.pico.resident-voice"],
              allowedExitCodes: [0],
              serviceKind: "voice"
            }
          ]);
          const rejection = expect(operation).rejects.toThrow("launchctl status command timed out");

          await vi.advanceTimersByTimeAsync(10_000);
          await rejection;
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only the resident voice service selector", () => {
    expect(readResidentLaunchdArguments(["--service=voice", "restart"])).toEqual({
      operation: "restart",
      serviceKind: "voice"
    });
    expect(readResidentLaunchdArguments(["status"])).toEqual({
      operation: "status",
      serviceKind: "voice"
    });
    expect(() => readResidentLaunchdArguments(["status", "--service=memory"])).toThrow(
      "resident launchd service must be voice"
    );
  });

  it("captures and sanitizes launchctl status before writing output", async () => {
    const output: string[] = [];

    await executeResidentLaunchdOperation(
      [
        {
          kind: "status",
          command: "launchctl",
          args: ["print", "gui/501/dev.toarupen.pico.resident-voice"],
          allowedExitCodes: [0],
          serviceKind: "voice"
        }
      ],
      {
        runStatusCommand: () =>
          Promise.resolve(
            "state = running\npid = 31880\nenvironment = { STACKCHAN_TOKEN => exposed-secret }"
          ),
        writeOutput: (content) => output.push(content)
      }
    );

    expect(output).toEqual([
      `${JSON.stringify({
        state: "running",
        pid: 31880
      })}\n`
    ]);
    expect(output.join("\n")).not.toContain("STACKCHAN_TOKEN");
    expect(output.join("\n")).not.toContain("exposed-secret");
  });
});

async function withLaunchctlExecutable(source: string, run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-launchctl-test-"));
  const executablePath = join(directory, "launchctl");
  const originalPath = process.env.PATH;

  try {
    await writeFile(executablePath, source, { mode: 0o700 });
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
}
