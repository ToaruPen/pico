export type LongMemoryCategory = "care_continuity" | "facility_knowledge" | "operational_note";

export const maximumAutomatedLongMemoryDraftCount = 5;

export type SessionMemoryCutoffEntry = {
  readonly id: string;
  readonly role: "staff" | "assistant" | "system";
  readonly content: string;
};

export type SessionMemoryCutoffInput = {
  readonly sessionId: string;
  readonly cutoffAt: string;
  readonly sourceEntryIds: readonly string[];
  readonly entries: readonly SessionMemoryCutoffEntry[];
  readonly requestedBy: string;
};

export class PermanentMemoryPolicyError extends Error {
  readonly code = "policy_violation";
}

const individualChildFieldPrefixes = ["child", "individualchild", "こども", "児童", "子ども"];
const individualChildExactPurposes = new Set(["id"]);
const individualChildFieldPurposes = [
  "abuse",
  "diagnosis",
  "disability",
  "evaluation",
  "familycircumstances",
  "health",
  "monitor",
  "monitoring",
  "profile",
  "record",
  "score",
  "scoring",
  "tracking",
  "診断",
  "障害",
  "家庭事情",
  "健康",
  "記録",
  "監視",
  "評価",
  "スコア",
  "虐待",
  "追跡"
];

export function defineSessionMemoryCutoffInput(input: unknown): SessionMemoryCutoffInput {
  assertNoIndividualChildLongMemoryFields(input);
  const record = requireRecord(input, "pico session memory cutoff input is malformed");
  const sourceEntryIds = requireSourceEntryIds(record.sourceEntryIds);
  const entries = requireEntries(record.entries);
  const entryIds = new Set(entries.map((entry) => entry.id));

  if (sourceEntryIds.some((entryId) => !entryIds.has(entryId))) {
    throw new Error("pico session memory cutoff source entries are invalid");
  }

  return Object.freeze({
    sessionId: requireText(record.sessionId, "pico session memory cutoff session id is required"),
    cutoffAt: requireTimestamp(record.cutoffAt),
    sourceEntryIds,
    entries,
    requestedBy: requireText(record.requestedBy, "pico session memory cutoff requester is required")
  });
}

export function assertNoIndividualChildLongMemoryFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoIndividualChildLongMemoryFields(item);
    }

    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (isIndividualChildField(key)) {
      throw new PermanentMemoryPolicyError(
        "pico long memory must not contain structured individual child profile fields"
      );
    }

    assertNoIndividualChildLongMemoryFields(item);
  }
}

function requireSourceEntryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("pico session memory cutoff source entries are required");
  }

  const seen = new Set<string>();
  const ids = value.map((entryId) => {
    const id = requireText(entryId, "pico session memory cutoff source entries are required");

    if (seen.has(id)) {
      throw new Error("pico session memory cutoff source entries are invalid");
    }

    seen.add(id);
    return id;
  });

  return Object.freeze(ids);
}

function requireEntries(value: unknown): readonly SessionMemoryCutoffEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("pico session memory cutoff entries are required");
  }

  const seenIds = new Set<string>();

  return Object.freeze(
    value.map((entry) => {
      const record = requireRecord(entry, "pico session memory cutoff entries are required");
      const role = record.role;
      const id = requireText(record.id, "pico session memory cutoff entry id is required");

      if (seenIds.has(id)) {
        throw new Error("pico session memory cutoff source entries are invalid");
      }

      seenIds.add(id);

      if (role !== "staff" && role !== "assistant" && role !== "system") {
        throw new Error("pico session memory cutoff entry role is invalid");
      }

      return Object.freeze({
        id,
        role,
        content: requireText(record.content, "pico session memory cutoff entry content is required")
      });
    })
  );
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value, "pico session memory cutoff timestamp is required");
  const milliseconds = Date.parse(timestamp);

  if (!Number.isFinite(milliseconds)) {
    throw new Error("pico long memory timestamp is invalid");
  }

  return new Date(milliseconds).toISOString();
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value.trim();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function isIndividualChildField(key: string): boolean {
  const normalized = key
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[\p{P}\p{S}\p{Z}\s\u02bb\u02bc\ua78c]/gu, "");

  return individualChildFieldPrefixes.some((prefix) => {
    if (!normalized.startsWith(prefix)) {
      return false;
    }

    const purpose = normalized.slice(prefix.length);

    return (
      individualChildExactPurposes.has(purpose) ||
      individualChildFieldPurposes.some((marker) => purpose.includes(marker))
    );
  });
}
