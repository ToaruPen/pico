import { DatabaseSync } from "node:sqlite";

import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";
import type { StructuredAuditLog } from "../audit/index.js";

export type LongMemoryCategory = "care_continuity" | "facility_knowledge" | "operational_note";

export type LongMemoryStatus = "active";
export type LongMemoryLifecycleStatus = "active" | "archived" | "deleted";

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
  readonly mem0MemoryId?: string;
  readonly sourceSessionId?: string;
  readonly importance?: number;
  readonly confidence?: number;
};

export type LongMemoryLifecycleMetadata = {
  readonly mem0MemoryId: string | undefined;
  readonly sourceSessionId: string | undefined;
  readonly importance: number;
  readonly confidence: number;
  readonly lastAccessedAt: string | undefined;
  readonly accessCount: number;
  readonly decayScore: number;
  readonly status: LongMemoryLifecycleStatus;
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
  readonly lifecycle: LongMemoryLifecycleMetadata;
};

export type LongMemorySearchResult = Pick<
  LongMemoryRecord,
  "id" | "title" | "category" | "lifecycle"
>;

export type LongMemoryDecayInput = {
  readonly now: string;
  readonly archiveThreshold: number;
  readonly deleteThreshold: number;
  readonly decayWindowDays: number;
};

export type LongMemoryDecayResult = {
  readonly id: number;
  readonly previousStatus: LongMemoryLifecycleStatus;
  readonly status: "archived" | "deleted";
  readonly decayScore: number;
  readonly mem0MemoryId: string | undefined;
};

export type LongMemoryStoreOptions = {
  readonly now?: () => string;
};

export type LongMemoryStore = {
  readonly writeReviewed: (input: ReviewedLongMemoryInput) => LongMemoryRecord;
  readonly read: (id: number) => LongMemoryRecord | undefined;
  readonly readLifecycle: (id: number) => LongMemoryLifecycleMetadata | undefined;
  readonly search: (query: string) => LongMemorySearchResult[];
  readonly runDecay: (input: LongMemoryDecayInput) => readonly LongMemoryDecayResult[];
  readonly correct: (id: number, input: ReviewedLongMemoryInput) => LongMemoryRecord;
  readonly delete: (id: number, review: LongMemoryReview) => void;
  readonly close: () => void;
};

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

export type LongMemoryCandidateState = "pending_review" | "approved" | "rejected";

export type LongMemoryCandidateDraft = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags?: readonly string[];
};

export type LongMemoryCandidateRecord = {
  readonly id: number;
  readonly sessionId: string;
  readonly sourceEntryIds: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
  readonly state: LongMemoryCandidateState;
  readonly createdAt: string;
  readonly reviewedAt: string | undefined;
  readonly review: Required<LongMemoryReview> | undefined;
  readonly promotedMemoryId: number | undefined;
};

export type SessionMemoryCandidateJobStatus = "queued" | "processing" | "processed" | "failed";

export type SessionMemoryCandidateJob = {
  readonly id: number;
  readonly sessionId: string;
  readonly status: SessionMemoryCandidateJobStatus;
  readonly sourceEntryCount: number;
  readonly queuedAt: string;
  readonly processingStartedAt: string | undefined;
  readonly processedAt: string | undefined;
};

export type SessionMemoryCandidateProcessor = (
  session: SessionMemoryCutoffInput
) => Promise<readonly LongMemoryCandidateDraft[]>;

export type SessionMemoryCandidateStoreOptions = {
  readonly processSession: SessionMemoryCandidateProcessor;
  readonly audit?: StructuredAuditLog;
  readonly now?: () => string;
};

export type SessionMemoryCandidateQueueOptions = {
  readonly audit?: StructuredAuditLog;
  readonly now?: () => string;
};

export type SessionMemoryCandidateQueue = {
  readonly enqueueSessionCutoff: (input: SessionMemoryCutoffInput) => SessionMemoryCandidateJob;
  readonly countJobs: (statuses: readonly SessionMemoryCandidateJobStatus[]) => number;
  readonly listJobs: () => readonly SessionMemoryCandidateJob[];
  readonly close: () => void;
};

export type SessionMemoryCandidateStore = {
  readonly enqueueSessionCutoff: (input: SessionMemoryCutoffInput) => SessionMemoryCandidateJob;
  readonly processNextJob: () => Promise<SessionMemoryCandidateJob | undefined>;
  readonly recoverStaleProcessingJobs: (input: {
    readonly staleBefore: string;
    readonly recoveredAt: string;
  }) => readonly SessionMemoryCandidateJob[];
  readonly countJobs: (statuses: readonly SessionMemoryCandidateJobStatus[]) => number;
  readonly listJobs: () => readonly SessionMemoryCandidateJob[];
  readonly listPending: () => readonly LongMemoryCandidateRecord[];
  readonly readCandidate: (id: number) => LongMemoryCandidateRecord | undefined;
  readonly promoteReviewed: (id: number, review: LongMemoryReview) => LongMemoryRecord;
  readonly reject: (id: number, review: LongMemoryReview) => LongMemoryCandidateRecord;
  readonly close: () => void;
};

export const longMemoryModuleMetadata = {
  kind: "long_memory",
  status: "planned",
  summary: "Durable facility memory based on reviewed care-continuity knowledge.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;

export function defineSessionMemoryCutoffInput(input: unknown): SessionMemoryCutoffInput {
  return cloneSessionMemoryCutoffInput(normalizeSessionMemoryCutoffInput(input));
}

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
  readonly mem0_memory_id: string;
  readonly source_session_id: string;
  readonly importance: number;
  readonly confidence: number;
  readonly last_accessed_at: string;
  readonly access_count: number;
  readonly decay_score: number;
  readonly status: string;
};

type LongMemoryCandidateRow = {
  readonly id: number;
  readonly session_id: string;
  readonly source_entry_ids_json: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly tags_json: string;
  readonly state: string;
  readonly created_at: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  readonly promoted_memory_id: number | null;
};

type SessionMemoryCandidateJobRow = {
  readonly id: number;
  readonly session_id: string;
  readonly status: string;
  readonly source_entry_count: number;
  readonly queued_at: string;
  readonly processing_started_at: string | null;
  readonly processed_at: string | null;
};

type QueuedSessionMemoryCandidateJobRow = SessionMemoryCandidateJobRow & {
  readonly cutoff_json: string;
};

type NormalizedLongMemoryInput = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
  readonly review: Required<LongMemoryReview>;
  readonly mem0MemoryId: string | undefined;
  readonly sourceSessionId: string | undefined;
  readonly importance: number;
  readonly confidence: number;
};

type NormalizedLongMemoryCandidateDraft = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
};

const longMemoryCategories = new Set<LongMemoryCategory>([
  "care_continuity",
  "facility_knowledge",
  "operational_note"
]);
const minimumTrigramQueryLength = 3;
const longMemoryInputKeys = new Set([
  "title",
  "body",
  "category",
  "tags",
  "reviewedBy",
  "reviewedAt",
  "reviewNote",
  "mem0MemoryId",
  "sourceSessionId",
  "importance",
  "confidence"
]);
const longMemoryCandidateDraftKeys = new Set(["title", "body", "category", "tags"]);
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

export function openLongMemoryStore(
  path: string,
  options: LongMemoryStoreOptions = {}
): LongMemoryStore {
  const database = new DatabaseSync(path);
  initializeLongMemorySchema(database);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    writeReviewed(input) {
      return runInTransaction(database, () =>
        insertReviewedMemory(database, normalizeLongMemoryInput(input), 0, "create")
      );
    },
    read(id) {
      return readActiveMemory(database, id);
    },
    readLifecycle(id) {
      return readMemoryLifecycle(database, id);
    },
    search(query) {
      return searchActiveMemories(database, requireSearchQuery(query), requireTimestamp(now()));
    },
    runDecay(input) {
      return runInTransaction(database, () => runLongMemoryDecay(database, input));
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

export function openSessionMemoryCandidateQueue(
  path: string,
  options: SessionMemoryCandidateQueueOptions = {}
): SessionMemoryCandidateQueue {
  const database = new DatabaseSync(path);
  initializeLongMemorySchema(database);
  const now = options.now ?? (() => new Date().toISOString());
  const audit = options.audit;

  return {
    enqueueSessionCutoff(input) {
      return enqueueSessionMemoryCutoff(database, input, now(), audit);
    },
    countJobs(statuses) {
      return countSessionMemoryCandidateJobs(database, statuses);
    },
    listJobs() {
      return listSessionMemoryCandidateJobs(database);
    },
    close() {
      database.close();
    }
  };
}

export function openSessionMemoryCandidateStore(
  path: string,
  options: SessionMemoryCandidateStoreOptions
): SessionMemoryCandidateStore {
  const database = new DatabaseSync(path);
  initializeLongMemorySchema(database);
  const processSession = options.processSession;
  const now = options.now ?? (() => new Date().toISOString());
  const audit = options.audit;

  return {
    enqueueSessionCutoff(input) {
      return enqueueSessionMemoryCutoff(database, input, now(), audit);
    },
    async processNextJob() {
      const processingStartedAt = now();
      const queuedJob = claimNextQueuedSessionMemoryCandidateJob(database, processingStartedAt);

      if (queuedJob === undefined) {
        return undefined;
      }

      const job = mapSessionMemoryCandidateJob(queuedJob);
      const processedAt = now();
      let parsedSession: SessionMemoryCutoffInput | undefined;

      try {
        const session = parseSessionMemoryCutoffPayload(queuedJob);
        parsedSession = session;
        const drafts = await processSession(cloneSessionMemoryCutoffInput(session));
        const normalizedDrafts = drafts.map((draft) => normalizeLongMemoryCandidateDraft(draft));
        const insertedCandidates: LongMemoryCandidateRecord[] = [];

        const completed = runInTransaction(database, () => {
          if (!isOwnedProcessingCandidateJob(database, job.id, processingStartedAt)) {
            return false;
          }

          for (const draft of normalizedDrafts) {
            insertedCandidates.push(
              insertLongMemoryCandidate(database, session, draft, processedAt)
            );
          }

          markCandidateJobProcessed(database, job.id, processedAt, processingStartedAt, session);

          return true;
        });

        if (!completed) {
          return requireSessionMemoryCandidateJob(database, job.id);
        }

        for (const candidate of insertedCandidates) {
          recordCandidateAudit(audit, "long_memory.candidate.created", candidate.createdAt, {
            "pico.memory.candidate_id": candidate.id,
            "pico.memory.session_id": candidate.sessionId,
            "pico.memory.category": candidate.category,
            "pico.memory.source_entry_count": candidate.sourceEntryIds.length
          });
        }
        recordCandidateAudit(audit, "long_memory.candidate_job.processed", processedAt, {
          "pico.memory.session_id": session.sessionId,
          "pico.memory.candidate_job_id": job.id,
          "pico.memory.candidate_count": normalizedDrafts.length
        });

        return requireSessionMemoryCandidateJob(database, job.id);
      } catch (error) {
        const failed = runInTransaction(database, () => {
          if (!isOwnedProcessingCandidateJob(database, job.id, processingStartedAt)) {
            return false;
          }

          markCandidateJobFailed(database, job.id, processedAt, processingStartedAt, parsedSession);

          return true;
        });

        if (!failed) {
          return requireSessionMemoryCandidateJob(database, job.id);
        }

        throw error;
      }
    },
    recoverStaleProcessingJobs(input) {
      const staleBefore = requireTimestamp(input.staleBefore);
      const recoveredAt = requireTimestamp(input.recoveredAt);

      return runInTransaction(database, () => {
        const staleJobs = database
          .prepare(`
            SELECT id, session_id, status, source_entry_count, queued_at, processing_started_at, processed_at
            FROM long_memory_candidate_jobs
            WHERE status = 'processing'
              AND (
                (processing_started_at IS NOT NULL AND processing_started_at <= ?)
                OR (processing_started_at IS NULL AND queued_at <= ?)
              )
            ORDER BY id
          `)
          .all(staleBefore, staleBefore)
          .map((row) => mapSessionMemoryCandidateJob(row as SessionMemoryCandidateJobRow));

        for (const job of staleJobs) {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'queued', processing_started_at = NULL, processed_at = NULL
              WHERE id = ? AND status = 'processing'
            `)
            .run(job.id);
          recordCandidateAudit(audit, "long_memory.candidate_job.recovered", recoveredAt, {
            "pico.memory.session_id": job.sessionId,
            "pico.memory.candidate_job_id": job.id,
            "pico.memory.source_entry_count": job.sourceEntryCount
          });
        }

        return staleJobs;
      });
    },
    countJobs(statuses) {
      return countSessionMemoryCandidateJobs(database, statuses);
    },
    listJobs() {
      return listSessionMemoryCandidateJobs(database);
    },
    listPending() {
      return database
        .prepare(`
          SELECT
            id,
            session_id,
            source_entry_ids_json,
            title,
            body,
            category,
            tags_json,
            state,
            created_at,
            reviewed_by,
            reviewed_at,
            review_note,
            promoted_memory_id
          FROM long_memory_candidates
          WHERE state = 'pending_review'
          ORDER BY id
        `)
        .all()
        .map((row) => mapLongMemoryCandidate(row as LongMemoryCandidateRow));
    },
    readCandidate(id) {
      return readLongMemoryCandidate(database, id);
    },
    promoteReviewed(id, review) {
      return runInTransaction(database, () => {
        const candidate = requirePendingLongMemoryCandidate(database, id);
        const normalizedReview = normalizeReview(review.reviewedBy, review.reviewedAt, review.note);
        const record = insertReviewedMemory(
          database,
          {
            title: candidate.title,
            body: candidate.body,
            category: candidate.category,
            tags: candidate.tags,
            review: normalizedReview,
            mem0MemoryId: undefined,
            sourceSessionId: candidate.sessionId,
            importance: 0.5,
            confidence: 0.5
          },
          0,
          "create"
        );
        markCandidateReviewed(database, id, "approved", normalizedReview, record.id);
        recordCandidateLifecycle(database, id, "approved", normalizedReview.reviewedAt);
        recordCandidateAudit(audit, "long_memory.candidate.promoted", normalizedReview.reviewedAt, {
          "pico.memory.candidate_id": id,
          "pico.memory.long_memory_id": record.id,
          "pico.memory.category": candidate.category,
          "pico.memory.reviewed": true
        });

        return record;
      });
    },
    reject(id, review) {
      return runInTransaction(database, () => {
        const candidate = requirePendingLongMemoryCandidate(database, id);
        const normalizedReview = normalizeReview(review.reviewedBy, review.reviewedAt, review.note);
        markCandidateReviewed(database, id, "rejected", normalizedReview, 0);
        recordCandidateLifecycle(database, id, "rejected", normalizedReview.reviewedAt);
        recordCandidateAudit(audit, "long_memory.candidate.rejected", normalizedReview.reviewedAt, {
          "pico.memory.candidate_id": id,
          "pico.memory.category": candidate.category,
          "pico.memory.reviewed": true
        });

        return requireLongMemoryCandidate(database, id);
      });
    },
    close() {
      database.close();
    }
  };
}

function enqueueSessionMemoryCutoff(
  database: DatabaseSync,
  input: SessionMemoryCutoffInput,
  queuedAtInput: string,
  audit: StructuredAuditLog | undefined
): SessionMemoryCandidateJob {
  const session = normalizeSessionMemoryCutoffInput(input);
  const queuedAt = requireTimestamp(queuedAtInput);
  const result = database
    .prepare(`
      INSERT INTO long_memory_candidate_jobs (
        session_id,
        status,
        source_entry_count,
        queued_at,
        cutoff_json
      )
      VALUES (?, 'queued', ?, ?, ?)
    `)
    .run(session.sessionId, session.sourceEntryIds.length, queuedAt, JSON.stringify(session));
  const job = requireSessionMemoryCandidateJob(database, Number(result.lastInsertRowid));
  recordCandidateAudit(audit, "long_memory.candidate_job.enqueued", queuedAt, {
    "pico.memory.session_id": job.sessionId,
    "pico.memory.candidate_job_id": job.id,
    "pico.memory.source_entry_count": job.sourceEntryCount
  });

  return job;
}

function countSessionMemoryCandidateJobs(
  database: DatabaseSync,
  statuses: readonly SessionMemoryCandidateJobStatus[]
): number {
  if (statuses.length === 0) {
    return 0;
  }

  for (const status of statuses) {
    requireSessionMemoryCandidateJobStatus(status);
  }

  const placeholders = statuses.map(() => "?").join(", ");
  const row = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM long_memory_candidate_jobs
      WHERE status IN (${placeholders})
    `)
    .get(...statuses) as { readonly count: number };

  return row.count;
}

function listSessionMemoryCandidateJobs(
  database: DatabaseSync
): readonly SessionMemoryCandidateJob[] {
  return database
    .prepare(`
      SELECT id, session_id, status, source_entry_count, queued_at, processing_started_at, processed_at
      FROM long_memory_candidate_jobs
      ORDER BY id
    `)
    .all()
    .map((row) => mapSessionMemoryCandidateJob(row as SessionMemoryCandidateJobRow));
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
      status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded', 'deleted')),
      correction_of INTEGER NOT NULL DEFAULT 0,
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      mem0_memory_id TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
      last_accessed_at TEXT NOT NULL DEFAULT '',
      access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
      decay_score REAL NOT NULL DEFAULT 0 CHECK (decay_score >= 0 AND decay_score <= 1),
      archived_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS long_memory_entry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES long_memory_entries(id),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('create', 'correct', 'archive', 'delete')),
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

    CREATE TABLE IF NOT EXISTS long_memory_candidate_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
      source_entry_count INTEGER NOT NULL CHECK (source_entry_count >= 0),
      queued_at TEXT NOT NULL,
      processing_started_at TEXT,
      cutoff_json TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS long_memory_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source_entry_ids_json TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('care_continuity', 'facility_knowledge', 'operational_note')
      ),
      tags_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending_review', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT,
      promoted_memory_id INTEGER REFERENCES long_memory_entries(id)
    );

    CREATE TABLE IF NOT EXISTS long_memory_candidate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES long_memory_candidates(id),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('created', 'approved', 'rejected')),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureLongMemoryLifecycleColumns(database);
  ensureSessionMemoryCandidateJobColumns(database);
}

function ensureLongMemoryLifecycleColumns(database: DatabaseSync): void {
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(long_memory_entries)")
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );
  const migrations: Record<string, string> = {
    mem0_memory_id:
      "ALTER TABLE long_memory_entries ADD COLUMN mem0_memory_id TEXT NOT NULL DEFAULT ''",
    source_session_id:
      "ALTER TABLE long_memory_entries ADD COLUMN source_session_id TEXT NOT NULL DEFAULT ''",
    importance: "ALTER TABLE long_memory_entries ADD COLUMN importance REAL NOT NULL DEFAULT 0.5",
    confidence: "ALTER TABLE long_memory_entries ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5",
    last_accessed_at:
      "ALTER TABLE long_memory_entries ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT ''",
    access_count:
      "ALTER TABLE long_memory_entries ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
    decay_score: "ALTER TABLE long_memory_entries ADD COLUMN decay_score REAL NOT NULL DEFAULT 0",
    archived_at: "ALTER TABLE long_memory_entries ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''",
    deleted_at: "ALTER TABLE long_memory_entries ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"
  };

  for (const [column, statement] of Object.entries(migrations)) {
    if (!columns.has(column)) {
      database.exec(statement);
    }
  }

  ensureLongMemoryLifecycleConstraints(database);
}

function ensureSessionMemoryCandidateJobColumns(database: DatabaseSync): void {
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(long_memory_candidate_jobs)")
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );

  if (!columns.has("processing_started_at")) {
    database.exec("ALTER TABLE long_memory_candidate_jobs ADD COLUMN processing_started_at TEXT");
  }
}

function ensureLongMemoryLifecycleConstraints(database: DatabaseSync): void {
  const entriesSql = requireTableSql(database, "long_memory_entries");
  const eventsSql = requireTableSql(database, "long_memory_entry_events");

  if (entriesSql.includes("'archived'") && eventsSql.includes("'archive'")) {
    return;
  }

  rebuildLongMemoryReviewedTables(database);
  refreshLongMemorySearchObjects(database);
}

function requireTableSql(database: DatabaseSync, tableName: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  if (row === undefined || typeof (row as { sql: unknown }).sql !== "string") {
    throw new Error("pico long memory schema is malformed");
  }

  return (row as { sql: string }).sql;
}

function rebuildLongMemoryReviewedTables(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;

    DROP TRIGGER IF EXISTS long_memory_entries_insert_fts;
    DROP TRIGGER IF EXISTS long_memory_entries_remove_fts;

    ALTER TABLE long_memory_entry_events RENAME TO long_memory_entry_events_legacy;
    ALTER TABLE long_memory_entries RENAME TO long_memory_entries_legacy;

    CREATE TABLE long_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('care_continuity', 'facility_knowledge', 'operational_note')
      ),
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded', 'deleted')),
      correction_of INTEGER NOT NULL DEFAULT 0,
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      mem0_memory_id TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
      last_accessed_at TEXT NOT NULL DEFAULT '',
      access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
      decay_score REAL NOT NULL DEFAULT 0 CHECK (decay_score >= 0 AND decay_score <= 1),
      archived_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE long_memory_entry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES long_memory_entries(id),
      event_kind TEXT NOT NULL CHECK (event_kind IN ('create', 'correct', 'archive', 'delete')),
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO long_memory_entries (
      id,
      title,
      body,
      category,
      tags_json,
      status,
      correction_of,
      reviewed_by,
      reviewed_at,
      review_note,
      mem0_memory_id,
      source_session_id,
      importance,
      confidence,
      last_accessed_at,
      access_count,
      decay_score,
      archived_at,
      deleted_at,
      created_at,
      updated_at
    )
    SELECT
      id,
      title,
      body,
      category,
      tags_json,
      status,
      correction_of,
      reviewed_by,
      reviewed_at,
      review_note,
      mem0_memory_id,
      source_session_id,
      importance,
      confidence,
      last_accessed_at,
      access_count,
      decay_score,
      archived_at,
      deleted_at,
      created_at,
      updated_at
    FROM long_memory_entries_legacy;

    INSERT INTO long_memory_entry_events (
      id,
      memory_id,
      event_kind,
      reviewed_by,
      reviewed_at,
      review_note,
      snapshot_json,
      created_at
    )
    SELECT
      id,
      memory_id,
      event_kind,
      reviewed_by,
      reviewed_at,
      review_note,
      snapshot_json,
      created_at
    FROM long_memory_entry_events_legacy;

    DROP TABLE long_memory_entry_events_legacy;
    DROP TABLE long_memory_entries_legacy;
  `);

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  database.exec("PRAGMA foreign_keys = ON");

  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `pico long memory migration left foreign key violations: ${JSON.stringify(
        foreignKeyViolations
      )}`
    );
  }
}

function refreshLongMemorySearchObjects(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM long_memory_entries_fts;

    INSERT INTO long_memory_entries_fts(rowid, title, body)
    SELECT id, title, body
    FROM long_memory_entries
    WHERE status = 'active';

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
  validateLongMemoryInputKeys(input);
  const title = requireMemoryText(input.title);
  const body = requireMemoryText(input.body);

  rejectIndividualChildText(title);
  rejectIndividualChildText(body);

  return {
    title,
    body,
    category: requireLongMemoryCategory(input.category),
    tags: normalizeTags(input.tags),
    review: normalizeReview(input.reviewedBy, input.reviewedAt, input.reviewNote),
    mem0MemoryId: normalizeOptionalMetadataText(input.mem0MemoryId),
    sourceSessionId: normalizeOptionalMetadataText(input.sourceSessionId),
    importance: normalizeLifecycleScore(input.importance, "pico long memory importance"),
    confidence: normalizeLifecycleScore(input.confidence, "pico long memory confidence")
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
        review_note,
        mem0_memory_id,
        source_session_id,
        importance,
        confidence
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.title,
      input.body,
      input.category,
      JSON.stringify(input.tags),
      correctionOf,
      input.review.reviewedBy,
      input.review.reviewedAt,
      input.review.note,
      input.mem0MemoryId ?? "",
      input.sourceSessionId ?? "",
      input.importance,
      input.confidence
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
        review_note,
        mem0_memory_id,
        source_session_id,
        importance,
        confidence,
        last_accessed_at,
        access_count,
        decay_score,
        status
      FROM long_memory_entries
      WHERE id = ? AND status = 'active'
    `)
    .get(id);

  if (row === undefined) {
    return undefined;
  }

  return mapLongMemoryRow(row as LongMemoryRow);
}

function searchActiveMemories(
  database: DatabaseSync,
  query: string,
  accessedAt: string
): LongMemorySearchResult[] {
  const results =
    query.length >= minimumTrigramQueryLength
      ? searchActiveMemoriesByMatch(database, query)
      : searchActiveMemoriesByLike(database, query);

  recordMemoryAccess(
    database,
    results.map((result) => result.id),
    accessedAt
  );

  return results.map((result) => ({
    ...result,
    lifecycle: Object.freeze({
      ...result.lifecycle,
      lastAccessedAt: accessedAt,
      accessCount: result.lifecycle.accessCount + 1
    })
  }));
}

function searchActiveMemoriesByMatch(
  database: DatabaseSync,
  query: string
): LongMemorySearchResult[] {
  return database
    .prepare(`
      SELECT
        e.id,
        e.title,
        e.category,
        e.mem0_memory_id,
        e.source_session_id,
        e.importance,
        e.confidence,
        e.last_accessed_at,
        e.access_count,
        e.decay_score,
        e.status
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
      SELECT
        e.id,
        e.title,
        e.category,
        e.mem0_memory_id,
        e.source_session_id,
        e.importance,
        e.confidence,
        e.last_accessed_at,
        e.access_count,
        e.decay_score,
        e.status
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

function recordMemoryAccess(
  database: DatabaseSync,
  ids: readonly number[],
  accessedAt: string
): void {
  if (ids.length === 0) {
    return;
  }

  const update = database.prepare(`
    UPDATE long_memory_entries
    SET
      last_accessed_at = ?,
      access_count = access_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'active'
  `);

  for (const id of ids) {
    update.run(accessedAt, id);
  }
}

function readMemoryLifecycle(
  database: DatabaseSync,
  id: number
): LongMemoryLifecycleMetadata | undefined {
  const row = database
    .prepare(`
      SELECT
        mem0_memory_id,
        source_session_id,
        importance,
        confidence,
        last_accessed_at,
        access_count,
        decay_score,
        status
      FROM long_memory_entries
      WHERE id = ?
    `)
    .get(id);

  if (row === undefined) {
    return undefined;
  }

  if ((row as { status: unknown }).status === "superseded") {
    return undefined;
  }

  const lifecycle = mapLifecycle(row as LongMemoryRow);

  return lifecycle;
}

function runLongMemoryDecay(
  database: DatabaseSync,
  input: LongMemoryDecayInput
): readonly LongMemoryDecayResult[] {
  const now = requireTimestamp(input.now);
  const archiveThreshold = requireDecayThreshold(input.archiveThreshold, "archiveThreshold");
  const deleteThreshold = requireDecayThreshold(input.deleteThreshold, "deleteThreshold");
  const decayWindowDays = requirePositiveNumber(input.decayWindowDays, "decayWindowDays");

  if (deleteThreshold > archiveThreshold) {
    throw new Error("pico long memory decay delete threshold must be <= archive threshold");
  }

  return database
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
        review_note,
        mem0_memory_id,
        source_session_id,
        importance,
        confidence,
        last_accessed_at,
        access_count,
        decay_score,
        status
      FROM long_memory_entries
      WHERE status = 'active'
      ORDER BY id
    `)
    .all()
    .flatMap((row) =>
      decayMemoryRow(database, row as LongMemoryRow, {
        now,
        archiveThreshold,
        deleteThreshold,
        decayWindowDays
      })
    );
}

function decayMemoryRow(
  database: DatabaseSync,
  row: LongMemoryRow,
  input: {
    readonly now: string;
    readonly archiveThreshold: number;
    readonly deleteThreshold: number;
    readonly decayWindowDays: number;
  }
): readonly LongMemoryDecayResult[] {
  const lifecycle = mapLifecycle(row);
  const decayScore = calculateDecayScore(row, input.now, input.decayWindowDays);
  const nextStatus =
    decayScore <= input.deleteThreshold
      ? "deleted"
      : decayScore <= input.archiveThreshold
        ? "archived"
        : undefined;

  updateDecayScore(database, row.id, decayScore);

  if (nextStatus === undefined) {
    return [];
  }

  transitionMemoryLifecycle(database, row, nextStatus, input.now, decayScore);

  return [
    {
      id: row.id,
      previousStatus: lifecycle.status,
      status: nextStatus,
      decayScore,
      mem0MemoryId: lifecycle.mem0MemoryId
    }
  ];
}

function calculateDecayScore(row: LongMemoryRow, now: string, decayWindowDays: number): number {
  const referenceAt = row.last_accessed_at === "" ? row.reviewed_at : row.last_accessed_at;
  const elapsedDays = Math.max(0, (Date.parse(now) - Date.parse(referenceAt)) / 86_400_000);
  const recency = clampUnit(1 - elapsedDays / decayWindowDays);
  const access = clampUnit(row.access_count / 5);
  const score = row.importance * 0.25 + row.confidence * 0.4 + recency * 0.25 + access * 0.1;

  return roundLifecycleScore(score);
}

function updateDecayScore(database: DatabaseSync, id: number, decayScore: number): void {
  database
    .prepare(`
      UPDATE long_memory_entries
      SET decay_score = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(decayScore, id);
}

function transitionMemoryLifecycle(
  database: DatabaseSync,
  row: LongMemoryRow,
  status: "archived" | "deleted",
  occurredAt: string,
  decayScore: number
): void {
  database
    .prepare(`
      UPDATE long_memory_entries
      SET
        status = ?,
        decay_score = ?,
        archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END,
        deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `)
    .run(status, decayScore, status, occurredAt, status, occurredAt, row.id);
  recordMemoryEvent(
    database,
    row.id,
    status === "archived" ? "archive" : "delete",
    {
      reviewedBy: "pico.decay",
      reviewedAt: occurredAt,
      note: ""
    },
    JSON.stringify({
      id: row.id,
      previousStatus: "active",
      status,
      decayScore,
      mem0MemoryId: mapLifecycle(row).mem0MemoryId
    })
  );
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
  status: "superseded" | "archived" | "deleted"
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
  eventKind: "create" | "correct" | "archive" | "delete",
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

function normalizeSessionMemoryCutoffInput(input: unknown): SessionMemoryCutoffInput {
  const record = requireMemoryRecord(input, "pico session memory cutoff input is malformed");
  const sessionId = requireMemoryText(record.sessionId);
  const cutoffAt = requireTimestamp(record.cutoffAt);
  const requestedBy = requireReviewText(record.requestedBy);
  const sourceEntryIds = normalizeSourceEntryIds(record.sourceEntryIds);
  const entries = normalizeSessionEntries(record.entries);

  return Object.freeze({
    sessionId,
    cutoffAt,
    requestedBy,
    sourceEntryIds,
    entries
  });
}

function cloneSessionMemoryCutoffInput(input: SessionMemoryCutoffInput): SessionMemoryCutoffInput {
  return Object.freeze({
    sessionId: input.sessionId,
    cutoffAt: input.cutoffAt,
    requestedBy: input.requestedBy,
    sourceEntryIds: Object.freeze([...input.sourceEntryIds]),
    entries: Object.freeze(input.entries.map((entry) => Object.freeze({ ...entry })))
  });
}

function normalizeSourceEntryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("pico session memory cutoff source entries are required");
  }

  return Object.freeze(value.map((entryId) => requireMemoryText(entryId)));
}

function normalizeSessionEntries(value: unknown): readonly SessionMemoryCutoffEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("pico session memory cutoff entries are required");
  }

  return Object.freeze(
    value.map((entry) => {
      const record = requireSessionEntryRecord(
        entry,
        "pico session memory cutoff entries are required"
      );

      return Object.freeze({
        id: requireMemoryText(record.id),
        role: requireSessionEntryRole(record.role),
        content: normalizeSessionEntryContent(record.content)
      });
    })
  );
}

function normalizeSessionEntryContent(value: unknown): string {
  const content = requireMemoryText(value);
  rejectIndividualChildText(content);

  return content;
}

function requireSessionEntryRole(value: unknown): SessionMemoryCutoffEntry["role"] {
  if (value === "staff" || value === "assistant" || value === "system") {
    return value;
  }

  throw new Error("pico session memory cutoff entry role is invalid");
}

function requireMemoryRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function requireSessionEntryRecord(value: unknown, message: string): Record<string, unknown> {
  return requireMemoryRecord(value, message);
}

function normalizeLongMemoryCandidateDraft(draft: unknown): NormalizedLongMemoryCandidateDraft {
  const record = requireMemoryRecord(draft, "pico long memory candidate input is malformed");
  validateLongMemoryCandidateDraftKeys(record);
  const title = requireMemoryText(record.title);
  const body = requireMemoryText(record.body);

  rejectIndividualChildText(title);
  rejectIndividualChildText(body);

  return {
    title,
    body,
    category: requireLongMemoryCategory(record.category),
    tags: normalizeTags(record.tags)
  };
}

function insertLongMemoryCandidate(
  database: DatabaseSync,
  session: SessionMemoryCutoffInput,
  draft: NormalizedLongMemoryCandidateDraft,
  createdAt: string
): LongMemoryCandidateRecord {
  const result = database
    .prepare(`
      INSERT INTO long_memory_candidates (
        session_id,
        source_entry_ids_json,
        title,
        body,
        category,
        tags_json,
        state,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?)
    `)
    .run(
      session.sessionId,
      JSON.stringify(session.sourceEntryIds),
      draft.title,
      draft.body,
      draft.category,
      JSON.stringify(draft.tags),
      createdAt
    );
  const id = Number(result.lastInsertRowid);

  recordCandidateLifecycle(database, id, "created", createdAt);

  return requireLongMemoryCandidate(database, id);
}

function readLongMemoryCandidate(
  database: DatabaseSync,
  id: number
): LongMemoryCandidateRecord | undefined {
  const row = database
    .prepare(`
      SELECT
        id,
        session_id,
        source_entry_ids_json,
        title,
        body,
        category,
        tags_json,
        state,
        created_at,
        reviewed_by,
        reviewed_at,
        review_note,
        promoted_memory_id
      FROM long_memory_candidates
      WHERE id = ?
    `)
    .get(id);

  if (row === undefined) {
    return undefined;
  }

  return mapLongMemoryCandidate(row as LongMemoryCandidateRow);
}

function requireLongMemoryCandidate(database: DatabaseSync, id: number): LongMemoryCandidateRecord {
  const candidate = readLongMemoryCandidate(database, id);

  if (candidate === undefined) {
    throw new Error("pico long memory candidate does not exist");
  }

  return candidate;
}

function requirePendingLongMemoryCandidate(
  database: DatabaseSync,
  id: number
): LongMemoryCandidateRecord {
  const candidate = requireLongMemoryCandidate(database, id);

  if (candidate.state !== "pending_review") {
    throw new Error("pico long memory candidate is not pending review");
  }

  return candidate;
}

function markCandidateReviewed(
  database: DatabaseSync,
  id: number,
  state: "approved" | "rejected",
  review: Required<LongMemoryReview>,
  promotedMemoryId: number
): void {
  if (promotedMemoryId === 0) {
    database
      .prepare(`
        UPDATE long_memory_candidates
        SET
          state = ?,
          reviewed_by = ?,
          reviewed_at = ?,
          review_note = ?,
          promoted_memory_id = NULL
        WHERE id = ? AND state = 'pending_review'
      `)
      .run(state, review.reviewedBy, review.reviewedAt, review.note, id);

    return;
  }

  database
    .prepare(`
      UPDATE long_memory_candidates
      SET
        state = ?,
        reviewed_by = ?,
        reviewed_at = ?,
        review_note = ?,
        promoted_memory_id = ?
      WHERE id = ? AND state = 'pending_review'
    `)
    .run(state, review.reviewedBy, review.reviewedAt, review.note, promotedMemoryId, id);
}

function recordCandidateLifecycle(
  database: DatabaseSync,
  candidateId: number,
  eventKind: "created" | "approved" | "rejected",
  occurredAt: string
): void {
  database
    .prepare(`
      INSERT INTO long_memory_candidate_events (
        candidate_id,
        event_kind,
        occurred_at
      )
      VALUES (?, ?, ?)
    `)
    .run(candidateId, eventKind, occurredAt);
}

function requireSessionMemoryCandidateJob(
  database: DatabaseSync,
  id: number
): SessionMemoryCandidateJob {
  const row = database
    .prepare(`
      SELECT id, session_id, status, source_entry_count, queued_at, processing_started_at, processed_at
      FROM long_memory_candidate_jobs
      WHERE id = ?
    `)
    .get(id);

  if (row === undefined) {
    throw new Error("pico session memory candidate job does not exist");
  }

  return mapSessionMemoryCandidateJob(row as SessionMemoryCandidateJobRow);
}

function claimNextQueuedSessionMemoryCandidateJob(
  database: DatabaseSync,
  processingStartedAt: string
): QueuedSessionMemoryCandidateJobRow | undefined {
  return runInTransaction(database, () => {
    const row = readNextQueuedSessionMemoryCandidateJob(database);

    if (row === undefined) {
      return undefined;
    }

    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET status = 'processing', processing_started_at = ?
        WHERE id = ? AND status = 'queued'
      `)
      .run(processingStartedAt, row.id);

    return {
      ...row,
      status: "processing",
      processing_started_at: processingStartedAt
    };
  });
}

function readNextQueuedSessionMemoryCandidateJob(
  database: DatabaseSync
): QueuedSessionMemoryCandidateJobRow | undefined {
  const row = database
    .prepare(`
      SELECT
        id,
        session_id,
        status,
        source_entry_count,
        queued_at,
        processing_started_at,
        processed_at,
        cutoff_json
      FROM long_memory_candidate_jobs
      WHERE status = 'queued'
      ORDER BY id
      LIMIT 1
    `)
    .get();

  if (row === undefined) {
    return undefined;
  }

  return row as QueuedSessionMemoryCandidateJobRow;
}

function parseSessionMemoryCutoffPayload(
  row: QueuedSessionMemoryCandidateJobRow
): SessionMemoryCutoffInput {
  let payload: unknown;

  try {
    payload = JSON.parse(row.cutoff_json);
  } catch {
    throw new Error("pico session memory candidate job row is malformed");
  }

  const session = normalizeSessionMemoryCutoffInput(payload);

  if (
    session.sessionId !== row.session_id ||
    session.sourceEntryIds.length !== row.source_entry_count
  ) {
    throw new Error("pico session memory candidate job row is malformed");
  }

  return session;
}

function isOwnedProcessingCandidateJob(
  database: DatabaseSync,
  id: number,
  processingStartedAt: string
): boolean {
  const row = database
    .prepare(`
      SELECT 1
      FROM long_memory_candidate_jobs
      WHERE id = ?
        AND status = 'processing'
        AND processing_started_at = ?
    `)
    .get(id, processingStartedAt);

  return row !== undefined;
}

function markCandidateJobProcessed(
  database: DatabaseSync,
  id: number,
  processedAt: string,
  processingStartedAt: string,
  session: SessionMemoryCutoffInput
): void {
  database
    .prepare(`
      UPDATE long_memory_candidate_jobs
      SET status = 'processed', processed_at = ?, cutoff_json = ?
      WHERE id = ? AND status = 'processing' AND processing_started_at = ?
    `)
    .run(
      processedAt,
      JSON.stringify(compactProcessedCutoffPayload(session)),
      id,
      processingStartedAt
    );
}

function compactProcessedCutoffPayload(session: SessionMemoryCutoffInput): Record<string, unknown> {
  return compactCutoffPayload(session, "processed_metadata_only");
}

function compactFailedCutoffPayload(session: SessionMemoryCutoffInput): Record<string, unknown> {
  return compactCutoffPayload(session, "failed_metadata_only");
}

function compactCutoffPayload(
  session: SessionMemoryCutoffInput,
  retention: "processed_metadata_only" | "failed_metadata_only"
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    cutoffAt: session.cutoffAt,
    sourceEntryIds: session.sourceEntryIds,
    sourceEntryCount: session.entries.length,
    requestedBy: session.requestedBy,
    retention
  };
}

function markCandidateJobFailed(
  database: DatabaseSync,
  id: number,
  processedAt: string,
  processingStartedAt: string,
  session: SessionMemoryCutoffInput | undefined
): void {
  const retentionPayload =
    session === undefined ? undefined : JSON.stringify(compactFailedCutoffPayload(session));

  if (retentionPayload === undefined) {
    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET status = 'failed', processed_at = ?
        WHERE id = ? AND status = 'processing' AND processing_started_at = ?
      `)
      .run(processedAt, id, processingStartedAt);

    return;
  }

  database
    .prepare(`
      UPDATE long_memory_candidate_jobs
      SET status = 'failed', processed_at = ?, cutoff_json = ?
      WHERE id = ? AND status = 'processing' AND processing_started_at = ?
    `)
    .run(processedAt, retentionPayload, id, processingStartedAt);
}

function recordCandidateAudit(
  audit: StructuredAuditLog | undefined,
  name: string,
  occurredAt: string,
  attributes: Record<string, string | number | boolean>
): void {
  audit?.record({
    category: "memory_write",
    name,
    severity: "info",
    occurredAt,
    summary: "Long-memory candidate lifecycle event.",
    attributes
  });
}

function mapLongMemoryCandidate(row: LongMemoryCandidateRow): LongMemoryCandidateRecord {
  const reviewedAt = row.reviewed_at === null ? undefined : row.reviewed_at;
  const reviewedBy = row.reviewed_by === null ? undefined : row.reviewed_by;
  const reviewNote = row.review_note === null ? undefined : row.review_note;

  return Object.freeze({
    id: row.id,
    sessionId: row.session_id,
    sourceEntryIds: Object.freeze(JSON.parse(row.source_entry_ids_json) as string[]),
    title: row.title,
    body: row.body,
    category: requireLongMemoryCategory(row.category),
    tags: Object.freeze(JSON.parse(row.tags_json) as string[]),
    state: requireLongMemoryCandidateState(row.state),
    createdAt: row.created_at,
    reviewedAt,
    review:
      reviewedBy === undefined || reviewedAt === undefined
        ? undefined
        : normalizeStoredReview(reviewedBy, reviewedAt, reviewNote),
    promotedMemoryId: row.promoted_memory_id === null ? undefined : row.promoted_memory_id
  });
}

function mapSessionMemoryCandidateJob(
  row: SessionMemoryCandidateJobRow
): SessionMemoryCandidateJob {
  return Object.freeze({
    id: row.id,
    sessionId: row.session_id,
    status: requireSessionMemoryCandidateJobStatus(row.status),
    sourceEntryCount: row.source_entry_count,
    queuedAt: requireTimestamp(row.queued_at),
    processingStartedAt:
      row.processing_started_at === null ? undefined : requireTimestamp(row.processing_started_at),
    processedAt: row.processed_at === null ? undefined : requireTimestamp(row.processed_at)
  });
}

function mapLongMemoryRow(row: LongMemoryRow): LongMemoryRecord {
  return Object.freeze({
    id: row.id,
    title: row.title,
    body: row.body,
    category: requireLongMemoryCategory(row.category),
    tags: Object.freeze(JSON.parse(row.tags_json) as string[]),
    status: "active" as const,
    correctionOf: row.correction_of === 0 ? undefined : row.correction_of,
    review: normalizeStoredReview(row.reviewed_by, row.reviewed_at, row.review_note),
    lifecycle: mapLifecycle(row)
  });
}

function mapSearchResult(row: Record<string, unknown>): LongMemorySearchResult {
  return Object.freeze({
    id: requireRowNumber(row.id),
    title: requireRowString(row.title),
    category: requireLongMemoryCategory(row.category),
    lifecycle: mapLifecycle(row as LongMemoryRow)
  });
}

function mapLifecycle(row: LongMemoryRow): LongMemoryLifecycleMetadata {
  return Object.freeze({
    mem0MemoryId: normalizeStoredOptionalText(row.mem0_memory_id),
    sourceSessionId: normalizeStoredOptionalText(row.source_session_id),
    importance: requireLifecycleUnit(row.importance, "pico long memory row is malformed"),
    confidence: requireLifecycleUnit(row.confidence, "pico long memory row is malformed"),
    lastAccessedAt: normalizeStoredOptionalText(row.last_accessed_at),
    accessCount: requireNonNegativeInteger(row.access_count),
    decayScore: requireLifecycleUnit(row.decay_score, "pico long memory row is malformed"),
    status: requireLongMemoryLifecycleStatus(row.status)
  });
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
    reviewedAt: requireTimestamp(reviewedAt),
    note: normalizedNote
  };
}

function normalizeOptionalMetadataText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireReviewText(value);
}

function normalizeStoredOptionalText(value: unknown): string | undefined {
  const text = requireStoredText(value);

  return text === "" ? undefined : text;
}

function normalizeLifecycleScore(value: unknown, label: string): number {
  if (value === undefined) {
    return 0.5;
  }

  return requireLifecycleUnit(value, label);
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

function normalizeTags(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("pico long memory input is malformed");
  }

  const tags: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new Error("pico long memory input is malformed");
    }

    const normalized = requireMemoryText(value[index]);
    rejectIndividualChildText(normalized);

    tags.push(normalized);
  }

  return Object.freeze(tags);
}

function validateLongMemoryInputKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (isIndividualChildField(key)) {
      throw new Error("pico long memory must not contain individual child profile data");
    }

    if (!longMemoryInputKeys.has(key)) {
      throw new Error("pico long memory input is malformed");
    }
  }
}

function validateLongMemoryCandidateDraftKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (isIndividualChildField(key)) {
      throw new Error("pico long memory must not contain individual child profile data");
    }

    if (!longMemoryCandidateDraftKeys.has(key)) {
      throw new Error("pico long memory candidate input is malformed");
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

function requireLongMemoryCandidateState(value: unknown): LongMemoryCandidateState {
  if (value === "pending_review" || value === "approved" || value === "rejected") {
    return value;
  }

  throw new Error("pico long memory candidate row is malformed");
}

function requireSessionMemoryCandidateJobStatus(value: unknown): SessionMemoryCandidateJobStatus {
  if (value === "queued" || value === "processing" || value === "processed" || value === "failed") {
    return value;
  }

  throw new Error("pico session memory candidate job row is malformed");
}

function requireLongMemoryLifecycleStatus(value: unknown): LongMemoryLifecycleStatus {
  if (value === "active" || value === "archived" || value === "deleted") {
    return value;
  }

  throw new Error("pico long memory row is malformed");
}

function requireMemoryText(value: unknown): string {
  return requireNonEmptyTrimmedString(value, "pico long memory text is required");
}

function requireReviewText(value: unknown): string {
  return requireNonEmptyTrimmedString(value, "pico long memory review metadata is required");
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireReviewText(value);

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("pico long memory timestamp is invalid");
  }

  return timestamp;
}

function requireNonEmptyTrimmedString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(message);
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

function requireDecayThreshold(value: unknown, label: string): number {
  return requireLifecycleUnit(value, `pico long memory decay ${label} is invalid`);
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  throw new Error(`pico long memory decay ${label} is invalid`);
}

function requireLifecycleUnit(value: unknown, message: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }

  throw new Error(message);
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw new Error("pico long memory row is malformed");
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundLifecycleScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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
