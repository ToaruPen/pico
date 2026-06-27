import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("justfile", () => {
  it("exposes the resident voice development session as just dev-session", () => {
    const justfile = readFileSync("Justfile", "utf8");

    expect(justfile).toContain("dev-session:");
    expect(justfile).toContain("npm run resident:voice:dev-terminal");
  });

  it("exposes simple resident voice operation recipes", () => {
    const justfile = readFileSync("Justfile", "utf8");

    expect(justfile).toContain("voice-status:");
    expect(justfile).toContain("resident:voice:launchd -- status");
    expect(justfile).toContain("voice-normal:");
    expect(justfile).toContain("resident:voice:launchd -- install");
    expect(justfile).toContain("voice-stop:");
    expect(justfile).toContain("resident:voice:launchd -- stop");
    expect(justfile).toContain("voice-dev:");
    expect(justfile).toContain("-npm run resident:voice:launchd -- stop");
    expect(justfile).toContain("resident:voice:dev-terminal -- --terminal=terminal");
    expect(justfile).toContain("voice-dev-kitty:");
    expect(justfile).toContain("resident:voice:dev-terminal -- --terminal=kitty");
    expect(justfile).toContain("resident-voice-dev-terminal:");
    expect(justfile).toContain("npm run resident:voice:dev-terminal");
    expect(justfile).toContain("field-resident-voice-deferred-rallies:");
    expect(justfile).toContain("npm run field:resident-voice-deferred-rallies");
  });
});
