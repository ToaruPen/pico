import { DatabaseSync } from "node:sqlite";

import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export type LongMemoryCategory = "care_continuity" | "facility_knowledge" | "operational_note";

export type LongMemoryStatus = "active";

export type LongMemoryReview = {
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly note?: string;
};

export type ReviewedLongMemoryInput = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags?: readonly string[];
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly reviewNote?: string;
};

export type LongMemoryRecord = {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
  readonly status: LongMemoryStatus;
  readonly correctionOf: number | undefined;
  readonly review: LongMemoryReview;
};

export type LongMemorySearchResult = Pick<LongMemoryRecord, "id" | "title" | "category">;

export type LongMemoryStore = {
  readonly writeReviewed: (input: ReviewedLongMemoryInput) => LongMemoryRecord;
  readonly read: (id: number) => LongMemoryRecord | undefined;
  readonly search: (query: string) => LongMemorySearchResult[];
  readonly correct: (id: number, input: ReviewedLongMemoryInput) => LongMemoryRecord;
  readonly delete: (id: number, review: LongMemoryReview) => void;
  readonly close: () => void;
};

export const longMemoryModuleMetadata = {
  kind: "long_memory",
  status: "planned",
  summary: "Durable facility memory based on reviewed care-continuity knowledge.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;

type LongMemoryRow = {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly tags_json: string;
  readonly correction_of: number;
  readonly reviewed_by: string;
  readonly reviewed_at: string;
  readonly review_note: string;
};

type NormalizedLongMemoryInput = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
  readonly review: Required<LongMemoryReview>;
};

const longMemoryCategories = new Set<LongMemoryCategory>([
  "care_continuity",
  "facility_knowledge",
  "operational_note"
]);
const longMemoryInputKeys = new Set([
  "title",
  "body",
  "category",
  "tags",
  "reviewedBy",
  "reviewedAt",
  "reviewNote"
]);
const individualChildTextMarkers = [
  "childid",
  "childevaluation",
  "childevaluating",
  "childmonitor",
  "childmonitoring",
  "childprofile",
  "childprofiling",
  "childtracking",
  "childscore",
  "childscoring",
  "individualchild",
  "児童id",
  "子どもid",
  "個別記録",
  "個人記録",
  "児童評価",
  "子ども評価",
  "児童の評価",
  "子どもの評価",
  "児童監視",
  "子ども監視",
  "児童の監視",
  "子どもの監視",
  "児童プロフィール",
  "子どもプロフィール",
  "児童スコア",
  "子どもスコア",
  "児童のスコア",
  "子どものスコア",
  "児童追跡",
  "子ども追跡",
  "児童の追跡",
  "子どもの追跡"
];
const individualChildFieldMarkers = [
  "childevaluation",
  "childmonitor",
  "childprofile",
  "childtracking",
  "childscore",
  "individualchild"
];
const individualChildFieldNames = new Set(["childid", "profile", "tracking", "scoring"]);

export function openLongMemoryStore(path: string): LongMemoryStore {
  const database = new DatabaseSync(path);
  initializeLongMemorySchema(database);

  return {
    writeReviewed(input) {
      return runInTransaction(database, () =>
        insertReviewedMemory(database, normalizeLongMemoryInput(input), 0, "create")
      );
    },
    read(id) {
      return readActiveMemory(database, id);
    },
    search(query) {
      return searchActiveMemories(database, requireSearchQuery(query));
    },
    correct(id, input) {
      return runInTransaction(database, () => {
        requireActiveMemory(database, id);
        const record = insertReviewedMemory(
          database,
          normalizeLongMemoryInput(input),
          id,
          "correct"
        );
        markMemoryStatus(database, id, "superseded");

        return record;
      });
    },
    delete(id, review) {
      runInTransaction(database, () => {
        const record = requireActiveMemory(database, id);
        const normalized = normalizeReview(review.reviewedBy, review.reviewedAt, review.note);
        markMemoryStatus(database, id, "deleted");
        recordMemoryEvent(database, id, "delete", normalized, JSON.stringify(record));
      });
    },
    close() {
      database.close();
    }
  };
}

function initializeLongMemorySchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS long_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('care_continuity', 'facility_knowledge', 'operational_note')
      ),
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
      correction_of INTEGER NOT NULL DEFAULT 0,
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS long_memory_entry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES long_memory_entries(id),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('create', 'correct', 'delete')),
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS long_memory_entries_fts
      USING fts5(title, body, tokenize='trigram');

    CREATE TRIGGER IF NOT EXISTS long_memory_entries_insert_fts
    AFTER INSERT ON long_memory_entries
    WHEN new.status = 'active'
    BEGIN
      INSERT INTO long_memory_entries_fts(rowid, title, body)
      VALUES (new.id, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS long_memory_entries_remove_fts
    AFTER UPDATE OF status ON long_memory_entries
    WHEN old.status = 'active' AND new.status <> 'active'
    BEGIN
      DELETE FROM long_memory_entries_fts WHERE rowid = old.id;
    END;
  `);
}

function normalizeLongMemoryInput(input: ReviewedLongMemoryInput): NormalizedLongMemoryInput {
  rejectIndividualChildFields(input);
  requireKnownInputKeys(input);
  const title = requireMemoryText(input.title);
  const body = requireMemoryText(input.body);

  rejectIndividualChildText(title);
  rejectIndividualChildText(body);

  return {
    title,
    body,
    category: requireLongMemoryCategory(input.category),
    tags: normalizeTags(input.tags),
    review: normalizeReview(input.reviewedBy, input.reviewedAt, input.reviewNote)
  };
}

function runInTransaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = run();
    database.exec("COMMIT");

    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }

    throw error;
  }
}

function insertReviewedMemory(
  database: DatabaseSync,
  input: NormalizedLongMemoryInput,
  correctionOf: number,
  eventKind: "create" | "correct"
): LongMemoryRecord {
  const result = database
    .prepare(`
      INSERT INTO long_memory_entries (
        title,
        body,
        category,
        tags_json,
        status,
        correction_of,
        reviewed_by,
        reviewed_at,
        review_note
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `)
    .run(
      input.title,
      input.body,
      input.category,
      JSON.stringify(input.tags),
      correctionOf,
      input.review.reviewedBy,
      input.review.reviewedAt,
      input.review.note
    );
  const id = Number(result.lastInsertRowid);
  const record = requireActiveMemory(database, id);

  recordMemoryEvent(database, id, eventKind, input.review, JSON.stringify(record));

  return record;
}

function readActiveMemory(database: DatabaseSync, id: number): LongMemoryRecord | undefined {
  const row = database
    .prepare(`
      SELECT
        id,
        title,
        body,
        category,
        tags_json,
        correction_of,
        reviewed_by,
        reviewed_at,
        review_note
      FROM long_memory_entries
      WHERE id = ? AND status = 'active'
    `)
    .get(id);

  if (row === undefined) {
    return undefined;
  }

  return mapLongMemoryRow(row as LongMemoryRow);
}

function searchActiveMemories(database: DatabaseSync, query: string): LongMemorySearchResult[] {
  if (query.length >= 3) {
    return searchActiveMemoriesByMatch(database, query);
  }

  return searchActiveMemoriesByLike(database, query);
}

function searchActiveMemoriesByMatch(
  database: DatabaseSync,
  query: string
): LongMemorySearchResult[] {
  return database
    .prepare(`
      SELECT e.id, e.title, e.category
      FROM long_memory_entries_fts
      JOIN long_memory_entries AS e ON e.id = long_memory_entries_fts.rowid
      WHERE long_memory_entries_fts MATCH ? AND e.status = 'active'
      ORDER BY rank, e.id
    `)
    .all(quoteFtsQuery(query))
    .map(mapSearchResult);
}

function searchActiveMemoriesByLike(
  database: DatabaseSync,
  query: string
): LongMemorySearchResult[] {
  const pattern = `%${escapeLikePattern(query)}%`;

  return database
    .prepare(`
      SELECT e.id, e.title, e.category
      FROM long_memory_entries_fts
      JOIN long_memory_entries AS e ON e.id = long_memory_entries_fts.rowid
      WHERE e.status = 'active'
        AND (
          long_memory_entries_fts.title LIKE ? ESCAPE '\\'
          OR long_memory_entries_fts.body LIKE ? ESCAPE '\\'
        )
      ORDER BY e.id
    `)
    .all(pattern, pattern)
    .map(mapSearchResult);
}

function requireActiveMemory(database: DatabaseSync, id: number): LongMemoryRecord {
  const record = readActiveMemory(database, id);

  if (record === undefined) {
    throw new Error("pico long memory entry is not active");
  }

  return record;
}

function markMemoryStatus(
  database: DatabaseSync,
  id: number,
  status: "superseded" | "deleted"
): void {
  database
    .prepare(
      "UPDATE long_memory_entries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .run(status, id);
}

function recordMemoryEvent(
  database: DatabaseSync,
  memoryId: number,
  eventKind: "create" | "correct" | "delete",
  review: Required<LongMemoryReview>,
  snapshotJson: string
): void {
  database
    .prepare(`
      INSERT INTO long_memory_entry_events (
        memory_id,
        event_kind,
        reviewed_by,
        reviewed_at,
        review_note,
        snapshot_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(memoryId, eventKind, review.reviewedBy, review.reviewedAt, review.note, snapshotJson);
}

function mapLongMemoryRow(row: LongMemoryRow): LongMemoryRecord {
  return Object.freeze({
    id: row.id,
    title: row.title,
    body: row.body,
    category: requireLongMemoryCategory(row.category),
    tags: Object.freeze(JSON.parse(row.tags_json) as string[]),
    status: "active",
    correctionOf: row.correction_of === 0 ? undefined : row.correction_of,
    review: normalizeStoredReview(row.reviewed_by, row.reviewed_at, row.review_note)
  });
}

function mapSearchResult(row: Record<string, unknown>): LongMemorySearchResult {
  return {
    id: requireRowNumber(row.id),
    title: requireRowString(row.title),
    category: requireLongMemoryCategory(row.category)
  };
}

function normalizeReview(
  reviewedBy: unknown,
  reviewedAt: unknown,
  note: unknown
): Required<LongMemoryReview> {
  const normalizedNote = note === undefined ? "" : requireMemoryText(note);
  rejectIndividualChildText(normalizedNote);

  return {
    reviewedBy: requireReviewText(reviewedBy),
    reviewedAt: requireReviewText(reviewedAt),
    note: normalizedNote
  };
}

function normalizeStoredReview(
  reviewedBy: unknown,
  reviewedAt: unknown,
  note: unknown
): Required<LongMemoryReview> {
  const normalizedNote = note === undefined ? "" : requireStoredText(note);

  return {
    reviewedBy: requireReviewText(reviewedBy),
    reviewedAt: requireReviewText(reviewedAt),
    note: normalizedNote
  };
}

function normalizeTags(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("pico long memory input is malformed");
  }

  const tags = value.map((tag) => {
    const normalized = requireMemoryText(tag);
    rejectIndividualChildText(normalized);

    return normalized;
  });

  return Object.freeze(tags);
}

function rejectIndividualChildFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (isIndividualChildField(key)) {
      throw new Error("pico long memory must not contain individual child profile data");
    }
  }
}

function requireKnownInputKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!longMemoryInputKeys.has(key)) {
      throw new Error("pico long memory input is malformed");
    }
  }
}

function isIndividualChildField(key: string): boolean {
  const normalized = key.toLowerCase();

  return (
    individualChildFieldMarkers.some((marker) => normalized.includes(marker)) ||
    individualChildFieldNames.has(normalized)
  );
}

function rejectIndividualChildText(value: string): void {
  const normalized = value.toLowerCase().replaceAll(/\s|_|-/gu, "");

  if (individualChildTextMarkers.some((marker) => normalized.includes(marker))) {
    throw new Error("pico long memory must not contain individual child profile data");
  }
}

function requireLongMemoryCategory(value: unknown): LongMemoryCategory {
  if (typeof value === "string" && longMemoryCategories.has(value as LongMemoryCategory)) {
    return value as LongMemoryCategory;
  }

  throw new Error("pico long memory category is invalid");
}

function requireMemoryText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico long memory text is required");
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error("pico long memory text is required");
  }

  return trimmed;
}

function requireReviewText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico long memory review metadata is required");
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error("pico long memory review metadata is required");
  }

  return trimmed;
}

function requireStoredText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico long memory row is malformed");
  }

  return value.trim();
}

function requireSearchQuery(value: unknown): string {
  const query = requireMemoryText(value);

  if (query.includes("\0")) {
    throw new Error("pico long memory search query is invalid");
  }

  return query;
}

function quoteFtsQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

function escapeLikePattern(query: string): string {
  return query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function requireRowNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  throw new Error("pico long memory row is malformed");
}

function requireRowString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error("pico long memory row is malformed");
}
