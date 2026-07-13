import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type {
  AutomatedFacilityMemoryDraft,
  FacilityMemoryExtractor
} from "../src/modules/long-memory/extractor.js";
import {
  openLongMemoryStore,
  openSessionMemoryCandidateQueue,
  openSessionMemoryCandidateStore,
  type SessionMemoryCutoffInput
} from "../src/modules/long-memory/index.js";
import { createResidentMemoryDrainWorker } from "../src/runtime/resident-memory-worker.js";

describe("resident memory drain worker", () => {
  it("drains queued session cutoffs into automated SQLite memories", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const queue = openSessionMemoryCandidateQueue(path, {
        audit,
        now: () => "2026-06-20T09:00:00.000Z"
      });
      const extractedSessions: string[] = [];
      const extractor: FacilityMemoryExtractor = {
        extract: (cutoff) => {
          extractedSessions.push(cutoff.sessionId);

          return Promise.resolve([
            {
              title: `${cutoff.sessionId} の継続準備`,
              body: "活動前に工作セットを準備する。",
              category: "care_continuity",
              tags: ["工作"],
              sourceEntryIds: [cutoff.sourceEntryIds[0] as string],
              confidence: 0.9
            }
          ]);
        }
      };

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-resident-1"));
        queue.enqueueSessionCutoff(cutoffInput("session-resident-2"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor,
        audit,
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 2,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 2,
          writtenMemoryIds: [1, 2],
          deadLetterCount: 0
        });
      } finally {
        worker.close();
      }

      const store = openSessionMemoryCandidateStore(path, {
        processSession: () => Promise.resolve([])
      });
      const memories = openLongMemoryStore(path, {
        now: () => "2026-06-20T09:00:02.000Z"
      });

      try {
        expect(extractedSessions).toEqual(["session-resident-1", "session-resident-2"]);
        expect(store.listJobs().map((job) => job.status)).toEqual(["processed", "processed"]);
        expect(store.listPending()).toEqual([]);
        expect(memories.searchActive({ query: "継続準備", limit: 5 })).toHaveLength(2);
        expect(audit.entries().map((event) => event.name)).toEqual(
          expect.arrayContaining([
            "long_memory.candidate_job.enqueued",
            "long_memory.candidate_job.processed",
            "long_memory.worker.drain_once"
          ])
        );
        expect(audit.entries().map((event) => event.name)).not.toContain(
          "long_memory.candidate.created"
        );
      } finally {
        memories.close();
        store.close();
      }
    });
  });

  it("shares one drain report across overlapping drain requests", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-overlapping-drain"));
      } finally {
        queue.close();
      }

      let resolveExtraction:
        | ((drafts: readonly AutomatedFacilityMemoryDraft[]) => void)
        | undefined;
      const extraction = new Promise<readonly AutomatedFacilityMemoryDraft[]>((resolve) => {
        resolveExtraction = resolve;
      });
      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: () => extraction
        }
      });

      try {
        const firstDrain = worker.drainUntilIdle();
        const overlappingDrain = worker.drainUntilIdle();

        expect(overlappingDrain).toBe(firstDrain);
        resolveExtraction?.([
          {
            title: "Overlapping drain sentinel",
            body: "Concurrent callers share the active facility-memory drain.",
            category: "operational_note",
            tags: ["worker"],
            sourceEntryIds: ["session-overlapping-drain-entry-1"],
            confidence: 0.8
          }
        ]);

        await expect(firstDrain).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 1,
          writtenMemoryIds: [1],
          deadLetterCount: 0
        });
        await expect(overlappingDrain).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 1,
          writtenMemoryIds: [1],
          deadLetterCount: 0
        });
      } finally {
        worker.close();
      }
    });
  });

  it("deduplicates repeated automated drafts within one drain", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);
      const duplicateDraft = {
        title: "雨の日の工作準備",
        body: "雨の日は工作セットを早めに準備する。",
        category: "facility_knowledge" as const,
        tags: ["雨", "工作"],
        sourceEntryIds: ["session-repeat-entry-1"],
        confidence: 0.82
      };

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-repeat"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: () => Promise.resolve([duplicateDraft, duplicateDraft])
        }
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 1,
          writtenMemoryIds: [1],
          deadLetterCount: 0
        });
      } finally {
        worker.close();
      }

      const memories = openLongMemoryStore(path);

      try {
        expect(memories.searchActive({ query: "工作準備", limit: 5 })).toHaveLength(1);
      } finally {
        memories.close();
      }
    });
  });

  it("treats an empty extraction as a successful processed job", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-empty"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: () => Promise.resolve([])
        }
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 0,
          deadLetterCount: 0
        });
      } finally {
        worker.close();
      }
    });
  });

  it("rolls back every automated memory when one draft violates policy", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-atomic-policy"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: (cutoff) =>
            Promise.resolve([
              {
                title: "Atomic transaction sentinel",
                body: "Prepare the facility activity kit before arrival.",
                category: "facility_knowledge",
                tags: ["atomic-sentinel"],
                sourceEntryIds: cutoff.sourceEntryIds,
                confidence: 0.9
              },
              {
                title: "Structurally prohibited record",
                body: "Facility-wide draft with an invalid structured field.",
                category: "care_continuity",
                tags: [],
                sourceEntryIds: cutoff.sourceEntryIds,
                confidence: 0.9,
                childId: "child-1"
              } as unknown as AutomatedFacilityMemoryDraft
            ])
        }
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toMatchObject({
          processedCount: 0,
          memoryWrittenCount: 0,
          deadLetterCount: 1,
          lastErrorCode: "policy_violation"
        });
      } finally {
        worker.close();
      }

      const memories = openLongMemoryStore(path);

      try {
        expect(memories.searchActive({ query: "atomic-sentinel", limit: 5 })).toEqual([]);
      } finally {
        memories.close();
      }
    });
  });

  it("reports a scheduled retry without terminating the drain loop", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path, {
        now: () => "2026-06-20T09:00:00.000Z"
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-retry"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: () => Promise.reject(new Error("provider unavailable with sensitive detail"))
        },
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 0,
          recoveredCount: 0,
          idle: false,
          memoryWrittenCount: 0,
          retryScheduledCount: 1,
          deadLetterCount: 0,
          lastErrorCode: "extraction_failed"
        });
      } finally {
        worker.close();
      }
    });
  });

  it("continues draining later ready jobs after scheduling a retry", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path, {
        now: () => "2026-06-20T09:00:00.000Z"
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-retry-first"));
        queue.enqueueSessionCutoff(cutoffInput("session-ready-second"));
      } finally {
        queue.close();
      }

      const extractedSessions: string[] = [];
      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: (cutoff) => {
            extractedSessions.push(cutoff.sessionId);

            if (cutoff.sessionId === "session-retry-first") {
              return Promise.reject(new Error("temporary provider failure"));
            }

            return Promise.resolve([
              {
                title: "後続施設メモ",
                body: "後続の正常なjobを同じdrainで処理する。",
                category: "operational_note",
                tags: ["worker"],
                sourceEntryIds: cutoff.sourceEntryIds,
                confidence: 0.8
              }
            ]);
          }
        },
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: false,
          memoryWrittenCount: 1,
          writtenMemoryIds: [1],
          retryScheduledCount: 1,
          deadLetterCount: 0,
          lastErrorCode: "extraction_failed"
        });
        expect(extractedSessions).toEqual(["session-retry-first", "session-ready-second"]);
      } finally {
        worker.close();
      }
    });
  });

  it("attributes two handled failures to their own attempts within one drain", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path, {
        now: () => "2026-06-20T09:00:00.000Z"
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-failure-one"));
        queue.enqueueSessionCutoff(cutoffInput("session-failure-two"));
      } finally {
        queue.close();
      }

      const extractedSessions: string[] = [];
      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: (cutoff) => {
            extractedSessions.push(cutoff.sessionId);
            return Promise.reject(new Error(`provider failure for ${cutoff.sessionId}`));
          }
        },
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 0,
          recoveredCount: 0,
          idle: false,
          memoryWrittenCount: 0,
          retryScheduledCount: 2,
          deadLetterCount: 0,
          lastErrorCode: "extraction_failed"
        });
        expect(extractedSessions).toEqual(["session-failure-one", "session-failure-two"]);
      } finally {
        worker.close();
      }

      const verificationQueue = openSessionMemoryCandidateQueue(path);

      try {
        expect(verificationQueue.listJobs()).toEqual([
          expect.objectContaining({
            sessionId: "session-failure-one",
            status: "queued",
            attemptCount: 1,
            lastErrorCode: "extraction_failed"
          }),
          expect.objectContaining({
            sessionId: "session-failure-two",
            status: "queued",
            attemptCount: 1,
            lastErrorCode: "extraction_failed"
          })
        ]);
      } finally {
        verificationQueue.close();
      }
    });
  });

  it("counts handled failures against the drain job limit", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path, {
        now: () => "2026-06-20T09:00:00.000Z"
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-retry-limited"));
        queue.enqueueSessionCutoff(cutoffInput("session-ready-after-limit"));
      } finally {
        queue.close();
      }

      const extractedSessions: string[] = [];
      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        maxDrainJobs: 1,
        extractor: {
          extract: (cutoff) => {
            extractedSessions.push(cutoff.sessionId);

            if (cutoff.sessionId === "session-retry-limited") {
              return Promise.reject(new Error("temporary provider failure"));
            }

            return Promise.resolve([
              {
                title: "Deferred facility note",
                body: "This job must remain queued until the next drain.",
                category: "operational_note",
                tags: ["worker"],
                sourceEntryIds: cutoff.sourceEntryIds,
                confidence: 0.8
              }
            ]);
          }
        },
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 0,
          recoveredCount: 0,
          idle: false,
          memoryWrittenCount: 0,
          retryScheduledCount: 1,
          deadLetterCount: 0,
          lastErrorCode: "extraction_failed"
        });
        expect(extractedSessions).toEqual(["session-retry-limited"]);
      } finally {
        worker.close();
      }
    });
  });

  it("does not report a negative retry count when a scheduled retry succeeds", async () => {
    await withLongMemoryDatabase(async (path) => {
      let currentTime = "2026-06-20T09:00:01.000Z";
      let extractionCount = 0;
      const queue = openSessionMemoryCandidateQueue(path, {
        now: () => "2026-06-20T09:00:00.000Z"
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-retry-success"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        extractor: {
          extract: (cutoff) => {
            extractionCount += 1;

            if (extractionCount === 1) {
              return Promise.reject(new Error("temporary provider failure"));
            }

            return Promise.resolve([
              {
                title: "Retry success",
                body: "The scheduled extraction completed.",
                category: "operational_note",
                tags: ["retry"],
                sourceEntryIds: cutoff.sourceEntryIds,
                confidence: 0.8
              }
            ]);
          }
        },
        now: () => currentTime
      });

      try {
        await worker.drainUntilIdle();
        currentTime = "2026-06-20T09:01:00.000Z";

        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 1,
          recoveredCount: 0,
          idle: true,
          memoryWrittenCount: 1,
          writtenMemoryIds: [1],
          deadLetterCount: 0
        });
      } finally {
        worker.close();
      }
    });
  });
});

async function withLongMemoryDatabase(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-resident-memory-worker-"));
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
    cutoffAt: "2026-06-20T09:00:00.000Z",
    sourceEntryIds: [`${sessionId}-entry-1`],
    entries: [
      {
        id: `${sessionId}-entry-1`,
        role: "staff",
        content: `${sessionId} の活動継続メモ。`
      }
    ],
    requestedBy: "session_lifecycle"
  };
}
