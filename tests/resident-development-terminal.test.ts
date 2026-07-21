import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defineResidentDevelopmentTerminalSession,
  requireResidentDevelopmentTerminalPlatform
} from "../src/runtime/resident-development-terminal.js";

describe("resident dev terminal", () => {
  it("fails fast outside macOS before Terminal.app operations are planned", () => {
    expect(() => {
      requireResidentDevelopmentTerminalPlatform("linux");
    }).toThrow("resident:voice:dev-terminal is supported only on macOS (darwin)");
    expect(() => {
      requireResidentDevelopmentTerminalPlatform("darwin");
    }).not.toThrow();
  });

  it("builds a Terminal.app session that leaves Pi conversation output in the terminal", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: "/Users/monsoon/Dev/pico project",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      terminal: "terminal",
      now: () => "2026-06-22T01:02:03.000Z",
      processId: 1234
    });

    expect(session.runId).toBe("2026-06-22T01-02-03-000Z-1234");
    expect(session.logDirectory).toBe(
      "/Users/monsoon/.pico/resident-voice/managed/development/processes/2026-06-22"
    );
    expect(session.logPath).toBe(
      "/Users/monsoon/.pico/resident-voice/managed/development/processes/2026-06-22/2026-06-22T01-02-03-000Z-1234.log"
    );
    expect(session.launcherDirectory).toBe("/Users/monsoon/.pico/dev-terminal");
    expect(session.picoDirectory).toBe("/Users/monsoon/.pico");
    expect(session.launcherPath).toBe(
      "/Users/monsoon/.pico/dev-terminal/resident-voice-launcher.sh"
    );
    expect(session.launcherScript).toContain("#!/bin/zsh\n");
    expect(session.shellCommand).toContain("cd '/Users/monsoon/Dev/pico project'");
    expect(session.shellCommand).toContain("mkdir -p '/Users/monsoon/.pico/dev-terminal'");
    expect(session.shellCommand).toContain(
      "mkdir -p '/Users/monsoon/.pico/resident-voice/managed/development/processes/2026-06-22'"
    );
    expect(session.shellCommand).toContain("chmod 700 '/Users/monsoon/.pico'");
    expect(session.shellCommand).toContain(
      "export PICO_RESIDENT_VOICE_RUN_ID='2026-06-22T01-02-03-000Z-1234'"
    );
    expect(session.shellCommand).toContain(
      "export PICO_CONFIG_PATH='/Users/monsoon/Dev/pico/config/pico.local.yaml'"
    );
    expect(session.shellCommand).toContain("export PICO_VOICE_PROBE_STDOUT='summary'");
    expect(session.shellCommand).toContain("export PICO_RESIDENT_VOICE_LOG_MODE='development'");
    expect(session.shellCommand).toContain(
      "export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin':\"$PATH\""
    );
    expect(session.shellCommand).toContain(
      "chmod 600 '/Users/monsoon/.pico/resident-voice/managed/development/processes/2026-06-22/2026-06-22T01-02-03-000Z-1234.log'"
    );
    expect(session.shellCommand).not.toContain(": >");
    expect(session.shellCommand).toContain("PICO_DEV_TERMINAL_TTY=$(tty)");
    expect(session.shellCommand).toContain("printf '\\033]0;%s\\007' 'pico resident voice'");
    expect(session.shellCommand).toContain("[pico] metadata log: %s");
    expect(session.shellCommand).toContain(
      "node_modules/.bin/pi --no-session --extension ./src/index.ts --pico"
    );
    expect(session.shellCommand).not.toContain("npm run resident:voice");
    expect(session.shellCommand).not.toContain("tee -a");
    expect(session.shellCommand).not.toContain("--pico 2>&1");
    expect(session.shellCommand).not.toContain(
      "> '/Users/monsoon/.pico/resident-voice/managed/development/processes/2026-06-22/2026-06-22T01-02-03-000Z-1234.log'"
    );
    expect(session.shellCommand).toContain("resident voice exited with status");
    expect(session.shellCommand).toContain("exit_code=$?");
    expect(session.shellCommand).not.toContain("status=$?");
    expect(session.shellCommand).toContain("close windowItem saving no");
    expect(session.shellCommand).toContain("close tabItem saving no");
    expect(session.shellCommand).toContain('exit "$exit_code"');
    expect(session.shellCommand).not.toContain("pico_HotStation");
    expect(session.shellCommand).not.toContain("HasunohaLabo7087");
    expect(session.appleScript).toContain(
      "exec /bin/zsh '/Users/monsoon/.pico/dev-terminal/resident-voice-launcher.sh'"
    );
    expect(session.appleScript).not.toContain("npm run resident:voice");
  });

  it("builds a Ghostty session by default through the macOS app launcher", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: "/Users/monsoon/Dev/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    });

    expect(session.terminal).toBe("ghostty");
    expect(session.ghosttyCommand).toEqual({
      command: "open",
      args: [
        "-na",
        "Ghostty.app",
        "--args",
        "--title=pico resident voice",
        "--wait-after-command=true",
        "-e",
        "/bin/zsh",
        "/Users/monsoon/.pico/dev-terminal/resident-voice-launcher.sh"
      ]
    });
    expect(session.shellCommand).not.toContain("PICO_DEV_TERMINAL_TTY=$(tty)");
    expect(session.shellCommand).not.toContain("osascript");
    expect(session.appleScript).toBeUndefined();
    expect(session.kittyCommand).toBeUndefined();
  });

  it("builds a kitty session without Terminal.app AppleScript tab management", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: "/Users/monsoon/Dev/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      terminal: "kitty"
    });

    expect(session.terminal).toBe("kitty");
    expect(session.kittyCommand).toEqual({
      command: "kitty",
      args: [
        "--title",
        "pico resident voice",
        "/bin/zsh",
        "/Users/monsoon/.pico/dev-terminal/resident-voice-launcher.sh"
      ]
    });
    expect(session.shellCommand).toContain(
      "node_modules/.bin/pi --no-session --extension ./src/index.ts --pico"
    );
    expect(session.shellCommand).not.toContain("npm run resident:voice");
    expect(session.shellCommand).toContain('exit "$exit_code"');
    expect(session.shellCommand).not.toContain("PICO_DEV_TERMINAL_TTY=$(tty)");
    expect(session.shellCommand).not.toContain("osascript");
    expect(session.appleScript).toBeUndefined();
  });

  it.runIf(process.platform === "darwin")(
    "propagates the Pi exit code without copying conversation output to the metadata log",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pico-dev-terminal-"));
      const repoRoot = join(root, "repo");
      const homeDirectory = join(root, "home");
      const piExecutablePath = join(repoRoot, "node_modules/.bin/pi");
      const launcherPath = join(root, "generated-launcher.sh");
      const conversationSentinel = "SENTINEL_STAFF_CONVERSATION";
      mkdirSync(join(repoRoot, "node_modules/.bin"), { recursive: true });
      mkdirSync(homeDirectory, { recursive: true });
      writeFileSync(
        piExecutablePath,
        `#!/bin/zsh\nprint -r -- '${conversationSentinel}'\nprint -r -- '${conversationSentinel}' >&2\nexit 7\n`
      );
      chmodSync(piExecutablePath, 0o700);
      const session = defineResidentDevelopmentTerminalSession({
        repoRoot,
        homeDirectory,
        configPath: join(repoRoot, "config/pico.local.yaml"),
        pathEnvironment: "/usr/bin:/bin",
        terminal: "kitty",
        now: () => "2026-06-22T01:02:03.000Z",
        processId: 1234
      });
      writeFileSync(launcherPath, session.launcherScript);
      chmodSync(launcherPath, 0o700);

      const result = spawnSync("/bin/zsh", [launcherPath], { encoding: "utf8" });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.stdout).toContain(conversationSentinel);
      expect(result.stderr).toContain(conversationSentinel);
      expect(result.stderr).not.toContain("read-only variable");
      expect(result.stdout).toContain("resident voice exited with status 7");
      expect(readFileSync(session.logPath, "utf8")).not.toContain(conversationSentinel);
      expect(session.shellCommand).not.toContain("tee");
    }
  );

  it("quotes shell paths and AppleScript strings with spaces, apostrophes, and double quotes", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: '/tmp/pico\'s "lab"',
      homeDirectory: "/tmp/home",
      configPath: '/tmp/pico\'s "lab"/config/pico.local.yaml',
      pathEnvironment: "/bin",
      terminal: "terminal"
    });

    expect(session.shellCommand).toContain("cd '/tmp/pico'\\''s \"lab\"'");
    expect(session.shellCommand).toContain(
      "export PICO_CONFIG_PATH='/tmp/pico'\\''s \"lab\"/config/pico.local.yaml'"
    );
    expect(session.appleScript).toContain('tell application "Terminal"');
    expect(session.appleScript).toContain('do script "');
    expect(session.launcherScript).toContain("cd '/tmp/pico'\\''s \"lab\"");
    expect(session.appleScript).toContain(
      "/tmp/home/.pico/dev-terminal/resident-voice-launcher.sh"
    );
  });
});
