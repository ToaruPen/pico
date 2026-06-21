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

  it("builds a Terminal.app session that streams resident voice logs to the screen and a local log file", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: "/Users/monsoon/Dev/pico project",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    });

    expect(session.logDirectory).toBe("/Users/monsoon/.pico/resident-voice/development/processes");
    expect(session.logPath).toBe(
      "/Users/monsoon/.pico/resident-voice/development/processes/dev-terminal.log"
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
      "mkdir -p '/Users/monsoon/.pico/resident-voice/development/processes'"
    );
    expect(session.shellCommand).toContain("chmod 700 '/Users/monsoon/.pico'");
    expect(session.shellCommand).toContain(
      "export PICO_CONFIG_PATH='/Users/monsoon/Dev/pico/config/pico.local.yaml'"
    );
    expect(session.shellCommand).toContain("export PICO_VOICE_PROBE_STDOUT='summary'");
    expect(session.shellCommand).toContain("export PICO_RESIDENT_VOICE_LOG_MODE='development'");
    expect(session.shellCommand).toContain(
      "export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin':\"$PATH\""
    );
    expect(session.shellCommand).toContain(
      ": > '/Users/monsoon/.pico/resident-voice/development/processes/dev-terminal.log'"
    );
    expect(session.shellCommand).toContain(
      "chmod 600 '/Users/monsoon/.pico/resident-voice/development/processes/dev-terminal.log'"
    );
    expect(session.shellCommand).toContain("PICO_DEV_TERMINAL_TTY=$(tty)");
    expect(session.shellCommand).toContain("printf '\\033]0;%s\\007' 'pico resident voice'");
    expect(session.shellCommand).toContain("npm run resident:voice");
    expect(session.shellCommand).toContain(
      "2>&1 | tee -a '/Users/monsoon/.pico/resident-voice/development/processes/dev-terminal.log'"
    );
    expect(session.shellCommand).toContain("resident voice exited with status");
    expect(session.shellCommand).toContain("close windowItem saving no");
    expect(session.shellCommand).toContain("close tabItem saving no");
    expect(session.shellCommand).toContain('exit "$status"');
    expect(session.shellCommand).not.toContain("pico_HotStation");
    expect(session.shellCommand).not.toContain("HasunohaLabo7087");
    expect(session.appleScript).toContain(
      "exec /bin/zsh '/Users/monsoon/.pico/dev-terminal/resident-voice-launcher.sh'"
    );
    expect(session.appleScript).not.toContain("npm run resident:voice");
  });

  it("quotes shell paths and AppleScript strings with spaces, apostrophes, and double quotes", () => {
    const session = defineResidentDevelopmentTerminalSession({
      repoRoot: '/tmp/pico\'s "lab"',
      homeDirectory: "/tmp/home",
      configPath: '/tmp/pico\'s "lab"/config/pico.local.yaml',
      pathEnvironment: "/bin"
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
