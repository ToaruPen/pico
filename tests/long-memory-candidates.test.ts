import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  type LongMemoryCandidateDraft,
  openLongMemoryStore,
  openSessionMemoryCandidateStore,
  PermanentMemoryPolicyError,
  type SessionMemoryCutoffInput
} from "../src/modules/long-memory/index.js";

const completedSession = {
  sessionId: "session-2026-06-10-evening",
  cutoffAt: "2026-06-10T18:30:00.000Z",
  sourceEntryIds: ["memory-1", "memory-2"],
  entries: [
    {
      id: "memory-1",
      role: "staff",
      content: "雨の日は工作セットを早めに出すと落ち着いて始められた。"
    },
    {
      id: "memory-2",
      role: "assistant",
      content: "次の雨の日も工作セットを先に準備する候補として扱う。"
    }
  ],
  requestedBy: "pico"
} as const satisfies SessionMemoryCutoffInput;

async function withLongMemoryDatabase(run: (path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-long-memory-candidates-"));
  const path = join(directory, "long-memory.sqlite");

  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readCandidateJobRow(
  path: string,
  id = 1
): { readonly status: string; readonly cutoff_json: string } {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare("SELECT status, cutoff_json FROM long_memory_candidate_jobs WHERE id = ?")
      .get(id) as { readonly status: string; readonly cutoff_json: string };
  } finally {
    database.close();
  }
}

function listTables(path: string): readonly string[] {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
      .map((row) => String((row as { name: unknown }).name));
  } finally {
    database.close();
  }
}

function countCandidateJobs(path: string): number {
  const database = new DatabaseSync(path);

  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM long_memory_candidate_jobs")
      .get() as { count: number };

    return row.count;
  } finally {
    database.close();
  }
}

describe("session long-memory candidate pipeline", () => {
  it("stores generated candidates separately from reviewed long-memory entries", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        now: () => "2026-06-10T18:31:00.000Z",
        processSession: (session) => {
          expect(session).toEqual(completedSession);

          return Promise.resolve([
            {
              title: "雨の日の工作準備",
              body: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
              category: "care_continuity",
              tags: ["weather", "activity"]
            }
          ]);
        }
      });

      try {
        const job = candidates.enqueueSessionCutoff(completedSession);
        await expect(candidates.processNextJob()).resolves.toMatchObject({
          id: job.id,
          status: "processed"
        });

        expect(listTables(path)).toEqual(
          expect.arrayContaining([
            "long_memory_candidates",
            "long_memory_candidate_events",
            "long_memory_candidate_jobs"
          ])
        );
        expect(candidates.listPending()).toEqual([
          {
            id: 1,
            sessionId: "session-2026-06-10-evening",
            sourceEntryIds: ["memory-1", "memory-2"],
            title: "雨の日の工作準備",
            body: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
            category: "care_continuity",
            tags: ["weather", "activity"],
            state: "pending_review",
            createdAt: "2026-06-10T18:31:00.000Z",
            reviewedAt: undefined,
            review: undefined,
            promotedMemoryId: undefined
          }
        ]);

        const longMemory = openLongMemoryStore(path);

        try {
          expect(longMemory.search("工作準備")).toEqual([]);
        } finally {
          longMemory.close();
        }

        expect(JSON.stringify(candidates.listJobs())).not.toContain("工作セットを早めに出す");
        expect(JSON.stringify(candidates.listJobs())).not.toContain("工作セットを先に準備する候補");
        const row = readCandidateJobRow(path);

        expect(row.cutoff_json).not.toContain("工作セットを早めに出す");
        expect(row.cutoff_json).not.toContain("工作セットを先に準備する候補");
        expect(JSON.parse(row.cutoff_json)).toEqual({
          sessionId: "session-2026-06-10-evening",
          cutoffAt: "2026-06-10T18:30:00.000Z",
          sourceEntryIds: ["memory-1", "memory-2"],
          sourceEntryCount: 2,
          requestedBy: "pico",
          retention: "processed_metadata_only"
        });
        expect(audit.entries().map((event) => event.name)).toEqual([
          "long_memory.candidate_job.enqueued",
          "long_memory.candidate.created",
          "long_memory.candidate_job.processed"
        ]);
        expect(JSON.stringify(audit.entries())).not.toContain("工作セットを早めに出す");
      } finally {
        candidates.close();
      }
    });
  });

  it("schedules retryable failures after 30 seconds without scrubbing the cutoff payload", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        now: () => "2026-07-11T00:00:00.000Z",
        processSession: () => {
          throw new Error("processor unavailable with raw provider output");
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow("processor unavailable");

        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "queued",
            attemptCount: 1,
            nextAttemptAt: "2026-07-11T00:00:30.000Z",
            lastErrorCode: "extraction_failed",
            deadLetteredAt: undefined,
            purgeAfter: undefined
          })
        ]);

        const row = readCandidateJobRow(path);

        expect(row.status).toBe("queued");
        expect(JSON.parse(row.cutoff_json)).toEqual(completedSession);
        expect(JSON.stringify(audit.entries())).not.toContain(
          "processor unavailable with raw provider output"
        );
      } finally {
        candidates.close();
      }
    });
  });

  it("uses a two-minute second retry delay and dead-letters the third failed attempt", async () => {
    await withLongMemoryDatabase(async (path) => {
      let currentTime = "2026-07-11T00:00:00.000Z";
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => currentTime,
        processSession: () => {
          throw new Error("retryable extraction failure");
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await expect(candidates.processNextJob()).rejects.toThrow("retryable extraction failure");

        currentTime = "2026-07-11T00:00:29.999Z";
        await expect(candidates.processNextJob()).resolves.toBeUndefined();

        currentTime = "2026-07-11T00:00:30.000Z";
        await expect(candidates.processNextJob()).rejects.toThrow("retryable extraction failure");
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "queued",
            attemptCount: 2,
            nextAttemptAt: "2026-07-11T00:02:30.000Z",
            lastErrorCode: "extraction_failed"
          })
        ]);

        currentTime = "2026-07-11T00:02:30.000Z";
        await expect(candidates.processNextJob()).rejects.toThrow("retryable extraction failure");
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "dead_letter",
            attemptCount: 3,
            nextAttemptAt: undefined,
            lastErrorCode: "extraction_failed",
            deadLetteredAt: "2026-07-11T00:02:30.000Z",
            purgeAfter: "2026-07-18T00:02:30.000Z"
          })
        ]);

        const row = readCandidateJobRow(path);

        expect(row.status).toBe("dead_letter");
        expect(JSON.parse(row.cutoff_json)).toEqual(completedSession);
      } finally {
        candidates.close();
      }
    });
  });

  it("dead-letters permanent policy failures immediately and scrubs raw cutoff content", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        now: () => "2026-07-11T00:00:00.000Z",
        processSession: () => {
          throw new PermanentMemoryPolicyError("raw policy-sensitive model output");
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await expect(candidates.processNextJob()).rejects.toThrow(PermanentMemoryPolicyError);

        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "dead_letter",
            attemptCount: 1,
            nextAttemptAt: undefined,
            lastErrorCode: "policy_violation",
            deadLetteredAt: "2026-07-11T00:00:00.000Z",
            purgeAfter: undefined
          })
        ]);

        const row = readCandidateJobRow(path);

        expect(row.cutoff_json).not.toContain("工作セットを早めに出す");
        expect(JSON.parse(row.cutoff_json)).toMatchObject({
          sessionId: completedSession.sessionId,
          retention: "dead_letter_metadata_only"
        });
        expect(JSON.stringify(audit.entries())).not.toContain("raw policy-sensitive model output");
      } finally {
        candidates.close();
      }
    });
  });

  it("purges expired retry-exhausted dead-letter payloads to metadata only", async () => {
    await withLongMemoryDatabase(async (path) => {
      let currentTime = "2026-07-11T00:00:00.000Z";
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => currentTime,
        processSession: () => {
          throw new Error("retryable extraction failure");
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await expect(candidates.processNextJob()).rejects.toThrow();
        currentTime = "2026-07-11T00:00:30.000Z";
        await expect(candidates.processNextJob()).rejects.toThrow();
        currentTime = "2026-07-11T00:02:30.000Z";
        await expect(candidates.processNextJob()).rejects.toThrow();

        expect(candidates.purgeExpiredDeadLetterPayloads({ now: "2026-07-18T00:02:29.999Z" })).toBe(
          0
        );
        expect(candidates.purgeExpiredDeadLetterPayloads({ now: "2026-07-18T00:02:30.000Z" })).toBe(
          1
        );

        const row = readCandidateJobRow(path);

        expect(row.cutoff_json).not.toContain("工作セットを早めに出す");
        expect(JSON.parse(row.cutoff_json)).toMatchObject({
          sessionId: completedSession.sessionId,
          retention: "dead_letter_metadata_only"
        });
      } finally {
        candidates.close();
      }
    });
  });

  it("canonicalizes offset timestamps for retry eligibility and dead-letter purge", async () => {
    await withLongMemoryDatabase(async (path) => {
      let currentTime = "2026-07-11T09:00:00.000+09:00";
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => currentTime,
        processSession: () => {
          throw new Error("retryable extraction failure");
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await expect(candidates.processNextJob()).rejects.toThrow();
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            queuedAt: "2026-07-11T00:00:00.000Z",
            nextAttemptAt: "2026-07-11T00:00:30.000Z"
          })
        ]);

        currentTime = "2026-07-11T09:00:29.999+09:00";
        await expect(candidates.processNextJob()).resolves.toBeUndefined();
        currentTime = "2026-07-11T09:00:30.000+09:00";
        await expect(candidates.processNextJob()).rejects.toThrow();
        currentTime = "2026-07-11T09:02:30.000+09:00";
        await expect(candidates.processNextJob()).rejects.toThrow();

        expect(
          candidates.purgeExpiredDeadLetterPayloads({
            now: "2026-07-18T09:02:29.999+09:00"
          })
        ).toBe(0);
        expect(
          candidates.purgeExpiredDeadLetterPayloads({
            now: "2026-07-18T09:02:30.000+09:00"
          })
        ).toBe(1);
      } finally {
        candidates.close();
      }
    });
  });

  it("processes queued session cutoff jobs after reopening the candidate store", async () => {
    await withLongMemoryDatabase(async (path) => {
      const first = openSessionMemoryCandidateStore(path, {
        processSession: () => Promise.resolve([])
      });

      try {
        first.enqueueSessionCutoff(completedSession);
      } finally {
        first.close();
      }

      const reopened = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-10T18:31:00.000Z",
        processSession: (session) => {
          expect(session).toEqual(completedSession);

          return Promise.resolve([
            {
              title: "再開後の候補",
              body: "再オープン後もqueued jobを処理できる。",
              category: "operational_note"
            }
          ]);
        }
      });

      try {
        await expect(reopened.processNextJob()).resolves.toMatchObject({
          status: "processed"
        });
        expect(reopened.listPending()).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not classify ordinary session-cutoff prose", async () => {
    await withLongMemoryDatabase((path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: () => Promise.resolve([])
      });

      try {
        expect(
          candidates.enqueueSessionCutoff({
            ...completedSession,
            entries: [
              {
                id: "memory-1",
                role: "staff",
                content: "施設の健康管理手順を年度末に見直す。"
              }
            ]
          }).status
        ).toBe("queued");
      } finally {
        candidates.close();
      }

      expect(countCandidateJobs(path)).toBe(1);
    });
  });

  it("does not classify medical vocabulary in session-cutoff prose", async () => {
    await withLongMemoryDatabase((path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: () => Promise.resolve([])
      });

      try {
        expect(
          candidates.enqueueSessionCutoff({
            ...completedSession,
            entries: [
              {
                id: "memory-1",
                role: "staff",
                content: "喘息対応を含む施設の緊急手順を見直す。"
              }
            ]
          }).status
        ).toBe("queued");
      } finally {
        candidates.close();
      }

      expect(countCandidateJobs(path)).toBe(1);
    });
  });

  it("rolls back enqueue when audit validation rejects the event", async () => {
    await withLongMemoryDatabase((path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        audit: createStructuredAuditLog(),
        processSession: () => Promise.resolve([])
      });

      try {
        expect(() =>
          candidates.enqueueSessionCutoff({
            ...completedSession,
            sessionId: "s".repeat(257)
          })
        ).toThrow();
      } finally {
        candidates.close();
      }

      expect(countCandidateJobs(path)).toBe(0);
    });
  });

  it("claims a queued session cutoff job once during concurrent processing", async () => {
    await withLongMemoryDatabase(async (path) => {
      let releaseProcessing: (() => void) | undefined;
      const processingGate = new Promise<void>((resolve) => {
        releaseProcessing = resolve;
      });
      const processedSessions: SessionMemoryCutoffInput[] = [];
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-10T18:31:00.000Z",
        processSession: async (session) => {
          processedSessions.push(session);
          await processingGate;

          return [
            {
              title: "並行処理候補",
              body: "同じqueued jobから候補を重複作成しない。",
              category: "operational_note"
            }
          ];
        }
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        const first = candidates.processNextJob();
        const second = candidates.processNextJob();
        await Promise.resolve();
        releaseProcessing?.();

        await expect(Promise.all([first, second])).resolves.toEqual([
          expect.objectContaining({ status: "processed" }),
          undefined
        ]);
        expect(processedSessions).toHaveLength(1);
        expect(candidates.listPending()).toHaveLength(1);
      } finally {
        candidates.close();
      }
    });
  });

  it("promotes a pending candidate to reviewed long memory only with staff review metadata", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-06-10T18:31:00.000Z",
        processSession: () =>
          Promise.resolve([
            {
              title: "雨の日の工作準備",
              body: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
              category: "care_continuity"
            }
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await candidates.processNextJob();

        expect(() =>
          candidates.promoteReviewed(1, {
            reviewedBy: "",
            reviewedAt: "2026-06-10T19:00:00.000Z"
          })
        ).toThrow("pico long memory review metadata is required");

        const record = candidates.promoteReviewed(1, {
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T19:00:00.000Z",
          note: "スタッフ確認済み。"
        });

        expect(record).toMatchObject({
          id: 1,
          title: "雨の日の工作準備",
          body: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
          category: "care_continuity",
          review: {
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T19:00:00.000Z",
            note: "スタッフ確認済み。"
          }
        });
        expect(candidates.readCandidate(1)).toMatchObject({
          state: "approved",
          promotedMemoryId: 1
        });
      } finally {
        candidates.close();
      }
    });
  });

  it("rejects pending candidates without creating reviewed long-memory entries", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        now: () => "2026-06-10T18:31:00.000Z",
        processSession: () =>
          Promise.resolve([
            {
              title: "古い候補",
              body: "スタッフ確認で採用しない候補。",
              category: "operational_note"
            }
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);
        await candidates.processNextJob();
        candidates.reject(1, {
          reviewedBy: "staff-b",
          reviewedAt: "2026-06-10T19:05:00.000Z",
          note: "一時的な出来事で継続知識ではない。"
        });

        expect(candidates.readCandidate(1)).toMatchObject({
          state: "rejected",
          reviewedAt: "2026-06-10T19:05:00.000Z",
          review: {
            reviewedBy: "staff-b",
            reviewedAt: "2026-06-10T19:05:00.000Z",
            note: "一時的な出来事で継続知識ではない。"
          },
          promotedMemoryId: undefined
        });

        const longMemory = openLongMemoryStore(path);

        try {
          expect(longMemory.search("古い候補")).toEqual([]);
        } finally {
          longMemory.close();
        }

        expect(audit.entries().map((event) => event.name)).toContain(
          "long_memory.candidate.rejected"
        );
      } finally {
        candidates.close();
      }
    });
  });

  it("dead-letters structurally explicit child-profile fields immediately", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: () =>
          Promise.resolve([
            {
              title: "施設メモ",
              body: "施設全体の候補。",
              category: "care_continuity",
              childId: "child-1"
            } as unknown as LongMemoryCandidateDraft
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow(PermanentMemoryPolicyError);
        expect(candidates.listPending()).toEqual([]);
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "dead_letter",
            attemptCount: 1,
            lastErrorCode: "policy_violation",
            purgeAfter: undefined
          })
        ]);

        const row = readCandidateJobRow(path);

        expect(row.cutoff_json).not.toContain("工作セットを早めに出す");
        expect(JSON.parse(row.cutoff_json)).toMatchObject({
          sessionId: completedSession.sessionId,
          retention: "dead_letter_metadata_only"
        });
      } finally {
        candidates.close();
      }
    });
  });

  it("dead-letters and scrubs structurally explicit child scoring immediately", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: () =>
          Promise.resolve([
            {
              title: "施設メモ",
              body: "施設全体の候補。",
              category: "care_continuity",
              childScore: 1
            } as unknown as LongMemoryCandidateDraft
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow(PermanentMemoryPolicyError);
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "dead_letter",
            attemptCount: 1,
            lastErrorCode: "policy_violation",
            purgeAfter: undefined
          })
        ]);

        const row = readCandidateJobRow(path);

        expect(row.cutoff_json).not.toContain("工作セットを早めに出す");
        expect(JSON.parse(row.cutoff_json)).toMatchObject({
          sessionId: completedSession.sessionId,
          retention: "dead_letter_metadata_only"
        });
      } finally {
        candidates.close();
      }
    });
  });

  it.each([
    "profile",
    "childGuidance",
    "childVideo",
    "childIdea"
  ])("retries generic unknown field %s instead of treating it as a child-policy violation", async (field) => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-07-11T00:00:00.000Z",
        processSession: () =>
          Promise.resolve([
            {
              title: "施設メモ",
              body: "施設全体の候補。",
              category: "care_continuity",
              [field]: "facility"
            } as unknown as LongMemoryCandidateDraft
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow(
          "pico long memory candidate input is malformed"
        );
        expect(candidates.listJobs()).toEqual([
          expect.objectContaining({
            status: "queued",
            attemptCount: 1,
            lastErrorCode: "extraction_failed",
            nextAttemptAt: "2026-07-11T00:00:30.000Z"
          })
        ]);

        expect(JSON.parse(readCandidateJobRow(path).cutoff_json)).toEqual(completedSession);
      } finally {
        candidates.close();
      }
    });
  });

  it("does not keep candidate-created audit events when draft processing rolls back", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const candidates = openSessionMemoryCandidateStore(path, {
        audit,
        processSession: () =>
          Promise.resolve([
            {
              title: "有効な候補",
              body: "これは有効な候補。",
              category: "operational_note"
            },
            {
              title: "施設メモ",
              body: "施設全体の候補。",
              category: "care_continuity",
              childProfile: { score: 1 }
            } as unknown as LongMemoryCandidateDraft
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow(
          "pico long memory must not contain structured individual child profile fields"
        );
        expect(candidates.listPending()).toEqual([]);
        expect(audit.entries().map((event) => event.name)).not.toContain(
          "long_memory.candidate.created"
        );
      } finally {
        candidates.close();
      }
    });
  });

  it("rejects candidate drafts that include child profile fields", async () => {
    await withLongMemoryDatabase(async (path) => {
      const candidates = openSessionMemoryCandidateStore(path, {
        processSession: () =>
          Promise.resolve([
            {
              title: "施設メモ",
              body: "施設全体の候補。",
              category: "care_continuity",
              childId: "child-1"
            } as unknown as LongMemoryCandidateDraft
          ])
      });

      try {
        candidates.enqueueSessionCutoff(completedSession);

        await expect(candidates.processNextJob()).rejects.toThrow(
          "pico long memory must not contain structured individual child profile fields"
        );
        expect(candidates.listPending()).toEqual([]);
      } finally {
        candidates.close();
      }
    });
  });
});
