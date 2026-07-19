import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPicoCliPlan, formatPicoCliHelp } from "../src/runtime/pico-cli.js";

describe("pico cli", () => {
  it("identifies the failing target script in delegated command errors", () => {
    const repoRoot = process.cwd();
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "node_modules/jiti/lib/jiti-cli.mjs"), "scripts/pico.ts", "roster"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(repoRoot, "scripts/roster.ts"));
  });

  it("starts the Pi host without persisting its infrastructure session", () => {
    expect(createPicoCliPlan([])).toEqual({
      kind: "pi",
      args: ["--no-session", "--extension", "./src/index.ts", "--pico"]
    });
  });

  it("prints help for explicit help invocations", () => {
    expect(createPicoCliPlan(["help"])).toEqual({
      kind: "help",
      text: formatPicoCliHelp()
    });
    expect(createPicoCliPlan(["--help"])).toEqual({
      kind: "help",
      text: formatPicoCliHelp()
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

  it("routes roster management to the local roster script", () => {
    expect(createPicoCliPlan(["roster", "status", "--database", "/tmp/registry.sqlite"])).toEqual({
      kind: "script",
      scriptPath: "scripts/roster.ts",
      args: ["status", "--database", "/tmp/registry.sqlite"]
    });
  });

  it("does not expose resident launchd lifecycle as pico commands", () => {
    for (const command of [
      "install",
      "start",
      "restart",
      "stop",
      "status",
      "uninstall",
      "print-plist"
    ]) {
      expect(() => createPicoCliPlan([command])).toThrow(`unknown pico command: ${command}`);
    }
  });

  it("rejects foreground because Pi Agent owns production startup", () => {
    expect(() => createPicoCliPlan(["foreground"])).toThrow("unknown pico command: foreground");
  });

  it("rejects the ambiguous run command and points to the Pi Agent startup boundary", () => {
    expect(() => createPicoCliPlan(["run"])).toThrow(
      "pico run is ambiguous; start Pi Agent with the pico extension instead"
    );
  });

  it("rejects unknown commands with help guidance", () => {
    expect(() => createPicoCliPlan(["unknown"])).toThrow("unknown pico command: unknown");
  });

  it("describes pico as a development helper", () => {
    const help = formatPicoCliHelp();

    expect(help).toContain("pico dev");
    expect(help).toContain("pico roster");
    expect(help).toContain("Pi Agent");
    expect(help).toContain("non-persistent host session");

    for (const command of [
      "foreground",
      "install",
      "start",
      "restart",
      "stop",
      "status",
      "uninstall",
      "print-plist",
      "run"
    ]) {
      expect(help).not.toContain(`pico ${command}`);
    }
  });
});
