import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";
import type { StructuredAuditLog } from "../audit/index.js";

export type LongMemoryCategory = "care_continuity" | "facility_knowledge" | "operational_note";

export const maximumAutomatedLongMemoryDraftCount = 5;

export type LongMemoryStatus = "active";
export type LongMemoryLifecycleStatus = "active" | "archived" | "deleted";

export type LongMemoryReview = {
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly note?: string;
};

export type LongMemoryProvenance =
  | {
      readonly kind: "staff_review";
      readonly reviewedBy: string;
      readonly reviewedAt: string;
      readonly note?: string;
    }
  | {
      readonly kind: "session_cutoff_automation";
      readonly policyVersion: "session-cutoff-v1";
      readonly sourceSessionId: string;
      readonly sourceEntryIds: readonly string[];
      readonly createdAt: string;
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

export type AutomatedLongMemoryInput = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags?: readonly string[];
  readonly sourceSessionId: string;
  readonly sourceEntryIds: readonly string[];
  readonly policyVersion: "session-cutoff-v1";
  readonly confidence: number;
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
  readonly review: LongMemoryReview | undefined;
  readonly provenance: LongMemoryProvenance;
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
  readonly writeAutomated: (input: AutomatedLongMemoryInput) => LongMemoryRecord;
  readonly read: (id: number) => LongMemoryRecord | undefined;
  readonly readLifecycle: (id: number) => LongMemoryLifecycleMetadata | undefined;
  readonly search: (query: string) => LongMemorySearchResult[];
  readonly searchActive: (input: {
    readonly query: string;
    readonly limit: number;
  }) => readonly LongMemoryRecord[];
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

export type SessionMemoryCandidateJobStatus = "queued" | "processing" | "processed" | "dead_letter";

export type SessionMemoryCandidateJobErrorCode = "extraction_failed" | "policy_violation";

export class PermanentMemoryPolicyError extends Error {
  readonly code = "policy_violation";
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
      throwIndividualChildPolicyError();
    }

    assertNoIndividualChildLongMemoryFields(item);
  }
}

export type SessionMemoryCandidateJob = {
  readonly id: number;
  readonly sessionId: string;
  readonly status: SessionMemoryCandidateJobStatus;
  readonly sourceEntryCount: number;
  readonly queuedAt: string;
  readonly processingStartedAt: string | undefined;
  readonly processedAt: string | undefined;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | undefined;
  readonly lastErrorCode: SessionMemoryCandidateJobErrorCode | undefined;
  readonly deadLetteredAt: string | undefined;
  readonly purgeAfter: string | undefined;
};

export type SessionMemoryCandidateProcessor = (
  session: SessionMemoryCutoffInput
) => Promise<readonly LongMemoryCandidateDraft[]>;

export type SessionMemoryAutomatedProcessor = (
  session: SessionMemoryCutoffInput
) => Promise<
  readonly Pick<
    AutomatedLongMemoryInput,
    "title" | "body" | "category" | "tags" | "sourceEntryIds" | "confidence"
  >[]
>;

export type SessionMemoryCandidateStoreOptions = {
  readonly processSession?: SessionMemoryCandidateProcessor;
  readonly processAutomatedSession?: SessionMemoryAutomatedProcessor;
  readonly onAutomatedMemoriesWritten?: (records: readonly LongMemoryRecord[]) => void;
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
  readonly invalidateProcessingOwnership: (input: {
    readonly jobId: number;
    readonly processingStartedAt: string;
  }) => void;
  readonly recoverStaleProcessingJobs: (input: {
    readonly staleBefore: string;
    readonly recoveredAt: string;
  }) => readonly SessionMemoryCandidateJob[];
  readonly purgeExpiredDeadLetterPayloads: (input: { readonly now: string }) => number;
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
  readonly origin_kind: string;
  readonly origin_policy_version: string;
  readonly origin_source_session_id: string;
  readonly origin_source_entry_ids_json: string;
  readonly origin_created_at: string;
  readonly automated_fingerprint: string;
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
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error_code: string | null;
  readonly dead_lettered_at: string | null;
  readonly purge_after: string | null;
};

type QueuedSessionMemoryCandidateJobRow = SessionMemoryCandidateJobRow & {
  readonly cutoff_json: string;
};

type MappedSessionMemoryCandidateJob = SessionMemoryCandidateJob & {
  readonly attemptCount: number;
  readonly nextAttemptAt: string | undefined;
  readonly lastErrorCode: SessionMemoryCandidateJobErrorCode | undefined;
  readonly deadLetteredAt: string | undefined;
  readonly purgeAfter: string | undefined;
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

type NormalizedAutomatedLongMemoryInput = {
  readonly title: string;
  readonly body: string;
  readonly category: LongMemoryCategory;
  readonly tags: readonly string[];
  readonly sourceSessionId: string;
  readonly sourceEntryIds: readonly string[];
  readonly policyVersion: "session-cutoff-v1";
  readonly confidence: number;
  readonly fingerprint: string;
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
const deadLetterPayloadRetentionMs = 7 * 86_400_000;
const invalidatedProcessingOwnershipTimestamp = "1970-01-01T00:00:00.000Z";
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
const automatedLongMemoryInputKeys = new Set([
  "title",
  "body",
  "category",
  "tags",
  "sourceSessionId",
  "sourceEntryIds",
  "policyVersion",
  "confidence"
]);
const longMemoryCandidateDraftKeys = new Set(["title", "body", "category", "tags"]);
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

export function openLongMemoryStore(
  path: string,
  options: LongMemoryStoreOptions = {}
): LongMemoryStore {
  const database = openLongMemoryDatabase(path);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    writeReviewed(input) {
      return runInTransaction(database, () =>
        insertReviewedMemory(database, normalizeLongMemoryInput(input), 0, "create")
      );
    },
    writeAutomated(input) {
      const normalized = normalizeAutomatedLongMemoryInput(input);
      const createdAt = requireTimestamp(now());

      return runInTransaction(database, () =>
        writeAutomatedMemory(database, normalized, createdAt)
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
    searchActive(input) {
      const query = requireSearchQuery(input.query);
      const limit = requireSearchLimit(input.limit);
      const accessedAt = requireTimestamp(now());

      return runInTransaction(database, () =>
        searchBoundedActiveMemories(database, query, limit, accessedAt)
      );
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
  const database = openLongMemoryDatabase(path);
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
  const database = openLongMemoryDatabase(path);
  const processSession = options.processSession;
  const processAutomatedSession = options.processAutomatedSession;
  const now = options.now ?? (() => new Date().toISOString());
  const audit = options.audit;

  if ((processSession === undefined) === (processAutomatedSession === undefined)) {
    database.close();
    throw new Error("pico session memory store requires exactly one processor");
  }

  return {
    enqueueSessionCutoff(input) {
      return enqueueSessionMemoryCutoff(database, input, now(), audit);
    },
    async processNextJob() {
      const processingStartedAt = requireTimestamp(now());
      const queuedJob = claimNextQueuedSessionMemoryCandidateJob(database, processingStartedAt);

      if (queuedJob === undefined) {
        return undefined;
      }

      const job = mapSessionMemoryCandidateJob(queuedJob);
      let parsedSession: SessionMemoryCutoffInput | undefined;

      try {
        const session = parseSessionMemoryCutoffPayload(queuedJob);
        parsedSession = session;
        const { normalizedDrafts, normalizedAutomatedDrafts } = await processSessionMemoryDrafts(
          session,
          processSession,
          processAutomatedSession
        );
        const insertedCandidates: LongMemoryCandidateRecord[] = [];
        const writtenMemories: LongMemoryRecord[] = [];
        const processedAt = requireTimestamp(now());

        const completed = runInTransaction(database, () => {
          if (!isOwnedProcessingCandidateJob(database, job.id, processingStartedAt)) {
            return false;
          }

          for (const draft of normalizedDrafts) {
            insertedCandidates.push(
              insertLongMemoryCandidate(database, session, draft, processedAt)
            );
          }

          for (const draft of normalizedAutomatedDrafts) {
            writtenMemories.push(writeAutomatedMemory(database, draft, processedAt));
          }

          markCandidateJobProcessed(database, job.id, processedAt, processingStartedAt, session);

          return true;
        });

        if (!completed) {
          return requireSessionMemoryCandidateJob(database, job.id);
        }

        options.onAutomatedMemoriesWritten?.(Object.freeze(writtenMemories));

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
          "pico.memory.candidate_count": normalizedDrafts.length + normalizedAutomatedDrafts.length
        });

        return requireSessionMemoryCandidateJob(database, job.id);
      } catch (error) {
        const transitionedAt = requireTimestamp(now());
        const errorCode = classifySessionMemoryCandidateJobError(error);
        const transitioned = runInTransaction(database, () => {
          if (!isOwnedProcessingCandidateJob(database, job.id, processingStartedAt)) {
            return false;
          }

          transitionFailedCandidateJob(database, {
            job,
            transitionedAt,
            processingStartedAt,
            session: parsedSession,
            errorCode
          });

          return true;
        });

        if (!transitioned) {
          return requireSessionMemoryCandidateJob(database, job.id);
        }

        const transitionedJob = requireSessionMemoryCandidateJob(database, job.id);
        recordCandidateAudit(
          audit,
          transitionedJob.status === "dead_letter"
            ? "long_memory.candidate_job.dead_lettered"
            : "long_memory.candidate_job.retry_scheduled",
          transitionedAt,
          {
            "pico.memory.session_id": job.sessionId,
            "pico.memory.candidate_job_id": job.id,
            "pico.memory.attempt_count": job.attemptCount,
            "pico.memory.error_code": errorCode
          }
        );

        throw error;
      }
    },
    invalidateProcessingOwnership(input) {
      const processingStartedAt = requireTimestamp(input.processingStartedAt);
      database
        .prepare(`
          UPDATE long_memory_candidate_jobs
          SET processing_started_at = ?
          WHERE id = ?
            AND status = 'processing'
            AND processing_started_at = ?
        `)
        .run(invalidatedProcessingOwnershipTimestamp, input.jobId, processingStartedAt);
    },
    recoverStaleProcessingJobs(input) {
      const staleBefore = requireTimestamp(input.staleBefore);
      const recoveredAt = requireTimestamp(input.recoveredAt);

      return runInTransaction(database, () => {
        const staleJobs = database
          .prepare(`
            SELECT
              id,
              session_id,
              status,
              source_entry_count,
              queued_at,
              processing_started_at,
              processed_at,
              attempt_count,
              next_attempt_at,
              last_error_code,
              dead_lettered_at,
              purge_after
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
          if (job.attemptCount >= 3) {
            database
              .prepare(`
                UPDATE long_memory_candidate_jobs
                SET status = 'dead_letter',
                    processing_started_at = NULL,
                    processed_at = NULL,
                    next_attempt_at = NULL,
                    last_error_code = 'extraction_failed',
                    dead_lettered_at = ?,
                    purge_after = ?
                WHERE id = ? AND status = 'processing'
              `)
              .run(recoveredAt, addMilliseconds(recoveredAt, deadLetterPayloadRetentionMs), job.id);
            recordCandidateAudit(audit, "long_memory.candidate_job.dead_lettered", recoveredAt, {
              "pico.memory.session_id": job.sessionId,
              "pico.memory.candidate_job_id": job.id,
              "pico.memory.attempt_count": job.attemptCount,
              "pico.memory.error_code": "extraction_failed"
            });
          } else {
            database
              .prepare(`
                UPDATE long_memory_candidate_jobs
                SET status = 'queued',
                    processing_started_at = NULL,
                    processed_at = NULL,
                    next_attempt_at = ?
                WHERE id = ? AND status = 'processing'
              `)
              .run(recoveredAt, job.id);
            recordCandidateAudit(audit, "long_memory.candidate_job.recovered", recoveredAt, {
              "pico.memory.session_id": job.sessionId,
              "pico.memory.candidate_job_id": job.id,
              "pico.memory.source_entry_count": job.sourceEntryCount
            });
          }
        }

        return staleJobs.map((job) => requireSessionMemoryCandidateJob(database, job.id));
      });
    },
    purgeExpiredDeadLetterPayloads(input) {
      const purgedAt = requireTimestamp(input.now);
      const purgedJobs = runInTransaction(database, () =>
        purgeExpiredDeadLetterPayloads(database, purgedAt)
      );

      for (const job of purgedJobs) {
        recordCandidateAudit(audit, "long_memory.candidate_job.payload_purged", purgedAt, {
          "pico.memory.session_id": job.sessionId,
          "pico.memory.candidate_job_id": job.id,
          "pico.memory.attempt_count": job.attemptCount
        });
      }

      return purgedJobs.length;
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

async function processSessionMemoryDrafts(
  session: SessionMemoryCutoffInput,
  processSession: SessionMemoryCandidateProcessor | undefined,
  processAutomatedSession: SessionMemoryAutomatedProcessor | undefined
): Promise<{
  readonly normalizedDrafts: readonly NormalizedLongMemoryCandidateDraft[];
  readonly normalizedAutomatedDrafts: readonly NormalizedAutomatedLongMemoryInput[];
}> {
  const clonedSession = cloneSessionMemoryCutoffInput(session);

  if (processSession !== undefined) {
    const drafts = await processSession(clonedSession);

    return {
      normalizedDrafts: drafts.map((draft) => normalizeLongMemoryCandidateDraft(draft)),
      normalizedAutomatedDrafts: []
    };
  }

  if (processAutomatedSession === undefined) {
    throw new Error("pico session memory automated processor is unavailable");
  }

  const automatedDrafts = await processAutomatedSession(clonedSession);
  const allowedSourceEntryIds = new Set(session.sourceEntryIds);

  if (automatedDrafts.length > maximumAutomatedLongMemoryDraftCount) {
    throw new Error("pico automated long memory input is malformed");
  }

  const normalizedAutomatedDrafts = automatedDrafts.map((draft) =>
    normalizeAutomatedLongMemoryInput({
      ...draft,
      sourceSessionId: session.sessionId,
      policyVersion: "session-cutoff-v1"
    })
  );

  if (
    normalizedAutomatedDrafts.some((draft) =>
      draft.sourceEntryIds.some((entryId) => !allowedSourceEntryIds.has(entryId))
    )
  ) {
    throw new Error("pico automated long memory source entries are invalid");
  }

  return {
    normalizedDrafts: [],
    normalizedAutomatedDrafts
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
  return runInTransaction(database, () => {
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
  });
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
      SELECT
        id,
        session_id,
        status,
        source_entry_count,
        queued_at,
        processing_started_at,
        processed_at,
        attempt_count,
        next_attempt_at,
        last_error_code,
        dead_lettered_at,
        purge_after
      FROM long_memory_candidate_jobs
      ORDER BY id
    `)
    .all()
    .map((row) => mapSessionMemoryCandidateJob(row as SessionMemoryCandidateJobRow));
}

function openLongMemoryDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = OFF;
    `);
    runInTransaction(database, () => {
      initializeLongMemorySchema(database);
      assertLongMemoryForeignKeys(database);
    });
    database.exec("PRAGMA foreign_keys = ON");

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertLongMemoryForeignKeys(database: DatabaseSync): void {
  const violations = database.prepare("PRAGMA foreign_key_check").all();

  if (violations.length > 0) {
    throw new Error(
      `pico long memory migration left foreign key violations: ${JSON.stringify(violations)}`
    );
  }
}

function initializeLongMemorySchema(database: DatabaseSync): void {
  database.exec(`
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
      origin_kind TEXT NOT NULL DEFAULT 'staff_review' CHECK (
        origin_kind IN ('staff_review', 'session_cutoff_automation')
      ),
      origin_policy_version TEXT NOT NULL DEFAULT '',
      origin_source_session_id TEXT NOT NULL DEFAULT '',
      origin_source_entry_ids_json TEXT NOT NULL DEFAULT '[]',
      origin_created_at TEXT NOT NULL DEFAULT '',
      automated_fingerprint TEXT NOT NULL DEFAULT '',
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

  `);
  ensureLongMemoryLifecycleColumns(database);
  ensureLongMemoryProvenanceSchema(database);
  ensureLongMemoryCandidateSchema(database);
  ensureSessionMemoryCandidateJobColumns(database);
}

function ensureLongMemoryCandidateSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS long_memory_candidate_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'dead_letter')),
      source_entry_count INTEGER NOT NULL CHECK (source_entry_count >= 0),
      queued_at TEXT NOT NULL,
      processing_started_at TEXT,
      cutoff_json TEXT NOT NULL,
      processed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN ('extraction_failed', 'policy_violation')
      ),
      dead_lettered_at TEXT,
      purge_after TEXT
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
}

function ensureLongMemoryProvenanceSchema(database: DatabaseSync): void {
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(long_memory_entries)")
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );
  const migrations: Record<string, string> = {
    origin_kind:
      "ALTER TABLE long_memory_entries ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'staff_review'",
    origin_policy_version:
      "ALTER TABLE long_memory_entries ADD COLUMN origin_policy_version TEXT NOT NULL DEFAULT ''",
    origin_source_session_id:
      "ALTER TABLE long_memory_entries ADD COLUMN origin_source_session_id TEXT NOT NULL DEFAULT ''",
    origin_source_entry_ids_json:
      "ALTER TABLE long_memory_entries ADD COLUMN origin_source_entry_ids_json TEXT NOT NULL DEFAULT '[]'",
    origin_created_at:
      "ALTER TABLE long_memory_entries ADD COLUMN origin_created_at TEXT NOT NULL DEFAULT ''",
    automated_fingerprint:
      "ALTER TABLE long_memory_entries ADD COLUMN automated_fingerprint TEXT NOT NULL DEFAULT ''"
  };

  for (const [column, statement] of Object.entries(migrations)) {
    if (!columns.has(column)) {
      database.exec(statement);
    }
  }

  database.exec(`
    UPDATE long_memory_entries
    SET origin_kind = 'staff_review'
    WHERE origin_kind = '';

    CREATE UNIQUE INDEX IF NOT EXISTS long_memory_entries_active_automated_fingerprint
    ON long_memory_entries(automated_fingerprint)
    WHERE automated_fingerprint <> '' AND status = 'active';

    CREATE TABLE IF NOT EXISTS long_memory_automation_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES long_memory_entries(id),
      policy_version TEXT NOT NULL CHECK (policy_version = 'session-cutoff-v1'),
      source_session_id TEXT NOT NULL,
      source_entry_ids_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
  const tableSql = requireTableSql(database, "long_memory_candidate_jobs");

  if (!tableSql.includes("'dead_letter'")) {
    rebuildSessionMemoryCandidateJobs(database);
  }

  const columns = new Set(
    database
      .prepare("PRAGMA table_info(long_memory_candidate_jobs)")
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );

  const migrations: Record<string, string> = {
    processing_started_at:
      "ALTER TABLE long_memory_candidate_jobs ADD COLUMN processing_started_at TEXT",
    attempt_count:
      "ALTER TABLE long_memory_candidate_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)",
    next_attempt_at: "ALTER TABLE long_memory_candidate_jobs ADD COLUMN next_attempt_at TEXT",
    last_error_code:
      "ALTER TABLE long_memory_candidate_jobs ADD COLUMN last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN ('extraction_failed', 'policy_violation'))",
    dead_lettered_at: "ALTER TABLE long_memory_candidate_jobs ADD COLUMN dead_lettered_at TEXT",
    purge_after: "ALTER TABLE long_memory_candidate_jobs ADD COLUMN purge_after TEXT"
  };

  for (const [column, statement] of Object.entries(migrations)) {
    if (!columns.has(column)) {
      database.exec(statement);
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS long_memory_candidate_jobs_due
    ON long_memory_candidate_jobs(status, next_attempt_at, id)
  `);
}

function rebuildSessionMemoryCandidateJobs(database: DatabaseSync): void {
  const migratedFailedJobs = (
    database
      .prepare(`
        SELECT id, session_id, source_entry_count, queued_at, cutoff_json, processed_at
        FROM long_memory_candidate_jobs
        WHERE status = 'failed'
        ORDER BY id
      `)
      .all() as Array<{
      readonly id: number;
      readonly session_id: string;
      readonly source_entry_count: number;
      readonly queued_at: string;
      readonly cutoff_json: string;
      readonly processed_at: string | null;
    }>
  ).map((row) => {
    const deadLetteredAt = requireTimestamp(row.processed_at ?? row.queued_at);
    let session: SessionMemoryCutoffInput | undefined;

    try {
      const normalized = normalizeSessionMemoryCutoffInput(JSON.parse(row.cutoff_json) as unknown);

      if (
        normalized.sessionId === row.session_id &&
        normalized.sourceEntryIds.length === row.source_entry_count
      ) {
        session = normalized;
      }
    } catch {
      session = undefined;
    }

    const retainedPayload =
      session === undefined
        ? compactUnparseableDeadLetterCutoffPayload(
            row.id,
            row.session_id,
            row.source_entry_count,
            deadLetteredAt
          )
        : compactDeadLetterCutoffPayload(session);

    return {
      id: row.id,
      cutoffJson: JSON.stringify(retainedPayload),
      purgeAfter: addMilliseconds(deadLetteredAt, deadLetterPayloadRetentionMs)
    };
  });

  database.exec(`
    ALTER TABLE long_memory_candidate_jobs RENAME TO long_memory_candidate_jobs_legacy;

    CREATE TABLE long_memory_candidate_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'dead_letter')),
      source_entry_count INTEGER NOT NULL CHECK (source_entry_count >= 0),
      queued_at TEXT NOT NULL,
      processing_started_at TEXT,
      cutoff_json TEXT NOT NULL,
      processed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN ('extraction_failed', 'policy_violation')
      ),
      dead_lettered_at TEXT,
      purge_after TEXT
    );

    INSERT INTO long_memory_candidate_jobs (
      id,
      session_id,
      status,
      source_entry_count,
      queued_at,
      processing_started_at,
      cutoff_json,
      processed_at,
      attempt_count,
      last_error_code,
      dead_lettered_at
    )
    SELECT
      id,
      session_id,
      CASE status WHEN 'failed' THEN 'dead_letter' ELSE status END,
      source_entry_count,
      queued_at,
      processing_started_at,
      cutoff_json,
      CASE status WHEN 'failed' THEN NULL ELSE processed_at END,
      CASE status WHEN 'failed' THEN 3 ELSE 0 END,
      CASE status WHEN 'failed' THEN 'extraction_failed' ELSE NULL END,
      CASE status WHEN 'failed' THEN COALESCE(processed_at, queued_at) ELSE NULL END
    FROM long_memory_candidate_jobs_legacy;

    DROP TABLE long_memory_candidate_jobs_legacy;
  `);

  const updateMigratedFailedJob = database.prepare(`
    UPDATE long_memory_candidate_jobs
    SET cutoff_json = ?, purge_after = ?
    WHERE id = ? AND status = 'dead_letter'
  `);

  for (const job of migratedFailedJobs) {
    updateMigratedFailedJob.run(job.cutoffJson, job.purgeAfter, job.id);
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
      origin_kind TEXT NOT NULL DEFAULT 'staff_review' CHECK (
        origin_kind IN ('staff_review', 'session_cutoff_automation')
      ),
      origin_policy_version TEXT NOT NULL DEFAULT '',
      origin_source_session_id TEXT NOT NULL DEFAULT '',
      origin_source_entry_ids_json TEXT NOT NULL DEFAULT '[]',
      origin_created_at TEXT NOT NULL DEFAULT '',
      automated_fingerprint TEXT NOT NULL DEFAULT '',
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
  assertNoIndividualChildLongMemoryFields(input);
  validateLongMemoryKeys(input, longMemoryInputKeys, "pico long memory input is malformed");
  const title = requireMemoryText(input.title);
  const body = requireMemoryText(input.body);

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

function normalizeAutomatedLongMemoryInput(
  input: AutomatedLongMemoryInput
): NormalizedAutomatedLongMemoryInput {
  assertNoIndividualChildLongMemoryFields(input);
  const record = requireMemoryRecord(input, "pico automated long memory input is malformed");
  validateLongMemoryKeys(
    record,
    automatedLongMemoryInputKeys,
    "pico automated long memory input is malformed"
  );
  const title = requireMemoryText(record.title);
  const body = requireMemoryText(record.body);
  const category = requireLongMemoryCategory(record.category);
  const tags = normalizeTags(record.tags);
  const sourceSessionId = requireMemoryText(record.sourceSessionId);
  const sourceEntryIds = normalizeAutomatedSourceEntryIds(record.sourceEntryIds);
  const policyVersion = requireAutomationPolicyVersion(record.policyVersion);
  const confidence = requireLifecycleUnit(
    record.confidence,
    "pico automated long memory confidence is invalid"
  );

  return {
    title,
    body,
    category,
    tags,
    sourceSessionId,
    sourceEntryIds,
    policyVersion,
    confidence,
    fingerprint: createHash("sha256")
      .update([policyVersion, category, title, body].join("\0"))
      .digest("hex")
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

function writeAutomatedMemory(
  database: DatabaseSync,
  input: NormalizedAutomatedLongMemoryInput,
  createdAt: string
): LongMemoryRecord {
  const existing = readActiveAutomatedMemory(database, input.fingerprint);

  if (existing !== undefined) {
    recordAutomationObservation(database, existing.id, input, createdAt);
    return existing;
  }

  const result = database
    .prepare(`
      INSERT INTO long_memory_entries (
        title,
        body,
        category,
        tags_json,
        status,
        reviewed_by,
        reviewed_at,
        review_note,
        source_session_id,
        confidence,
        origin_kind,
        origin_policy_version,
        origin_source_session_id,
        origin_source_entry_ids_json,
        origin_created_at,
        automated_fingerprint
      )
      VALUES (?, ?, ?, ?, 'active', '', '', '', ?, ?, 'session_cutoff_automation', ?, ?, ?, ?, ?)
    `)
    .run(
      input.title,
      input.body,
      input.category,
      JSON.stringify(input.tags),
      input.sourceSessionId,
      input.confidence,
      input.policyVersion,
      input.sourceSessionId,
      JSON.stringify(input.sourceEntryIds),
      createdAt,
      input.fingerprint
    );
  const id = Number(result.lastInsertRowid);

  recordAutomationObservation(database, id, input, createdAt);

  return requireActiveMemory(database, id);
}

function readActiveAutomatedMemory(
  database: DatabaseSync,
  fingerprint: string
): LongMemoryRecord | undefined {
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
        status,
        origin_kind,
        origin_policy_version,
        origin_source_session_id,
        origin_source_entry_ids_json,
        origin_created_at,
        automated_fingerprint
      FROM long_memory_entries
      WHERE automated_fingerprint = ? AND status = 'active'
    `)
    .get(fingerprint);

  return row === undefined ? undefined : mapLongMemoryRow(row as LongMemoryRow);
}

function recordAutomationObservation(
  database: DatabaseSync,
  memoryId: number,
  input: NormalizedAutomatedLongMemoryInput,
  observedAt: string
): void {
  database
    .prepare(`
      INSERT INTO long_memory_automation_observations (
        memory_id,
        policy_version,
        source_session_id,
        source_entry_ids_json,
        observed_at
      )
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      memoryId,
      input.policyVersion,
      input.sourceSessionId,
      JSON.stringify(input.sourceEntryIds),
      observedAt
    );
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
        status,
        origin_kind,
        origin_policy_version,
        origin_source_session_id,
        origin_source_entry_ids_json,
        origin_created_at,
        automated_fingerprint
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

function searchBoundedActiveMemories(
  database: DatabaseSync,
  query: string,
  limit: number,
  accessedAt: string
): readonly LongMemoryRecord[] {
  const records =
    query.length >= minimumTrigramQueryLength
      ? searchBoundedActiveMemoriesByMatch(database, query, limit)
      : searchBoundedActiveMemoriesByLike(database, query, limit);

  recordMemoryAccess(
    database,
    records.map((record) => record.id),
    accessedAt
  );

  return records.map((record) =>
    Object.freeze({
      ...record,
      lifecycle: Object.freeze({
        ...record.lifecycle,
        lastAccessedAt: accessedAt,
        accessCount: record.lifecycle.accessCount + 1
      })
    })
  );
}

function searchBoundedActiveMemoriesByMatch(
  database: DatabaseSync,
  query: string,
  limit: number
): LongMemoryRecord[] {
  return database
    .prepare(`
      SELECT
        e.id,
        e.title,
        e.body,
        e.category,
        e.tags_json,
        e.correction_of,
        e.reviewed_by,
        e.reviewed_at,
        e.review_note,
        e.mem0_memory_id,
        e.source_session_id,
        e.importance,
        e.confidence,
        e.last_accessed_at,
        e.access_count,
        e.decay_score,
        e.status,
        e.origin_kind,
        e.origin_policy_version,
        e.origin_source_session_id,
        e.origin_source_entry_ids_json,
        e.origin_created_at,
        e.automated_fingerprint
      FROM long_memory_entries_fts
      JOIN long_memory_entries AS e ON e.id = long_memory_entries_fts.rowid
      WHERE long_memory_entries_fts MATCH ? AND e.status = 'active'
      ORDER BY rank, e.id
      LIMIT ?
    `)
    .all(quoteFtsQuery(query), limit)
    .map((row) => mapLongMemoryRow(row as LongMemoryRow));
}

function searchBoundedActiveMemoriesByLike(
  database: DatabaseSync,
  query: string,
  limit: number
): LongMemoryRecord[] {
  const pattern = `%${escapeLikePattern(query)}%`;

  return database
    .prepare(`
      SELECT
        e.id,
        e.title,
        e.body,
        e.category,
        e.tags_json,
        e.correction_of,
        e.reviewed_by,
        e.reviewed_at,
        e.review_note,
        e.mem0_memory_id,
        e.source_session_id,
        e.importance,
        e.confidence,
        e.last_accessed_at,
        e.access_count,
        e.decay_score,
        e.status,
        e.origin_kind,
        e.origin_policy_version,
        e.origin_source_session_id,
        e.origin_source_entry_ids_json,
        e.origin_created_at,
        e.automated_fingerprint
      FROM long_memory_entries_fts
      JOIN long_memory_entries AS e ON e.id = long_memory_entries_fts.rowid
      WHERE e.status = 'active'
        AND (
          long_memory_entries_fts.title LIKE ? ESCAPE '\\'
          OR long_memory_entries_fts.body LIKE ? ESCAPE '\\'
        )
      ORDER BY e.id
      LIMIT ?
    `)
    .all(pattern, pattern, limit)
    .map((row) => mapLongMemoryRow(row as LongMemoryRow));
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
        status,
        origin_kind,
        origin_created_at
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
  const createdAt =
    row.origin_kind === "session_cutoff_automation"
      ? row.origin_created_at
      : row.origin_kind === "staff_review"
        ? row.reviewed_at
        : "";
  const referenceAt = requireStoredTimestamp(
    row.last_accessed_at === "" ? createdAt : row.last_accessed_at
  );
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
  assertNoIndividualChildLongMemoryFields(input);
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

function normalizeAutomatedSourceEntryIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("pico automated long memory source entries are required");
  }

  const sourceEntryIds: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new Error("pico automated long memory input is malformed");
    }

    sourceEntryIds.push(requireMemoryText(value[index]));
  }

  return Object.freeze(sourceEntryIds);
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
  return requireMemoryText(value);
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
  assertNoIndividualChildLongMemoryFields(draft);
  const record = requireMemoryRecord(draft, "pico long memory candidate input is malformed");
  validateLongMemoryKeys(
    record,
    longMemoryCandidateDraftKeys,
    "pico long memory candidate input is malformed"
  );
  const title = requireMemoryText(record.title);
  const body = requireMemoryText(record.body);

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
      SELECT
        id,
        session_id,
        status,
        source_entry_count,
        queued_at,
        processing_started_at,
        processed_at,
        attempt_count,
        next_attempt_at,
        last_error_code,
        dead_lettered_at,
        purge_after
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
    const row = readNextQueuedSessionMemoryCandidateJob(database, processingStartedAt);

    if (row === undefined) {
      return undefined;
    }

    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET status = 'processing',
            processing_started_at = ?,
            processed_at = NULL,
            attempt_count = attempt_count + 1
        WHERE id = ? AND status = 'queued'
      `)
      .run(processingStartedAt, row.id);

    return {
      ...row,
      status: "processing",
      processing_started_at: processingStartedAt,
      attempt_count: row.attempt_count + 1
    };
  });
}

function readNextQueuedSessionMemoryCandidateJob(
  database: DatabaseSync,
  eligibleAt: string
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
        attempt_count,
        next_attempt_at,
        last_error_code,
        dead_lettered_at,
        purge_after,
        cutoff_json
      FROM long_memory_candidate_jobs
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY id
      LIMIT 1
    `)
    .get(eligibleAt);

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
      SET status = 'processed',
          processed_at = ?,
          next_attempt_at = NULL,
          last_error_code = NULL,
          dead_lettered_at = NULL,
          purge_after = NULL,
          cutoff_json = ?
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

function compactDeadLetterCutoffPayload(
  session: SessionMemoryCutoffInput
): Record<string, unknown> {
  return compactCutoffPayload(session, "dead_letter_metadata_only");
}

function compactCutoffPayload(
  session: SessionMemoryCutoffInput,
  retention: "processed_metadata_only" | "dead_letter_metadata_only"
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    cutoffAt: session.cutoffAt,
    sourceEntryIds: session.sourceEntryIds,
    sourceEntryCount: session.sourceEntryIds.length,
    requestedBy: session.requestedBy,
    retention
  };
}

function compactUnparseableDeadLetterCutoffPayload(
  jobId: number,
  sessionId: string,
  sourceEntryCount: number,
  deadLetteredAt: string
): Record<string, unknown> {
  return {
    jobId,
    sessionId,
    deadLetteredAt,
    sourceEntryIds: [],
    sourceEntryCount,
    retention: "dead_letter_metadata_only"
  };
}

function classifySessionMemoryCandidateJobError(
  error: unknown
): SessionMemoryCandidateJobErrorCode {
  return error instanceof PermanentMemoryPolicyError ? "policy_violation" : "extraction_failed";
}

function transitionFailedCandidateJob(
  database: DatabaseSync,
  input: {
    readonly job: MappedSessionMemoryCandidateJob;
    readonly transitionedAt: string;
    readonly processingStartedAt: string;
    readonly session: SessionMemoryCutoffInput | undefined;
    readonly errorCode: SessionMemoryCandidateJobErrorCode;
  }
): void {
  if (input.errorCode === "policy_violation") {
    const retentionPayload =
      input.session === undefined
        ? compactUnparseableDeadLetterCutoffPayload(
            input.job.id,
            input.job.sessionId,
            input.job.sourceEntryCount,
            input.transitionedAt
          )
        : compactDeadLetterCutoffPayload(input.session);

    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET status = 'dead_letter',
            processed_at = NULL,
            next_attempt_at = NULL,
            last_error_code = ?,
            dead_lettered_at = ?,
            purge_after = NULL,
            cutoff_json = ?
        WHERE id = ? AND status = 'processing' AND processing_started_at = ?
      `)
      .run(
        input.errorCode,
        input.transitionedAt,
        JSON.stringify(retentionPayload),
        input.job.id,
        input.processingStartedAt
      );
    return;
  }

  const retryDelayMs = retryDelayAfterAttempt(input.job.attemptCount);

  if (retryDelayMs !== undefined) {
    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET status = 'queued',
            processing_started_at = NULL,
            processed_at = NULL,
            next_attempt_at = ?,
            last_error_code = ?,
            dead_lettered_at = NULL,
            purge_after = NULL
        WHERE id = ? AND status = 'processing' AND processing_started_at = ?
      `)
      .run(
        addMilliseconds(input.transitionedAt, retryDelayMs),
        input.errorCode,
        input.job.id,
        input.processingStartedAt
      );
    return;
  }

  database
    .prepare(`
      UPDATE long_memory_candidate_jobs
      SET status = 'dead_letter',
          processed_at = NULL,
          next_attempt_at = NULL,
          last_error_code = ?,
          dead_lettered_at = ?,
          purge_after = ?
      WHERE id = ? AND status = 'processing' AND processing_started_at = ?
    `)
    .run(
      input.errorCode,
      input.transitionedAt,
      addMilliseconds(input.transitionedAt, deadLetterPayloadRetentionMs),
      input.job.id,
      input.processingStartedAt
    );
}

function retryDelayAfterAttempt(attemptCount: number): number | undefined {
  return [30_000, 120_000][attemptCount - 1];
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function purgeExpiredDeadLetterPayloads(
  database: DatabaseSync,
  purgedAt: string
): readonly MappedSessionMemoryCandidateJob[] {
  const rows = database
    .prepare(`
      SELECT
        id,
        session_id,
        status,
        source_entry_count,
        queued_at,
        processing_started_at,
        processed_at,
        attempt_count,
        next_attempt_at,
        last_error_code,
        dead_lettered_at,
        purge_after,
        cutoff_json
      FROM long_memory_candidate_jobs
      WHERE status = 'dead_letter' AND purge_after IS NOT NULL AND purge_after <= ?
      ORDER BY id
    `)
    .all(purgedAt) as QueuedSessionMemoryCandidateJobRow[];

  for (const row of rows) {
    let session: SessionMemoryCutoffInput | undefined;

    try {
      session = parseSessionMemoryCutoffPayload(row);
    } catch {
      session = undefined;
    }

    const retentionPayload =
      session === undefined
        ? compactUnparseableDeadLetterCutoffPayload(
            row.id,
            row.session_id,
            row.source_entry_count,
            row.dead_lettered_at ?? purgedAt
          )
        : compactDeadLetterCutoffPayload(session);

    database
      .prepare(`
        UPDATE long_memory_candidate_jobs
        SET cutoff_json = ?, purge_after = NULL
        WHERE id = ? AND status = 'dead_letter' AND purge_after IS NOT NULL AND purge_after <= ?
      `)
      .run(JSON.stringify(retentionPayload), row.id, purgedAt);
  }

  return rows.map((row) =>
    Object.freeze({
      ...mapSessionMemoryCandidateJob(row),
      purgeAfter: undefined
    })
  );
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
): MappedSessionMemoryCandidateJob {
  return Object.freeze({
    id: row.id,
    sessionId: row.session_id,
    status: requireSessionMemoryCandidateJobStatus(row.status),
    sourceEntryCount: row.source_entry_count,
    queuedAt: requireTimestamp(row.queued_at),
    processingStartedAt:
      row.processing_started_at === null ? undefined : requireTimestamp(row.processing_started_at),
    processedAt: row.processed_at === null ? undefined : requireTimestamp(row.processed_at),
    attemptCount: requireNonNegativeInteger(row.attempt_count),
    nextAttemptAt: row.next_attempt_at === null ? undefined : requireTimestamp(row.next_attempt_at),
    lastErrorCode:
      row.last_error_code === null
        ? undefined
        : requireSessionMemoryCandidateJobErrorCode(row.last_error_code),
    deadLetteredAt:
      row.dead_lettered_at === null ? undefined : requireTimestamp(row.dead_lettered_at),
    purgeAfter: row.purge_after === null ? undefined : requireTimestamp(row.purge_after)
  });
}

function mapLongMemoryRow(row: LongMemoryRow): LongMemoryRecord {
  const provenance = mapLongMemoryProvenance(row);

  return Object.freeze({
    id: row.id,
    title: row.title,
    body: row.body,
    category: requireLongMemoryCategory(row.category),
    tags: Object.freeze(JSON.parse(row.tags_json) as string[]),
    status: "active" as const,
    correctionOf: row.correction_of === 0 ? undefined : row.correction_of,
    review:
      provenance.kind === "staff_review"
        ? normalizeStoredReview(row.reviewed_by, row.reviewed_at, row.review_note)
        : undefined,
    provenance,
    lifecycle: mapLifecycle(row)
  });
}

function mapLongMemoryProvenance(row: LongMemoryRow): LongMemoryProvenance {
  if (row.origin_kind === "staff_review") {
    const review = normalizeStoredReview(row.reviewed_by, row.reviewed_at, row.review_note);

    return Object.freeze({
      kind: "staff_review",
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      note: review.note
    });
  }

  if (row.origin_kind === "session_cutoff_automation") {
    return Object.freeze({
      kind: "session_cutoff_automation",
      policyVersion: requireAutomationPolicyVersion(row.origin_policy_version),
      sourceSessionId: requireStoredRequiredText(row.origin_source_session_id),
      sourceEntryIds: parseStoredSourceEntryIds(row.origin_source_entry_ids_json),
      createdAt: requireStoredTimestamp(row.origin_created_at)
    });
  }

  throw new Error("pico long memory row is malformed");
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

    tags.push(requireMemoryText(value[index]));
  }

  return Object.freeze(tags);
}

function validateLongMemoryKeys(
  input: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  malformedMessage: string
): void {
  for (const key of Object.keys(input)) {
    if (isIndividualChildField(key)) {
      throwIndividualChildPolicyError();
    }

    if (!allowedKeys.has(key)) {
      throw new Error(malformedMessage);
    }
  }
}

function isIndividualChildField(key: string): boolean {
  const normalized = normalizeStructuralFieldName(key);

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

function normalizeStructuralFieldName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[\p{P}\p{S}\p{Z}\s\u02bb\u02bc\ua78c]/gu, "");
}

function throwIndividualChildPolicyError(): never {
  throw new PermanentMemoryPolicyError(
    "pico long memory must not contain structured individual child profile fields"
  );
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
  if (
    value === "queued" ||
    value === "processing" ||
    value === "processed" ||
    value === "dead_letter"
  ) {
    return value;
  }

  throw new Error("pico session memory candidate job row is malformed");
}

function requireSessionMemoryCandidateJobErrorCode(
  value: unknown
): SessionMemoryCandidateJobErrorCode {
  if (value === "extraction_failed" || value === "policy_violation") {
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
  const timestampMs = Date.parse(timestamp);

  if (!Number.isFinite(timestampMs)) {
    throw new Error("pico long memory timestamp is invalid");
  }

  return new Date(timestampMs).toISOString();
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

function requireSearchLimit(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  throw new Error("pico long memory search limit is invalid");
}

function requireAutomationPolicyVersion(value: unknown): "session-cutoff-v1" {
  if (value === "session-cutoff-v1") {
    return value;
  }

  throw new Error("pico automated long memory policy version is invalid");
}

function requireStoredRequiredText(value: unknown): string {
  const text = requireStoredText(value);

  if (text === "") {
    throw new Error("pico long memory row is malformed");
  }

  return text;
}

function requireStoredTimestamp(value: unknown): string {
  const timestamp = requireStoredRequiredText(value);

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("pico long memory row is malformed");
  }

  return timestamp;
}

function parseStoredSourceEntryIds(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    throw new Error("pico long memory row is malformed");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("pico long memory row is malformed");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("pico long memory row is malformed");
  }

  return Object.freeze(parsed.map((entryId) => requireStoredRequiredText(entryId)));
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
