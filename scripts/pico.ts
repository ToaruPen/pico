import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { createPicoCliPlan } from "../src/runtime/pico-cli.js";

const repoRoot = resolve(process.env.PICO_REPO_ROOT ?? process.cwd());

try {
  const plan = createPicoCliPlan(process.argv.slice(2));

  if (plan.kind === "help") {
    process.stdout.write(`${plan.text}\n`);
  } else {
    await runScript(plan.scriptPath, plan.args);
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function runScript(scriptPath: string, arguments_: readonly string[]): Promise<void> {
  const jitiCliPath = join(repoRoot, "node_modules", "jiti", "lib", "jiti-cli.mjs");
  const child = spawn(process.execPath, [jitiCliPath, join(repoRoot, scriptPath), ...arguments_], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PICO_REPO_ROOT: repoRoot
    },
    stdio: "inherit"
  });

  return new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }

      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`${scriptPath} exited with code ${String(code ?? -1)}`));
    });
  });
}
