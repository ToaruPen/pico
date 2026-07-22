import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    const voiceDevelopmentRecipe = justfile.slice(
      justfile.indexOf("voice-dev:"),
      justfile.indexOf("voice-dev-terminal:")
    );
    expect(voiceDevelopmentRecipe).toContain("resident:voice:dev-terminal -- --terminal=terminal");
    expect(voiceDevelopmentRecipe).not.toContain("--terminal=ghostty");
    expect(justfile).toContain("voice-dev-terminal:");
    expect(justfile).toContain("resident:voice:dev-terminal -- --terminal=terminal");
    expect(justfile).toContain("voice-dev-kitty:");
    expect(justfile).toContain("resident:voice:dev-terminal -- --terminal=kitty");
    expect(justfile).toContain("resident-voice-dev-terminal:");
    expect(justfile).toContain("npm run resident:voice:dev-terminal");
    expect(justfile).toContain("field-resident-hold-to-talk:");
    expect(justfile).toContain("npm run field:resident-hold-to-talk");
  });

  it("does not expose the removed SQLite memory worker or field harnesses", () => {
    const justfile = readFileSync("Justfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(packageJson.scripts?.["resident:memory"]).toBeUndefined();
    expect(packageJson.scripts?.["resident:memory:launchd"]).toBeUndefined();
    expect(packageJson.scripts?.["field:session-memory-retrieval"]).toBeUndefined();
    expect(justfile).not.toContain("memory-status:");
    expect(justfile).not.toContain("field-session-memory-retrieval:");
    expect(
      [
        "src/modules/memory",
        "src/modules/long-memory",
        "src/runtime/memory-tool.ts",
        "src/runtime/session-tool.ts",
        "scripts/resident/memory.ts"
      ].filter((path) => existsSync(resolve(path)))
    ).toEqual([]);
  });

  it("exposes the Apple Speech sidecar gate", () => {
    const justfile = readFileSync("Justfile", "utf8");

    expect(justfile).toContain("apple-speech-check:");
    expect(justfile).toContain("bash scripts/ci/run-apple-speech-gates.sh");
  });

  it("exposes the macOS resident audio measurement probe", () => {
    const justfile = readFileSync("Justfile", "utf8");

    expect(justfile).toContain("macos-resident-audio-probe *args:");
    expect(justfile).toContain(
      "xcrun swift scripts/field/macos-resident-audio-probe.swift {{args}}"
    );
    expect(existsSync(resolve("scripts/field/macos-resident-audio-probe.swift"))).toBe(true);
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
    const checkRecipe = justfile.slice(justfile.indexOf("\ncheck:"), justfile.indexOf("\nci:"));
    const appleSpeechGate =
      'if [ "$(uname -s)" = "Darwin" ]; then just apple-speech-check macos-resident-io-check; fi';

    expect(checkRecipe).toContain(appleSpeechGate);
    expect(checkRecipe.indexOf(appleSpeechGate)).toBeLessThan(checkRecipe.indexOf("npm run check"));
  });

  it("runs the Apple Speech gate in macOS CI", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      readonly jobs?: Readonly<
        Record<
          string,
          {
            readonly "runs-on"?: string;
            readonly steps?: readonly { readonly run?: string }[];
          }
        >
      >;
    };
    const appleSpeechJob = workflow.jobs?.["apple-speech"];

    expect(appleSpeechJob?.["runs-on"]).toBe("macos-26");
    expect(
      appleSpeechJob?.steps?.some(
        (step) => step.run === "bash scripts/ci/run-apple-speech-gates.sh"
      )
    ).toBe(true);
  });
});
