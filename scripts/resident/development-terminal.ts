import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  defineResidentDevelopmentTerminalSession,
  type ResidentDevelopmentTerminal,
  requireResidentDevelopmentTerminalPlatform
} from "../../src/runtime/resident-development-terminal.js";

requireResidentDevelopmentTerminalPlatform(process.platform);

const session = defineResidentDevelopmentTerminalSession({
  repoRoot: process.cwd(),
  homeDirectory: homedir(),
  configPath: resolve(process.env.PICO_CONFIG_PATH ?? "config/pico.local.yaml"),
  pathEnvironment: readDevelopmentTerminalPathEnvironment(process.env, homedir()),
  terminal: readDevelopmentTerminal(process.argv.slice(2), process.env)
});

await writeLauncherScript(session);

if (session.terminal === "ghostty") {
  await runTerminalApplication(requireGhosttyCommand(session.ghosttyCommand));
} else if (session.terminal === "kitty") {
  await runTerminalApplication(requireKittyCommand(session.kittyCommand));
} else {
  await runAppleScript(requireAppleScript(session.appleScript));
}

function runTerminalApplication(command: {
  readonly command: "kitty" | "open";
  readonly args: readonly string[];
}): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.command, command.args, {
      stdio: "inherit"
    });

    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`${command.command} exited with code ${String(code ?? -1)}`));
    });
  });
}

async function writeLauncherScript(session: {
  readonly picoDirectory: string;
  readonly launcherDirectory: string;
  readonly launcherPath: string;
  readonly launcherScript: string;
}): Promise<void> {
  await mkdir(session.launcherDirectory, { recursive: true, mode: 0o700 });
  await chmod(session.picoDirectory, 0o700);
  await chmod(session.launcherDirectory, 0o700);
  await writeFile(session.launcherPath, session.launcherScript, { encoding: "utf8" });
  await chmod(session.launcherPath, 0o700);
}

function runAppleScript(script: string): Promise<void> {
  const arguments_ = script.split("\n").flatMap((line) => ["-e", line]);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("osascript", arguments_, {
      stdio: "inherit"
    });

    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`osascript exited with code ${String(code ?? -1)}`));
    });
  });
}

function requireKittyCommand(
  command: { readonly command: "kitty"; readonly args: readonly string[] } | undefined
): { readonly command: "kitty"; readonly args: readonly string[] } {
  if (command === undefined) {
    throw new Error("pico dev terminal session is missing kitty command");
  }

  return command;
}

function requireGhosttyCommand(
  command: { readonly command: "open"; readonly args: readonly string[] } | undefined
): { readonly command: "open"; readonly args: readonly string[] } {
  if (command === undefined) {
    throw new Error("pico dev terminal session is missing Ghostty command");
  }

  return command;
}

function requireAppleScript(script: string | undefined): string {
  if (script === undefined) {
    throw new Error("pico dev terminal session is missing Terminal.app AppleScript");
  }

  return script;
}

function readDevelopmentTerminal(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv
): ResidentDevelopmentTerminal {
  const option = arguments_.find((argument) => argument.startsWith("--terminal="));
  const value = option?.slice("--terminal=".length) ?? environment.PICO_DEV_TERMINAL ?? "ghostty";

  if (value === "ghostty" || value === "kitty" || value === "terminal") {
    return value;
  }

  throw new Error("PICO_DEV_TERMINAL and --terminal must be ghostty, kitty, or terminal");
}

function readDevelopmentTerminalPathEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): string {
  if (
    environment.PICO_DEV_TERMINAL_PATH !== undefined &&
    environment.PICO_DEV_TERMINAL_PATH.trim() !== ""
  ) {
    return environment.PICO_DEV_TERMINAL_PATH;
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
