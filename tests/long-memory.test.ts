import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { type LongMemoryStore, openLongMemoryStore } from "../src/modules/long-memory/index.js";

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

  it("rejects legacy migration when foreign key violations remain", async () => {
    await withLongMemoryDatabase((path) => {
      createLegacyLongMemoryDatabase(path);
      insertLegacyDanglingEvent(path);

      expect(() => openLongMemoryStore(path)).toThrow(
        "pico long memory migration left foreign key violations"
      );
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
          "pico long memory must not contain individual child profile data"
        );
      });
    });
  });

  it("rejects individual child assessment content in reviewed text", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(() =>
          store.writeReviewed({
            title: "施設メモ",
            body: "child evaluation notes must not become durable memory.",
            category: "care_continuity",
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          })
        ).toThrow("pico long memory must not contain individual child profile data");
      });
    });
  });

  it("rejects individual child assessment content in reviewed tags", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        expect(() =>
          store.writeReviewed({
            title: "施設メモ",
            body: "施設全体の申し送りとして扱う。",
            category: "care_continuity",
            tags: ["child-evaluating"],
            reviewedBy: "staff-a",
            reviewedAt: "2026-06-10T09:00:00.000Z"
          })
        ).toThrow("pico long memory must not contain individual child profile data");
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

  it("rejects individual child assessment content in delete review notes", async () => {
    await withLongMemoryDatabase((path) => {
      withLongMemoryStore(path, (store) => {
        const written = store.writeReviewed({
          title: "室内準備",
          body: "雨の日は工作セットを早めに準備する。",
          category: "care_continuity",
          reviewedBy: "staff-a",
          reviewedAt: "2026-06-10T09:00:00.000Z"
        });

        expect(() =>
          store.delete(written.id, {
            reviewedBy: "staff-b",
            reviewedAt: "2026-06-10T10:00:00.000Z",
            note: "child evaluation note must not become durable memory."
          })
        ).toThrow("pico long memory must not contain individual child profile data");
        expect(store.read(written.id)?.status).toBe("active");
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
