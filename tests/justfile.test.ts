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

  it("exposes the Apple Speech sidecar gate", () => {
    const justfile = readFileSync("Justfile", "utf8");

    expect(justfile).toContain("apple-speech-check:");
    expect(justfile).toContain("bash scripts/ci/run-apple-speech-gates.sh");
  });

  it("isolates the Apple Speech gate from the operator release build", () => {
    const gate = readFileSync("scripts/ci/run-apple-speech-gates.sh", "utf8");

    expect(gate).toContain('build_dir="$temporary_dir/swift-build"');
    expect(gate.match(/--scratch-path "\$build_dir"/gu)).toHaveLength(3);
    expect(gate).not.toContain('build_dir="$package_dir/.build"');
    expect(gate).not.toContain('rm -rf "$build_dir"');
  });

  it("runs the Apple Speech gate from the standard check on Darwin", () => {
    const justfile = readFileSync("Justfile", "utf8");
    const checkRecipe = justfile.slice(justfile.indexOf("check:"), justfile.indexOf("\nci:"));
    const appleSpeechGate =
      'if [ "$(uname -s)" = "Darwin" ]; then bash scripts/ci/run-apple-speech-gates.sh; fi';

    expect(checkRecipe).toContain(appleSpeechGate);
    expect(checkRecipe.indexOf(appleSpeechGate)).toBeLessThan(checkRecipe.indexOf("npm run check"));
  });

  it("runs the Apple Speech gate in macOS CI", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("runs-on: macos-26");
    expect(workflow).toContain("run: bash scripts/ci/run-apple-speech-gates.sh");
  });
});
