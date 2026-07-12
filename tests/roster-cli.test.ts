import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { runRosterCli } from "../src/runtime/roster-cli.js";

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
