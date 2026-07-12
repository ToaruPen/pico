import {
  IdentityNormalizationError,
  normalizeIdentityDisplayText,
  normalizeIdentityLookupText,
  normalizeIdentityReading
} from "./normalization.js";

export const ROSTER_SCHEMA_VERSION = 1 as const;
export const ROSTER_NORMALIZATION_VERSION = 1 as const;
export const ROSTER_CLEAR_LITERAL = "[[CLEAR]]" as const;
export const ROSTER_LIMITS = Object.freeze({
  maximumFileBytes: 10 * 1024 * 1024,
  maximumRosterRows: 2_000,
  maximumWorkbookCells: 50_000,
  maximumCellCodePoints: 512,
  maximumNameCodePoints: 64,
  maximumAliases: 20,
  maximumAliasCodePoints: 64
});

const rosterHeaders = [
  "pico_id",
  "revision",
  "姓",
  "名",
  "姓かな",
  "名かな",
  "あだ名",
  "状態"
] as const;

export const ROSTER_COLUMNS = Object.freeze(
  rosterHeaders.map((header) => Object.freeze({ header }))
) as readonly Readonly<{ header: (typeof rosterHeaders)[number] }>[];

export type ChildIdentityStatus = "active" | "inactive";
export type ChildIdentity = Readonly<{
  subjectRef: string;
  revision: number;
  name: Readonly<{ family: string; given: string; familyKana: string; givenKana: string }>;
  aliases: readonly string[];
  status: ChildIdentityStatus;
  updatedAt: string;
}>;

export type RosterFieldUpdate<T> =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "set"; value: T }>
  | Readonly<{ kind: "clear" }>;
export type RosterRequiredFieldUpdate<T> = Exclude<RosterFieldUpdate<T>, { kind: "clear" }>;

export type RosterRowPatch =
  | Readonly<{
      kind: "create";
      rowNumber: number;
      name: ChildIdentity["name"];
      aliases: readonly string[];
      status: ChildIdentityStatus;
    }>
  | Readonly<{
      kind: "update";
      rowNumber: number;
      subjectRef: string;
      revision: number;
      family: RosterRequiredFieldUpdate<string>;
      given: RosterRequiredFieldUpdate<string>;
      familyKana: RosterRequiredFieldUpdate<string>;
      givenKana: RosterRequiredFieldUpdate<string>;
      aliases: RosterFieldUpdate<readonly string[]>;
      status: RosterRequiredFieldUpdate<ChildIdentityStatus>;
    }>;

export type RosterValidationErrorCode =
  | "unknown_field"
  | "required"
  | "invalid_value"
  | "clear_not_allowed"
  | "unsafe_text"
  | "duplicate_value"
  | "too_long";
export type RosterValidationFieldCode =
  | "row"
  | "pico_id"
  | "revision"
  | "family"
  | "given"
  | "family_kana"
  | "given_kana"
  | "aliases"
  | "status"
  | "updated_at";
export type RosterValidationError = Readonly<{
  rowNumber: number;
  fieldCode: RosterValidationFieldCode;
  code: RosterValidationErrorCode;
}>;
export type RosterRowParseResult =
  | Readonly<{ ok: true; row: RosterRowPatch }>
  | Readonly<{ ok: false; errors: readonly RosterValidationError[] }>;

const allowedInputKeys = new Set<string>(rosterHeaders);
const identityKeys = new Set(["subjectRef", "revision", "name", "aliases", "status", "updatedAt"]);
const identityNameKeys = new Set(["family", "given", "familyKana", "givenKana"]);
const subjectReferencePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const keep = Object.freeze({ kind: "keep" } as const);
const clear = Object.freeze({ kind: "clear" } as const);

export function parseRosterRow(
  input: Readonly<Record<string, unknown>>,
  rowNumber: number
): RosterRowParseResult {
  const errors: RosterValidationError[] = [];
  if (Object.keys(input).some((key) => !allowedInputKeys.has(key))) {
    errors.push(error(rowNumber, "row", "unknown_field"));
  }

  const subjectCell = cellText(input.pico_id);
  const revisionCell = input.revision;
  const create = isBlank(input.pico_id) && isBlank(revisionCell);
  let row: RosterRowPatch | undefined;
  if (create) {
    row = parseCreateRow(input, rowNumber, errors);
  } else {
    row = parseUpdateRow(input, rowNumber, subjectCell, revisionCell, errors);
  }
  if (errors.length > 0 || row === undefined) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  return Object.freeze({ ok: true, row });
}

// eslint-disable-next-line complexity -- The fixed persisted contract validates each field explicitly.
export function validateChildIdentity(
  value: unknown,
  rowNumber = 0
): readonly RosterValidationError[] {
  const errors: RosterValidationError[] = [];
  if (!isRecord(value)) {
    return Object.freeze([error(rowNumber, "row", "invalid_value")]);
  }
  if (Object.keys(value).some((key) => !identityKeys.has(key))) {
    errors.push(error(rowNumber, "row", "unknown_field"));
  }
  if (!isSubjectReference(value.subjectRef))
    errors.push(error(rowNumber, "pico_id", "invalid_value"));
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    errors.push(error(rowNumber, "revision", "invalid_value"));
  }
  validateIdentityName(value.name, rowNumber, errors);
  validateAliases(value.aliases, rowNumber, errors);
  if (!isStatus(value.status)) errors.push(error(rowNumber, "status", "invalid_value"));
  if (!isCanonicalTimestamp(value.updatedAt)) {
    errors.push(error(rowNumber, "updated_at", "invalid_value"));
  }
  return Object.freeze(errors);
}

function parseCreateRow(
  input: Readonly<Record<string, unknown>>,
  rowNumber: number,
  errors: RosterValidationError[]
): RosterRowPatch | undefined {
  const family = parseRequiredName(input.姓, "family", rowNumber, errors, false);
  const given = parseRequiredName(input.名, "given", rowNumber, errors, false);
  const familyKana = parseRequiredName(input.姓かな, "family_kana", rowNumber, errors, true);
  const givenKana = parseRequiredName(input.名かな, "given_kana", rowNumber, errors, true);
  const aliases = parseAliases(input.あだ名, rowNumber, errors, false);
  const status = parseStatus(input.状態, rowNumber, errors, false);
  if (
    family === undefined ||
    given === undefined ||
    familyKana === undefined ||
    givenKana === undefined ||
    aliases === undefined ||
    status === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "create",
    rowNumber,
    name: Object.freeze({ family, given, familyKana, givenKana }),
    aliases,
    status
  });
}

// eslint-disable-next-line complexity -- The fixed eight-column update contract keeps field errors independent.
function parseUpdateRow(
  input: Readonly<Record<string, unknown>>,
  rowNumber: number,
  subjectCell: string | undefined,
  revisionCell: unknown,
  errors: RosterValidationError[]
): RosterRowPatch | undefined {
  const subjectReference =
    subjectCell !== undefined && isSubjectReference(subjectCell) ? subjectCell : undefined;
  if (subjectReference === undefined) errors.push(error(rowNumber, "pico_id", "invalid_value"));
  const revision =
    Number.isSafeInteger(revisionCell) && Number(revisionCell) > 0
      ? Number(revisionCell)
      : undefined;
  if (revision === undefined) errors.push(error(rowNumber, "revision", "invalid_value"));
  const family = parseNameUpdate(input.姓, "family", rowNumber, errors, false);
  const given = parseNameUpdate(input.名, "given", rowNumber, errors, false);
  const familyKana = parseNameUpdate(input.姓かな, "family_kana", rowNumber, errors, true);
  const givenKana = parseNameUpdate(input.名かな, "given_kana", rowNumber, errors, true);
  const aliases = parseAliases(input.あだ名, rowNumber, errors, true);
  const status = parseStatus(input.状態, rowNumber, errors, true);
  if (
    subjectReference === undefined ||
    revision === undefined ||
    family === undefined ||
    given === undefined ||
    familyKana === undefined ||
    givenKana === undefined ||
    aliases === undefined ||
    status === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "update",
    rowNumber,
    subjectRef: subjectReference,
    revision,
    family,
    given,
    familyKana,
    givenKana,
    aliases,
    status
  });
}

function parseRequiredName(
  value: unknown,
  fieldCode: RosterValidationFieldCode,
  rowNumber: number,
  errors: RosterValidationError[],
  reading: boolean
): string | undefined {
  if (isBlank(value)) {
    errors.push(error(rowNumber, fieldCode, "required"));
    return undefined;
  }
  return parseName(value, fieldCode, rowNumber, errors, reading);
}

function parseNameUpdate(
  value: unknown,
  fieldCode: RosterValidationFieldCode,
  rowNumber: number,
  errors: RosterValidationError[],
  reading: boolean
): RosterRequiredFieldUpdate<string> | undefined {
  if (isBlank(value)) return keep;
  if (value === ROSTER_CLEAR_LITERAL) {
    errors.push(error(rowNumber, fieldCode, "clear_not_allowed"));
    return undefined;
  }
  const parsed = parseName(value, fieldCode, rowNumber, errors, reading);
  return parsed === undefined ? undefined : Object.freeze({ kind: "set", value: parsed });
}

function parseName(
  value: unknown,
  fieldCode: RosterValidationFieldCode,
  rowNumber: number,
  errors: RosterValidationError[],
  reading: boolean
): string | undefined {
  if (typeof value !== "string") {
    errors.push(error(rowNumber, fieldCode, "invalid_value"));
    return undefined;
  }
  try {
    const normalized = reading
      ? normalizeIdentityReading(value)
      : normalizeIdentityDisplayText(value);
    if (codePointLength(normalized) > ROSTER_LIMITS.maximumNameCodePoints) {
      errors.push(error(rowNumber, fieldCode, "too_long"));
      return undefined;
    }
    return normalized;
  } catch (caught: unknown) {
    errors.push(
      error(
        rowNumber,
        fieldCode,
        caught instanceof IdentityNormalizationError && caught.code === "identity_text_unsafe"
          ? "unsafe_text"
          : "invalid_value"
      )
    );
    return undefined;
  }
}

function parseAliases(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: false
): readonly string[] | undefined;
function parseAliases(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: true
): RosterFieldUpdate<readonly string[]> | undefined;
// eslint-disable-next-line complexity -- Alias parsing keeps bounded validation failures explicit.
function parseAliases(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: boolean
): readonly string[] | RosterFieldUpdate<readonly string[]> | undefined {
  if (isBlank(value)) return update ? keep : Object.freeze([]);
  if (value === ROSTER_CLEAR_LITERAL) return update ? clear : Object.freeze([]);
  if (typeof value !== "string") {
    errors.push(error(rowNumber, "aliases", "invalid_value"));
    return undefined;
  }
  const aliases: string[] = [];
  const normalizedSeen = new Set<string>();
  try {
    for (const line of value.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      const display = normalizeIdentityDisplayText(line);
      if (codePointLength(display) > ROSTER_LIMITS.maximumAliasCodePoints) {
        errors.push(error(rowNumber, "aliases", "too_long"));
        return undefined;
      }
      const normalized = normalizeIdentityLookupText(display);
      if (normalizedSeen.has(normalized)) continue;
      normalizedSeen.add(normalized);
      aliases.push(display);
    }
  } catch (caught: unknown) {
    errors.push(
      error(
        rowNumber,
        "aliases",
        caught instanceof IdentityNormalizationError && caught.code === "identity_text_unsafe"
          ? "unsafe_text"
          : "invalid_value"
      )
    );
    return undefined;
  }
  if (aliases.length > ROSTER_LIMITS.maximumAliases) {
    errors.push(error(rowNumber, "aliases", "too_long"));
    return undefined;
  }
  const frozen = Object.freeze(aliases);
  return update ? Object.freeze({ kind: "set", value: frozen }) : frozen;
}

function parseStatus(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: false
): ChildIdentityStatus | undefined;
function parseStatus(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: true
): RosterRequiredFieldUpdate<ChildIdentityStatus> | undefined;
function parseStatus(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[],
  update: boolean
): ChildIdentityStatus | RosterRequiredFieldUpdate<ChildIdentityStatus> | undefined {
  if (isBlank(value)) {
    if (update) return keep;
    errors.push(error(rowNumber, "status", "required"));
    return undefined;
  }
  if (!isStatus(value)) {
    errors.push(error(rowNumber, "status", "invalid_value"));
    return undefined;
  }
  return update ? Object.freeze({ kind: "set", value }) : value;
}

function validateIdentityName(
  value: unknown,
  rowNumber: number,
  errors: RosterValidationError[]
): void {
  if (!isRecord(value) || Object.keys(value).some((key) => !identityNameKeys.has(key))) {
    errors.push(error(rowNumber, "row", "invalid_value"));
    return;
  }
  for (const [key, fieldCode, reading] of [
    ["family", "family", false],
    ["given", "given", false],
    ["familyKana", "family_kana", true],
    ["givenKana", "given_kana", true]
  ] as const) {
    parseName(value[key], fieldCode, rowNumber, errors, reading);
  }
}

function validateAliases(value: unknown, rowNumber: number, errors: RosterValidationError[]): void {
  if (!Array.isArray(value) || value.some((alias) => typeof alias !== "string")) {
    errors.push(error(rowNumber, "aliases", "invalid_value"));
    return;
  }
  parseAliases(value.join("\n"), rowNumber, errors, false);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

function cellText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isStatus(value: unknown): value is ChildIdentityStatus {
  return value === "active" || value === "inactive";
}

function isSubjectReference(value: unknown): value is string {
  return typeof value === "string" && subjectReferencePattern.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    timestampPattern.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function error(
  rowNumber: number,
  fieldCode: RosterValidationFieldCode,
  code: RosterValidationErrorCode
): RosterValidationError {
  return Object.freeze({ rowNumber, fieldCode, code });
}
