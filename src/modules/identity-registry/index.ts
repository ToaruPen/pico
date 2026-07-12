import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { PicoModule } from "../../orchestrator/contracts.js";
import type { StructuredAuditLog } from "../audit/index.js";
import type {
  ChildIdentity,
  RosterFieldUpdate,
  RosterRequiredFieldUpdate,
  RosterRowPatch,
  RosterValidationFieldCode
} from "./schema.js";
import {
  type IdentityApplySummary,
  type IdentityPreviewChange,
  type IdentityRegistryStatus,
  type IdentityRegistryStore,
  type IdentityResolveResult,
  initializeIdentityRegistryDatabase,
  openIdentityRegistryDatabase
} from "./store.js";
import {
  createRosterExportWorkbook,
  createRosterTemplateWorkbook,
  parseRosterWorkbook
} from "./workbook.js";

export type OwnerApprovalAssertion = Readonly<{ ownerApproved: boolean }>;
export type IdentityPreviewFieldCode = "formal_name" | "formal_reading" | "aliases" | "status";
export type IdentityPreviewRowChange = Readonly<{
  rowNumber: number;
  operation: "create" | "update";
  fieldCodes: readonly IdentityPreviewFieldCode[];
}>;
export type IdentityPreviewCounts = Readonly<{
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
}>;
export type IdentityPreviewRowError = Readonly<{
  rowNumber: number;
  fieldCode: RosterValidationFieldCode;
  code:
    | "revision_stale"
    | "identity_not_found"
    | "invalid_value"
    | "unknown_field"
    | "required"
    | "clear_not_allowed"
    | "unsafe_text"
    | "duplicate_value"
    | "too_long";
}>;
export type IdentityWorkbookPreview =
  | Readonly<{
      ok: true;
      applicable: true;
      counts: IdentityPreviewCounts;
      changes: readonly IdentityPreviewRowChange[];
      previewId: string;
    }>
  | Readonly<{
      ok: true;
      applicable: false;
      resultCode: "no_changes";
      counts: IdentityPreviewCounts;
      changes: readonly [];
    }>
  | Readonly<{
      ok: false;
      applicable: false;
      resultCode: "workbook_validation_failed";
      counts: IdentityPreviewCounts;
      changes: readonly [];
      errors: readonly IdentityPreviewRowError[];
    }>;

export type IdentityRegistryService = Readonly<{
  status(): IdentityRegistryStatus;
  resolve(query: string): IdentityResolveResult;
  createTemplateWorkbook(): Promise<Buffer>;
  previewWorkbook(path: string): Promise<IdentityWorkbookPreview>;
  applyPreview(previewId: string, approval: OwnerApprovalAssertion): IdentityApplySummary;
  createExportWorkbook(approval: OwnerApprovalAssertion): Promise<Buffer>;
  addAlias(subjectReference: string, alias: string, approval: OwnerApprovalAssertion): void;
  removeAlias(subjectReference: string, alias: string, approval: OwnerApprovalAssertion): void;
  activate(subjectReference: string, approval: OwnerApprovalAssertion): void;
  deactivate(subjectReference: string, approval: OwnerApprovalAssertion): void;
  close(): void;
}>;

export type IdentityRegistryServiceOptions = Readonly<{
  now?: () => string;
  audit?: StructuredAuditLog;
}>;
export type NativeIdentityRegistryOptions = IdentityRegistryServiceOptions &
  Readonly<{ databasePath?: string }>;

export class IdentityRegistryServiceError extends Error {
  readonly code: "owner_approval_required";

  constructor() {
    super("owner_approval_required");
    this.name = "IdentityRegistryServiceError";
    this.code = "owner_approval_required";
  }
}

const noPreviewChanges: readonly [] = [];

export function createIdentityRegistryModule(): PicoModule {
  return {
    metadata: {
      kind: "identity_registry",
      status: "available",
      summary: "Provides a local child identity registry for deterministic pseudonym resolution.",
      capabilities: [
        {
          id: "identity_registry.resolve",
          description: "Resolve a local formal name, reading, or registered alias exactly."
        },
        {
          id: "identity_registry.roster",
          description: "Manage a local plaintext roster through owner-approved workflows."
        }
      ]
    }
  };
}

export function createIdentityRegistryService(
  store: IdentityRegistryStore,
  options: IdentityRegistryServiceOptions = {}
): IdentityRegistryService {
  const now = options.now ?? (() => new Date().toISOString());
  const audit = options.audit;
  return Object.freeze({
    status: () => store.status(),
    resolve: (query) => store.resolve(query),
    createTemplateWorkbook: () => createRosterTemplateWorkbook(now()),
    previewWorkbook: async (path) => previewWorkbook(store, path, now(), audit),
    applyPreview(previewId, approval) {
      requireOwnerApproval(approval);
      const summary = store.applyPreview(previewId, now());
      recordAudit(audit, "identity_registry.apply", now(), true, summary.applied);
      return summary;
    },
    createExportWorkbook(approval) {
      requireOwnerApproval(approval);
      return createRosterExportWorkbook(store.list(), now());
    },
    addAlias(subjectReference, alias, approval) {
      requireOwnerApproval(approval);
      store.addAlias(subjectReference, alias, now());
      recordAudit(audit, "identity_registry.alias_add", now(), true, 1);
    },
    removeAlias(subjectReference, alias, approval) {
      requireOwnerApproval(approval);
      store.removeAlias(subjectReference, alias, now());
      recordAudit(audit, "identity_registry.alias_remove", now(), true, 1);
    },
    activate(subjectReference, approval) {
      requireOwnerApproval(approval);
      store.setStatus(subjectReference, "active", now());
      recordAudit(audit, "identity_registry.activate", now(), true, 1);
    },
    deactivate(subjectReference, approval) {
      requireOwnerApproval(approval);
      store.setStatus(subjectReference, "inactive", now());
      recordAudit(audit, "identity_registry.deactivate", now(), true, 1);
    },
    close: () => store.close()
  });
}

export function initializeIdentityRegistry(
  options: NativeIdentityRegistryOptions = {},
  approval?: OwnerApprovalAssertion
): IdentityRegistryService {
  requireOwnerApproval(approval ?? { ownerApproved: false });
  const now = options.now ?? (() => new Date().toISOString());
  const store = initializeIdentityRegistryDatabase({
    databasePath: resolveDatabasePath(options.databasePath),
    now: now()
  });
  recordAudit(options.audit, "identity_registry.init", now(), true, 0);
  return createIdentityRegistryService(store, options);
}

export function openIdentityRegistry(
  options: NativeIdentityRegistryOptions = {}
): IdentityRegistryService {
  const store = openIdentityRegistryDatabase({
    databasePath: resolveDatabasePath(options.databasePath)
  });
  return createIdentityRegistryService(store, options);
}

// eslint-disable-next-line complexity -- The flat branches map the fixed preview result variants.
async function previewWorkbook(
  store: IdentityRegistryStore,
  path: string,
  now: string,
  audit: StructuredAuditLog | undefined
): Promise<IdentityWorkbookPreview> {
  const parsed = await parseRosterWorkbook(path);
  if (parsed.errors.length > 0) {
    return Object.freeze({
      ok: false,
      applicable: false,
      resultCode: "workbook_validation_failed",
      counts: counts(0, 0, 0, parsed.errors.length),
      changes: noPreviewChanges,
      errors: Object.freeze(parsed.errors.map((error) => Object.freeze({ ...error })))
    });
  }
  const current = store.list();
  const currentBySubject = new Map(current.map((identity) => [identity.subjectRef, identity]));
  const storeChanges: IdentityPreviewChange[] = [];
  const previewChanges: IdentityPreviewRowChange[] = [];
  const errors: IdentityPreviewRowError[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of parsed.rows) {
    if (row.kind === "create") {
      const identity = materializeCreatedIdentity(row, now);
      storeChanges.push(Object.freeze({ kind: "create", identity }));
      previewChanges.push(createRowChange(row));
      created += 1;
      continue;
    }
    const existing = currentBySubject.get(row.subjectRef);
    if (existing === undefined) {
      errors.push(
        Object.freeze({
          rowNumber: row.rowNumber,
          fieldCode: "pico_id",
          code: "identity_not_found"
        })
      );
      continue;
    }
    if (existing.revision !== row.revision) {
      errors.push(
        Object.freeze({ rowNumber: row.rowNumber, fieldCode: "revision", code: "revision_stale" })
      );
      continue;
    }
    const candidate = materializeUpdatedIdentity(existing, row, now);
    const fieldCodes = changedFieldCodes(existing, candidate);
    if (fieldCodes.length === 0) {
      unchanged += 1;
      continue;
    }
    storeChanges.push(
      Object.freeze({ kind: "update", identity: candidate, expectedRevision: existing.revision })
    );
    previewChanges.push(
      Object.freeze({
        rowNumber: row.rowNumber,
        operation: "update",
        fieldCodes: Object.freeze(fieldCodes)
      })
    );
    updated += 1;
  }

  if (errors.length > 0) {
    return Object.freeze({
      ok: false,
      applicable: false,
      resultCode: "workbook_validation_failed",
      counts: counts(created, updated, unchanged, errors.length),
      changes: noPreviewChanges,
      errors: Object.freeze(errors)
    });
  }
  if (storeChanges.length === 0) {
    return Object.freeze({
      ok: true,
      applicable: false,
      resultCode: "no_changes",
      counts: counts(created, updated, unchanged, 0),
      changes: noPreviewChanges
    });
  }
  const staged = store.stagePreview({ changes: storeChanges, now });
  recordAudit(audit, "identity_registry.preview", now, false, storeChanges.length);
  return Object.freeze({
    ok: true,
    applicable: true,
    counts: counts(created, updated, unchanged, 0),
    changes: Object.freeze(previewChanges),
    previewId: staged.previewId
  });
}

function materializeCreatedIdentity(
  row: Extract<RosterRowPatch, { kind: "create" }>,
  now: string
): ChildIdentity {
  return freezeIdentity({
    subjectRef: randomUUID(),
    revision: 1,
    name: row.name,
    aliases: row.aliases,
    status: row.status,
    updatedAt: now
  });
}

function materializeUpdatedIdentity(
  current: ChildIdentity,
  row: Extract<RosterRowPatch, { kind: "update" }>,
  now: string
): ChildIdentity {
  return freezeIdentity({
    ...current,
    revision: current.revision + 1,
    name: {
      family: applyRequired(row.family, current.name.family),
      given: applyRequired(row.given, current.name.given),
      familyKana: applyRequired(row.familyKana, current.name.familyKana),
      givenKana: applyRequired(row.givenKana, current.name.givenKana)
    },
    aliases: applyAliases(row.aliases, current.aliases),
    status: applyRequired(row.status, current.status),
    updatedAt: now
  });
}

function applyRequired<T>(update: RosterRequiredFieldUpdate<T>, current: T): T {
  return update.kind === "set" ? update.value : current;
}

function applyAliases(
  update: RosterFieldUpdate<readonly string[]>,
  current: readonly string[]
): readonly string[] {
  if (update.kind === "set") return update.value;
  if (update.kind === "clear") return [];
  return current;
}

function changedFieldCodes(
  current: ChildIdentity,
  candidate: ChildIdentity
): IdentityPreviewFieldCode[] {
  const fields: IdentityPreviewFieldCode[] = [];
  if (
    current.name.family !== candidate.name.family ||
    current.name.given !== candidate.name.given
  ) {
    fields.push("formal_name");
  }
  if (
    current.name.familyKana !== candidate.name.familyKana ||
    current.name.givenKana !== candidate.name.givenKana
  ) {
    fields.push("formal_reading");
  }
  if (!isDeepStrictEqual(current.aliases, candidate.aliases)) fields.push("aliases");
  if (current.status !== candidate.status) fields.push("status");
  return fields;
}

function createRowChange(
  row: Extract<RosterRowPatch, { kind: "create" }>
): IdentityPreviewRowChange {
  const fieldCodes: IdentityPreviewFieldCode[] = ["formal_name", "formal_reading", "status"];
  if (row.aliases.length > 0) fieldCodes.push("aliases");
  return Object.freeze({
    rowNumber: row.rowNumber,
    operation: "create",
    fieldCodes: Object.freeze(fieldCodes)
  });
}

function counts(
  created: number,
  updated: number,
  unchanged: number,
  errors: number
): IdentityPreviewCounts {
  return Object.freeze({ created, updated, unchanged, errors });
}

function requireOwnerApproval(approval: OwnerApprovalAssertion): void {
  if (!approval.ownerApproved) throw new IdentityRegistryServiceError();
}

function recordAudit(
  audit: StructuredAuditLog | undefined,
  name: string,
  occurredAt: string,
  ownerApproved: boolean,
  changeCount: number
): void {
  audit?.record({
    category: "identity_registry",
    name,
    severity: "info",
    occurredAt,
    summary: "Identity registry operation recorded.",
    attributes: {
      owner_approval_asserted: ownerApproved,
      change_count: changeCount,
      result_code: "ok"
    }
  });
}

function resolveDatabasePath(path: string | undefined): string {
  if (path !== undefined) return resolve(path);
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "pico", "identity-registry.sqlite");
}

function freezeIdentity(identity: ChildIdentity): ChildIdentity {
  return Object.freeze({
    ...identity,
    name: Object.freeze({ ...identity.name }),
    aliases: Object.freeze([...identity.aliases])
  });
}
