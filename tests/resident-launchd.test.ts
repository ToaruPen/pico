import { describe, expect, it } from "vitest";

import {
  createResidentLaunchctlCommandPlan,
  createResidentLaunchdOperationPlan,
  defineResidentLaunchdService
} from "../src/runtime/resident-launchd.js";

describe("resident launchd service", () => {
  it("builds a resident voice LaunchAgent without embedding local config contents", () => {
    const service = defineResidentLaunchdService({
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
    expect(service.standardOutputPath).toBe(
      "/Users/monsoon/Dev/pico project/.pico-local/logs/resident-voice.out.log"
    );
    expect(service.standardErrorPath).toBe(
      "/Users/monsoon/Dev/pico project/.pico-local/logs/resident-voice.err.log"
    );
    expect(service.plist).toContain("<key>RunAtLoad</key>");
    expect(service.plist).toContain("<true/>");
    expect(service.plist).toContain("<key>KeepAlive</key>");
    expect(service.plist).toContain("<key>PICO_CONFIG_PATH</key>");
    expect(service.plist).toContain(
      "<string>/Users/monsoon/Dev/pico/config/pico.local.yaml</string>"
    );
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

  it("escapes plist XML values for paths containing special characters", () => {
    const service = defineResidentLaunchdService({
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
      repoRoot: "/repo/pico",
      homeDirectory: "/Users/monsoon",
      configPath: "/repo/pico/config/pico.local.yaml",
      nodePath: "/usr/local/bin/node",
      pathEnvironment: "/bin"
    });

    expect(createResidentLaunchdOperationPlan(service, "install", 501)).toEqual([
      {
        kind: "mkdir",
        path: "/repo/pico/.pico-local/logs"
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

  it("stops a KeepAlive service by booting it out while keeping the plist installed", () => {
    const service = defineResidentLaunchdService({
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
});
