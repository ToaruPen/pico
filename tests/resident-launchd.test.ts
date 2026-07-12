import { describe, expect, it } from "vitest";

import {
  createResidentLaunchctlCommandPlan,
  createResidentLaunchdOperationPlan,
  defineResidentLaunchdService,
  formatResidentLaunchdStatus,
  requireResidentLaunchdPlatform
} from "../src/runtime/resident-launchd.js";

describe("resident launchd service", () => {
  it("formats only allowlisted status fields from launchctl output", () => {
    const rawStatus = `gui/501/dev.toarupen.pico.resident-memory = {
  state = running
  pid = 31880
  environment = {
    STACKCHAN_TOKEN => exposed-secret-value
    PICO_CONFIG_PATH => /secret/local/config.yaml
  }
}`;

    const status = formatResidentLaunchdStatus(rawStatus);

    expect(status).toEqual({
      state: "running",
      pid: 31880,
      lastExitCode: undefined
    });
    expect(JSON.stringify(status)).not.toContain("STACKCHAN_TOKEN");
    expect(JSON.stringify(status)).not.toContain("exposed-secret-value");
    expect(JSON.stringify(status)).not.toContain("PICO_CONFIG_PATH");
  });

  it("bounds unknown state and parses the last exit code", () => {
    expect(
      formatResidentLaunchdStatus(`state = waiting\nlast exit code = 78\npath = /private/path`)
    ).toEqual({
      state: "waiting",
      pid: undefined,
      lastExitCode: 78
    });
    expect(formatResidentLaunchdStatus("state = secret-state\npid = invalid")).toEqual({
      state: "unknown",
      pid: undefined,
      lastExitCode: undefined
    });
  });

  it("adds only bounded memory queue readiness fields", () => {
    expect(
      formatResidentLaunchdStatus("state = running\npid = 42", {
        queueDepth: 3,
        oldestQueuedAgeMs: 60_000,
        deadLetterCount: 2
      })
    ).toEqual({
      state: "running",
      pid: 42,
      lastExitCode: undefined,
      queueDepth: 3,
      oldestQueuedAgeMs: 60_000,
      deadLetterCount: 2
    });
  });

  it("fails fast outside macOS before launchctl operations are planned", () => {
    expect(() => {
      requireResidentLaunchdPlatform("linux");
    }).toThrow("resident launchd is supported only on macOS (darwin)");
    expect(() => {
      requireResidentLaunchdPlatform("darwin");
    }).not.toThrow();
  });

  it("builds a resident voice LaunchAgent without embedding local config contents", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "voice",
      repoRoot: "/Users/monsoon/Dev/pico project",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      nodePath: "/Users/monsoon/.nvm/versions/node/v24.13.0/bin/node",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    });

    expect(service.label).toBe("dev.toarupen.pico.resident-voice");
    expect(service.plistPath).toBe(
      "/Users/monsoon/Library/LaunchAgents/dev.toarupen.pico.resident-voice.plist"
    );
    expect(service.logDirectory).toBe("/Users/monsoon/.pico/resident-voice/normal/processes");
    expect(service.picoDirectory).toBe("/Users/monsoon/.pico");
    expect(service.standardOutputPath).toContain(
      "/Users/monsoon/.pico/resident-voice/normal/processes/"
    );
    expect(service.standardOutputPath).toMatch(/resident-voice\.out\.log$/);
    expect(service.standardErrorPath).toContain(
      "/Users/monsoon/.pico/resident-voice/normal/processes/"
    );
    expect(service.standardErrorPath).toMatch(/resident-voice\.err\.log$/);
    expect(service.plist).toContain("<key>RunAtLoad</key>");
    expect(service.plist).toContain("<true/>");
    expect(service.plist).toContain("<key>KeepAlive</key>");
    expect(service.plist).toContain("<key>PICO_CONFIG_PATH</key>");
    expect(service.plist).toContain(
      "<string>/Users/monsoon/Dev/pico/config/pico.local.yaml</string>"
    );
    expect(service.plist).toContain("<key>PICO_VOICE_PROBE_STDOUT</key>");
    expect(service.plist).toContain("<string>summary</string>");
    expect(service.plist).toContain("<key>PICO_RESIDENT_VOICE_LOG_MODE</key>");
    expect(service.plist).toContain("<string>normal</string>");
    expect(service.plist).toContain(`<string>${service.standardOutputPath}</string>`);
    expect(service.plist).toContain(
      "<string>/Users/monsoon/.nvm/versions/node/v24.13.0/bin/node</string>"
    );
    expect(service.plist).toContain(
      "<string>/Users/monsoon/Dev/pico project/node_modules/jiti/lib/jiti-cli.mjs</string>"
    );
    expect(service.plist).toContain(
      "<string>/Users/monsoon/Dev/pico project/scripts/resident/voice.ts</string>"
    );
    expect(service.plist).not.toContain("pico_HotStation");
    expect(service.plist).not.toContain("HasunohaLabo7087");
  });

  it("builds a separate resident memory worker LaunchAgent", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "memory",
      repoRoot: "/Users/monsoon/Dev/pico project",
      homeDirectory: "/Users/monsoon",
      configPath: "/Users/monsoon/Dev/pico/config/pico.local.yaml",
      nodePath: "/Users/monsoon/.nvm/versions/node/v24.13.0/bin/node",
      pathEnvironment: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    });

    expect(service.label).toBe("dev.toarupen.pico.resident-memory");
    expect(service.logDirectory).toBe("/Users/monsoon/.pico/resident-memory/processes");
    expect(service.standardOutputPath).toMatch(/resident-memory\.out\.log$/);
    expect(service.standardErrorPath).toMatch(/resident-memory\.err\.log$/);
    expect(service.plist).toContain(
      "<string>/Users/monsoon/Dev/pico project/scripts/resident/memory.ts</string>"
    );
    expect(service.plist).not.toContain("PICO_VOICE_PROBE_STDOUT");
    expect(service.plist).not.toContain("PICO_RESIDENT_VOICE_LOG_MODE");
  });

  it("escapes plist XML values for paths containing special characters", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "voice",
      repoRoot: "/tmp/pico's & lab",
      homeDirectory: "/tmp/home",
      configPath: "/tmp/pico's & lab/config/pico.local.yaml",
      nodePath: "/tmp/node's/bin/node",
      pathEnvironment: "/bin"
    });

    expect(service.plist).toContain("<string>/tmp/pico&apos;s &amp; lab</string>");
    expect(service.plist).toContain(
      "<string>/tmp/pico&apos;s &amp; lab/node_modules/jiti/lib/jiti-cli.mjs</string>"
    );
    expect(service.plist).toContain(
      "<string>/tmp/pico&apos;s &amp; lab/scripts/resident/voice.ts</string>"
    );
  });

  it("builds launchctl commands for the current user agent domain", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "voice",
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    expect(createResidentLaunchctlCommandPlan(service, "bootstrap", 501)).toEqual({
      command: "launchctl",
      args: ["bootstrap", "gui/501", service.plistPath]
    });
    expect(createResidentLaunchctlCommandPlan(service, "start", 501)).toEqual({
      command: "launchctl",
      args: ["kickstart", "gui/501/dev.toarupen.pico.resident-voice"]
    });
    expect(createResidentLaunchctlCommandPlan(service, "restart", 501)).toEqual({
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/dev.toarupen.pico.resident-voice"]
    });
    expect(createResidentLaunchctlCommandPlan(service, "stop", 501)).toEqual({
      command: "launchctl",
      args: ["bootout", "gui/501/dev.toarupen.pico.resident-voice"]
    });
    expect(createResidentLaunchctlCommandPlan(service, "status", 501)).toEqual({
      command: "launchctl",
      args: ["print", "gui/501/dev.toarupen.pico.resident-voice"]
    });
    expect(createResidentLaunchctlCommandPlan(service, "bootout", 501)).toEqual({
      command: "launchctl",
      args: ["bootout", "gui/501/dev.toarupen.pico.resident-voice"]
    });
  });

  it("plans install and uninstall filesystem operations around launchctl", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "voice",
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    expect(createResidentLaunchdOperationPlan(service, "install", 501)).toEqual([
      {
        kind: "mkdir",
        path: service.picoDirectory,
        mode: 0o700
      },
      {
        kind: "mkdir",
        path: service.logDirectory,
        mode: 0o700
      },
      {
        kind: "mkdir",
        path: "/Users/monsoon/Library/LaunchAgents"
      },
      {
        kind: "writeFile",
        path: service.plistPath,
        content: service.plist
      },
      {
        kind: "command",
        command: "launchctl",
        args: ["bootstrap", "gui/501", service.plistPath],
        allowedExitCodes: [0]
      }
    ]);
    expect(createResidentLaunchdOperationPlan(service, "uninstall", 501)).toEqual([
      {
        kind: "command",
        command: "launchctl",
        args: ["bootout", "gui/501/dev.toarupen.pico.resident-voice"],
        allowedExitCodes: [0, 3]
      },
      {
        kind: "removeFile",
        path: service.plistPath
      }
    ]);
  });

  it("rejects memory LaunchAgent activation until Pico startup owns it", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "memory",
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    for (const operation of ["install", "start", "restart"] as const) {
      expect(() => createResidentLaunchdOperationPlan(service, operation, 501)).toThrow(
        "resident memory LaunchAgent activation is deferred until Pico startup owns it"
      );
    }
  });

  it("stops a KeepAlive service by booting it out while keeping the plist installed", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "voice",
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    expect(createResidentLaunchdOperationPlan(service, "stop", 501)).toEqual([
      {
        kind: "command",
        command: "launchctl",
        args: ["bootout", "gui/501/dev.toarupen.pico.resident-voice"],
        allowedExitCodes: [0]
      }
    ]);
  });

  it("plans status as captured output instead of inherited stdout", () => {
    const service = defineResidentLaunchdService({
      serviceKind: "memory",
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    expect(createResidentLaunchdOperationPlan(service, "status", 501)).toEqual([
      {
        kind: "status",
        command: "launchctl",
        args: ["print", "gui/501/dev.toarupen.pico.resident-memory"],
        allowedExitCodes: [0],
        serviceKind: "memory",
        configPath: "/repo/pico/config/pico.local.yaml"
      }
    ]);
  });
});
