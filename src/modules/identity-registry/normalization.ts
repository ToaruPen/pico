export type IdentityNormalizationErrorCode =
  | "identity_text_unsafe"
  | "identity_text_empty"
  | "identity_reading_invalid";

export class IdentityNormalizationError extends Error {
  readonly code: IdentityNormalizationErrorCode;

  constructor(code: IdentityNormalizationErrorCode) {
    super(code);
    this.name = "IdentityNormalizationError";
    this.code = code;
  }
}

export type IdentityLookupSource = Readonly<{
  family: string;
  given: string;
  familyKana: string;
  givenKana: string;
  aliases: readonly string[];
}>;

export type IdentityLookupMaterial = Readonly<{
  kind: "formal" | "reading" | "alias";
  normalizedText: string;
}>;

const whitespacePattern = /\p{White_Space}+/gu;
const asciiUppercasePattern = /[A-Z]/gu;
const validReadingPattern = /^[\u3041-\u3096\u309d\u309eー・]+$/u;
const queryHonorifics = Object.freeze(["ちゃん", "さん", "くん", "君"] as const);

export function assertSafeIdentityText(value: string): void {
  if (hasUnsafeControl(value) || hasUnpairedSurrogate(value)) {
    throw new IdentityNormalizationError("identity_text_unsafe");
  }
}

export function normalizeIdentityDisplayText(value: string): string {
  const normalized = normalizeSafeText(value).trim().replace(whitespacePattern, " ");
  return requireNonempty(normalized);
}

export function normalizeIdentityLookupText(value: string): string {
  const compact = normalizeSafeText(value)
    .replace(asciiUppercasePattern, (character) => character.toLowerCase())
    .replace(whitespacePattern, "");
  const normalized = Array.from(compact, katakanaToHiragana).join("");
  return requireNonempty(normalized);
}

export function normalizeIdentityReading(value: string): string {
  const normalized = normalizeSafeText(value).replace(whitespacePattern, "");
  const reading = Array.from(requireNonempty(normalized), katakanaToHiragana).join("");
  if (!validReadingPattern.test(reading)) {
    throw new IdentityNormalizationError("identity_reading_invalid");
  }
  return reading;
}

export function createIdentityLookupQueryVariants(value: string): readonly string[] {
  const exact = normalizeIdentityLookupText(value);
  const honorific = queryHonorifics.find((candidate) => exact.endsWith(candidate));
  if (honorific === undefined) {
    return Object.freeze([exact]);
  }
  const stripped = exact.slice(0, -honorific.length);
  return Object.freeze(stripped === "" ? [exact] : [exact, stripped]);
}

export function createIdentityLookupMaterials(
  source: IdentityLookupSource
): readonly IdentityLookupMaterial[] {
  const candidates: readonly IdentityLookupMaterial[] = [
    {
      kind: "formal",
      normalizedText: normalizeIdentityLookupText(`${source.family}${source.given}`)
    },
    {
      kind: "reading",
      normalizedText: normalizeIdentityReading(`${source.familyKana}${source.givenKana}`)
    },
    ...source.aliases.map((alias) => ({
      kind: "alias" as const,
      normalizedText: normalizeIdentityLookupText(alias)
    }))
  ];
  const seen = new Set<string>();
  const materials: IdentityLookupMaterial[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}\u0000${candidate.normalizedText}`;
    if (!seen.has(key)) {
      seen.add(key);
      materials.push(Object.freeze(candidate));
    }
  }
  return Object.freeze(materials);
}

function normalizeSafeText(value: string): string {
  assertSafeIdentityText(value);
  const normalized = value.normalize("NFKC");
  assertSafeIdentityText(normalized);
  return normalized;
}

function requireNonempty(value: string): string {
  if (value === "") {
    throw new IdentityNormalizationError("identity_text_empty");
  }
  return value;
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (isHighSurrogate(current)) {
      const next = value.charCodeAt(index + 1);
      if (!isLowSurrogate(next)) return true;
      index += 1;
    } else if (isLowSurrogate(current)) {
      return true;
    }
  }
  return false;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return Number.isFinite(value) && value >= 0xdc00 && value <= 0xdfff;
}

function katakanaToHiragana(character: string): string {
  const codePoint = character.codePointAt(0);
  if (
    codePoint !== undefined &&
    ((codePoint >= 0x30a1 && codePoint <= 0x30f6) || (codePoint >= 0x30fd && codePoint <= 0x30fe))
  ) {
    return String.fromCodePoint(codePoint - 0x60);
  }
  return character;
}
