# Minimal Identity Registry・名簿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** クラウド送信時の仮名化に必要な最小 identity を、owner-only の平文 SQLite と schema-generated XLSX で管理する。

**Architecture:** `src/modules/identity-registry/` は schema、normalization、workbook、plaintext SQLite store、application service を所有する。全 mutation は service を通し、bulk import は plaintext preview と owner-approved apply の2段階にする。Privacy Filter、application encryption、native keyring、custom ZIP parser はこの slice に含めない。

**Tech Stack:** Node.js 24 ESM、TypeScript strict、`node:sqlite`、ExcelJS 4.4.0、Vitest、Biome、ESLint、ast-grep。

---

## File map

- `src/modules/identity-registry/schema.ts`: minimal identity contract、XLSX columns、validation bounds。
- `src/modules/identity-registry/normalization.ts`: exact lookup normalization と honorific query variants。
- `src/modules/identity-registry/workbook.ts`: template、bounded parse、export。
- `src/modules/identity-registry/store.ts`: plaintext SQLite schema、lookup、preview、transaction。
- `src/modules/identity-registry/index.ts`: application service と module metadata。
- `src/runtime/roster-cli.ts`: CLI parser、service routing、bounded JSON result。
- `scripts/roster.ts`: CLI process entrypoint。
- `src/runtime/pico-cli.ts`: `pico roster` routing。
- `tests/identity-registry-*.test.ts`: focused schema、workbook、store、service tests。
- `tests/roster-cli.test.ts`: owner CLI contract。
- `docs/superpowers/specs/2026-07-11-identity-registry-roster-design.md`: approved minimal design。

削除対象は `crypto.ts`、`keyring.ts`、`lifecycle.ts`、`zip-preflight.ts`、registry-specific `audit.ts`、対応 test/field script、`@napi-rs/keyring`、`yauzl`、`@types/yauzl` とする。PR前に参照と責務を再確認してから確定する。

## State Boundary

1. State being changed: SQLite metadata、plaintext identity、lookup、preview、revision、registry epoch。
2. Lifecycle boundary: `migration-required`。schema/normalization version は open 中に変更しない。
3. Mutation path inventory: init、preview、owner-approved apply、alias add/remove、activate/deactivate。env、config watcher、LLM、Pi tool、resident voice、background worker は非対象。
4. Consumer/invariant inventory: schema validator、workbook adapter、store、resolver、CLI、後続 Privacy Filter。
5. Central enforcement point: `IdentityRegistryService` が全 mutation と transaction precondition を所有する。
6. Forbidden paths: direct SQL mutation、LLM-issued subjectRef、name-based update、automatic alias learning、preview bypass。
7. Required tests: allowed/forbidden mutation、stale rollback、collision、ambiguity、permission、workbook validation、CLI routing。
8. Async ownership and terminal states: background ownerなし。1 invocation が workbook/database を close し、applied/stale preview を消費する。

### Task 1: Minimal schema and normalization

**Files:**
- Rewrite: `tests/identity-registry-schema.test.ts`
- Rewrite: `tests/identity-registry-normalization.test.ts`
- Rewrite: `src/modules/identity-registry/schema.ts`
- Rewrite: `src/modules/identity-registry/normalization.ts`

- [x] **Step 1: RED tests を書く**

```ts
expect(ROSTER_COLUMNS.map(({ header }) => header)).toEqual([
  "pico_id", "revision", "姓", "名", "姓かな", "名かな", "あだ名", "状態"
]);
expect(validateChildIdentity({
  subjectRef: "child-1",
  revision: 1,
  name: { family: "架空", given: "花子", familyKana: "かくう", givenKana: "はなこ" },
  aliases: ["はなちゃん"],
  status: "active",
  updatedAt: "2026-07-12T00:00:00.000Z"
})).toEqual([]);
expect(normalizeIdentityLookupText(" 架空　花子 ")).toBe("架空花子");
expect(createIdentityLookupQueryVariants("はなちゃん")).toEqual(["はなちゃん", "はな"]);
```

Field limits、unknown key、control character、NFKC、Katakana-to-Hiragana、alias count、status enum、exact-first honorific cases を含める。

- [x] **Step 2: RED を確認する**

Run:

```bash
npx vitest run tests/identity-registry-schema.test.ts tests/identity-registry-normalization.test.ts
```

Expected: old 17-column contract または removed field contract により FAIL。

- [x] **Step 3: minimal contract を実装する**

`ChildIdentity` は `subjectRef`、revision、4 name fields、aliases、`active|inactive`、updatedAtだけを持つ。schema constant から row parser と workbook metadata を導出する。normalization は NFKC、whitespace removal、reading conversion、control rejection、exact-first honorific variantだけを実装する。

- [x] **Step 4: GREEN を確認する**

Run:

```bash
npx vitest run tests/identity-registry-schema.test.ts tests/identity-registry-normalization.test.ts
just typecheck
```

Expected: focused tests と typecheck PASS。

### Task 2: Minimal XLSX adapter

**Files:**
- Rewrite: `tests/identity-registry-workbook.test.ts`
- Rewrite: `src/modules/identity-registry/workbook.ts`
- Delete after replacement: `src/modules/identity-registry/zip-preflight.ts`
- Delete after replacement: `tests/identity-registry-zip-preflight.test.ts`

- [x] **Step 1: RED tests を書く**

```ts
const template = await createRosterTemplateWorkbook("2026-07-12T00:00:00.000Z");
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(template);
expect(workbook.worksheets.map(({ name }) => name)).toEqual([
  "児童名簿", "入力ガイド", "_pico_schema"
]);
expect(workbook.getWorksheet("児童名簿")?.getRow(1).values).toEqual([
  undefined, "pico_id", "revision", "姓", "名", "姓かな", "名かな", "あだ名", "状態"
]);
```

Round trip、formula、hyperlink、rich text、unexpected sheet/header、merged/hidden cell、10 MiB file、2,000 row、50,000 cell、512 code-point limit を検証する。

- [x] **Step 2: RED を確認する**

Run: `npx vitest run tests/identity-registry-workbook.test.ts`

Expected: old sheet/column contract により FAIL。

- [x] **Step 3: ExcelJS-only implementation を書く**

`readFile`/`fstat` で regular file と10 MiB limitを確認し、ExcelJSでloadする。post-load structural validationを行い、custom ZIP parsing、CRC、buffer zero-fillを呼ばない。export はplain text cellだけを書く。

- [x] **Step 4: GREEN と削除を確認する**

Run:

```bash
npx vitest run tests/identity-registry-workbook.test.ts
rg -n "zip-preflight|preflightXlsx|yauzl|crc32" src tests
```

Expected: tests PASS、production/test reference 0件。確認後に ZIP preflight source/test を削除する。

### Task 3: Plaintext SQLite store

**Files:**
- Rewrite: `tests/identity-registry-store.test.ts`
- Rewrite: `src/modules/identity-registry/store.ts`
- Delete after replacement: `src/modules/identity-registry/crypto.ts`
- Delete after replacement: `src/modules/identity-registry/keyring.ts`
- Delete after replacement: `src/modules/identity-registry/lifecycle.ts`
- Delete after replacement: `src/modules/identity-registry/audit.ts`
- Delete corresponding tests and field script after reference scan

- [x] **Step 1: RED tests を書く**

Use real `node:sqlite` and a temporary mode-0700 directory. Initialize a store, insert a synthetic identity through preview/apply, then assert:

```ts
expect(store.resolve("架空花子")).toMatchObject({
  kind: "resolved",
  identity: { subjectRef, status: "active" }
});
expect(readFileSync(databasePath).includes(Buffer.from("架空", "utf8"))).toBe(true);
expect(statSync(databasePath).mode & 0o777).toBe(0o600);
```

Preview plaintext persistence、revision/epoch、stale preview consumption、transaction rollback、duplicate formal ambiguity、alias collision、inactive token reservation、close-after-use rejection を含める。

- [x] **Step 2: RED を確認する**

Run: `npx vitest run tests/identity-registry-store.test.ts`

Expected: current encrypted store does not expose the minimal plaintext contract and test FAIL。

- [x] **Step 3: minimal store を実装する**

Tables are `identity_registry_metadata`、`identity_registry_entries`、`identity_registry_aliases`、`identity_registry_lookups`、`identity_registry_previews`。Names and aliases are plaintext. Store owns SQL transaction primitives; service-visible methods expose status/list/resolve/stage/apply and single-identity mutations without crypto/key parameters。

- [x] **Step 4: GREEN と obsolete boundary scan**

Run:

```bash
npx vitest run tests/identity-registry-store.test.ts
rg -n "encrypt|decrypt|ciphertext|authentication_tag|recordEncryptionKey|keyring|HKDF|HMAC" src/modules/identity-registry tests/identity-registry*.test.ts scripts/field
```

Expected: focused test PASS、remaining hits are only explicit absence assertions/docs。確認後に obsolete files を削除する。

### Task 4: Application service

**Files:**
- Rewrite: `tests/identity-registry.test.ts`
- Rewrite: `src/modules/identity-registry/index.ts`

- [x] **Step 1: RED service tests を書く**

Cover initialize/open、template→preview→owner-approved apply、owner gate rejection、stable subjectRef export/reimport、no implicit delete、stale preview、alias add/remove、activate/deactivate、ambiguous formal lookup。

```ts
expect(() => service.applyPreview(preview.previewId, { ownerApproved: false })).toThrow(
  "owner_approval_required"
);
```

- [x] **Step 2: RED を確認する**

Run: `npx vitest run tests/identity-registry.test.ts`

Expected: old keyring/encrypted-preview API mismatch により FAIL。

- [x] **Step 3: service を実装する**

Service constructor/open path creates owner-only default directory/database, delegates persistence to store, computes workbook diff, generates `subjectRef` only for create rows, enforces owner approval, and records value-free generic audit events。

- [x] **Step 4: GREEN を確認する**

Run:

```bash
npx vitest run tests/identity-registry.test.ts tests/audit.test.ts
just typecheck
just lint
```

Expected: all PASS。

### Task 5: Owner CLI and module registration

**Files:**
- Create: `tests/roster-cli.test.ts`
- Create: `src/runtime/roster-cli.ts`
- Create: `scripts/roster.ts`
- Modify: `src/runtime/pico-cli.ts`
- Modify: `tests/pico-cli.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`
- Modify: `src/orchestrator/contracts.ts`
- Modify: `src/modules/audit/index.ts`
- Modify: `package.json`

- [x] **Step 1: RED CLI/routing tests を書く**

Assert documented roster commands、unknown option rejection、owner-approved mutation gate、bounded JSON result、`pico roster` routing、module metadata registration。

- [x] **Step 2: RED を確認する**

Run:

```bash
npx vitest run tests/roster-cli.test.ts tests/pico-cli.test.ts tests/extension.test.ts
```

Expected: missing CLI/registration により FAIL。

- [x] **Step 3: minimal CLI and registration を実装する**

CLI maps args to service methods and always closes service in `finally`。Audit category remains generic and has no import from identity-registry-specific validator。Add only ExcelJS to runtime dependencies。

- [x] **Step 4: GREEN を確認する**

Run:

```bash
npx vitest run tests/roster-cli.test.ts tests/pico-cli.test.ts tests/extension.test.ts tests/audit.test.ts
just typecheck
just lint
```

Expected: all PASS。

### Task 6: Dependency and inherited-file cleanup

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `TOOLS.md`
- Delete: obsolete identity-registry source/tests/scripts proven unused

- [x] **Step 1: dependency absence test を書く**

`tests/identity-registry-dependencies.test.ts` reads `package.json` and asserts ExcelJS remains while `@napi-rs/keyring`、`yauzl`、`@types/yauzl` are absent。

- [x] **Step 2: RED を確認する**

Run: `npx vitest run tests/identity-registry-dependencies.test.ts`

Expected: obsolete dependencies still present and FAIL。

- [x] **Step 3: dependency/file cleanup を実行する**

Remove obsolete packages with npm, remove keyring field script/command/tool notes, delete crypto/keyring/lifecycle/ZIP-specific tests, and retain only source/tests referenced by the approved design。

- [x] **Step 4: GREEN and ownership scan**

Run:

```bash
npx vitest run tests/identity-registry-dependencies.test.ts
rg -n "@napi-rs/keyring|yauzl|identity-registry-keyring|zip-preflight|encryptIdentityJson" . --glob '!node_modules/**' --glob '!docs/superpowers/plans/**' --glob '!docs/superpowers/specs/**'
git status --short
```

Expected: test PASS、runtime/reference hits 0、status contains only intended files。

### Task 7: Verification, scope review, and draft PR

**Files:**
- All changed files

- [x] **Step 1: format and focused tests**

Run:

```bash
just format
npx vitest run tests/identity-registry*.test.ts tests/roster-cli.test.ts tests/pico-cli.test.ts tests/audit.test.ts tests/extension.test.ts
```

Expected: all PASS。

- [x] **Step 2: full gates**

Run:

```bash
just check
git diff --name-only --diff-filter=ACMR -z origin/main...HEAD | xargs -0 npx --yes --package=secretlint@9.3.2 --package=@secretlint/secretlint-rule-preset-recommend@9.3.2 secretlint --secretlintrc=.secretlintrc.json
git diff --name-only --diff-filter=ACMR --cached -z | xargs -0 npx --yes --package=secretlint@9.3.2 --package=@secretlint/secretlint-rule-preset-recommend@9.3.2 secretlint --secretlintrc=.secretlintrc.json
git ls-files -m -o --exclude-standard -z | xargs -0 npx --yes --package=secretlint@9.3.2 --package=@secretlint/secretlint-rule-preset-recommend@9.3.2 secretlint --secretlintrc=.secretlintrc.json
npm audit --omit=dev
git diff --check
```

Expected: all exit 0。

- [x] **Step 3: PR scope review**

Review every inherited file with `git status --short`、`git diff --stat`、`rg` reference scans。Delete any file whose only responsibility was encryption、keyring、custom ZIP validation、or redundant test coverage。Re-run focused and full gates after deletions。

- [x] **Step 4: commit and draft PR**

Stage only intended changes, commit with a concise Conventional Commit message, push `codex/identity-registry-roster`, and create a draft PR containing scope、design reduction、tests、and deferred Privacy Filter work。
