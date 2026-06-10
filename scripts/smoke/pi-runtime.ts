#!/usr/bin/env jiti
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const expected = { loaded: true, identity: "pico" } as const;
const prompt =
  "Return compact JSON only, with keys loaded and identity. Set loaded true only if your active system instructions define a named agent identity. Set identity to the exact identity name from those active system instructions. Use null if no identity is defined. Do not infer identity from this user message.";
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const piBinary = join(repositoryRoot, "node_modules", ".bin", "pi");
const smokeTimeoutMs = 60_000;
const missingCredentialsPattern = /no\s+api\s+key|api\s+key\s+not\s+found/i;

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
      encoding: "utf8",
      timeout: smokeTimeoutMs
    }
  );

  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.error !== undefined) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      writeError(`pico Pi runtime smoke timed out after ${smokeTimeoutMs / 1000} seconds.`);
      process.exit(1);
    }

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

  if (missingCredentialsPattern.test(result.output)) {
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
    "loaded" in value &&
    "identity" in value &&
    value.loaded === expected.loaded &&
    value.identity === expected.identity
  );
}

requirePiBinary();

const result = runPiSmoke();
handleFailedSmoke(result);
validateSmokeOutput(parseSmokeOutput(result.output), result.output);
process.stdout.write(`${JSON.stringify(expected)}\n`);
