import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  openSessionMemoryCandidateQueue,
  openSessionMemoryCandidateStore,
  type SessionMemoryCutoffInput
} from "../src/modules/long-memory/index.js";
import { createMem0MemoryProvider } from "../src/modules/long-memory/mem0.js";
import { createResidentMemoryDrainWorker } from "../src/runtime/resident-memory-worker.js";

describe("resident memory drain worker", () => {
  it("drains queued session cutoffs into Mem0 without duplicating raw text into candidates", async () => {
    await withLongMemoryDatabase(async (path) => {
      const audit = createStructuredAuditLog();
      const queue = openSessionMemoryCandidateQueue(path, {
        audit,
        now: () => "2026-06-20T09:00:00.000Z"
      });
      const mem0Sessions: string[] = [];
      const mem0Provider = createMem0MemoryProvider({
        scopeId: "pico-resident-test",
        audit,
        client: {
          add: (request) => {
            mem0Sessions.push(request.metadata.source_session_id);
            return Promise.resolve({
              memories: [{ id: `mem0-${request.metadata.source_session_id}` }]
            });
          },
          search: () => Promise.resolve({ memories: [] }),
          delete: () => Promise.resolve()
        }
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-resident-1"));
        queue.enqueueSessionCutoff(cutoffInput("session-resident-2"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        mem0Provider,
        audit,
        now: () => "2026-06-20T09:00:01.000Z"
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 2,
          recoveredCount: 0,
          idle: true,
          mem0MemoryCount: 2
        });
      } finally {
        worker.close();
      }

      const store = openSessionMemoryCandidateStore(path, {
        processSession: () => Promise.resolve([])
      });

      try {
        expect(mem0Sessions).toEqual(["session-resident-1", "session-resident-2"]);
        expect(store.listJobs().map((job) => job.status)).toEqual(["processed", "processed"]);
        expect(store.listPending()).toEqual([]);
        expect(audit.entries().map((event) => event.name)).toEqual(
          expect.arrayContaining([
            "long_memory.candidate_job.enqueued",
            "long_memory.mem0.added",
            "long_memory.candidate_job.processed",
            "long_memory.worker.drain_once"
          ])
        );
        expect(audit.entries().map((event) => event.name)).not.toContain(
          "long_memory.candidate.created"
        );
      } finally {
        store.close();
      }
    });
  });

  it("does not call Mem0 again when the same session cutoff is reprocessed", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);
      const mem0Sessions: string[] = [];
      const mem0Provider = createMem0MemoryProvider({
        scopeId: "pico-resident-test",
        client: {
          add: (request) => {
            mem0Sessions.push(request.metadata.source_session_id);
            return Promise.resolve({
              memories: [{ id: `mem0-${request.metadata.source_session_id}` }]
            });
          },
          search: () => Promise.resolve({ memories: [] }),
          delete: () => Promise.resolve()
        }
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-repeat"));
        queue.enqueueSessionCutoff(cutoffInput("session-repeat"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        mem0Provider
      });

      try {
        await expect(worker.drainUntilIdle()).resolves.toEqual({
          processedCount: 2,
          recoveredCount: 0,
          idle: true,
          mem0MemoryCount: 1
        });
      } finally {
        worker.close();
      }

      expect(mem0Sessions).toEqual(["session-repeat"]);
    });
  });

  it("fails instead of resending Mem0 when a previous write is uncertain", async () => {
    await withLongMemoryDatabase(async (path) => {
      const queue = openSessionMemoryCandidateQueue(path);
      let mem0CallCount = 0;
      const mem0Provider = createMem0MemoryProvider({
        scopeId: "pico-resident-test",
        client: {
          add: () => {
            mem0CallCount += 1;
            return Promise.reject(new Error("simulated crash after external write"));
          },
          search: () => Promise.resolve({ memories: [] }),
          delete: () => Promise.resolve()
        }
      });

      try {
        queue.enqueueSessionCutoff(cutoffInput("session-uncertain"));
        queue.enqueueSessionCutoff(cutoffInput("session-uncertain"));
      } finally {
        queue.close();
      }

      const worker = createResidentMemoryDrainWorker({
        databasePath: path,
        mem0Provider
      });

      try {
        await expect(worker.drainOnce()).rejects.toThrow("simulated crash after external write");
        await expect(worker.drainOnce()).rejects.toThrow(
          "pico resident memory Mem0 write is already in progress or uncertain for session session-uncertain"
        );
      } finally {
        worker.close();
      }

      expect(mem0CallCount).toBe(1);
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
