import { describe, expect, it } from "vitest";

import { createPicoCliPlan, formatPicoCliHelp } from "../src/runtime/pico-cli.js";

describe("pico cli", () => {
  it("prints help for pico help and empty invocations", () => {
    expect(createPicoCliPlan([])).toEqual({
      kind: "help",
      text: formatPicoCliHelp()
    });
    expect(createPicoCliPlan(["help"])).toEqual({
      kind: "help",
      text: formatPicoCliHelp()
    });
    expect(createPicoCliPlan(["--help"])).toEqual({
      kind: "help",
      text: formatPicoCliHelp()
    });
  });

  it("routes foreground to the current-terminal resident voice process", () => {
    expect(createPicoCliPlan(["foreground"])).toEqual({
      kind: "script",
      scriptPath: "scripts/resident/voice.ts",
      args: []
    });
  });

  it("routes dev to a kitty-backed development terminal", () => {
    expect(createPicoCliPlan(["dev"])).toEqual({
      kind: "script",
      scriptPath: "scripts/resident/development-terminal.ts",
      args: ["--terminal=kitty"]
    });
  });

  it("allows Terminal.app development sessions explicitly", () => {
    expect(createPicoCliPlan(["dev", "--terminal=terminal"])).toEqual({
      kind: "script",
      scriptPath: "scripts/resident/development-terminal.ts",
      args: ["--terminal=terminal"]
    });
  });

  it("routes launchd lifecycle commands to the resident launchd script", () => {
    for (const command of [
      "install",
      "start",
      "restart",
      "stop",
      "status",
      "uninstall",
      "print-plist"
    ]) {
      expect(createPicoCliPlan([command])).toEqual({
        kind: "script",
        scriptPath: "scripts/resident/launchd.ts",
        args: [command]
      });
    }
  });

  it("rejects the ambiguous run command and points to precise alternatives", () => {
    expect(() => createPicoCliPlan(["run"])).toThrow(
      "pico run is ambiguous; use pico foreground or pico start"
    );
  });

  it("rejects unknown commands with help guidance", () => {
    expect(() => createPicoCliPlan(["unknown"])).toThrow("unknown pico command: unknown");
  });

  it("describes foreground and start without using run as a public command", () => {
    const help = formatPicoCliHelp();

    expect(help).toContain("pico foreground");
    expect(help).toContain("pico start");
    expect(help).not.toContain("pico run");
  });
});
