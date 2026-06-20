import { DatabaseSync } from "node:sqlite";

import type { StructuredAuditLog } from "../modules/audit/index.js";
import { openSessionMemoryCandidateStore } from "../modules/long-memory/index.js";
import type { Mem0MemoryProvider } from "../modules/long-memory/mem0.js";
import {
  createSessionMemoryWorker,
  type SessionMemoryDrainReport,
  type SessionMemoryWorker
} from "../modules/long-memory/session-worker.js";

export type ResidentMemoryDrainWorkerOptions = {
  readonly databasePath: string;
  readonly mem0Provider: Mem0MemoryProvider;
  readonly audit?: StructuredAuditLog;
  readonly maxQueueDepth?: number;
  readonly recoverProcessingOlderThanMs?: number;
  readonly maxDrainJobs?: number;
  readonly now?: () => string;
};

export type ResidentMemoryDrainReport = SessionMemoryDrainReport & {
  readonly mem0MemoryCount: number;
};

export type ResidentMemoryDrainWorker = Pick<
  SessionMemoryWorker,
  "enqueueCutoff" | "recoverStaleProcessingJobs" | "drainOnce"
> & {
  readonly drainUntilIdle: () => Promise<ResidentMemoryDrainReport>;
  readonly close: () => void;
};

export function createResidentMemoryDrainWorker(
  options: ResidentMemoryDrainWorkerOptions
): ResidentMemoryDrainWorker {
  let mem0MemoryCount = 0;
  const mem0Writes = openResidentMem0SessionWriteStore(options.databasePath, options.now);
  const store = openSessionMemoryCandidateStore(options.databasePath, {
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    processSession: async (session) => {
      const existing = mem0Writes.read(session.sessionId);

      if (existing?.status === "written") {
        return [];
      }

      if (existing?.status === "processing") {
        throw new Error(
          `pico resident memory Mem0 write is already in progress or uncertain for session ${session.sessionId}`
        );
      }

      mem0Writes.begin(session.sessionId);
      const result = await options.mem0Provider.addSessionCutoff(session);

      mem0Writes.markWritten(session.sessionId, result.memoryIds);
      mem0MemoryCount += result.memoryIds.length;

      return [];
    }
  });
  const worker = createSessionMemoryWorker({
    store,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
    ...(options.recoverProcessingOlderThanMs === undefined
      ? {}
      : { recoverProcessingOlderThanMs: options.recoverProcessingOlderThanMs }),
    ...(options.maxDrainJobs === undefined ? {} : { maxDrainJobs: options.maxDrainJobs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });

  return {
    enqueueCutoff: worker.enqueueCutoff,
    recoverStaleProcessingJobs: worker.recoverStaleProcessingJobs,
    drainOnce: worker.drainOnce,
    async drainUntilIdle() {
      const before = mem0MemoryCount;
      const report = await worker.drainUntilIdle();

      return {
        ...report,
        mem0MemoryCount: mem0MemoryCount - before
      };
    },
    close() {
      mem0Writes.close();
      store.close();
    }
  };
}

type ResidentMem0SessionWriteStatus = "processing" | "written";

type ResidentMem0SessionWrite = {
  readonly sessionId: string;
  readonly status: ResidentMem0SessionWriteStatus;
  readonly memoryIds: readonly string[];
};

type ResidentMem0SessionWriteRow = {
  readonly session_id: string;
  readonly status: ResidentMem0SessionWriteStatus;
  readonly memory_ids_json: string;
};

type ResidentMem0SessionWriteStore = {
  readonly read: (sessionId: string) => ResidentMem0SessionWrite | undefined;
  readonly begin: (sessionId: string) => void;
  readonly markWritten: (sessionId: string, memoryIds: readonly string[]) => void;
  readonly close: () => void;
};

function openResidentMem0SessionWriteStore(
  path: string,
  now: (() => string) | undefined
): ResidentMem0SessionWriteStore {
  const database = new DatabaseSync(path);
  const timestamp = now ?? (() => new Date().toISOString());

  database.exec(`
    CREATE TABLE IF NOT EXISTS resident_mem0_session_writes (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('processing', 'written')),
      memory_ids_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      written_at TEXT
    );
  `);

  return {
    read(sessionId) {
      const row = database
        .prepare(`
          SELECT session_id, status, memory_ids_json
          FROM resident_mem0_session_writes
          WHERE session_id = ?
        `)
        .get(sessionId) as ResidentMem0SessionWriteRow | undefined;

      if (row === undefined) {
        return undefined;
      }

      return {
        sessionId: row.session_id,
        status: row.status,
        memoryIds: parseMemoryIds(row.memory_ids_json)
      };
    },
    begin(sessionId) {
      database
        .prepare(`
          INSERT INTO resident_mem0_session_writes (
            session_id, status, memory_ids_json, started_at
          )
          VALUES (?, 'processing', '[]', ?)
        `)
        .run(sessionId, timestamp());
    },
    markWritten(sessionId, memoryIds) {
      database
        .prepare(`
          UPDATE resident_mem0_session_writes
          SET status = 'written', memory_ids_json = ?, written_at = ?
          WHERE session_id = ? AND status = 'processing'
        `)
        .run(JSON.stringify(memoryIds), timestamp(), sessionId);
    },
    close() {
      database.close();
    }
  };
}

function parseMemoryIds(payload: string): readonly string[] {
  const parsed: unknown = JSON.parse(payload);

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("pico resident memory Mem0 write row is malformed");
  }

  return Object.freeze(parsed);
}
