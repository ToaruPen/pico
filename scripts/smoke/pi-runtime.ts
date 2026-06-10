#!/usr/bin/env jiti
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const expected = { pico_loaded: true, identity: "pico" } as const;
const prompt =
  'You are being used for a pico runtime smoke test. If your active system prompt says you are pico, reply with exactly: {"pico_loaded":true,"identity":"pico"}';
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const piBinary = join(repositoryRoot, "node_modules", ".bin", "pi");

type SmokeResult = {
  readonly status: number;
  readonly output: string;
};

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function requirePiBinary(): void {
  if (!existsSync(piBinary)) {
    writeError("pico Pi runtime smoke requires node_modules/.bin/pi. Run npm install first.");
    process.exit(2);
  }
}

function runPiSmoke(): SmokeResult {
  const result = spawnSync(
    piBinary,
    [
      ...process.argv.slice(2),
      "--no-approve",
      "--no-session",
      "--no-tools",
      "--extension",
      "./src/index.ts",
      "-p",
      prompt
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );

  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.error !== undefined) {
    writeError(`pico Pi runtime smoke failed to start pi: ${result.error.message}`);
    process.exit(1);
  }

  return {
    status: result.status ?? 1,
    output
  };
}

function handleFailedSmoke(result: SmokeResult): void {
  if (result.status === 0) {
    return;
  }

  if (result.output.includes("No API key found")) {
    writeError(
      "pico Pi runtime smoke requires configured Pi Agent model credentials. Authenticate Pi Agent or pass provider/model args after `--`."
    );
    process.exit(2);
  }

  writeError(result.output);
  process.exit(result.status);
}

function parseSmokeOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    writeError("pico Pi runtime smoke expected a JSON response from Pi Agent.");
    writeError(output);
    process.exit(1);
  }
}

function validateSmokeOutput(value: unknown, output: string): void {
  if (!isExpectedSmokeOutput(value)) {
    writeError("pico Pi runtime smoke did not observe the expected pico identity response.");
    writeError(output);
    process.exit(1);
  }
}

function isExpectedSmokeOutput(value: unknown): value is typeof expected {
  return (
    typeof value === "object" &&
    value !== null &&
    "pico_loaded" in value &&
    "identity" in value &&
    value.pico_loaded === expected.pico_loaded &&
    value.identity === expected.identity
  );
}

requirePiBinary();

const result = runPiSmoke();
handleFailedSmoke(result);
validateSmokeOutput(parseSmokeOutput(result.output), result.output);
process.stdout.write(`${JSON.stringify(expected)}\n`);
