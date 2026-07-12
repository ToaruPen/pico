import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  createIdentityRegistryModule,
  createIdentityRegistryService,
  initializeIdentityRegistry,
  openIdentityRegistry
} from "../src/modules/identity-registry/index.js";
import { initializeIdentityRegistryDatabase } from "../src/modules/identity-registry/store.js";

const directories: string[] = [];
const now = "2026-07-12T00:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("minimal identity registry service", () => {
  it("previews and applies a workbook only with owner approval", async () => {
    const service = createService();
    const path = await createRosterPath(service, [
      [undefined, undefined, "架空", "花子", "カクウ", "ハナコ", "はなちゃん", "active"]
    ]);

    const preview = await service.previewWorkbook(path);
    expect(preview).toMatchObject({
      ok: true,
      applicable: true,
      counts: { created: 1, updated: 0, unchanged: 0, errors: 0 },
      changes: [{ rowNumber: 2, operation: "create" }]
    });
    if (!preview.ok || !preview.applicable) throw new Error("expected applicable preview");
    expect(() => service.applyPreview(preview.previewId, { ownerApproved: false })).toThrow(
      "owner_approval_required"
    );
    expect(service.applyPreview(preview.previewId, { ownerApproved: true })).toEqual({
      applied: 1,
      registryEpoch: 1
    });
    expect(service.resolve("はなちゃん")).toMatchObject({
      kind: "resolved",
      identity: { name: { family: "架空", given: "花子" } }
    });
    service.close();
  });

  it("preserves stable subject references on export and reimport", async () => {
    const service = createService();
    const input = await createRosterPath(service, [
      [undefined, undefined, "架空", "花子", "かくう", "はなこ", undefined, "active"]
    ]);
    const first = await service.previewWorkbook(input);
    if (!first.ok || !first.applicable) throw new Error("expected first preview");
    service.applyPreview(first.previewId, { ownerApproved: true });

    const exportBuffer = await service.createExportWorkbook({ ownerApproved: true });
    const exportPath = writeBuffer(exportBuffer);
    const second = await service.previewWorkbook(exportPath);

    expect(second).toEqual({
      ok: true,
      applicable: false,
      resultCode: "no_changes",
      counts: { created: 0, updated: 0, unchanged: 1, errors: 0 },
      changes: []
    });
    service.close();
  });

  it("mutates aliases and status through the service boundary", async () => {
    const service = createService();
    const input = await createRosterPath(service, [
      [undefined, undefined, "架空", "花子", "かくう", "はなこ", undefined, "active"]
    ]);
    const preview = await service.previewWorkbook(input);
    if (!preview.ok || !preview.applicable) throw new Error("expected preview");
    service.applyPreview(preview.previewId, { ownerApproved: true });
    const resolved = service.resolve("架空花子");
    if (resolved.kind !== "resolved") throw new Error("expected identity");

    service.addAlias(resolved.identity.subjectRef, "はなちゃん", { ownerApproved: true });
    expect(service.resolve("はなちゃん").kind).toBe("resolved");
    service.deactivate(resolved.identity.subjectRef, { ownerApproved: true });
    expect(service.resolve("架空花子")).toMatchObject({
      kind: "resolved",
      identity: { status: "inactive" }
    });
    service.activate(resolved.identity.subjectRef, { ownerApproved: true });
    service.removeAlias(resolved.identity.subjectRef, "はなちゃん", { ownerApproved: true });
    expect(service.resolve("はなちゃん")).toEqual({ kind: "not_found" });
    service.close();
  });

  it("records value-free generic audit events", async () => {
    const audit = createStructuredAuditLog();
    const service = createService(audit);
    const path = await createRosterPath(service, [
      [undefined, undefined, "架空", "花子", "かくう", "はなこ", undefined, "active"]
    ]);
    const preview = await service.previewWorkbook(path);
    if (!preview.ok || !preview.applicable) throw new Error("expected preview");
    service.applyPreview(preview.previewId, { ownerApproved: true });

    const serialized = JSON.stringify(audit.entries());
    expect(serialized).not.toContain("架空");
    expect(serialized).not.toContain("花子");
    expect(audit.entries().map(({ name }) => name)).toEqual([
      "identity_registry.preview",
      "identity_registry.apply"
    ]);
    service.close();
  });

  it("initializes and reopens the default native store without a keyring", () => {
    const { databasePath } = createDatabasePath();
    expect(() => initializeIdentityRegistry({ databasePath, now: () => now })).toThrow(
      "owner_approval_required"
    );
    const created = initializeIdentityRegistry(
      { databasePath, now: () => now },
      { ownerApproved: true }
    );
    created.close();
    const reopened = openIdentityRegistry({ databasePath, now: () => now });
    expect(reopened.status().identityCount).toBe(0);
    reopened.close();
  });

  it("registers a local plaintext capability without exposing a Pi mutation tool", () => {
    expect(createIdentityRegistryModule().metadata).toMatchObject({
      kind: "identity_registry",
      status: "available"
    });
    expect(createIdentityRegistryModule().metadata.summary).toContain(
      "local child identity registry"
    );
    expect(createIdentityRegistryModule().metadata.summary).not.toContain("encrypted");
  });
});

function createDatabasePath(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "pico-identity-service-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "registry.sqlite") };
}

function createService(audit = createStructuredAuditLog()) {
  const { databasePath } = createDatabasePath();
  const store = initializeIdentityRegistryDatabase({ databasePath, now });
  return createIdentityRegistryService(store, { now: () => now, audit });
}

async function createRosterPath(
  service: ReturnType<typeof createService>,
  rows: readonly (readonly unknown[])[]
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const template = await service.createTemplateWorkbook();
  await workbook.xlsx.load(template as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);
  const roster = workbook.getWorksheet("児童名簿");
  if (roster === undefined) throw new Error("missing roster fixture");
  for (const row of rows) roster.addRow([...row]);
  return writeBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
}

function writeBuffer(buffer: Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-identity-service-book-"));
  directories.push(directory);
  const path = join(directory, "roster.xlsx");
  writeFileSync(path, buffer, { mode: 0o600 });
  return path;
}
