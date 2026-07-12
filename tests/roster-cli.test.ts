import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { formatRosterCliHelp, runRosterCli } from "../src/runtime/roster-cli.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("roster cli", () => {
  it("initializes and reports registry status", async () => {
    const { databasePath } = createPaths();

    await expect(
      runRosterCli(["init", "--owner-approved", "--database", databasePath])
    ).resolves.toMatchObject({ ok: true, command: "init", identityCount: 0 });
    await expect(runRosterCli(["status", "--database", databasePath])).resolves.toEqual({
      ok: true,
      command: "status",
      schemaVersion: 1,
      normalizationVersion: 1,
      registryEpoch: 0,
      identityCount: 0
    });
  });

  it("requires owner approval for mutations", async () => {
    const { databasePath } = createPaths();
    await expect(runRosterCli(["init", "--database", databasePath])).rejects.toThrow(
      "owner_approval_required"
    );
  });

  it("creates a plaintext template without overwriting an existing file", async () => {
    const { outputPath } = createPaths();

    await expect(runRosterCli(["template", "--output", outputPath])).resolves.toEqual({
      ok: true,
      command: "template",
      outputPath
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    await expect(runRosterCli(["template", "--output", outputPath])).rejects.toThrow();
  });

  it("rejects unknown commands and options", async () => {
    await expect(runRosterCli(["unknown"])).rejects.toThrow("unknown roster command");
    await expect(runRosterCli(["status", "--unknown"])).rejects.toThrow();
  });

  it("reports roster help for both supported forms", async () => {
    expect(formatRosterCliHelp()).toContain("pico roster init");
    await expect(runRosterCli(["help"])).resolves.toEqual({
      ok: true,
      command: "help",
      usage: formatRosterCliHelp()
    });
    await expect(runRosterCli(["--help"])).resolves.toEqual({
      ok: true,
      command: "help",
      usage: formatRosterCliHelp()
    });
  });

  it("dispatches preview and enforces every mutation approval gate", async () => {
    const { databasePath, outputPath } = createPaths();
    await runRosterCli(["init", "--owner-approved", "--database", databasePath]);
    await runRosterCli(["template", "--output", outputPath]);

    await expect(
      runRosterCli(["preview", "--input", outputPath, "--database", databasePath])
    ).resolves.toMatchObject({ ok: true, command: "preview", resultCode: "no_changes" });
    await expect(runRosterCli(["preview", "--database", databasePath])).rejects.toThrow(
      "--input is required"
    );

    const mutationArguments = [
      ["apply", "--preview", "preview-id"],
      ["export", "--output", join(dirname(databasePath), "export.xlsx")],
      ["add-alias", "--subject", "subject", "--alias", "alias"],
      ["remove-alias", "--subject", "subject", "--alias", "alias"],
      ["activate", "--subject", "subject"],
      ["deactivate", "--subject", "subject"]
    ] as const;
    for (const arguments_ of mutationArguments) {
      await expect(runRosterCli([...arguments_, "--database", databasePath])).rejects.toThrow(
        "owner_approval_required"
      );
    }
  });

  it("routes value-free events through the structured audit log", async () => {
    const { databasePath } = createPaths();
    const audit = createStructuredAuditLog();

    await runRosterCli(["init", "--owner-approved", "--database", databasePath], { audit });

    expect(audit.entries().map(({ name }) => name)).toEqual(["identity_registry.init"]);
    expect(JSON.stringify(audit.entries())).not.toContain(databasePath);
  });
});

function createPaths(): { databasePath: string; outputPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "pico-roster-cli-"));
  directories.push(directory);
  return {
    databasePath: join(directory, "registry.sqlite"),
    outputPath: join(directory, "roster.xlsx")
  };
}
