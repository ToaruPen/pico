import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import type { ChildIdentity } from "../src/modules/identity-registry/schema.js";
import {
  createRosterExportWorkbook,
  createRosterTemplateWorkbook,
  parseRosterWorkbook
} from "../src/modules/identity-registry/workbook.js";

const temporaryDirectories: string[] = [];
const now = "2026-07-12T00:00:00.000Z";
const identity: ChildIdentity = {
  subjectRef: "018f0f4e-0000-7000-8000-000000000001",
  revision: 2,
  name: {
    family: "架空",
    given: "花子",
    familyKana: "かくう",
    givenKana: "はなこ"
  },
  aliases: ["はなちゃん"],
  status: "active",
  updatedAt: now
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("minimal identity registry workbook", () => {
  it("generates exactly three sheets and eight columns", async () => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));

    expect(workbook.worksheets.map(({ name, state }) => ({ name, state }))).toEqual([
      { name: "児童名簿", state: "visible" },
      { name: "入力ガイド", state: "visible" },
      { name: "_pico_schema", state: "hidden" }
    ]);
    expect(workbook.getWorksheet("児童名簿")?.getRow(1).values).toEqual([
      undefined,
      "pico_id",
      "revision",
      "姓",
      "名",
      "姓かな",
      "名かな",
      "あだ名",
      "状態"
    ]);
  });

  it("round trips a plaintext export", async () => {
    const path = writeWorkbook(await createRosterExportWorkbook([identity], now));

    await expect(parseRosterWorkbook(path)).resolves.toEqual({
      rows: [
        {
          kind: "update",
          rowNumber: 2,
          subjectRef: identity.subjectRef,
          revision: 2,
          family: { kind: "set", value: "架空" },
          given: { kind: "set", value: "花子" },
          familyKana: { kind: "set", value: "かくう" },
          givenKana: { kind: "set", value: "はなこ" },
          aliases: { kind: "set", value: ["はなちゃん"] },
          status: { kind: "set", value: "active" }
        }
      ],
      errors: []
    });
  });

  it("parses a populated template create row", async () => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const roster = workbook.getWorksheet("児童名簿");
    if (roster === undefined) throw new Error("missing roster fixture");
    roster.addRow([
      undefined,
      undefined,
      "架空",
      "花子",
      "カクウ",
      "ハナコ",
      "はなちゃん",
      "active"
    ]);

    const path = writeWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    const parsed = await parseRosterWorkbook(path);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ kind: "create", rowNumber: 2, status: "active" });
  });

  it.each(["formula", "hyperlink", "rich text"] as const)("rejects %s cells", async (kind) => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const roster = workbook.getWorksheet("児童名簿");
    if (roster === undefined) throw new Error("missing roster fixture");
    const cell = roster.getCell("C2");
    if (kind === "formula") cell.value = { formula: 'HYPERLINK("https://example.invalid")' };
    if (kind === "hyperlink") cell.value = { text: "架空", hyperlink: "https://example.invalid" };
    if (kind === "rich text") cell.value = { richText: [{ text: "架空" }] };

    const path = writeWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    await expect(parseRosterWorkbook(path)).rejects.toThrow("roster_workbook_invalid");
  });

  it("does not apply editable-sheet restrictions to the guide", async () => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const guide = workbook.getWorksheet("入力ガイド");
    if (guide === undefined) throw new Error("missing guide fixture");
    guide.getCell("C1").value = { formula: 'HYPERLINK("https://example.invalid")' };
    guide.getColumn(3).hidden = true;
    guide.getRow(2).hidden = true;
    guide.mergeCells("A4:B4");

    const path = writeWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    await expect(parseRosterWorkbook(path)).resolves.toMatchObject({ errors: [] });
  });

  it("rejects data outside the fixed eight roster columns", async () => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const roster = workbook.getWorksheet("児童名簿");
    if (roster === undefined) throw new Error("missing roster fixture");
    roster.getCell("I2").value = "unknown";

    const path = writeWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    await expect(parseRosterWorkbook(path)).rejects.toThrow("roster_workbook_invalid");
  });

  it("validates schema generation time", async () => {
    const invalidTimestamp = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const schema = invalidTimestamp.getWorksheet("_pico_schema");
    if (schema === undefined) throw new Error("missing schema fixture");
    schema.getCell("A2").value = "invalid";
    await expect(
      parseRosterWorkbook(writeWorkbook(Buffer.from(await invalidTimestamp.xlsx.writeBuffer())))
    ).rejects.toThrow("roster_workbook_invalid");
  });

  it("applies the global cell-size bound to rich text", async () => {
    const oversized = await loadWorkbook(await createRosterTemplateWorkbook(now));
    const guide = oversized.getWorksheet("入力ガイド");
    if (guide === undefined) throw new Error("missing guide fixture");
    guide.getCell("C1").value = {
      richText: [{ text: "長".repeat(513) }]
    };
    await expect(
      parseRosterWorkbook(writeWorkbook(Buffer.from(await oversized.xlsx.writeBuffer())))
    ).rejects.toThrow("roster_workbook_too_large");
  });

  it("rejects unexpected sheets and non-xlsx paths", async () => {
    const workbook = await loadWorkbook(await createRosterTemplateWorkbook(now));
    workbook.addWorksheet("unexpected");
    const path = writeWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));

    await expect(parseRosterWorkbook(path)).rejects.toThrow("roster_workbook_invalid");
    await expect(parseRosterWorkbook(path.replace(/\.xlsx$/u, ".xlsm"))).rejects.toThrow(
      "roster_workbook_invalid"
    );
  });

  it("rejects files larger than ten MiB before workbook load", async () => {
    const path = writeWorkbook(Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(parseRosterWorkbook(path)).rejects.toThrow("roster_workbook_too_large");
  });
});

async function loadWorkbook(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);
  return workbook;
}

function writeWorkbook(buffer: Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-roster-workbook-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "roster.xlsx");
  writeFileSync(path, buffer, { mode: 0o600 });
  return path;
}
