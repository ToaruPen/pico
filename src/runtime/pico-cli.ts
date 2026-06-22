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
    throw new Error("pico run is ambiguous; start Pi Agent with the pico extension instead");
  }

  if (command === "dev") {
    return createDevelopmentTerminalPlan(rest);
  }

  throw new Error(`unknown pico command: ${command}\n\n${formatPicoCliHelp()}`);
}

export function formatPicoCliHelp(): string {
  return [
    "Usage:",
    "  pico help",
    "  pico dev [--terminal=kitty|terminal]",
    "",
    "Commands:",
    "  help        Show this help.",
    "  dev         Open a visible resident voice development terminal with live logs.",
    "",
    "Notes:",
    "  Pi Agent owns production startup and loads pico as an extension.",
    "  The pico CLI is only a development helper."
  ].join("\n");
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
