import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  type LongMemoryStore,
  openLongMemoryStore,
  openSessionMemoryCandidateStore,
  PermanentMemoryPolicyError
} from "../src/modules/long-memory/index.js";

async function withLongMemoryDatabase(run: (path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-long-memory-"));
  const path = join(directory, "long-memory.sqlite");

  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function withLongMemoryStore<T>(path: string, run: (store: LongMemoryStore) => T): T {
  const store = openLongMemoryStore(path);

  try {
    return run(store);
  } finally {
    store.close();
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

function listEventKinds(path: string): readonly string[] {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare("SELECT event_kind FROM long_memory_entry_events ORDER BY id")
      .all()
      .map((row) => String((row as { event_kind: unknown }).event_kind));
  } finally {
    database.close();
  }
}

function countRows(path: string, table: string): number {
  const database = new DatabaseSync(path);

  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    };

    return row.count;
  } finally {
    database.close();
  }
}

function listColumns(path: string, table: string): readonly string[] {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String((row as { readonly name: unknown }).name));
  } finally {
    database.close();
  }
}

function listForeignKeyTargets(path: string, table: string): readonly string[] {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map((row) => String((row as { readonly table: unknown }).table));
  } finally {
    database.close();
  }
}

function restoreMemorySearchRow(path: string, id: number): void {
  const database = new DatabaseSync(path);

  try {
    database
      .prepare(`
        INSERT INTO long_memory_entries_fts(rowid, title, body)
        SELECT id, title, body FROM long_memory_entries WHERE id = ?
      `)
      .run(id);
  } finally {
    database.close();
  }
}

function rejectMemoryAccessUpdate(path: string, id: number): void {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      CREATE TRIGGER reject_memory_access_update
      BEFORE UPDATE OF access_count ON long_memory_entries
      WHEN old.id = ${id}
      BEGIN
        SELECT RAISE(ABORT, 'access update rejected');
      END;
    `);
  } finally {
    database.close();
  }
}

function setMemoryStatus(path: string, id: number, status: string): void {
  const database = new DatabaseSync(path);

  try {
    database.prepare("UPDATE long_memory_entries SET status = ? WHERE id = ?").run(status, id);
  } finally {
    database.close();
  }
}

function insertCandidate(path: string, state: "pending_review" | "rejected"): void {
  const database = new DatabaseSync(path);

  try {
    database
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
        VALUES ('candidate-session', '["candidate-entry"]', '共通候補', '共通候補本文',
          'facility_knowledge', '[]', ?, '2026-07-11T00:00:00.000Z')
      `)
      .run(state);
  } finally {
    database.close();
  }
}

function dropMemoryEventsTable(path: string): void {
  const database = new DatabaseSync(path);

  try {
    database.exec("DROP TABLE long_memory_entry_events");
  } finally {
    database.close();
  }
}

function createLegacyLongMemoryDatabase(path: string): void {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      CREATE TABLE long_memory_entries (
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

      CREATE TABLE long_memory_entry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES long_memory_entries(id),
        event_kind TEXT NOT NULL CHECK (event_kind IN ('create', 'correct', 'delete')),
        reviewed_by TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        review_note TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE VIRTUAL TABLE long_memory_entries_fts
        USING fts5(title, body, tokenize='trigram');

      CREATE TRIGGER long_memory_entries_insert_fts
      AFTER INSERT ON long_memory_entries
      WHEN new.status = 'active'
      BEGIN
        INSERT INTO long_memory_entries_fts(rowid, title, body)
        VALUES (new.id, new.title, new.body);
      END;

      CREATE TRIGGER long_memory_entries_remove_fts
      AFTER UPDATE OF status ON long_memory_entries
      WHEN old.status = 'active' AND new.status <> 'active'
      BEGIN
        DELETE FROM long_memory_entries_fts WHERE rowid = old.id;
      END;
    `);
  } finally {
    database.close();
  }
}

function insertLegacyReviewedMemory(path: string): void {
  const database = new DatabaseSync(path);

  try {
    database
      .prepare(`
        INSERT INTO long_memory_entries (
          title,
          body,
          category,
          tags_json,
          status,
          reviewed_by,
          reviewed_at,
          review_note
        )
        VALUES (?, ?, 'facility_knowledge', '[]', 'active', ?, ?, ?)
      `)
      .run(
        "旧来の施設運用",
        "旧DBから引き継ぐ施設全体の運用。",
        "staff-legacy",
        "2026-04-01T09:00:00.000Z",
        "移行前に確認済み。"
      );
  } finally {
    database.close();
  }
}

function insertLegacyDanglingEvent(path: string): void {
  const database = new DatabaseSync(path);

  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        `
          INSERT INTO long_memory_entry_events (
            memory_id,
            event_kind,
            reviewed_by,
            reviewed_at,
            snapshot_json
          )
          VALUES (?, 'create', 'staff-a', '2026-04-01T09:00:00.000Z', '{}')
        `
      )
      .run(999);
  } finally {
    database.close();
  }
}

describe("SQLite long memory store", () => {
  it("creates the durable memory schema and FTS index in SQLite", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, () => undefined);
      const tables = listTables(path);

      expect(tables).toEqual(
        expect.arrayContaining(["long_memory_entries", "long_memory_entries_fts"])
      );
      expect(tables.some((table) => table.toLowerCase().includes("vector"))).toBe(false);
    });
  });

  it("writes reviewed care-continuity knowledge and reads it back from SQLite", async () => {
    await withLongMemoryDatabase((path) => {
      let writtenId = 0;

      withLongMemoryStore(path, (store) => {
        const written = store.writeReviewed({
          title: "雨の日の室内準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          tags: ["weather", "activity"],
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z",
          reviewNote: "施設運用メモとして確認済み。"
        });
        writtenId = written.id;

        expect(store.read(written.id)).toEqual({
          id: written.id,
          title: "雨の日の室内準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          tags: ["weather", "activity"],
          status: "active",
          correctionOf: undefined,
          review: {
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z",
            note: "施設運用メモとして確認済み。"
          },
          provenance: {
            kind: "staff_review",
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z",
            note: "施設運用メモとして確認済み。"
          },
          lifecycle: {
            mem0MemoryId: undefined,
            sourceSessionId: undefined,
            importance: 0.5,
            confidence: 0.5,
            lastAccessedAt: undefined,
            accessCount: 0,
            decayScore: 0,
            status: "active"
          }
        });
      });

      withLongMemoryStore(path, (reopened) => {
        expect(reopened.read(writtenId)?.title).toBe("雨の日の室内準備");
      });
    });
  });

  it("searches active durable memories through SQLite FTS5", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const rain = store.writeReviewed({
          title: "雨の日の準備",
          body: "工作セットと室内遊びの案を準備する。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });
        store.writeReviewed({
          title: "おやつ準備",
          body: "アレルギー表をスタッフが確認してから配膳する。",
          category: "operational_note",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:05:00.000Z"
        });

        expect(store.search("室内遊び")).toMatchObject([
          {
            id: rain.id,
            title: "雨の日の準備",
            category: "facility_knowledge",
            lifecycle: {
              status: "active"
            }
          }
        ]);
      });
    });
  });

  it("stores Mem0 provenance and updates lifecycle metadata on search", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-06-12T10:00:00.000Z"
      });

      try {
        const written = store.writeReviewed({
          title: "雨の日の工作準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          tags: ["weather"],
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z",
          mem0MemoryId: "mem0-rain-1",
          sourceSessionId: "session-2026-06-10-evening",
          importance: 0.8,
          confidence: 0.7
        });

        expect(store.read(written.id)?.lifecycle).toEqual({
          mem0MemoryId: "mem0-rain-1",
          sourceSessionId: "session-2026-06-10-evening",
          importance: 0.8,
          confidence: 0.7,
          lastAccessedAt: undefined,
          accessCount: 0,
          decayScore: 0,
          status: "active"
        });

        expect(store.search("工作準備")).toEqual([
          {
            id: written.id,
            title: "雨の日の工作準備",
            category: "care_continuity",
            lifecycle: {
              mem0MemoryId: "mem0-rain-1",
              sourceSessionId: "session-2026-06-10-evening",
              importance: 0.8,
              confidence: 0.7,
              lastAccessedAt: "2026-06-12T10:00:00.000Z",
              accessCount: 1,
              decayScore: 0,
              status: "active"
            }
          }
        ]);
        expect(store.read(written.id)?.lifecycle.accessCount).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("archives and deletes memories through deterministic lifecycle decay", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path);

      try {
        const archive = store.writeReviewed({
          title: "一時運用",
          body: "一時的に玄関掲示を変更した。",
          category: "operational_note",
          reviewedBy: "staff-a",
          reviewedAt: "2026-05-01T09:00:00.000Z",
          mem0MemoryId: "mem0-archive",
          sourceSessionId: "session-archive",
          importance: 0.2,
          confidence: 0.6
        });
        const remove = store.writeReviewed({
          title: "古い一時運用",
          body: "古い一時掲示の記録。",
          category: "operational_note",
          reviewedBy: "staff-a",
          reviewedAt: "2026-04-01T09:00:00.000Z",
          mem0MemoryId: "mem0-delete",
          sourceSessionId: "session-delete",
          importance: 0.05,
          confidence: 0.2
        });

        expect(
          store.runDecay({
            now: "2026-06-12T09:00:00.000Z",
            archiveThreshold: 0.35,
            deleteThreshold: 0.12,
            decayWindowDays: 30
          })
        ).toEqual([
          {
            id: archive.id,
            previousStatus: "active",
            status: "archived",
            decayScore: 0.29,
            mem0MemoryId: "mem0-archive"
          },
          {
            id: remove.id,
            previousStatus: "active",
            status: "deleted",
            decayScore: 0.0925,
            mem0MemoryId: "mem0-delete"
          }
        ]);
        expect(store.read(archive.id)).toBeUndefined();
        expect(store.read(remove.id)).toBeUndefined();
        expect(store.readLifecycle(archive.id)?.status).toBe("archived");
        expect(store.readLifecycle(remove.id)?.status).toBe("deleted");
      } finally {
        store.close();
      }
    });
  });

  it("rejects invalid review and decay timestamps before lifecycle persistence", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(() =>
          store.writeReviewed({
            title: "一時運用",
            body: "一時的に玄関掲示を変更した。",
            category: "operational_note",
            reviewedBy: "staff-a",
            reviewedAt: "not-a-date"
          })
        ).toThrow("pico long memory timestamp is invalid");

        const written = store.writeReviewed({
          title: "一時運用",
          body: "一時的に玄関掲示を変更した。",
          category: "operational_note",
          reviewedBy: "staff-a",
          reviewedAt: "2026-05-01T09:00:00.000Z"
        });

        expect(() =>
          store.runDecay({
            now: "not-a-date",
            archiveThreshold: 0.35,
            deleteThreshold: 0.12,
            decayWindowDays: 30
          })
        ).toThrow("pico long memory timestamp is invalid");
        expect(store.readLifecycle(written.id)?.status).toBe("active");
      });
    });
  });

  it("rejects invalid access timestamps before updating lifecycle metadata", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "not-a-date"
      });

      try {
        const written = store.writeReviewed({
          title: "雨の日の工作準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        expect(() => store.search("工作準備")).toThrow("pico long memory timestamp is invalid");
        expect(store.readLifecycle(written.id)?.lastAccessedAt).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("migrates legacy reviewed memory tables before lifecycle decay", async () => {
    await withLongMemoryDatabase((path) => {
      createLegacyLongMemoryDatabase(path);

      const store = openLongMemoryStore(path);

      try {
        const written = store.writeReviewed({
          title: "旧スキーマ運用",
          body: "古いDBから移行した一時運用。",
          category: "operational_note",
          reviewedBy: "staff-a",
          reviewedAt: "2026-04-01T09:00:00.000Z",
          importance: 0.1,
          confidence: 0.2
        });

        expect(
          store.runDecay({
            now: "2026-06-12T09:00:00.000Z",
            archiveThreshold: 0.3,
            deleteThreshold: 0.05,
            decayWindowDays: 30
          })
        ).toEqual([
          {
            id: written.id,
            previousStatus: "active",
            status: "archived",
            decayScore: 0.105,
            mem0MemoryId: undefined
          }
        ]);
        expect(store.readLifecycle(written.id)?.status).toBe("archived");
        expect(listEventKinds(path)).toEqual(["create", "archive"]);
      } finally {
        store.close();
      }
    });
  });

  it("migrates legacy reviewed rows to staff-review provenance", async () => {
    await withLongMemoryDatabase((path) => {
      createLegacyLongMemoryDatabase(path);
      insertLegacyReviewedMemory(path);

      const store = openLongMemoryStore(path);

      try {
        expect(store.read(1)).toMatchObject({
          id: 1,
          review: {
            reviewedBy: "staff-legacy",
            reviewedAt: "2026-04-01T09:00:00.000Z",
            note: "移行前に確認済み。"
          },
          provenance: {
            kind: "staff_review",
            reviewedBy: "staff-legacy",
            reviewedAt: "2026-04-01T09:00:00.000Z",
            note: "移行前に確認済み。"
          }
        });
      } finally {
        store.close();
      }
    });
  });

  it("keeps candidate foreign keys valid after a successful legacy migration", async () => {
    await withLongMemoryDatabase(async (path) => {
      createLegacyLongMemoryDatabase(path);
      insertLegacyReviewedMemory(path);

      withLongMemoryStore(path, () => undefined);

      expect(listForeignKeyTargets(path, "long_memory_candidates")).toEqual([
        "long_memory_entries"
      ]);

      const candidates = openSessionMemoryCandidateStore(path, {
        now: () => "2026-07-11T00:00:00.000Z",
        processSession: () =>
          Promise.resolve([
            {
              title: "移行後の候補",
              body: "移行後も候補を保存できる。",
              category: "facility_knowledge"
            }
          ])
      });

      try {
        candidates.enqueueSessionCutoff({
          sessionId: "session-after-migration",
          cutoffAt: "2026-07-10T23:59:00.000Z",
          sourceEntryIds: ["entry-after-migration"],
          entries: [
            {
              id: "entry-after-migration",
              role: "staff",
              content: "移行後も施設全体の候補を作成する。"
            }
          ],
          requestedBy: "pico"
        });

        await expect(candidates.processNextJob()).resolves.toMatchObject({ status: "processed" });
        expect(candidates.listPending()).toHaveLength(1);
      } finally {
        candidates.close();
      }
    });
  });

  it("writes automated provenance without a fake reviewer", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-07-11T00:00:00.000Z"
      });

      try {
        const automatic = store.writeAutomated({
          title: "雨の日の工作準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "facility_knowledge",
          tags: ["雨", "工作"],
          sourceSessionId: "session-1",
          sourceEntryIds: ["entry-1"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.82
        });

        expect(automatic.provenance).toEqual({
          kind: "session_cutoff_automation",
          policyVersion: "session-cutoff-v1",
          sourceSessionId: "session-1",
          sourceEntryIds: ["entry-1"],
          createdAt: "2026-07-11T00:00:00.000Z"
        });
        expect(automatic.review).toBeUndefined();

        const database = new DatabaseSync(path);

        try {
          expect(
            database
              .prepare("SELECT reviewed_by, reviewed_at FROM long_memory_entries WHERE id = ?")
              .get(automatic.id)
          ).toEqual({ reviewed_by: "", reviewed_at: "" });
        } finally {
          database.close();
        }
      } finally {
        store.close();
      }
    });
  });

  it("suppresses exact automated duplicates and records each observation", async () => {
    await withLongMemoryDatabase((path) => {
      const timestamps = ["2026-07-11T00:00:00.000Z", "2026-07-11T01:00:00.000Z"];
      const store = openLongMemoryStore(path, {
        now: () => timestamps.shift() ?? "2026-07-11T01:00:00.000Z"
      });

      try {
        const first = store.writeAutomated({
          title: "雨の日の工作準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "facility_knowledge",
          tags: ["雨"],
          sourceSessionId: "session-1",
          sourceEntryIds: ["entry-1"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.82
        });
        const duplicate = store.writeAutomated({
          title: "  雨の日の工作準備  ",
          body: "  雨の日は工作セットを早めに準備する。  ",
          category: "facility_knowledge",
          tags: ["再観測"],
          sourceSessionId: "session-2",
          sourceEntryIds: ["entry-9"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.91
        });

        expect(duplicate.id).toBe(first.id);
        expect(countRows(path, "long_memory_entries")).toBe(1);
        expect(countRows(path, "long_memory_automation_observations")).toBe(2);
      } finally {
        store.close();
      }
    });
  });

  it("decays automated memories from their automation creation timestamp", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-07-11T00:00:00.000Z"
      });

      try {
        const automatic = store.writeAutomated({
          title: "一時的な自動運用",
          body: "期限に応じて減衰できる自動記憶。",
          category: "operational_note",
          sourceSessionId: "session-decay",
          sourceEntryIds: ["entry-decay"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.1
        });

        expect(
          store.runDecay({
            now: "2026-07-11T00:00:00.000Z",
            archiveThreshold: 0.5,
            deleteThreshold: 0.1,
            decayWindowDays: 30
          })
        ).toEqual([
          {
            id: automatic.id,
            previousStatus: "active",
            status: "archived",
            decayScore: 0.415,
            mem0MemoryId: undefined
          }
        ]);
        expect(store.readLifecycle(automatic.id)?.status).toBe("archived");
      } finally {
        store.close();
      }
    });
  });

  it("returns bounded active full records and updates access only after SQL limit", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-07-11T02:00:00.000Z"
      });

      try {
        const automatic = store.writeAutomated({
          title: "共通の自動記憶",
          body: "共通本文その一。",
          category: "facility_knowledge",
          sourceSessionId: "session-1",
          sourceEntryIds: ["entry-1"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.8
        });
        const second = store.writeReviewed({
          title: "共通の確認済み記憶",
          body: "共通本文その二。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:10:00.000Z"
        });
        const beyondLimit = store.writeReviewed({
          title: "共通の三件目",
          body: "共通本文その三。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:20:00.000Z"
        });
        const archived = store.writeReviewed({
          title: "共通のアーカイブ",
          body: "共通の除外本文。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:30:00.000Z"
        });
        const superseded = store.writeReviewed({
          title: "共通の置換済み",
          body: "共通の除外本文。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:40:00.000Z"
        });
        const deleted = store.writeReviewed({
          title: "共通の削除済み",
          body: "共通の除外本文。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:50:00.000Z"
        });

        setMemoryStatus(path, archived.id, "archived");
        setMemoryStatus(path, superseded.id, "superseded");
        setMemoryStatus(path, deleted.id, "deleted");
        insertCandidate(path, "pending_review");
        insertCandidate(path, "rejected");

        const results = store.searchActive({ query: "共通", limit: 2 });

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
          id: automatic.id,
          body: "共通本文その一。",
          review: undefined,
          provenance: { kind: "session_cutoff_automation" },
          lifecycle: { accessCount: 1, lastAccessedAt: "2026-07-11T02:00:00.000Z" }
        });
        expect(results[1]).toMatchObject({
          id: second.id,
          body: "共通本文その二。",
          provenance: { kind: "staff_review" },
          lifecycle: { accessCount: 1, lastAccessedAt: "2026-07-11T02:00:00.000Z" }
        });
        expect(store.readLifecycle(beyondLimit.id)).toMatchObject({
          accessCount: 0,
          lastAccessedAt: undefined
        });
      } finally {
        store.close();
      }
    });
  });

  it("applies active status before the SQL search limit", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-07-11T02:00:00.000Z"
      });

      try {
        const inactive = store.writeReviewed({
          title: "境界の非アクティブ記憶",
          body: "境界検索では除外する。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:00:00.000Z"
        });
        setMemoryStatus(path, inactive.id, "archived");
        restoreMemorySearchRow(path, inactive.id);

        const active = store.writeReviewed({
          title: "境界のアクティブ記憶",
          body: "境界検索で返す。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:10:00.000Z"
        });

        expect(store.searchActive({ query: "境界", limit: 1 }).map((record) => record.id)).toEqual([
          active.id
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("rolls back all bounded-search access updates when one update fails", async () => {
    await withLongMemoryDatabase((path) => {
      const store = openLongMemoryStore(path, {
        now: () => "2026-07-11T02:00:00.000Z"
      });

      try {
        const first = store.writeReviewed({
          title: "更新失敗の一件目",
          body: "更新失敗時に部分反映しない。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:00:00.000Z"
        });
        const second = store.writeReviewed({
          title: "更新失敗の二件目",
          body: "更新失敗を発生させる。",
          category: "facility_knowledge",
          reviewedBy: "staff-a",
          reviewedAt: "2026-07-11T00:10:00.000Z"
        });
        rejectMemoryAccessUpdate(path, second.id);

        expect(() => store.searchActive({ query: "更新", limit: 2 })).toThrow(
          "access update rejected"
        );
        expect(store.readLifecycle(first.id)).toMatchObject({
          lastAccessedAt: undefined,
          accessCount: 0
        });
        expect(store.readLifecycle(second.id)).toMatchObject({
          lastAccessedAt: undefined,
          accessCount: 0
        });
      } finally {
        store.close();
      }
    });
  });

  it("rejects malformed and structurally explicit child-profile automated writes", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(() =>
          store.writeAutomated({
            title: "施設メモ",
            body: "施設全体の運用。",
            category: "facility_knowledge",
            sourceSessionId: "session-1",
            sourceEntryIds: [],
            policyVersion: "session-cutoff-v1",
            confidence: 0.8
          })
        ).toThrow("pico automated long memory source entries are required");

        const structurallyInvalid = {
          title: "施設メモ",
          body: "施設全体の運用。",
          category: "facility_knowledge",
          sourceSessionId: "session-1",
          sourceEntryIds: ["entry-1"],
          policyVersion: "session-cutoff-v1",
          confidence: 0.8,
          childProfile: { score: 1 }
        } as unknown as Parameters<LongMemoryStore["writeAutomated"]>[0];

        expect(() => store.writeAutomated(structurallyInvalid)).toThrow(
          "pico long memory must not contain structured individual child profile fields"
        );
        expect(countRows(path, "long_memory_entries")).toBe(0);
      });
    });
  });

  it("rejects legacy migration when foreign key violations remain", async () => {
    await withLongMemoryDatabase((path) => {
      createLegacyLongMemoryDatabase(path);
      insertLegacyDanglingEvent(path);

      expect(() => openLongMemoryStore(path)).toThrow(
        "pico long memory migration left foreign key violations"
      );
    });
  });

  it("rolls back a rejected legacy migration and rejects every subsequent open", async () => {
    await withLongMemoryDatabase((path) => {
      createLegacyLongMemoryDatabase(path);
      insertLegacyReviewedMemory(path);
      insertLegacyDanglingEvent(path);

      expect(() => openLongMemoryStore(path)).toThrow(
        "pico long memory migration left foreign key violations"
      );

      expect(listColumns(path, "long_memory_entries")).not.toEqual(
        expect.arrayContaining(["archived_at", "origin_kind", "automated_fingerprint"])
      );
      expect(countRows(path, "long_memory_entries")).toBe(1);
      expect(countRows(path, "long_memory_entry_events")).toBe(1);
      expect(listTables(path)).not.toEqual(
        expect.arrayContaining(["long_memory_candidates", "long_memory_automation_observations"])
      );

      expect(() => {
        const reopened = openLongMemoryStore(path);
        reopened.close();
      }).toThrow("pico long memory migration left foreign key violations");

      expect(countRows(path, "long_memory_entries")).toBe(1);
      expect(countRows(path, "long_memory_entry_events")).toBe(1);
    });
  });

  it("corrects and deletes durable memories only through reviewed boundaries", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const original = store.writeReviewed({
          title: "片付け開始",
          body: "お迎え前に片付けを始める。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        const corrected = store.correct(original.id, {
          title: "片付け開始",
          body: "お迎えの10分前に片付けを始める。",
          category: "care_continuity",
          reviewedBy: "staff-b",
          reviewedAt: "2026-06-10T10:00:00.000Z"
        });

        expect(store.read(original.id)).toBeUndefined();
        expect(store.read(corrected.id)).toMatchObject({
          id: corrected.id,
          correctionOf: original.id,
          status: "active",
          body: "お迎えの10分前に片付けを始める。"
        });

        store.delete(corrected.id, {
          reviewedBy: "staff-c",
          reviewedAt: "2026-06-10T11:00:00.000Z",
          note: "古い運用に戻したため非表示。"
        });

        expect(store.read(corrected.id)).toBeUndefined();
        expect(store.search("片付け")).toEqual([]);
      });

      expect(listEventKinds(path)).toEqual(["create", "correct", "delete"]);
    });
  });

  it("rejects durable writes without explicit review metadata", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(() =>
          store.writeReviewed({
            title: "未レビュー",
            body: "レビューなしでは永続化しない。",
            category: "operational_note",
            reviewedBy: "",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          })
        ).toThrow("pico long memory review metadata is required");
      });
    });
  });

  it("rejects individual child profile fields at the durable memory boundary", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: "個別記録",
          body: "施設全体の知識ではない個別記録。",
          category: "care_continuity" as const,
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z",
          childId: "child-1"
        };

        expect(() => store.writeReviewed(input)).toThrow(
          "pico long memory must not contain structured individual child profile fields"
        );
      });
    });
  });

  it.each([
    "childScore",
    "childMonitor",
    "childMonitoring",
    "児童監視"
  ])("rejects individual child scoring or tracking field %s at the durable boundary", async (field) => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: "個別記録",
          body: "施設全体の知識ではない個別記録。",
          category: "care_continuity" as const,
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z",
          [field]: "restricted"
        };

        expect(() => store.writeReviewed(input)).toThrow(PermanentMemoryPolicyError);
        expect(countRows(path, "long_memory_entries")).toBe(0);
      });
    });
  });

  it.each([
    "childGuidance",
    "childVideo",
    "childIdea"
  ])("treats generic unknown field %s as malformed rather than a child-policy violation", async (field) => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: "施設メモ",
          body: "施設全体の運用。",
          category: "facility_knowledge" as const,
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z",
          [field]: "facility"
        };
        let caught: unknown;

        try {
          store.writeReviewed(input);
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(PermanentMemoryPolicyError);
        expect((caught as Error).message).toBe("pico long memory input is malformed");
        expect(countRows(path, "long_memory_entries")).toBe(0);
      });
    });
  });

  it("does not apply a natural-language privacy classifier to facility prose", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const written = store.writeReviewed({
          title: "施設の健康管理手順",
          body: "職員は施設のアレルギー表を確認する。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        expect(written.body).toBe("職員は施設のアレルギー表を確認する。");
      });
    });
  });

  it.each([
    "施設の健康管理手順を年度末に見直す。",
    "職員は施設のアレルギー表を確認する。",
    "工作セットはちゃんと片付ける。"
  ])("preserves ordinary facility prose without lexical classification: %s", async (body) => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(
          store.writeReviewed({
            title: "施設メモ",
            body,
            category: "care_continuity",
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          }).body
        ).toBe(body);
      });
    });
  });

  it("does not classify legacy active-row prose during bounded search", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, () => undefined);
      const database = new DatabaseSync(path);

      try {
        database
          .prepare(`
            INSERT INTO long_memory_entries (
              title,
              body,
              category,
              tags_json,
              status,
              reviewed_by,
              reviewed_at
            ) VALUES (?, ?, 'care_continuity', '[]', 'active', 'legacy-staff', ?)
          `)
          .run(
            "施設の健康管理手順",
            "職員は施設のアレルギー表を確認する。",
            "2026-06-10T09:00:00.000Z"
          );
      } finally {
        database.close();
      }

      withLongMemoryStore(path, (store) => {
        expect(
          store.searchActive({ query: "健康管理", limit: 1 }).map((record) => record.id)
        ).toEqual([1]);
        expect(store.read(1)?.status).toBe("active");
      });
    });
  });

  it.each([
    ["施設の健康管理", "年度末に手順を見直す。"],
    ["アレルギー表", "職員が配膳前に確認する。"]
  ])("preserves facility prose split across memory fields: %s", async (title, body) => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(
          store.writeReviewed({
            title,
            body,
            category: "care_continuity",
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          }).body
        ).toBe(body);
      });
    });
  });

  it.each([
    "工作セットはちゃんと片付ける。",
    "備品をちゃんと元に戻す。"
  ])("preserves ordinary facility knowledge containing the adverb chanto: %s", async (body) => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(
          store.writeReviewed({
            title: "施設共通の片付け手順",
            body,
            category: "facility_knowledge",
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          }).body
        ).toBe(body);
      });
    });
  });

  it("does not classify reviewed tag text", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(
          store.writeReviewed({
            title: "施設メモ",
            body: "施設全体の申し送りとして扱う。",
            category: "care_continuity",
            tags: ["施設の健康管理"],
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          }).tags
        ).toEqual(["施設の健康管理"]);
      });
    });
  });

  it("rejects malformed durable text before marker scanning", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: 123,
          body: "型が壊れた入力。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        } as unknown as Parameters<LongMemoryStore["writeReviewed"]>[0];

        expect(() => store.writeReviewed(input)).toThrow("pico long memory text is required");
      });
    });
  });

  it("rejects malformed durable tags before marker scanning", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: "施設メモ",
          body: "タグの型が壊れた入力。",
          category: "care_continuity",
          tags: "weather",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        } as unknown as Parameters<LongMemoryStore["writeReviewed"]>[0];

        expect(() => store.writeReviewed(input)).toThrow("pico long memory input is malformed");
      });
    });
  });

  it("rejects sparse durable tags before persistence", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const input = {
          title: "施設メモ",
          body: "タグ配列の穴を永続化しない。",
          category: "care_continuity",
          tags: Array(1),
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        } as unknown as Parameters<LongMemoryStore["writeReviewed"]>[0];

        expect(() => store.writeReviewed(input)).toThrow("pico long memory input is malformed");
      });
    });
  });

  it("does not classify reviewed deletion-note prose", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const written = store.writeReviewed({
          title: "室内準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        store.delete(written.id, {
          reviewedBy: "staff-b",
          reviewedAt: "2026-06-10T10:00:00.000Z",
          note: "施設の健康管理手順を更新した。"
        });
        expect(store.read(written.id)).toBeUndefined();
      });
    });
  });

  it("rolls back reviewed mutations when event recording fails", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const written = store.writeReviewed({
          title: "室内準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        dropMemoryEventsTable(path);

        expect(() =>
          store.delete(written.id, {
            reviewedBy: "staff-b",
            reviewedAt: "2026-06-10T10:00:00.000Z"
          })
        ).toThrow();
        expect(store.read(written.id)?.status).toBe("active");
      });
    });
  });
});
