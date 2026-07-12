import { type FileHandle, open } from "node:fs/promises";
import { extname } from "node:path";

import ExcelJS, { type Cell, type Workbook, type Worksheet } from "exceljs";

import {
  type ChildIdentity,
  parseRosterRow,
  ROSTER_CLEAR_LITERAL,
  ROSTER_COLUMNS,
  ROSTER_LIMITS,
  ROSTER_SCHEMA_VERSION,
  type RosterRowPatch,
  type RosterValidationError,
  validateChildIdentity
} from "./schema.js";

export type ParsedRosterWorkbook = Readonly<{
  rows: readonly RosterRowPatch[];
  errors: readonly RosterValidationError[];
}>;

const rosterSheetName = "児童名簿";
const guideSheetName = "入力ガイド";
const schemaSheetName = "_pico_schema";
const rosterHeaders = Object.freeze(ROSTER_COLUMNS.map(({ header }) => header));
const expectedSheets = Object.freeze([
  Object.freeze({ name: rosterSheetName, state: "visible" as const }),
  Object.freeze({ name: guideSheetName, state: "visible" as const }),
  Object.freeze({ name: schemaSheetName, state: "hidden" as const })
]);
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const forbiddenCellTypes = new Set([
  ExcelJS.ValueType.Formula,
  ExcelJS.ValueType.Hyperlink,
  ExcelJS.ValueType.RichText,
  ExcelJS.ValueType.Error
]);

export async function createRosterTemplateWorkbook(now: string): Promise<Buffer> {
  return writeWorkbook(createBaseWorkbook(now));
}

export async function createRosterExportWorkbook(
  identities: readonly ChildIdentity[],
  now: string
): Promise<Buffer> {
  if (identities.length > ROSTER_LIMITS.maximumRosterRows) throw invalidWorkbook();
  const workbook = createBaseWorkbook(now);
  const roster = requireWorksheet(workbook, rosterSheetName);
  for (const [index, identity] of identities.entries()) {
    if (validateChildIdentity(identity, index + 2).length > 0) throw invalidWorkbook();
    roster.addRow([
      identity.subjectRef,
      identity.revision,
      identity.name.family,
      identity.name.given,
      identity.name.familyKana,
      identity.name.givenKana,
      identity.aliases.join("\n"),
      identity.status
    ]);
  }
  return writeWorkbook(workbook);
}

export async function parseRosterWorkbook(path: string): Promise<ParsedRosterWorkbook> {
  const buffer = await readBoundedWorkbook(path);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<Workbook["xlsx"]["load"]>[0]);
  } catch {
    throw invalidWorkbook();
  }
  validateWorkbook(workbook);
  const roster = requireWorksheet(workbook, rosterSheetName);
  const rows: RosterRowPatch[] = [];
  const errors: RosterValidationError[] = [];
  for (let rowNumber = 2; rowNumber <= roster.rowCount; rowNumber += 1) {
    const row = roster.getRow(rowNumber);
    if (isEmptyRosterRow(row.values)) continue;
    const input: Record<string, unknown> = {};
    for (const [index, header] of rosterHeaders.entries()) {
      input[header] = plainCellValue(row.getCell(index + 1));
    }
    const parsed = parseRosterRow(input, rowNumber);
    if (parsed.ok) rows.push(parsed.row);
    else errors.push(...parsed.errors);
  }
  return Object.freeze({ rows: Object.freeze(rows), errors: Object.freeze(errors) });
}

function createBaseWorkbook(now: string): Workbook {
  requireCanonicalTimestamp(now);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "pico";
  const roster = workbook.addWorksheet(rosterSheetName);
  const guide = workbook.addWorksheet(guideSheetName);
  const schema = workbook.addWorksheet(schemaSheetName, { state: "hidden" });

  roster.addRow([...rosterHeaders]);
  roster.views = [{ state: "frozen", ySplit: 1, activeCell: "A2", topLeftCell: "A2" }];
  guide.addRow(["項目", "説明"]);
  guide.addRow(["pico_id / revision", "新規行では空欄、既存行では変更しないでください。"]);
  guide.addRow(["あだ名", `1行1件。全削除は ${ROSTER_CLEAR_LITERAL}。`]);
  guide.addRow(["状態", "active または inactive。"]);
  schema.getCell("A1").value = ROSTER_SCHEMA_VERSION;
  schema.getCell("A2").value = now;
  return workbook;
}

async function writeWorkbook(workbook: Workbook): Promise<Buffer> {
  try {
    return Buffer.from(await workbook.xlsx.writeBuffer());
  } catch {
    throw invalidWorkbook();
  }
}

async function readBoundedWorkbook(path: string): Promise<Buffer> {
  if (extname(path) !== ".xlsx") throw invalidWorkbook();
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const statistics = await handle.stat();
    if (!statistics.isFile()) throw invalidWorkbook();
    if (statistics.size > ROSTER_LIMITS.maximumFileBytes) {
      throw new Error("roster_workbook_too_large");
    }
    return await readAtMostMaximumWorkbookBytes(handle);
  } catch (caught: unknown) {
    if (caught instanceof Error && caught.message === "roster_workbook_too_large") throw caught;
    throw invalidWorkbook();
  } finally {
    await handle?.close();
  }
}

async function readAtMostMaximumWorkbookBytes(handle: FileHandle): Promise<Buffer> {
  const maximumBytes = ROSTER_LIMITS.maximumFileBytes;
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead > maximumBytes) throw new Error("roster_workbook_too_large");
  return buffer.subarray(0, bytesRead);
}

// eslint-disable-next-line complexity -- The fixed workbook contract is a flat set of independent checks.
function validateWorkbook(workbook: Workbook): void {
  const actualSheets = workbook.worksheets.map(({ name, state }) => ({ name, state }));
  if (JSON.stringify(actualSheets) !== JSON.stringify(expectedSheets)) throw invalidWorkbook();
  const schema = requireWorksheet(workbook, schemaSheetName);
  if (schema.getCell("A1").value !== ROSTER_SCHEMA_VERSION) throw invalidWorkbook();
  requireCanonicalTimestamp(schema.getCell("A2").value);
  const roster = requireWorksheet(workbook, rosterSheetName);
  const headers = roster.getRow(1).values;
  const actualHeaders = Array.isArray(headers) ? headers.slice(1) : [];
  if (JSON.stringify(actualHeaders) !== JSON.stringify(rosterHeaders)) throw invalidWorkbook();
  if (roster.columnCount > rosterHeaders.length) throw invalidWorkbook();
  if (roster.rowCount - 1 > ROSTER_LIMITS.maximumRosterRows) {
    throw new Error("roster_workbook_too_large");
  }

  let cellCount = 0;
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cellCount += 1;
        validateCellSize(cell);
      });
    });
  }
  if (cellCount > ROSTER_LIMITS.maximumWorkbookCells) {
    throw new Error("roster_workbook_too_large");
  }

  for (let columnNumber = 1; columnNumber <= roster.columnCount; columnNumber += 1) {
    if (roster.getColumn(columnNumber).hidden) throw invalidWorkbook();
  }
  roster.eachRow({ includeEmpty: false }, (row) => {
    if (row.hidden || (row.outlineLevel ?? 0) > 0) throw invalidWorkbook();
    row.eachCell({ includeEmpty: false }, validateEditableCell);
  });
}

function validateCellSize(cell: Cell): void {
  if (codePointLength(cellTextPayload(cell)) > ROSTER_LIMITS.maximumCellCodePoints) {
    throw new Error("roster_workbook_too_large");
  }
}

function codePointLength(value: string): number {
  let length = 0;
  for (const character of value) {
    if (character.codePointAt(0) !== undefined) length += 1;
  }
  return length;
}

function cellTextPayload(cell: Cell): string {
  const value = cell.value;
  if (typeof value === "string") return value;
  if (!isRecord(value)) return cell.text;
  const richText: unknown = value.richText;
  if (Array.isArray(richText)) {
    return richText
      .map((part: unknown) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
          ? part.text
          : ""
      )
      .join("");
  }
  return ["formula", "sharedFormula", "text", "hyperlink", "result"]
    .map((key) => (typeof value[key] === "string" ? value[key] : ""))
    .join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEditableCell(cell: Cell): void {
  if (cell.isMerged || forbiddenCellTypes.has(cell.type)) throw invalidWorkbook();
}

function plainCellValue(cell: Cell): unknown {
  if (cell.value === null) return undefined;
  if (typeof cell.value === "string" || typeof cell.value === "number") return cell.value;
  throw invalidWorkbook();
}

function isEmptyRosterRow(values: unknown): boolean {
  if (!Array.isArray(values)) return true;
  return values.slice(1).every((value) => value === undefined || value === null || value === "");
}

function requireWorksheet(workbook: Workbook, name: string): Worksheet {
  const worksheet = workbook.getWorksheet(name);
  if (worksheet === undefined) throw invalidWorkbook();
  return worksheet;
}

function requireCanonicalTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !canonicalTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw invalidWorkbook();
  }
}

function invalidWorkbook(): Error {
  return new Error("roster_workbook_invalid");
}
