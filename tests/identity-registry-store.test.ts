import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { ChildIdentity } from "../src/modules/identity-registry/schema.js";
import {
  initializeIdentityRegistryDatabase,
  openIdentityRegistryDatabase
} from "../src/modules/identity-registry/store.js";

const directories: string[] = [];
const now = "2026-07-12T00:00:00.000Z";
const next = "2026-07-12T00:01:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("plaintext identity registry store", () => {
  it("persists plaintext identity data with owner-only permissions", () => {
    const { databasePath, directory } = createDatabasePath();
    const store = initializeIdentityRegistryDatabase({ databasePath, now });
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000001", "架空", "花子");

    const preview = store.stagePreview({ changes: [{ kind: "create", identity }], now });
    expect(store.applyPreview(preview.previewId, next)).toEqual({ applied: 1, registryEpoch: 1 });
    expect(store.resolve("架空花子")).toEqual({ kind: "resolved", identity });
    store.close();

    expect(readFileSync(databasePath).includes(Buffer.from("架空", "utf8"))).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("does not change an existing custom parent directory mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pico-identity-custom-parent-"));
    directories.push(root);
    const parent = join(root, "shared");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);

    const store = initializeIdentityRegistryDatabase({
      databasePath: join(parent, "registry.sqlite"),
      now
    });

    expect(statSync(parent).mode & 0o777).toBe(0o755);
    store.close();
  });

  it("reopens the same plaintext registry", () => {
    const { databasePath } = createDatabasePath();
    const created = initializeIdentityRegistryDatabase({ databasePath, now });
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000002", "架空", "太郎");
    const preview = created.stagePreview({ changes: [{ kind: "create", identity }], now });
    created.applyPreview(preview.previewId, next);
    created.close();

    const reopened = openIdentityRegistryDatabase({ databasePath });
    expect(reopened.status()).toEqual({
      schemaVersion: 1,
      normalizationVersion: 1,
      registryEpoch: 1,
      identityCount: 1
    });
    expect(reopened.list()).toEqual([identity]);
    reopened.close();
  });

  it("resolves exact aliases before stripping an honorific", () => {
    const store = createStore();
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000003", "架空", "花子", [
      "はなちゃん"
    ]);
    applyCreate(store, identity);

    expect(store.resolve("はなちゃん")).toEqual({ kind: "resolved", identity });
    expect(store.resolve("カクウハナコ")).toEqual({ kind: "resolved", identity });
    expect(store.resolve("架空花子さん")).toEqual({ kind: "resolved", identity });
    expect(store.resolve("unknown")).toEqual({ kind: "not_found" });
    store.close();
  });

  it("returns ambiguous for duplicate formal names", () => {
    const store = createStore();
    const first = createIdentity("018f0f4e-0000-7000-8000-000000000004", "同名", "児童");
    const second = createIdentity("018f0f4e-0000-7000-8000-000000000005", "同名", "児童");
    const preview = store.stagePreview({
      changes: [
        { kind: "create", identity: first },
        { kind: "create", identity: second }
      ],
      now
    });
    store.applyPreview(preview.previewId, next);

    expect(store.resolve("同名児童")).toEqual({ kind: "ambiguous" });
    store.close();
  });

  it("rejects an alias equal to a duplicated formal name", () => {
    const store = createStore();
    const first = createIdentity("018f0f4e-0000-7000-8000-000000000016", "同名", "児童");
    const second = createIdentity("018f0f4e-0000-7000-8000-000000000017", "同名", "児童");
    const preview = store.stagePreview({
      changes: [
        { kind: "create", identity: first },
        { kind: "create", identity: second }
      ],
      now
    });
    store.applyPreview(preview.previewId, next);

    expect(() => store.addAlias(first.subjectRef, "同名児童", next)).toThrow("identity_collision");
    store.close();
  });

  it("rejects an alias that collides with another identity", () => {
    const store = createStore();
    const first = createIdentity("018f0f4e-0000-7000-8000-000000000006", "架空", "花子");
    const second = createIdentity("018f0f4e-0000-7000-8000-000000000007", "架空", "太郎");
    const preview = store.stagePreview({
      changes: [
        { kind: "create", identity: first },
        { kind: "create", identity: second }
      ],
      now
    });
    store.applyPreview(preview.previewId, next);

    expect(() => store.addAlias(second.subjectRef, "架空花子", next)).toThrow("identity_collision");
    expect(store.list()).toEqual([first, second]);
    store.close();
  });

  it("rejects a Katakana alias that collides with another identity reading", () => {
    const store = createStore();
    const first = createIdentity("018f0f4e-0000-7000-8000-000000000014", "架空", "花子");
    const second = createIdentity("018f0f4e-0000-7000-8000-000000000015", "架空", "太郎");
    const preview = store.stagePreview({
      changes: [
        { kind: "create", identity: first },
        { kind: "create", identity: second }
      ],
      now
    });
    store.applyPreview(preview.previewId, next);

    expect(() => store.addAlias(second.subjectRef, "カクウハナコ", next)).toThrow(
      "identity_collision"
    );
    store.close();
  });

  it("consumes a preview when its registry epoch is stale", () => {
    const store = createStore();
    const stale = store.stagePreview({
      changes: [
        {
          kind: "create",
          identity: createIdentity("018f0f4e-0000-7000-8000-000000000008", "古い", "児童")
        }
      ],
      now
    });
    applyCreate(store, createIdentity("018f0f4e-0000-7000-8000-000000000009", "新しい", "児童"));

    expect(() => store.applyPreview(stale.previewId, next)).toThrow("preview_stale");
    expect(() => store.applyPreview(stale.previewId, next)).toThrow("preview_not_found");
    store.close();
  });

  it("rolls back a stale revision transaction before the next mutation", () => {
    const { databasePath } = createDatabasePath();
    const store = initializeIdentityRegistryDatabase({ databasePath, now });
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000018", "架空", "花子");
    applyCreate(store, identity);
    const preview = store.stagePreview({
      changes: [
        {
          kind: "update",
          expectedRevision: 1,
          identity: { ...identity, revision: 2, status: "inactive", updatedAt: next }
        }
      ],
      now
    });
    const external = new DatabaseSync(databasePath);
    external
      .prepare("UPDATE identity_registry_entries SET revision = 2 WHERE subject_ref = ?")
      .run(identity.subjectRef);
    external.close();

    expect(() => store.applyPreview(preview.previewId, next)).toThrow("preview_stale");
    expect(() => store.addAlias(identity.subjectRef, "はな", next)).not.toThrow();
    store.close();
  });

  it("keeps inactive lookup tokens reserved", () => {
    const store = createStore();
    const inactive = {
      ...createIdentity("018f0f4e-0000-7000-8000-000000000010", "退所", "児童"),
      status: "inactive" as const
    };
    applyCreate(store, inactive);
    const active = createIdentity("018f0f4e-0000-7000-8000-000000000011", "別の", "児童");
    applyCreate(store, active);

    expect(() => store.addAlias(active.subjectRef, "退所児童", next)).toThrow("identity_collision");
    store.close();
  });

  it("canonicalizes aliases and leaves revision and epoch unchanged for no-op mutations", () => {
    const store = createStore();
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000012", "架空", "花子");
    applyCreate(store, identity);

    store.addAlias(identity.subjectRef, " はな ", next);
    const afterAdd = store.status();
    const added = store.resolve("はな");
    expect(added).toMatchObject({
      kind: "resolved",
      identity: { aliases: ["はな"], revision: 2 }
    });

    store.addAlias(identity.subjectRef, "はな", "2026-07-12T00:02:00.000Z");
    expect(store.status()).toEqual(afterAdd);
    store.removeAlias(identity.subjectRef, "　はな　", "2026-07-12T00:03:00.000Z");
    const afterRemove = store.status();
    expect(store.resolve("はな")).toEqual({ kind: "not_found" });
    store.removeAlias(identity.subjectRef, "はな", "2026-07-12T00:04:00.000Z");
    expect(store.status()).toEqual(afterRemove);
    store.close();
  });

  it("preserves mutations made through separate open stores", () => {
    const { databasePath } = createDatabasePath();
    const first = initializeIdentityRegistryDatabase({ databasePath, now });
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000013", "架空", "花子");
    applyCreate(first, identity);
    const second = openIdentityRegistryDatabase({ databasePath });

    first.addAlias(identity.subjectRef, "はな", next);
    second.addAlias(identity.subjectRef, "かこ", "2026-07-12T00:02:00.000Z");

    expect(second.list()[0]).toMatchObject({ aliases: ["はな", "かこ"], revision: 3 });
    first.close();
    second.close();
  });

  it("uses a single SQLite snapshot for compound reads", () => {
    const store = createStore();
    const identity = createIdentity("018f0f4e-0000-7000-8000-000000000019", "架空", "花子", [
      "はな"
    ]);
    applyCreate(store, identity);
    const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
    if (execDescriptor === undefined || typeof execDescriptor.value !== "function") {
      throw new Error("missing DatabaseSync.exec descriptor");
    }
    const originalExec = execDescriptor.value as (this: DatabaseSync, sql: string) => void;
    const statements: string[] = [];
    Object.defineProperty(DatabaseSync.prototype, "exec", {
      ...execDescriptor,
      value(this: DatabaseSync, sql: string): void {
        statements.push(sql);
        Reflect.apply(originalExec, this, [sql]);
      }
    });

    try {
      for (const read of [() => store.status(), () => store.list(), () => store.resolve("はな")]) {
        statements.length = 0;
        read();
        expect(statements).toEqual(["BEGIN DEFERRED", "COMMIT"]);
      }
    } finally {
      Object.defineProperty(DatabaseSync.prototype, "exec", execDescriptor);
      store.close();
    }
  });

  it("rejects operations after close", () => {
    const store = createStore();
    store.close();
    expect(() => store.status()).toThrow("registry_closed");
  });
});

function createDatabasePath(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "pico-identity-store-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "registry.sqlite") };
}

function createStore() {
  const { databasePath } = createDatabasePath();
  return initializeIdentityRegistryDatabase({ databasePath, now });
}

function createIdentity(
  subjectReference: string,
  family: string,
  given: string,
  aliases: readonly string[] = []
): ChildIdentity {
  return {
    subjectRef: subjectReference,
    revision: 1,
    name: {
      family,
      given,
      familyKana: family === "同名" ? "どうめい" : "かくう",
      givenKana: given === "太郎" ? "たろう" : "はなこ"
    },
    aliases,
    status: "active",
    updatedAt: now
  };
}

function applyCreate(
  store: ReturnType<typeof initializeIdentityRegistryDatabase>,
  identity: ChildIdentity
): void {
  const preview = store.stagePreview({ changes: [{ kind: "create", identity }], now });
  store.applyPreview(preview.previewId, next);
}
