import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  type LongMemoryCandidateDraft,
  openSessionMemoryCandidateQueue,
  openSessionMemoryCandidateStore,
  type SessionMemoryCutoffInput
} from "../src/modules/long-memory/index.js";
import {
  createSessionMemoryEnqueueWorker,
  createSessionMemoryWorker
} from "../src/modules/long-memory/session-worker.js";
import { createSessionLifecycle } from "../src/modules/session/index.js";

async function withLongMemoryDatabase(run: (path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-worker-"));
  const path = join(directory, "long-memory.sqlite");

  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cutoffInput(sessionId: string): SessionMemoryCutoffInput {
  return {
    sessionId,
    cutoffAt: "2026-06-17T10:00:00.000Z",
    sourceEntryIds: [`${sessionId}-entry-1`],
    entries: [
      {
        id: `${sessionId}-entry-1`,
        role: "staff",
        content: `${sessionId} の継続メモ候補。`
      }
    ],
    requestedBy: "session_lifecycle"
  };
}

function draftFor(session: SessionMemoryCutoffInput): LongMemoryCandidateDraft {
  return {
    title: `${session.sessionId} continuity`,
    body: `${session.sessionId} memory candidate`,
    category: "care_continuity"
  };
}

describe("session memory worker", () => {
  it("supports enqueue-only resident processes without a drain processor", async () => {
    await withLongMemoryDatabase((path) => {
      const audit = createStructuredAuditLog();
      const queue = openSessionMemoryCandidateQueue(path, {
        audit,
        now: () => "2026-06-17T10:00:00.000Z"
      });
      const worker = createSessionMemoryEnqueueWorker({
        queue,
        audit,
        maxQueueDepth: 4,
        now: () => "2026-06-17T10:00:00.000Z"
      });

      try {
        const job = worker.enqueueCutoff(cutoffInput("session-resident"));

        expect(job).toMatchObject({
          sessionId: "session-resident",
          status: "queued",
          queuedAt: "2026-06-17T10:00:00.000Z"
        });
        expect(queue.countJobs(["queued", "processing"])).toBe(1);
        expect(queue.listJobs()).toEqual([
          expect.objectContaining({
            sessionId: "session-resident",
            status: "queued"
          })
        ]);
        expect(audit.entries().map((event) => event.name)).toEqual([
          "long_memory.candidate_job.enqueued",
          "long_memory.worker.cutoff_enqueued"
        ]);
      } finally {
        queue.close();
      }
    });
  });

  it("keeps later sessions responsive while an earlier cutoff is still processing", async () => {
    vi.useFakeTimers();

    try {
      await withLongMemoryDatabase(async (path) => {
        let releaseFirstJob: (() => void) | undefined;
        const firstJobGate = new Promise<void>((resolve) => {
          releaseFirstJob = resolve;
        });
        const processedSessions: string[] = [];
        const candidates = openSessionMemoryCandidateStore(path, {
          now: () => "2026-06-17T10:00:01.000Z",
          processSession: async (session) => {
            processedSessions.push(session.sessionId);

            if (session.sessionId === "session-1") {
              await firstJobGate;
            }

            return [draftFor(session)];
          }
        });
        const worker = createSessionMemoryWorker({
          store: candidates,
          maxQueueDepth: 4,
          now: () => "2026-06-17T10:00:01.000Z"
        });
        const lifecycle = createSessionLifecycle({
          ending: {
            mode: "timed",
            durationMs: 10
          }
        });

        try {
          const first = lifecycle.start({
            kind: "greeting",
            label: "おはよう",
            source: "test"
          });
          lifecycle.appendEntry(first.id, {
            role: "staff",
            content: "雨の日は工作セットを先に出す。"
          });
          await vi.advanceTimersByTimeAsync(10);
          worker.enqueueCutoff(lifecycle.cutoff(first.id));

          const firstDrain = worker.drainOnce();
          await Promise.resolve();

          const second = lifecycle.start({
            kind: "wake_name",
            label: "ピコ",
            source: "test"
          });
          lifecycle.appendEntry(second.id, {
            role: "staff",
            content: "スポーツイベントの日は入口付近が混みやすい。"
          });
          await vi.advanceTimersByTimeAsync(10);
          worker.enqueueCutoff(lifecycle.cutoff(second.id));

          releaseFirstJob?.();
          await expect(firstDrain).resolves.toMatchObject({
            processedJob: {
              status: "processed"
            }
          });
          await expect(worker.drainUntilIdle()).resolves.toMatchObject({
            processedCount: 1,
            recoveredCount: 0
          });

          expect(processedSessions).toEqual(["session-1", "session-2"]);
          expect(candidates.listJobs().map((job) => job.status)).toEqual([
            "processed",
            "processed"
          ]);
          expect(candidates.listPending().map((candidate) => candidate.sessionId)).toEqual([
            "session-1",
            "session-2"
          ]);
        } finally {
          candidates.close();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers stale processing jobs before draining queued work", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-17T10:10:00.000Z",
        processSession: (session) => Promise.resolve([draftFor(session)])
      });

      try {
        const staleJob = candidates.enqueueSessionCutoff(cutoffInput("session-stale"));
        const database = new DatabaseSync(path);

        try {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'processing', processing_started_at = ?, attempt_count = 1,
                  next_attempt_at = '2026-06-17T10:30:00.000Z'
              WHERE id = ?
            `)
            .run("2026-06-17T10:00:00.000Z", staleJob.id);
        } finally {
          database.close();
        }

        const worker = createSessionMemoryWorker({
          store: candidates,
          recoverProcessingOlderThanMs: 60_000,
          now: () => "2026-06-17T10:10:00.000Z"
        });

        expect(worker.recoverStaleProcessingJobs()).toEqual([
          expect.objectContaining({
            id: staleJob.id,
            status: "queued",
            attemptCount: 1,
            nextAttemptAt: "2026-06-17T10:10:00.000Z"
          })
        ]);
        await expect(worker.drainUntilIdle()).resolves.toMatchObject({
          processedCount: 1,
          recoveredCount: 0
        });
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            id: staleJob.id,
            status: "processed",
            attemptCount: 2,
            processingStartedAt: "2026-06-17T10:10:00.000Z"
          })
        ]);
      } finally {
        candidates.close();
      }
    });
  });

  it("dead-letters stale processing jobs whose third attempt was already claimed", async () => {
    await withLongMemoryDatabase(async (path) => {
      let processCallCount = 0;
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        now: () => "2026-06-17T10:10:00.000Z",
        processSession: () => {
          processCallCount += 1;
          return Promise.resolve([]);
        }
      });

      try {
        const staleJob = candidates.enqueueSessionCutoff(cutoffInput("session-exhausted-stale"));
        const database = new DatabaseSync(path);

        try {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'processing',
                  processing_started_at = '2026-06-17T10:00:00.000Z',
                  attempt_count = 3
              WHERE id = ?
            `)
            .run(staleJob.id);
        } finally {
          database.close();
        }

        const worker = createSessionMemoryWorker({
          store: candidates,
          audit,
          recoverProcessingOlderThanMs: 60_000,
          now: () => "2026-06-17T10:10:00.000Z"
        });

        expect(worker.recoverStaleProcessingJobs()).toEqual([]);
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            id: staleJob.id,
            status: "dead_letter",
            attemptCount: 3,
            lastErrorCode: "extraction_failed",
            deadLetteredAt: "2026-06-17T10:10:00.000Z",
            purgeAfter: "2026-06-24T10:10:00.000Z"
          })
        ]);
        await expect(candidates.processNextJob()).resolves.toBeUndefined();
        expect(processCallCount).toBe(0);
        expect(audit.entries().map((event) => event.name)).toContain(
          "long_memory.candidate_job.dead_lettered"
        );
        expect(audit.entries().map((event) => event.name)).not.toContain(
          "long_memory.worker.processing_recovered"
        );

        const verificationDatabase = new DatabaseSync(path);

        try {
          const row = verificationDatabase
            .prepare("SELECT cutoff_json FROM long_memory_candidate_jobs WHERE id = ?")
            .get(staleJob.id) as { readonly cutoff_json: string };

          expect(JSON.parse(row.cutoff_json)).toEqual(cutoffInput("session-exhausted-stale"));
        } finally {
          verificationDatabase.close();
        }
      } finally {
        candidates.close();
      }
    });
  });

  it("does not recover processing jobs by default", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-17T10:10:00.000Z",
        processSession: (session) => Promise.resolve([draftFor(session)])
      });

      try {
        const processingJob = candidates.enqueueSessionCutoff(cutoffInput("session-processing"));
        const database = new DatabaseSync(path);

        try {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'processing', processing_started_at = ?
              WHERE id = ?
            `)
            .run("2026-06-17T10:00:00.000Z", processingJob.id);
        } finally {
          database.close();
        }

        const worker = createSessionMemoryWorker({
          store: candidates,
          now: () => "2026-06-17T10:10:00.000Z"
        });

        expect(worker.recoverStaleProcessingJobs()).toEqual([]);
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 0,
          recoveredCount: 0,
          idle: false
        });
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            id: processingJob.id,
            status: "processing",
            processingStartedAt: "2026-06-17T10:00:00.000Z"
          })
        ]);
      } finally {
        candidates.close();
      }
    });
  });

  it("does not write duplicate candidates when stale recovery wins a processing race", async () => {
    await withLongMemoryDatabase(async (path) => {
      let now = "2026-06-17T10:00:00.000Z";
      let releaseOriginalProcessor: (() => void) | undefined;
      let processCallCount = 0;
      const originalProcessorGate = new Promise<void>((resolve) => {
        releaseOriginalProcessor = resolve;
      });
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => now,
        processSession: async (session) => {
          processCallCount += 1;

          if (processCallCount === 1) {
            await originalProcessorGate;
          }

          return [draftFor(session)];
        }
      });

      try {
        candidates.enqueueSessionCutoff(cutoffInput("session-race"));
        const originalDrain = candidates.processNextJob();
        await Promise.resolve();
        now = "2026-06-17T10:10:00.000Z";
        const worker = createSessionMemoryWorker({
          store: candidates,
          recoverProcessingOlderThanMs: 60_000,
          now: () => now
        });

        await expect(worker.drainUntilIdle()).resolves.toMatchObject({
          processedCount: 1,
          recoveredCount: 1
        });
        releaseOriginalProcessor?.();
        await expect(originalDrain).resolves.toMatchObject({
          status: "processed"
        });

        expect(processCallCount).toBe(2);
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "processed",
            processingStartedAt: "2026-06-17T10:10:00.000Z"
          })
        ]);
        expect(candidates.listPending().map((candidate) => candidate.sessionId)).toEqual([
          "session-race"
        ]);
      } finally {
        candidates.close();
      }
    });
  });

  it("does not report idle while a non-stale processing job remains", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-17T10:10:00.000Z",
        processSession: (session) => Promise.resolve([draftFor(session)])
      });

      try {
        const processingJob = candidates.enqueueSessionCutoff(cutoffInput("session-processing"));
        const database = new DatabaseSync(path);

        try {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'processing', processing_started_at = ?
              WHERE id = ?
            `)
            .run("2026-06-17T10:09:30.000Z", processingJob.id);
        } finally {
          database.close();
        }

        const worker = createSessionMemoryWorker({
          store: candidates,
          recoverProcessingOlderThanMs: 60_000,
          now: () => "2026-06-17T10:10:00.000Z"
        });

        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 0,
          recoveredCount: 0,
          idle: false
        });
      } finally {
        candidates.close();
      }
    });
  });

  it("fails explicitly when the session memory queue reaches the configured depth", async () => {
    await withLongMemoryDatabase((path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        processSession: (session) => Promise.resolve([draftFor(session)])
      });
      const worker = createSessionMemoryWorker({
        store: candidates,
        audit,
        maxQueueDepth: 1,
        now: () => "2026-06-17T10:00:00.000Z"
      });

      try {
        worker.enqueueCutoff(cutoffInput("session-1"));

        expect(() => worker.enqueueCutoff(cutoffInput("session-2"))).toThrow(
          "pico session memory worker queue depth limit reached"
        );
        expect(candidates.listJobs()).toHaveLength(1);
        expect(audit.entries().map((event) => event.name)).toContain(
          "long_memory.worker.backpressure"
        );
      } finally {
        candidates.close();
      }
    });
  });

  it("stops claiming after abort and waits for the in-flight transition", async () => {
    await withLongMemoryDatabase(async (path) => {
      let releaseProcessing: (() => void) | undefined;
      const processingGate = new Promise<void>((resolve) => {
        releaseProcessing = resolve;
      });
      const processedSessions: string[] = [];
      const controller = new AbortController();
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-17T10:00:00.000Z",
        processSession: async (session) => {
          processedSessions.push(session.sessionId);
          await processingGate;
          return [draftFor(session)];
        }
      });
      const worker = createSessionMemoryWorker({
        store: candidates,
        signal: controller.signal,
        now: () => "2026-06-17T10:00:00.000Z"
      });

      try {
        worker.enqueueCutoff(cutoffInput("session-in-flight"));
        worker.enqueueCutoff(cutoffInput("session-unclaimed"));
        const drain = worker.drainUntilIdle();
        await Promise.resolve();

        controller.abort();
        let settled = false;
        const settlement = drain.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseProcessing?.();
        await expect(drain).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: false
        });
        await settlement;
        expect(processedSessions).toEqual(["session-in-flight"]);
        expect(candidates.listJobs().map((job) => job.status)).toEqual(["processed", "queued"]);
        await expect(worker.drainOnce()).resolves.toEqual({
          recoveredCount: 0,
          processedJob: undefined
        });
      } finally {
        releaseProcessing?.();
        candidates.close();
      }
    });
  });

  it("purges expired dead-letter payloads through the worker timestamp boundary", async () => {
    await withLongMemoryDatabase((path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: (session) => Promise.resolve([draftFor(session)])
      });
      const worker = createSessionMemoryWorker({
        store: candidates,
        now: () => "2026-06-24T10:00:00.000Z"
      });

      try {
        const job = candidates.enqueueSessionCutoff(cutoffInput("session-expired"));
        const database = new DatabaseSync(path);

        try {
          database
            .prepare(`
              UPDATE long_memory_candidate_jobs
              SET status = 'dead_letter',
                  attempt_count = 3,
                  last_error_code = 'extraction_failed',
                  dead_lettered_at = '2026-06-17T10:00:00.000Z',
                  purge_after = '2026-06-24T10:00:00.000Z'
              WHERE id = ?
            `)
            .run(job.id);
        } finally {
          database.close();
        }

        expect(worker.purgeExpiredDeadLetterPayloads()).toBe(1);

        const verificationDatabase = new DatabaseSync(path);

        try {
          const row = verificationDatabase
            .prepare("SELECT cutoff_json, purge_after FROM long_memory_candidate_jobs WHERE id = ?")
            .get(job.id) as { readonly cutoff_json: string; readonly purge_after: string | null };

          expect(row.purge_after).toBeNull();
          expect(JSON.parse(row.cutoff_json)).toMatchObject({
            sessionId: "session-expired",
            retention: "dead_letter_metadata_only"
          });
        } finally {
          verificationDatabase.close();
        }
      } finally {
        candidates.close();
      }
    });
  });
});
