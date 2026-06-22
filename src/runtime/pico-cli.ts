import { parseArgs } from "node:util";

export type PicoCliPlan =
  | {
      readonly kind: "help";
      readonly text: string;
    }
  | {
      readonly kind: "script";
      readonly scriptPath: string;
      readonly args: readonly string[];
    };

type DevelopmentTerminal = "kitty" | "terminal";

const launchdCommands = new Set([
  "install",
  "start",
  "restart",
  "stop",
  "status",
  "uninstall",
  "print-plist"
]);
const helpCommands = new Set(["help", "--help", "-h"]);

export function createPicoCliPlan(arguments_: readonly string[]): PicoCliPlan {
  const [command, ...rest] = arguments_;

  if (command === undefined || helpCommands.has(command)) {
    return {
      kind: "help",
      text: formatPicoCliHelp()
    };
  }

  if (command === "run") {
    throw new Error("pico run is ambiguous; use pico foreground or pico start");
  }

  return createCommandPlan(command, rest);
}

export function formatPicoCliHelp(): string {
  return [
    "Usage:",
    "  pico help",
    "  pico dev [--terminal=kitty|terminal]",
    "  pico foreground",
    "  pico install",
    "  pico start",
    "  pico restart",
    "  pico stop",
    "  pico status",
    "  pico uninstall",
    "  pico print-plist",
    "",
    "Commands:",
    "  help        Show this help.",
    "  dev         Open a visible development voice session with live logs. Defaults to kitty.",
    "  foreground  Start resident voice in the current terminal and stop when that process exits.",
    "  install     Register the macOS LaunchAgent for resident voice and load it.",
    "  start       Start the installed LaunchAgent in the background.",
    "  restart     Restart the installed LaunchAgent in the background.",
    "  stop        Stop the background LaunchAgent while keeping it installed.",
    "  status      Print the LaunchAgent status from launchctl.",
    "  uninstall   Stop and remove the LaunchAgent plist.",
    "  print-plist Print the LaunchAgent plist without installing it.",
    "",
    "Notes:",
    "  Use foreground when you want to watch the process directly in this shell.",
    "  Use start when Pico should keep listening as a background resident service."
  ].join("\n");
}

function createCommandPlan(command: string, rest: readonly string[]): PicoCliPlan {
  if (command === "dev") {
    return createDevelopmentTerminalPlan(rest);
  }

  if (command === "foreground") {
    return createForegroundPlan(command, rest);
  }

  if (launchdCommands.has(command)) {
    return createLaunchdPlan(command, rest);
  }

  throw new Error(`unknown pico command: ${command}\n\n${formatPicoCliHelp()}`);
}

function createForegroundPlan(command: string, rest: readonly string[]): PicoCliPlan {
  rejectUnexpectedArguments(command, rest);

  return {
    kind: "script",
    scriptPath: "scripts/resident/voice.ts",
    args: []
  };
}

function createLaunchdPlan(command: string, rest: readonly string[]): PicoCliPlan {
  rejectUnexpectedArguments(command, rest);

  return {
    kind: "script",
    scriptPath: "scripts/resident/launchd.ts",
    args: [command]
  };
}

function createDevelopmentTerminalPlan(arguments_: readonly string[]): PicoCliPlan {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,
    options: {
      terminal: {
        type: "string",
        default: "kitty"
      }
    }
  });
  const terminal = requireDevelopmentTerminal(parsed.values.terminal);

  return {
    kind: "script",
    scriptPath: "scripts/resident/development-terminal.ts",
    args: [`--terminal=${terminal}`]
  };
}

function requireDevelopmentTerminal(value: string | boolean | undefined): DevelopmentTerminal {
  if (value === "kitty" || value === "terminal") {
    return value;
  }

  throw new Error("pico dev --terminal must be kitty or terminal");
}

function rejectUnexpectedArguments(command: string, arguments_: readonly string[]): void {
  if (arguments_.length > 0) {
    throw new Error(`pico ${command} does not accept arguments: ${arguments_.join(" ")}`);
  }
}
