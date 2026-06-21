import { join } from "node:path";

export type ResidentDevelopmentTerminalSessionOptions = {
  readonly repoRoot: string;
  readonly homeDirectory: string;
  readonly configPath: string;
  readonly pathEnvironment: string;
  readonly title?: string;
};

export type ResidentDevelopmentTerminalSession = {
  readonly picoDirectory: string;
  readonly launcherDirectory: string;
  readonly launcherPath: string;
  readonly launcherScript: string;
  readonly logDirectory: string;
  readonly logPath: string;
  readonly shellCommand: string;
  readonly appleScript: string;
};

const defaultTitle = "pico resident voice";
const relativeLogPath = "dev-terminal.log";

export function requireResidentDevelopmentTerminalPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("resident:voice:dev-terminal is supported only on macOS (darwin)");
  }
}

export function defineResidentDevelopmentTerminalSession(
  options: ResidentDevelopmentTerminalSessionOptions
): ResidentDevelopmentTerminalSession {
  const repoRoot = requireNonEmpty(options.repoRoot, "resident dev terminal repoRoot");
  const homeDirectory = requireNonEmpty(
    options.homeDirectory,
    "resident dev terminal homeDirectory"
  );
  const configPath = requireNonEmpty(options.configPath, "resident dev terminal configPath");
  const pathEnvironment = requireNonEmpty(
    options.pathEnvironment,
    "resident dev terminal pathEnvironment"
  );
  const title = requireNonEmpty(options.title ?? defaultTitle, "resident dev terminal title");
  const picoDirectory = join(homeDirectory, ".pico");
  const launcherDirectory = join(picoDirectory, "dev-terminal");
  const launcherPath = join(launcherDirectory, "resident-voice-launcher.sh");
  const logDirectory = join(picoDirectory, "resident-voice", "development", "processes");
  const logPath = join(logDirectory, relativeLogPath);
  const shellCommand = buildResidentDevelopmentTerminalShellCommand({
    repoRoot,
    picoDirectory,
    launcherDirectory,
    logDirectory,
    logPath,
    configPath,
    pathEnvironment,
    title
  });

  return {
    picoDirectory,
    launcherDirectory,
    launcherPath,
    launcherScript: buildLauncherScript(shellCommand),
    logDirectory,
    logPath,
    shellCommand,
    appleScript: buildTerminalAppleScript(buildTerminalLauncherCommand(launcherPath))
  };
}

function buildLauncherScript(shellCommand: string): string {
  return `#!/bin/zsh\n${shellCommand}\n`;
}

function buildTerminalLauncherCommand(launcherPath: string): string {
  return `exec /bin/zsh ${quoteShell(launcherPath)}`;
}

function buildResidentDevelopmentTerminalShellCommand(input: {
  readonly repoRoot: string;
  readonly picoDirectory: string;
  readonly launcherDirectory: string;
  readonly logDirectory: string;
  readonly logPath: string;
  readonly configPath: string;
  readonly pathEnvironment: string;
  readonly title: string;
}): string {
  return [
    `cd ${quoteShell(input.repoRoot)}`,
    "umask 077",
    "set -o pipefail",
    `mkdir -p ${quoteShell(input.launcherDirectory)}`,
    `mkdir -p ${quoteShell(input.logDirectory)}`,
    `chmod 700 ${quoteShell(input.picoDirectory)}`,
    `: > ${quoteShell(input.logPath)}`,
    `chmod 600 ${quoteShell(input.logPath)}`,
    `export PICO_CONFIG_PATH=${quoteShell(input.configPath)}`,
    "export PICO_VOICE_PROBE_STDOUT='summary'",
    "export PICO_RESIDENT_VOICE_LOG_MODE='development'",
    `export PATH=${quoteShell(input.pathEnvironment)}:"$PATH"`,
    "PICO_DEV_TERMINAL_TTY=$(tty)",
    `printf '\\033]0;%s\\007' ${quoteShell(input.title)}`,
    `printf '\\n[pico] resident voice dev terminal\\n[pico] log: %s\\n\\n' ${quoteShell(input.logPath)}`,
    buildResidentVoiceRunAndCloseCommand(input.logPath)
  ].join(" && ");
}

function buildResidentVoiceRunAndCloseCommand(logPath: string): string {
  return [
    `npm run resident:voice 2>&1 | tee -a ${quoteShell(logPath)}`,
    "status=$?",
    `printf '\\n[pico] resident voice exited with status %s\\n' "$status" | tee -a ${quoteShell(logPath)}`,
    "(sleep 0.2; osascript " +
      buildCloseTerminalTabAppleScriptArguments('"$PICO_DEV_TERMINAL_TTY"') +
      " >/dev/null 2>&1 &)",
    'exit "$status"'
  ].join("; ");
}

function buildCloseTerminalTabAppleScriptArguments(ttyVariableReference: string): string {
  const scriptLines = [
    "on run argv",
    "set targetTty to item 1 of argv",
    'tell application "Terminal"',
    "repeat with windowItem in windows",
    "repeat with tabItem in tabs of windowItem",
    "if tty of tabItem is targetTty then",
    "if (count of tabs of windowItem) is 1 then",
    "close windowItem saving no",
    "else",
    "close tabItem saving no",
    "end if",
    "return",
    "end if",
    "end repeat",
    "end repeat",
    "end tell",
    "end run"
  ];

  return `${scriptLines.map((line) => `-e ${quoteShell(line)}`).join(" ")} ${ttyVariableReference}`;
}

function buildTerminalAppleScript(shellCommand: string): string {
  return [
    'tell application "Terminal"',
    "  activate",
    `  do script "${escapeAppleScriptString(shellCommand)}"`,
    "end tell"
  ].join("\n");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }

  return value;
}
