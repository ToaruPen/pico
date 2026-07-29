import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createResidentLaunchdOperationPlan,
  defineResidentLaunchdService,
  formatResidentLaunchdStatus,
  type ResidentLaunchdOperation,
  type ResidentLaunchdOperationStep,
  requireResidentLaunchdPlatform
} from "../../src/runtime/resident-launchd.js";

export type ResidentLaunchdArguments = {
  readonly operation: ResidentLaunchdOperation;
};

export type ResidentLaunchdExecutionDependencies = {
  readonly runStatusCommand?: (
    command: "launchctl",
    arguments_: readonly string[],
    allowedExitCodes: readonly number[]
  ) => Promise<string>;
  readonly writeOutput?: (content: string) => void;
};

export function readResidentLaunchdArguments(
  arguments_: readonly string[]
): ResidentLaunchdArguments {
  if (arguments_.length !== 1) {
    throw new Error("resident launchd arguments are invalid");
  }

  return {
    operation: readOperation(arguments_[0])
  };
}

export async function executeResidentLaunchdOperation(
  steps: readonly ResidentLaunchdOperationStep[],
  dependencies: ResidentLaunchdExecutionDependencies = {}
): Promise<void> {
  for (const step of steps) {
    await executeResidentLaunchdOperationStep(step, dependencies);
  }
}

async function executeResidentLaunchdOperationStep(
  step: ResidentLaunchdOperationStep,
  dependencies: ResidentLaunchdExecutionDependencies
): Promise<void> {
  if (isFilesystemStep(step)) {
    await executeFilesystemStep(step);
    return;
  }

  if (step.kind === "output") {
    writeOutput(step.content, dependencies);
    return;
  }

  if (step.kind === "status") {
    await executeStatusStep(step, dependencies);
    return;
  }

  await runCommand(step.command, step.args, step.allowedExitCodes ?? [0]);
}

type ResidentLaunchdFilesystemStep = Extract<
  ResidentLaunchdOperationStep,
  { readonly kind: "mkdir" | "removeFile" | "writeFile" }
>;

function isFilesystemStep(
  step: ResidentLaunchdOperationStep
): step is ResidentLaunchdFilesystemStep {
  return step.kind === "mkdir" || step.kind === "removeFile" || step.kind === "writeFile";
}

async function executeFilesystemStep(step: ResidentLaunchdFilesystemStep): Promise<void> {
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

  await rm(step.path, { force: true });
}

async function executeStatusStep(
  step: Extract<ResidentLaunchdOperationStep, { readonly kind: "status" }>,
  dependencies: ResidentLaunchdExecutionDependencies
): Promise<void> {
  const execute = dependencies.runStatusCommand ?? runCapturedCommand;
  const rawStatus = await execute(step.command, step.args, step.allowedExitCodes ?? [0]);
  writeOutput(`${JSON.stringify(formatResidentLaunchdStatus(rawStatus))}\n`, dependencies);
}

function runCapturedCommand(
  command: "launchctl",
  arguments_: readonly string[],
  allowedExitCodes: readonly number[]
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;
    const maximumStatusBytes = 1024 * 1024;
    const commandTimeoutMs = 10_000;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      rejectCommand(new Error("launchctl status command timed out"));
    }, commandTimeoutMs);
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      rejectCommand(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      byteCount += chunk.byteLength;

      if (byteCount > maximumStatusBytes) {
        child.kill();
        rejectOnce(new Error("resident launchd status output exceeded limit"));
        return;
      }

      chunks.push(chunk);
    });
    child.once("error", rejectOnce);
    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      const exitCode = code ?? -1;

      if (!allowedExitCodes.includes(exitCode)) {
        rejectCommand(new Error(`${command} exited with code ${String(exitCode)}`));
        return;
      }

      resolveCommand(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function writeOutput(
  content: string,
  dependencies: Pick<ResidentLaunchdExecutionDependencies, "writeOutput">
): void {
  if (dependencies.writeOutput === undefined) {
    process.stdout.write(content);
    return;
  }

  dependencies.writeOutput(content);
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
    "usage: resident launchd -- install|start|restart|stop|status|uninstall|print-plist"
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

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  requireResidentLaunchdPlatform(process.platform);
  const arguments_ = readResidentLaunchdArguments(process.argv.slice(2));
  const homeDirectory = homedir();
  const service = defineResidentLaunchdService({
    repoRoot: process.cwd(),
    homeDirectory,
    configPath: resolve(process.env.PICO_CONFIG_PATH ?? "config/pico.local.yaml"),
    environmentFilePath: join(homeDirectory, ".pico", "stackchan-mcp", "local-gateway.env"),
    nodePath: process.execPath,
    pathEnvironment: readLaunchdPathEnvironment(process.env, homeDirectory)
  });

  await executeResidentLaunchdOperation(
    createResidentLaunchdOperationPlan(service, arguments_.operation, userInfo().uid)
  );
}
