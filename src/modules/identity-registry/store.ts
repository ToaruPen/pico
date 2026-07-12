import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  createIdentityLookupMaterials,
  createIdentityLookupQueryVariants,
  normalizeIdentityDisplayText,
  normalizeIdentityLookupText
} from "./normalization.js";
import {
  type ChildIdentity,
  ROSTER_NORMALIZATION_VERSION,
  ROSTER_SCHEMA_VERSION,
  validateChildIdentity
} from "./schema.js";

export type IdentityResolveResult =
  | Readonly<{ kind: "resolved"; identity: ChildIdentity }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "not_found" }>;

export type IdentityRegistryStatus = Readonly<{
  schemaVersion: number;
  normalizationVersion: number;
  registryEpoch: number;
  identityCount: number;
}>;

export type IdentityPreviewChange =
  | Readonly<{ kind: "create"; identity: ChildIdentity }>
  | Readonly<{ kind: "update"; identity: ChildIdentity; expectedRevision: number }>;

export type IdentityPreviewChangeSet = Readonly<{
  changes: readonly IdentityPreviewChange[];
  now: string;
}>;

export type IdentityPreviewSummary = Readonly<{
  previewId: string;
  baseRegistryEpoch: number;
  changeCount: number;
}>;

export type IdentityApplySummary = Readonly<{ applied: number; registryEpoch: number }>;

export type IdentityRegistryStore = Readonly<{
  status(): IdentityRegistryStatus;
  list(): readonly ChildIdentity[];
  resolve(query: string): IdentityResolveResult;
  stagePreview(input: IdentityPreviewChangeSet): IdentityPreviewSummary;
  applyPreview(previewId: string, now: string): IdentityApplySummary;
  addAlias(subjectReference: string, alias: string, now: string): void;
  removeAlias(subjectReference: string, alias: string, now: string): void;
  setStatus(subjectReference: string, status: ChildIdentity["status"], now: string): void;
  close(): void;
}>;

export type IdentityRegistryErrorCode =
  | "registry_exists"
  | "registry_unavailable"
  | "registry_schema_invalid"
  | "registry_closed"
  | "identity_invalid"
  | "identity_not_found"
  | "identity_stale"
  | "identity_collision"
  | "preview_invalid"
  | "preview_not_found"
  | "preview_stale";

export class IdentityRegistryError extends Error {
  readonly code: IdentityRegistryErrorCode;

  constructor(code: IdentityRegistryErrorCode) {
    super(code);
    this.name = "IdentityRegistryError";
    this.code = code;
  }
}

const schemaSql = `
  CREATE TABLE identity_registry_metadata (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    schema_version INTEGER NOT NULL,
    normalization_version INTEGER NOT NULL,
    registry_epoch INTEGER NOT NULL CHECK (registry_epoch >= 0)
  ) STRICT;
  CREATE TABLE identity_registry_entries (
    subject_ref TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    family TEXT NOT NULL,
    given TEXT NOT NULL,
    family_kana TEXT NOT NULL,
    given_kana TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE identity_registry_aliases (
    subject_ref TEXT NOT NULL REFERENCES identity_registry_entries(subject_ref) ON DELETE CASCADE,
    alias_position INTEGER NOT NULL CHECK (alias_position >= 0),
    alias TEXT NOT NULL,
    PRIMARY KEY (subject_ref, alias_position)
  ) STRICT;
  CREATE TABLE identity_registry_lookups (
    normalized_text TEXT NOT NULL,
    subject_ref TEXT NOT NULL REFERENCES identity_registry_entries(subject_ref) ON DELETE CASCADE,
    lookup_kind TEXT NOT NULL CHECK (lookup_kind IN ('formal', 'reading', 'alias')),
    PRIMARY KEY (normalized_text, subject_ref, lookup_kind)
  ) STRICT;
  CREATE INDEX identity_registry_lookup_text
    ON identity_registry_lookups(normalized_text);
  CREATE TABLE identity_registry_previews (
    preview_id TEXT PRIMARY KEY,
    base_registry_epoch INTEGER NOT NULL,
    changes_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`;

export function initializeIdentityRegistryDatabase(input: {
  databasePath: string;
  now: string;
}): IdentityRegistryStore {
  requireTimestamp(input.now);
  if (existsSync(input.databasePath)) throw new IdentityRegistryError("registry_exists");
  const parent = dirname(input.databasePath);
  const parentAlreadyExists = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentAlreadyExists) chmodSync(parent, 0o700);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath);
    configureDatabase(database);
    database.exec(schemaSql);
    database
      .prepare(
        `INSERT INTO identity_registry_metadata
         (singleton_id, schema_version, normalization_version, registry_epoch)
         VALUES (1, ?, ?, 0)`
      )
      .run(ROSTER_SCHEMA_VERSION, ROSTER_NORMALIZATION_VERSION);
    chmodSync(input.databasePath, 0o600);
    return createStore(database);
  } catch (caught: unknown) {
    database?.close();
    if (caught instanceof IdentityRegistryError) throw caught;
    throw new IdentityRegistryError("registry_unavailable");
  }
}

export function openIdentityRegistryDatabase(input: {
  databasePath: string;
}): IdentityRegistryStore {
  if (!existsSync(input.databasePath)) throw new IdentityRegistryError("registry_unavailable");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath);
    configureDatabase(database);
    requireMetadata(database);
    chmodSync(input.databasePath, 0o600);
    return createStore(database);
  } catch (caught: unknown) {
    database?.close();
    if (caught instanceof IdentityRegistryError) throw caught;
    throw new IdentityRegistryError("registry_unavailable");
  }
}

function createStore(database: DatabaseSync): IdentityRegistryStore {
  let closed = false;

  function requireOpen(): void {
    if (closed) throw new IdentityRegistryError("registry_closed");
  }

  function status(): IdentityRegistryStatus {
    requireOpen();
    const metadata = requireMetadata(database);
    const count = database.prepare("SELECT COUNT(*) AS count FROM identity_registry_entries").get();
    return Object.freeze({
      schemaVersion: metadata.schemaVersion,
      normalizationVersion: metadata.normalizationVersion,
      registryEpoch: metadata.registryEpoch,
      identityCount: requireInteger(rowValue(count, "count"))
    });
  }

  function list(): readonly ChildIdentity[] {
    requireOpen();
    return loadIdentities(database);
  }

  function resolve(query: string): IdentityResolveResult {
    requireOpen();
    for (const variant of createIdentityLookupQueryVariants(query)) {
      const matches = database
        .prepare(
          `SELECT DISTINCT subject_ref
           FROM identity_registry_lookups
           WHERE normalized_text = ?
           ORDER BY subject_ref`
        )
        .all(variant)
        .map((row) => requireString(rowValue(row, "subject_ref")));
      if (matches.length > 1) return Object.freeze({ kind: "ambiguous" });
      if (matches.length === 1) {
        return Object.freeze({
          kind: "resolved",
          identity: loadIdentity(database, matches[0] as string)
        });
      }
    }
    return Object.freeze({ kind: "not_found" });
  }

  function stagePreview(input: IdentityPreviewChangeSet): IdentityPreviewSummary {
    requireOpen();
    requireTimestamp(input.now);
    if (input.changes.length === 0) throw new IdentityRegistryError("preview_invalid");
    const current = loadIdentities(database);
    const resulting = applyChangesInMemory(current, input.changes);
    assertCompatible(resulting);
    const previewId = randomUUID();
    const baseRegistryEpoch = requireMetadata(database).registryEpoch;
    database
      .prepare(
        `INSERT INTO identity_registry_previews
         (preview_id, base_registry_epoch, changes_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(previewId, baseRegistryEpoch, JSON.stringify(input.changes), input.now);
    return Object.freeze({ previewId, baseRegistryEpoch, changeCount: input.changes.length });
  }

  function applyPreview(previewId: string, now: string): IdentityApplySummary {
    requireOpen();
    requireTimestamp(now);
    const preview = readPreview(database, previewId);
    database.exec("BEGIN IMMEDIATE");
    try {
      const metadata = requireMetadata(database);
      if (metadata.registryEpoch !== preview.baseRegistryEpoch) {
        database
          .prepare("DELETE FROM identity_registry_previews WHERE preview_id = ?")
          .run(previewId);
        database.exec("COMMIT");
        throw new IdentityRegistryError("preview_stale");
      }
      const current = loadIdentities(database);
      const resulting = applyChangesInMemory(current, preview.changes);
      assertCompatible(resulting);
      for (const change of preview.changes) {
        writeIdentity(
          database,
          change.identity,
          change.kind,
          change.kind === "update" ? change.expectedRevision : undefined
        );
      }
      rebuildLookups(database, resulting);
      const registryEpoch = metadata.registryEpoch + 1;
      database
        .prepare("UPDATE identity_registry_metadata SET registry_epoch = ? WHERE singleton_id = 1")
        .run(registryEpoch);
      database
        .prepare("DELETE FROM identity_registry_previews WHERE preview_id = ?")
        .run(previewId);
      database.exec("COMMIT");
      return Object.freeze({ applied: preview.changes.length, registryEpoch });
    } catch (caught: unknown) {
      if (!(caught instanceof IdentityRegistryError && caught.code === "preview_stale")) {
        rollback(database);
      }
      throw caught;
    }
  }

  function updateIdentity(
    subjectReference: string,
    now: string,
    update: (identity: ChildIdentity) => ChildIdentity | undefined
  ): void {
    requireOpen();
    requireTimestamp(now);
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = loadIdentities(database);
      const index = current.findIndex((identity) => identity.subjectRef === subjectReference);
      if (index < 0) throw new IdentityRegistryError("identity_not_found");
      const existing = current[index] as ChildIdentity;
      const candidate = update(existing);
      if (candidate === undefined) {
        database.exec("ROLLBACK");
        return;
      }
      const changed = freezeIdentity(candidate);
      if (validateChildIdentity(changed).length > 0) {
        throw new IdentityRegistryError("identity_invalid");
      }
      const resulting = [...current];
      resulting[index] = changed;
      assertCompatible(resulting);
      writeIdentity(database, changed, "update", existing.revision);
      rebuildLookups(database, resulting);
      database.exec(
        "UPDATE identity_registry_metadata SET registry_epoch = registry_epoch + 1 WHERE singleton_id = 1"
      );
      database.exec("COMMIT");
    } catch (caught: unknown) {
      rollback(database);
      throw caught;
    }
  }

  return Object.freeze({
    status,
    list,
    resolve,
    stagePreview,
    applyPreview,
    addAlias(subjectReference, alias, now) {
      const displayAlias = normalizeIdentityDisplayText(alias);
      const normalizedAlias = normalizeIdentityLookupText(displayAlias);
      updateIdentity(subjectReference, now, (identity) => {
        if (
          identity.aliases.some(
            (candidate) => normalizeIdentityLookupText(candidate) === normalizedAlias
          )
        ) {
          return undefined;
        }
        return {
          ...identity,
          aliases: [...identity.aliases, displayAlias],
          revision: identity.revision + 1,
          updatedAt: now
        };
      });
    },
    removeAlias(subjectReference, alias, now) {
      const normalizedAlias = normalizeIdentityLookupText(alias);
      updateIdentity(subjectReference, now, (identity) => {
        const aliases = identity.aliases.filter(
          (candidate) => normalizeIdentityLookupText(candidate) !== normalizedAlias
        );
        if (aliases.length === identity.aliases.length) return undefined;
        return {
          ...identity,
          aliases,
          revision: identity.revision + 1,
          updatedAt: now
        };
      });
    },
    setStatus(subjectReference, identityStatus, now) {
      updateIdentity(subjectReference, now, (identity) =>
        identity.status === identityStatus
          ? undefined
          : {
              ...identity,
              status: identityStatus,
              revision: identity.revision + 1,
              updatedAt: now
            }
      );
    },
    close() {
      if (!closed) {
        closed = true;
        database.close();
      }
    }
  });
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = DELETE");
}

function requireMetadata(database: DatabaseSync): {
  schemaVersion: number;
  normalizationVersion: number;
  registryEpoch: number;
} {
  let row: Record<string, SQLOutputValue> | undefined;
  try {
    row = database
      .prepare(
        `SELECT schema_version, normalization_version, registry_epoch
         FROM identity_registry_metadata WHERE singleton_id = 1`
      )
      .get();
  } catch {
    throw new IdentityRegistryError("registry_schema_invalid");
  }
  if (row === undefined) throw new IdentityRegistryError("registry_schema_invalid");
  const schemaVersion = requireInteger(rowValue(row, "schema_version"));
  const normalizationVersion = requireInteger(rowValue(row, "normalization_version"));
  const registryEpoch = requireInteger(rowValue(row, "registry_epoch"));
  if (
    schemaVersion !== ROSTER_SCHEMA_VERSION ||
    normalizationVersion !== ROSTER_NORMALIZATION_VERSION
  ) {
    throw new IdentityRegistryError("registry_schema_invalid");
  }
  return { schemaVersion, normalizationVersion, registryEpoch };
}

function loadIdentities(database: DatabaseSync): readonly ChildIdentity[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT subject_ref, revision, family, given, family_kana, given_kana, status, updated_at
         FROM identity_registry_entries ORDER BY rowid`
      )
      .all()
      .map((row) => materializeIdentity(database, row))
  );
}

function loadIdentity(database: DatabaseSync, subjectReference: string): ChildIdentity {
  const row = database
    .prepare(
      `SELECT subject_ref, revision, family, given, family_kana, given_kana, status, updated_at
       FROM identity_registry_entries WHERE subject_ref = ?`
    )
    .get(subjectReference);
  if (row === undefined) throw new IdentityRegistryError("identity_not_found");
  return materializeIdentity(database, row);
}

function materializeIdentity(database: DatabaseSync, row: unknown): ChildIdentity {
  const subjectReference = requireString(rowValue(row, "subject_ref"));
  const aliases = database
    .prepare(
      `SELECT alias FROM identity_registry_aliases
       WHERE subject_ref = ? ORDER BY alias_position`
    )
    .all(subjectReference)
    .map((aliasRow) => requireString(rowValue(aliasRow, "alias")));
  return freezeIdentity({
    subjectRef: subjectReference,
    revision: requireInteger(rowValue(row, "revision")),
    name: {
      family: requireString(rowValue(row, "family")),
      given: requireString(rowValue(row, "given")),
      familyKana: requireString(rowValue(row, "family_kana")),
      givenKana: requireString(rowValue(row, "given_kana"))
    },
    aliases,
    status: requireStatus(rowValue(row, "status")),
    updatedAt: requireString(rowValue(row, "updated_at"))
  });
}

function writeIdentity(
  database: DatabaseSync,
  identity: ChildIdentity,
  kind: IdentityPreviewChange["kind"],
  expectedRevision?: number
): void {
  if (kind === "create") {
    database
      .prepare(
        `INSERT INTO identity_registry_entries
         (subject_ref, revision, family, given, family_kana, given_kana, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        identity.subjectRef,
        identity.revision,
        identity.name.family,
        identity.name.given,
        identity.name.familyKana,
        identity.name.givenKana,
        identity.status,
        identity.updatedAt
      );
  } else {
    if (expectedRevision === undefined) {
      throw new IdentityRegistryError("identity_stale");
    }
    const result = database
      .prepare(
        `UPDATE identity_registry_entries
         SET revision = ?, family = ?, given = ?, family_kana = ?, given_kana = ?,
             status = ?, updated_at = ?
         WHERE subject_ref = ? AND revision = ?`
      )
      .run(
        identity.revision,
        identity.name.family,
        identity.name.given,
        identity.name.familyKana,
        identity.name.givenKana,
        identity.status,
        identity.updatedAt,
        identity.subjectRef,
        expectedRevision
      );
    if (Number(result.changes) !== 1) throw new IdentityRegistryError("identity_stale");
  }
  database
    .prepare("DELETE FROM identity_registry_aliases WHERE subject_ref = ?")
    .run(identity.subjectRef);
  const insertAlias = database.prepare(
    `INSERT INTO identity_registry_aliases (subject_ref, alias_position, alias) VALUES (?, ?, ?)`
  );
  for (const [position, alias] of identity.aliases.entries()) {
    insertAlias.run(identity.subjectRef, position, alias);
  }
}

function rebuildLookups(database: DatabaseSync, identities: readonly ChildIdentity[]): void {
  database.exec("DELETE FROM identity_registry_lookups");
  const insert = database.prepare(
    `INSERT INTO identity_registry_lookups (normalized_text, subject_ref, lookup_kind)
     VALUES (?, ?, ?)`
  );
  for (const identity of identities) {
    for (const material of createIdentityLookupMaterials({
      ...identity.name,
      aliases: identity.aliases
    })) {
      insert.run(material.normalizedText, identity.subjectRef, material.kind);
    }
  }
}

// eslint-disable-next-line complexity -- Create and update invariants are checked in one linear pass.
function applyChangesInMemory(
  current: readonly ChildIdentity[],
  changes: readonly IdentityPreviewChange[]
): readonly ChildIdentity[] {
  const resulting = current.map(freezeIdentity);
  const touched = new Set<string>();
  for (const change of changes) {
    if (touched.has(change.identity.subjectRef)) throw new IdentityRegistryError("preview_invalid");
    touched.add(change.identity.subjectRef);
    if (validateChildIdentity(change.identity).length > 0) {
      throw new IdentityRegistryError("identity_invalid");
    }
    const index = resulting.findIndex(
      (identity) => identity.subjectRef === change.identity.subjectRef
    );
    if (change.kind === "create") {
      if (index >= 0 || change.identity.revision !== 1) {
        throw new IdentityRegistryError("preview_invalid");
      }
      resulting.push(freezeIdentity(change.identity));
    } else {
      const existing = resulting[index];
      if (
        existing === undefined ||
        existing.revision !== change.expectedRevision ||
        change.identity.revision !== change.expectedRevision + 1
      ) {
        throw new IdentityRegistryError("preview_stale");
      }
      resulting[index] = freezeIdentity(change.identity);
    }
  }
  return Object.freeze(resulting);
}

function assertCompatible(identities: readonly ChildIdentity[]): void {
  const byText = new Map<string, { subjectRef: string; kind: "formal" | "reading" | "alias" }[]>();
  for (const identity of identities) {
    for (const material of createIdentityLookupMaterials({
      ...identity.name,
      aliases: identity.aliases
    })) {
      const entries = byText.get(material.normalizedText) ?? [];
      entries.push({ subjectRef: identity.subjectRef, kind: material.kind });
      byText.set(material.normalizedText, entries);
    }
  }
  for (const entries of byText.values()) {
    const subjects = new Set(entries.map(({ subjectRef }) => subjectRef));
    if (subjects.size > 1 && entries.some(({ kind }) => kind === "alias")) {
      throw new IdentityRegistryError("identity_collision");
    }
  }
}

function readPreview(
  database: DatabaseSync,
  previewId: string
): { baseRegistryEpoch: number; changes: readonly IdentityPreviewChange[] } {
  const row = database
    .prepare(
      `SELECT base_registry_epoch, changes_json FROM identity_registry_previews WHERE preview_id = ?`
    )
    .get(previewId);
  if (row === undefined) throw new IdentityRegistryError("preview_not_found");
  let changes: unknown;
  try {
    changes = JSON.parse(requireString(rowValue(row, "changes_json")));
  } catch {
    throw new IdentityRegistryError("preview_invalid");
  }
  if (!Array.isArray(changes)) throw new IdentityRegistryError("preview_invalid");
  return {
    baseRegistryEpoch: requireInteger(rowValue(row, "base_registry_epoch")),
    changes: changes as readonly IdentityPreviewChange[]
  };
}

function freezeIdentity(identity: ChildIdentity): ChildIdentity {
  return Object.freeze({
    ...identity,
    name: Object.freeze({ ...identity.name }),
    aliases: Object.freeze([...identity.aliases])
  });
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The transaction may already have committed a consumed stale preview.
  }
}

function rowValue(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row) || !(key in row)) {
    throw new IdentityRegistryError("registry_schema_invalid");
  }
  return (row as Record<string, unknown>)[key];
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new IdentityRegistryError("registry_schema_invalid");
  return value;
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new IdentityRegistryError("registry_schema_invalid");
  }
  return value;
}

function requireStatus(value: unknown): ChildIdentity["status"] {
  if (value !== "active" && value !== "inactive") {
    throw new IdentityRegistryError("registry_schema_invalid");
  }
  return value;
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new IdentityRegistryError("identity_invalid");
  }
}
