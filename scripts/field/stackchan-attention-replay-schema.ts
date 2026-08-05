import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type StackChanAttentionReplayJsonSchema = Readonly<Record<string, unknown>>;

type ValidationIssue = {
  readonly path: string;
  readonly message: string;
};

const schemaUrl = new URL("./stackchan-attention-replay-report.schema.json", import.meta.url);

export function loadStackChanAttentionReplaySchema(): StackChanAttentionReplayJsonSchema {
  const parsed = parseJsonRejectingDuplicateKeys(
    readFileSync(schemaUrl, "utf8"),
    "StackChan attention replay schema"
  );
  if (!isRecord(parsed)) {
    throw new Error("StackChan attention replay schema must be an object");
  }
  return parsed;
}

export function parseJsonRejectingDuplicateKeys(raw: string, label: string): unknown {
  const state: JsonParserState = { raw, label, index: 0 };
  parseJsonValue(state, "$");
  skipJsonWhitespace(state);
  if (state.index !== raw.length) {
    throw invalidJson(state, "unexpected trailing content");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidJson(state, "JSON.parse rejected the document");
  }
}

type JsonParserState = {
  readonly raw: string;
  readonly label: string;
  index: number;
};

function parseJsonValue(state: JsonParserState, path: string): void {
  skipJsonWhitespace(state);
  const token = state.raw[state.index];
  if (token === "{") {
    parseJsonObject(state, path);
    return;
  }
  if (token === "[") {
    parseJsonArray(state, path);
    return;
  }
  if (token === '"') {
    parseJsonString(state);
    return;
  }
  if (token === "t") {
    consumeJsonLiteral(state, "true");
    return;
  }
  if (token === "f") {
    consumeJsonLiteral(state, "false");
    return;
  }
  if (token === "n") {
    consumeJsonLiteral(state, "null");
    return;
  }
  parseJsonNumber(state);
}

function parseJsonObject(state: JsonParserState, path: string): void {
  state.index += 1;
  skipJsonWhitespace(state);
  if (consumeJsonToken(state, "}")) {
    return;
  }
  const keys = new Set<string>();
  for (;;) {
    skipJsonWhitespace(state);
    const key = parseJsonString(state);
    if (keys.has(key)) {
      throw new Error(`${state.label} has duplicate JSON key ${JSON.stringify(key)} at ${path}`);
    }
    keys.add(key);
    skipJsonWhitespace(state);
    requireJsonToken(state, ":");
    parseJsonValue(state, jsonPropertyPath(path, key));
    skipJsonWhitespace(state);
    if (consumeJsonToken(state, "}")) {
      return;
    }
    requireJsonToken(state, ",");
  }
}

function parseJsonArray(state: JsonParserState, path: string): void {
  state.index += 1;
  skipJsonWhitespace(state);
  if (consumeJsonToken(state, "]")) {
    return;
  }
  let index = 0;
  for (;;) {
    parseJsonValue(state, `${path}[${index}]`);
    index += 1;
    skipJsonWhitespace(state);
    if (consumeJsonToken(state, "]")) {
      return;
    }
    requireJsonToken(state, ",");
  }
}

function parseJsonString(state: JsonParserState): string {
  if (state.raw[state.index] !== '"') {
    throw invalidJson(state, "expected a string");
  }
  const start = state.index;
  state.index += 1;
  while (state.index < state.raw.length) {
    const token = state.raw[state.index];
    if (token === '"') {
      state.index += 1;
      try {
        return JSON.parse(state.raw.slice(start, state.index)) as string;
      } catch {
        throw invalidJson(state, "invalid string");
      }
    }
    if (token === "\\") {
      consumeJsonStringEscape(state);
      continue;
    }
    requireJsonStringCharacter(state, token);
    state.index += 1;
  }
  throw invalidJson(state, "unterminated string");
}

function requireJsonStringCharacter(state: JsonParserState, token: string | undefined): void {
  const codePoint = token?.codePointAt(0);
  if (codePoint === undefined || codePoint < 0x20) {
    throw invalidJson(state, "invalid string character");
  }
}

function consumeJsonStringEscape(state: JsonParserState): void {
  state.index += 1;
  const escapeCode = state.raw[state.index];
  if (escapeCode === "u") {
    const digits = state.raw.slice(state.index + 1, state.index + 5);
    if (!/^[\da-f]{4}$/iu.test(digits)) {
      throw invalidJson(state, "invalid Unicode escape");
    }
    state.index += 5;
    return;
  }
  if (escapeCode === undefined || !/^["\\/bfnrt]$/u.test(escapeCode)) {
    throw invalidJson(state, "invalid string escape");
  }
  state.index += 1;
}

function parseJsonNumber(state: JsonParserState): void {
  const start = state.index;
  consumeNumberToken(state, "-");
  if (consumeNumberToken(state, "0")) {
    // A leading zero is the complete integer part.
  } else if (isNonZeroDigit(state.raw[state.index])) {
    consumeDigits(state);
  } else {
    throw invalidJson(state, "expected a JSON value");
  }
  if (consumeNumberToken(state, ".")) {
    requireNumberDigits(state);
  }
  if (isExponentMarker(state.raw[state.index])) {
    state.index += 1;
    if (state.raw[state.index] === "+" || state.raw[state.index] === "-") {
      state.index += 1;
    }
    requireNumberDigits(state);
  }
  if (state.index === start) {
    throw invalidJson(state, "expected a JSON value");
  }
}

function consumeNumberToken(state: JsonParserState, token: string): boolean {
  if (state.raw[state.index] !== token) {
    return false;
  }
  state.index += 1;
  return true;
}

function requireNumberDigits(state: JsonParserState): void {
  if (!isDigit(state.raw[state.index])) {
    throw invalidJson(state, "invalid number");
  }
  consumeDigits(state);
}

function consumeDigits(state: JsonParserState): void {
  while (isDigit(state.raw[state.index])) {
    state.index += 1;
  }
}

function isDigit(token: string | undefined): boolean {
  return token !== undefined && token >= "0" && token <= "9";
}

function isNonZeroDigit(token: string | undefined): boolean {
  return token !== undefined && token >= "1" && token <= "9";
}

function isExponentMarker(token: string | undefined): boolean {
  return token === "e" || token === "E";
}

function consumeJsonLiteral(state: JsonParserState, literal: string): void {
  if (state.raw.slice(state.index, state.index + literal.length) !== literal) {
    throw invalidJson(state, `invalid ${literal} literal`);
  }
  state.index += literal.length;
}

function skipJsonWhitespace(state: JsonParserState): void {
  while (/[\t\n\r ]/u.test(state.raw[state.index] ?? "")) {
    state.index += 1;
  }
}

function requireJsonToken(state: JsonParserState, token: string): void {
  if (!consumeJsonToken(state, token)) {
    throw invalidJson(state, `expected ${JSON.stringify(token)}`);
  }
}

function consumeJsonToken(state: JsonParserState, token: string): boolean {
  if (state.raw[state.index] !== token) {
    return false;
  }
  state.index += 1;
  return true;
}

function invalidJson(state: JsonParserState, reason: string): Error {
  return new Error(`${state.label} is invalid JSON at byte ${state.index}: ${reason}`);
}

function jsonPropertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function stackChanAttentionReplaySchemaHash(
  schema: StackChanAttentionReplayJsonSchema = loadStackChanAttentionReplaySchema()
): string {
  return hashSchemaValue(schema);
}

export function stackChanAttentionReplayEventSchemaHash(
  schema: StackChanAttentionReplayJsonSchema = loadStackChanAttentionReplaySchema()
): string {
  const eventSchema = requireDefinition(schema, "event");
  return hashSchemaValue(resolveSchemaReferences(eventSchema, schema, new Set()));
}

export function validateStackChanAttentionReplaySchemaValue(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema = loadStackChanAttentionReplaySchema()
): void {
  const issue = findValidationIssue(value, schema, schema, "$");
  if (issue !== undefined) {
    throw new Error(
      `StackChan attention replay schema validation failed at ${issue.path}: ${issue.message}`
    );
  }
}

function findValidationIssue(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  const referenced = referenceTarget(schema, rootSchema);
  if (referenced !== undefined) {
    return findValidationIssue(value, referenced, rootSchema, path);
  }
  const anyOfIssue = validateAnyOf(value, schema, rootSchema, path);
  if (anyOfIssue !== undefined) {
    return anyOfIssue;
  }
  const valueIssue = validateFixedValues(value, schema, path);
  if (valueIssue !== undefined) {
    return valueIssue;
  }
  const type = schema.type;
  if (typeof type !== "string") {
    return undefined;
  }
  const typeIssue = validateType(value, type, path);
  if (typeIssue !== undefined) {
    return typeIssue;
  }
  return validateTypeKeywords(value, type, schema, rootSchema, path);
}

function validateAnyOf(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  const anyOf = schema.anyOf;
  if (anyOf === undefined) {
    return undefined;
  }
  if (!Array.isArray(anyOf)) {
    return { path, message: "schema anyOf must be an array" };
  }
  const matched = anyOf.some(
    (candidate) =>
      isRecord(candidate) && findValidationIssue(value, candidate, rootSchema, path) === undefined
  );
  return matched ? undefined : { path, message: "value does not match any allowed schema" };
}

function validateFixedValues(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  if (Object.hasOwn(schema, "const") && !sameJsonValue(value, schema.const)) {
    return { path, message: "value does not match const" };
  }
  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.some((candidate) => sameJsonValue(value, candidate))) {
    return { path, message: "value is not in enum" };
  }
  return undefined;
}

function validateType(value: unknown, type: string, path: string): ValidationIssue | undefined {
  const valid = typeMatches(value, type);
  return valid ? undefined : { path, message: `expected ${type}` };
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === "null") {
    return value === null;
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "integer") {
    return isFiniteNumber(value) && Number.isInteger(value);
  }
  if (type === "number") {
    return isFiniteNumber(value);
  }
  return typeof value === type;
}

function validateTypeKeywords(
  value: unknown,
  type: string,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  if (type === "object") {
    return validateObjectTypeKeywords(value, schema, rootSchema, path);
  }
  if (type === "array") {
    return validateArrayTypeKeywords(value, schema, rootSchema, path);
  }
  if (type === "string") {
    return validateStringTypeKeywords(value, schema, path);
  }
  if (type === "number") {
    return validateNumberTypeKeywords(value, schema, path);
  }
  if (type === "integer") {
    return validateNumberTypeKeywords(value, schema, path);
  }
  return undefined;
}

function validateObjectTypeKeywords(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  return isRecord(value) ? validateObject(value, schema, rootSchema, path) : undefined;
}

function validateArrayTypeKeywords(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  return Array.isArray(value) ? validateArray(value, schema, rootSchema, path) : undefined;
}

function validateStringTypeKeywords(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  return typeof value === "string" ? validateString(value, schema, path) : undefined;
}

function validateNumberTypeKeywords(
  value: unknown,
  schema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  return typeof value === "number" ? validateNumber(value, schema, path) : undefined;
}

function validateObject(
  value: Readonly<Record<string, unknown>>,
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return { path, message: "object schema must declare properties" };
  }
  const missing = requiredKeys(schema).find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    return { path: propertyPath(path, missing), message: "required property is missing" };
  }
  const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
  if (schema.additionalProperties === false && extra !== undefined) {
    return { path: propertyPath(path, extra), message: "additional property is not allowed" };
  }
  return validateObjectProperties(value, properties, rootSchema, path);
}

function validateObjectProperties(
  value: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>>,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !isRecord(propertySchema)) {
      continue;
    }
    const issue = findValidationIssue(
      value[key],
      propertySchema,
      rootSchema,
      propertyPath(path, key)
    );
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

function validateArray(
  value: readonly unknown[],
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  if (!isRecord(schema.items)) {
    return undefined;
  }
  for (const [index, item] of value.entries()) {
    const issue = findValidationIssue(item, schema.items, rootSchema, `${path}[${index}]`);
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

function validateString(
  value: string,
  schema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  const minimumLengthIssue = validateMinimumLength(value, schema.minLength, path);
  if (minimumLengthIssue !== undefined) {
    return minimumLengthIssue;
  }
  const pattern = schema.pattern;
  if (pattern === undefined) {
    return undefined;
  }
  if (typeof pattern !== "string") {
    return { path, message: "schema pattern must be a string" };
  }
  return new RegExp(pattern, "u").test(value)
    ? undefined
    : { path, message: `string does not match ${pattern}` };
}

function validateMinimumLength(
  value: string,
  minimumLength: unknown,
  path: string
): ValidationIssue | undefined {
  if (minimumLength !== undefined) {
    if (
      typeof minimumLength !== "number" ||
      !Number.isInteger(minimumLength) ||
      minimumLength < 0
    ) {
      return { path, message: "schema minLength must be a non-negative integer" };
    }
    if (value.length < minimumLength) {
      return { path, message: `string must have at least ${minimumLength} characters` };
    }
  }
  return undefined;
}

function validateNumber(
  value: number,
  schema: StackChanAttentionReplayJsonSchema,
  path: string
): ValidationIssue | undefined {
  const minimum = schema.minimum;
  if (minimum === undefined) {
    return undefined;
  }
  if (typeof minimum !== "number" || !Number.isFinite(minimum)) {
    return { path, message: "schema minimum must be a finite number" };
  }
  return value >= minimum ? undefined : { path, message: `number must be at least ${minimum}` };
}

function referenceTarget(
  schema: StackChanAttentionReplayJsonSchema,
  rootSchema: StackChanAttentionReplayJsonSchema
): StackChanAttentionReplayJsonSchema | undefined {
  const reference = schema.$ref;
  if (reference === undefined) {
    return undefined;
  }
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) {
    throw new Error("StackChan attention replay schema contains an unsupported reference");
  }
  return requireDefinition(rootSchema, reference.slice("#/$defs/".length));
}

function requireDefinition(
  schema: StackChanAttentionReplayJsonSchema,
  name: string
): StackChanAttentionReplayJsonSchema {
  const definitions = schema.$defs;
  const definition = isRecord(definitions) ? definitions[name] : undefined;
  if (!isRecord(definition)) {
    throw new Error(`StackChan attention replay schema definition ${name} is missing`);
  }
  return definition;
}

function resolveSchemaReferences(
  value: unknown,
  rootSchema: StackChanAttentionReplayJsonSchema,
  references: ReadonlySet<string>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveSchemaReferences(item, rootSchema, references));
  }
  if (!isRecord(value)) {
    return value;
  }
  const reference = value.$ref;
  if (typeof reference === "string") {
    return resolveReferenceForHash(reference, rootSchema, references);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveSchemaReferences(item, rootSchema, references)
    ])
  );
}

function resolveReferenceForHash(
  reference: string,
  rootSchema: StackChanAttentionReplayJsonSchema,
  references: ReadonlySet<string>
): unknown {
  if (!reference.startsWith("#/$defs/") || references.has(reference)) {
    throw new Error("StackChan attention replay event schema contains an invalid reference");
  }
  const nextReferences = new Set(references);
  nextReferences.add(reference);
  return resolveSchemaReferences(
    requireDefinition(rootSchema, reference.slice("#/$defs/".length)),
    rootSchema,
    nextReferences
  );
}

function hashSchemaValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredKeys(schema: StackChanAttentionReplayJsonSchema): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
