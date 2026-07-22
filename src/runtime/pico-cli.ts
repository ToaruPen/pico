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
    }
  | {
      readonly kind: "pi";
      readonly args: readonly string[];
    };

type DevelopmentTerminal = "ghostty" | "kitty" | "terminal";

const helpCommands = new Set(["help", "--help", "-h"]);

export function createPicoCliPlan(arguments_: readonly string[]): PicoCliPlan {
  const [command, ...rest] = arguments_;

  if (command === undefined) {
    return {
      kind: "pi",
      args: ["--no-session", "--extension", "./src/index.ts", "--pico"]
    };
  }

  if (helpCommands.has(command)) {
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

  if (command === "roster") {
    return {
      kind: "script",
      scriptPath: "scripts/roster.ts",
      args: rest
    };
  }

  throw new Error(`unknown pico command: ${command}\n\n${formatPicoCliHelp()}`);
}

export function formatPicoCliHelp(): string {
  return [
    "Usage:",
    "  pico",
    "  pico help",
    "  pico dev [--terminal=ghostty|kitty|terminal]",
    "  pico roster <command> [options]",
    "",
    "Commands:",
    "  (none)      Start Pi Agent as Pico.",
    "  help        Show this help.",
    "  dev         Open a visible resident voice development terminal with live logs.",
    "  roster      Manage the local child identity roster.",
    "",
    "Notes:",
    "  pico dev opens Terminal.app by default; use --terminal to select another terminal.",
    "  pico delegates production startup to Pi Agent with --pico and a non-persistent host session.",
    "  Pico model selection is loaded from YAML, not CLI model arguments."
  ].join("\n");
}

function createDevelopmentTerminalPlan(arguments_: readonly string[]): PicoCliPlan {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,
    options: {
      terminal: {
        type: "string",
        default: "terminal"
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
  if (value === "ghostty" || value === "kitty" || value === "terminal") {
    return value;
  }

  throw new Error("pico dev --terminal must be ghostty, kitty, or terminal");
}
