import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";

import {
  createResidentLaunchdOperationPlan,
  defineResidentLaunchdService,
  type ResidentLaunchdOperation,
  type ResidentLaunchdOperationStep,
  requireResidentLaunchdPlatform
} from "../../src/runtime/resident-launchd.js";

requireResidentLaunchdPlatform(process.platform);

const operation = readOperation(process.argv[2]);
const service = defineResidentLaunchdService({
  repoRoot: process.cwd(),
  homeDirectory: homedir(),
  configPath: resolve(process.env.PICO_CONFIG_PATH ?? "config/pico.local.yaml"),
  nodePath: process.execPath,
  pathEnvironment: readLaunchdPathEnvironment(process.env, homedir())
});

await executeResidentLaunchdOperation(
  createResidentLaunchdOperationPlan(service, operation, userInfo().uid)
);

async function executeResidentLaunchdOperation(
  steps: readonly ResidentLaunchdOperationStep[]
): Promise<void> {
  for (const step of steps) {
    await executeResidentLaunchdOperationStep(step);
  }
}

async function executeResidentLaunchdOperationStep(
  step: ResidentLaunchdOperationStep
): Promise<void> {
  if (step.kind === "mkdir") {
    await mkdir(step.path, { recursive: true, mode: step.mode });
    if (step.mode !== undefined) {
      await chmod(step.path, step.mode);
    }
    return;
  }

  if (step.kind === "writeFile") {
    await writeFile(step.path, step.content, { mode: 0o600 });
    return;
  }

  if (step.kind === "removeFile") {
    await rm(step.path, { force: true });
    return;
  }

  if (step.kind === "output") {
    process.stdout.write(step.content);
    return;
  }

  await runCommand(step.command, step.args, step.allowedExitCodes ?? [0]);
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  allowedExitCodes: readonly number[]
): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      stdio: "inherit"
    });

    child.once("error", rejectCommand);
    child.once("exit", (code) => {
      const exitCode = code ?? -1;

      if (allowedExitCodes.includes(exitCode)) {
        resolveCommand();
        return;
      }

      rejectCommand(new Error(`${command} exited with code ${String(exitCode)}`));
    });
  });
}

function readOperation(value: string | undefined): ResidentLaunchdOperation {
  if (isResidentLaunchdOperation(value)) {
    return value;
  }

  throw new Error(
    "usage: npm run resident:voice:launchd -- install|start|restart|stop|status|uninstall|print-plist"
  );
}

function isResidentLaunchdOperation(value: string | undefined): value is ResidentLaunchdOperation {
  return (
    value === "install" ||
    value === "start" ||
    value === "restart" ||
    value === "stop" ||
    value === "status" ||
    value === "uninstall" ||
    value === "print-plist"
  );
}

function readLaunchdPathEnvironment(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
  if (environment.PICO_LAUNCHD_PATH !== undefined && environment.PICO_LAUNCHD_PATH.trim() !== "") {
    return environment.PICO_LAUNCHD_PATH;
  }

  return [
    `${homeDirectory}/homebrew/bin`,
    `${homeDirectory}/homebrew/sbin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}
