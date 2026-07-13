# Autonomous Long-Memory Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** session cutoff から抽出した施設記憶を SQLite 正本へ安全に自動保存し、通常 Pi session と resident voice の両方から `pico_memory_search` で自発的に検索できるようにする。

**Architecture:** resident voice は cutoff を SQLite queue へ enqueue するだけとし、別 process の memory worker が no-tools Pi model session で構造化抽出して active memory を transactionally 保存する。検索 tool は SQLite の active entry だけを bounded に返し、Mem0/Qdrant はこの first slice の必須経路から外す。

**Tech Stack:** TypeScript 6, Node.js 24 `node:sqlite`, Pi Agent SDK, TypeBox, Vitest, launchd, ast-grep, Biome, ESLint

**Specification:** `docs/superpowers/specs/2026-07-11-autonomous-long-memory-retrieval-design.md`

**Commit policy:** Repository instructions require explicit user permission before commits. This plan intentionally leaves changes uncommitted and PR-ready.

---

## File Map

- `src/config/index.ts`: immutable `memory.longMemory` configuration and validation.
- `src/modules/long-memory/index.ts`: schema migration, provenance, automated writes, bounded active search, queue lifecycle.
- `src/modules/long-memory/extractor.ts`: structured facility-memory contract and structural-field validation.
- `src/modules/long-memory/pi-extractor.ts`: no-tools Pi model invocation for extraction.
- `src/runtime/resident-memory-worker.ts`: queue drain orchestration using the extractor and SQLite store.
- `src/runtime/memory-tool.ts`: bounded read-only Pi tool and lazy retrieval service lifecycle.
- `src/index.ts`: shared tool registration plus shutdown cleanup.
- `src/runtime/pi-agent-turn.ts`: resident exact allowlist.
- `src/runtime/resident-launchd.ts`: voice/memory service definitions and secret-safe status formatting.
- `scripts/resident/memory.ts`: production worker entrypoint.
- `scripts/resident/launchd.ts`: service-aware launchd CLI.
- `scripts/field/session-memory-retrieval.ts`: real cutoff-to-later-session field validation.
- `config/pico.example.yaml`, `README.md`, `package.json`, `Justfile`: operator contract.

## Task 1: Add the long-memory configuration boundary

Implementation status: completed and verified on 2026-07-12.

**Files:**

- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`

- [x] **Step 1: Write failing configuration tests**

Add tests proving the new section is immutable, disabled by default, and rejects partial or unknown provider configuration.

```ts
it("defines explicit long-memory SQLite and Pi extraction config", () => {
  const config = definePicoConfig({
    memory: {
      longMemory: {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      }
    }
  });

  expect(config.memory.longMemory).toEqual({
    enabled: true,
    databasePath: "/var/lib/pico/long-memory.sqlite",
    extraction: {
      provider: "pi_model",
      piProvider: "openai-codex",
      api: "openai-codex-responses",
      model: "gpt-5.4",
      thinkingLevel: "high",
      timeoutMs: 60_000
    }
  });
  expect(Object.isFrozen(config.memory.longMemory)).toBe(true);
});

it("defaults long memory to disabled", () => {
  expect(definePicoConfig({}).memory.longMemory).toEqual({ enabled: false });
});
```

Also add failures for missing `databasePath`, missing `extraction`, wrong provider/API, empty model, non-positive timeout, and unknown keys.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `memory.longMemory` is absent.

- [x] **Step 3: Implement the immutable config type and parser**

Add these contracts and route them through `defineMemorySection`:

```ts
export type PicoLongMemoryConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly databasePath: string;
      readonly extraction: PicoLongMemoryExtractionConfig;
    };

export type PicoLongMemoryExtractionConfig = {
  readonly provider: "pi_model";
  readonly piProvider: "openai-codex";
  readonly api: "openai-codex-responses";
  readonly model: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly timeoutMs: number;
};
```

`memory.mem0` remains optional and independent. Do not infer `longMemory` from `mem0`, and do not add a fallback priority.

- [x] **Step 4: Update the tracked example**

Add a `memory.longMemory` section using the existing local database path and Pi model values. Keep `memory.mem0` documented as optional secondary indexing and disabled in the first retrieval slice.

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm test -- tests/config.test.ts
npm run typecheck
```

Expected: focused tests and typecheck PASS.

## Task 2: Add honest provenance, automated writes, and bounded retrieval

Implementation status: completed and verified on 2026-07-12.

**Files:**

- Modify: `src/modules/long-memory/index.ts`
- Modify: `tests/long-memory.test.ts`

- [x] **Step 1: Write failing provenance and migration tests**

Cover a legacy reviewed database, a new automated entry, exact duplicate suppression, and active-only bounded search.

```ts
it("migrates reviewed entries and writes automated memories without a fake reviewer", () => {
  const store = openLongMemoryStore(path, { now: () => "2026-07-11T00:00:00.000Z" });
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
});
```

Add a test that a second `writeAutomated` with the same normalized title/body/category returns the existing active row and creates an observation without a duplicate entry.

Add a search test proving `searchActive({ query, limit: 2 })`:

- applies the limit before access updates;
- returns body and provenance;
- excludes archived, superseded, deleted, pending, and rejected rows;
- updates access metadata only for the returned rows.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/long-memory.test.ts
```

Expected: FAIL because automated provenance and bounded full-record search do not exist.

- [x] **Step 3: Add provenance and automated input contracts**

```ts
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
```

Extend `LongMemoryRecord` with `provenance` and make `review` optional. Preserve existing reviewed behavior.

- [x] **Step 4: Centralize SQLite opening and schema migration**

All long-memory openers must call one initialization boundary that enables:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Migrate legacy reviewed rows to `origin_kind='staff_review'`. Add origin policy/source columns, a non-empty partial unique index for automated fingerprints, and an observation table. Automated rows store empty reviewed columns but map to `review: undefined`; never synthesize a reviewer.

- [x] **Step 5: Implement transactional automated writes**

Normalize title/body/category, reject structurally explicit child-profile fields, and calculate:

```ts
createHash("sha256")
  .update([policyVersion, category, normalizedTitle, normalizedBody].join("\u0000"))
  .digest("hex");
```

Insert a new active row plus observation transactionally. On duplicate fingerprint, return the existing active row and insert only a new observation.

- [x] **Step 6: Implement SQL-level bounded active search**

Add:

```ts
readonly searchActive: (input: {
  readonly query: string;
  readonly limit: number;
}) => readonly LongMemoryRecord[];
```

The SQL selects `active` FTS matches with `LIMIT ?`; only selected IDs receive access updates. Do not fetch all matches and slice in TypeScript.

- [x] **Step 7: Verify GREEN and migration safety**

Run:

```bash
npm test -- tests/long-memory.test.ts tests/long-memory-candidates.test.ts
npm run typecheck
```

Expected: migration, legacy lifecycle, automated write, deduplication, and bounded search tests PASS.

## Task 3: Make queue retries and terminal states durable

Implementation status: completed and verified on 2026-07-12.

**Files:**

- Modify: `src/modules/long-memory/index.ts`
- Modify: `src/modules/long-memory/session-worker.ts`
- Modify: `tests/long-memory-candidates.test.ts`
- Modify: `tests/long-memory-session-worker.test.ts`

- [x] **Step 1: Write failing retry/dead-letter tests**

Use deterministic timestamps. Cover:

```ts
expect(jobAfterFirstFailure).toMatchObject({
  status: "queued",
  attemptCount: 1,
  nextAttemptAt: "2026-07-11T00:00:30.000Z",
  lastErrorCode: "extraction_failed"
});
```

Then prove the second delay is two minutes, the third failure becomes `dead_letter`, a permanent policy error immediately becomes `dead_letter` with scrubbed payload, stale `processing` recovery preserves attempt count, and expired dead-letter payloads are purged.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/long-memory-candidates.test.ts tests/long-memory-session-worker.test.ts
```

Expected: FAIL because current failures become terminal `failed` rows without retries.

- [x] **Step 3: Define the job state and error classification contract**

```ts
export type SessionMemoryCandidateJobStatus =
  | "queued"
  | "processing"
  | "processed"
  | "dead_letter";

export class PermanentMemoryPolicyError extends Error {
  readonly code = "policy_violation";
}
```

Persist `attempt_count`, `next_attempt_at`, `last_error_code`, `dead_lettered_at`, and `purge_after`. Error codes are fixed values; raw exception messages are forbidden.

- [x] **Step 4: Implement eligible claim and bounded transitions**

Claim only `queued` rows whose `next_attempt_at` is empty or due. Increment attempts on claim. Retry delays are `[30_000, 120_000]`; the third failed attempt dead-letters. Permanent policy failures dead-letter and scrub in the same transaction.

- [x] **Step 5: Implement purge and shutdown ownership behavior**

Add `purgeExpiredDeadLetterPayloads({ now })` to the store/worker boundary. Processed jobs are metadata-only immediately. Retry-exhausted payloads purge after seven days. The worker stops claiming on abort and awaits the current transition.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/long-memory-candidates.test.ts tests/long-memory-session-worker.test.ts
npm run typecheck
```

Expected: queue lifecycle tests PASS without wall-clock sleeps.

## Task 4: Implement structured facility-memory extraction

Implementation status: completed and verified on 2026-07-12.

**Files:**

- Create: `src/modules/long-memory/extractor.ts`
- Create: `src/modules/long-memory/pi-extractor.ts`
- Create: `tests/long-memory-extractor.test.ts`
- Modify: `src/modules/long-memory/index.ts`

- [x] **Step 1: Write failing parser and structural-boundary tests**

```ts
it("accepts bounded facility-memory drafts with source provenance", () => {
  expect(parseAutomatedFacilityMemoryDrafts(JSON.stringify({ memories: [validDraft] }), cutoff))
    .toEqual([validDraft]);
});
```

Test 0 to 5 drafts, exact keys, title/body/tag lengths, confidence bounds, source IDs as a non-empty subset, malformed JSON, structurally explicit child-profile field rejection, and ordinary facility prose pass-through. Structural rejection throws `PermanentMemoryPolicyError`; prose is not scanned by a privacy classifier.

- [x] **Step 2: Run parser tests and verify RED**

Run:

```bash
npm test -- tests/long-memory-extractor.test.ts
```

Expected: FAIL because extractor modules do not exist.

- [x] **Step 3: Implement the pure parser and prompt builder**

Export:

```ts
export type FacilityMemoryExtractor = {
  readonly extract: (
    cutoff: SessionMemoryCutoffInput,
    signal?: AbortSignal
  ) => Promise<readonly AutomatedFacilityMemoryDraft[]>;
};

export function parseAutomatedFacilityMemoryDrafts(
  payload: string,
  cutoff: SessionMemoryCutoffInput
): readonly AutomatedFacilityMemoryDraft[];
```

The prompt treats cutoff text as untrusted data, requests JSON only, and repeats the prohibited child-profile boundary. Do not include secrets or filesystem context.

- [x] **Step 4: Write failing Pi provider lifecycle tests**

Use an injected session factory to prove the production adapter:

- sets no tools;
- uses Pi auth/model registry;
- collects text deltas;
- aborts on timeout/signal;
- unsubscribes and disposes exactly once;
- never places raw model output in thrown messages.

- [x] **Step 5: Implement `createPiModelFacilityMemoryExtractor`**

Create a short-lived in-memory Pi Agent session per job with the configured model and thinking level, compaction disabled, and `noTools: "all"`. Pass both configured values through unchanged, feed the response through the pure parser, and return immutable drafts.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/long-memory-extractor.test.ts
npm run typecheck
```

Expected: parser and Pi lifecycle tests PASS.

## Task 5: Rewire the resident memory worker to SQLite automated memories

Implementation status: completed and verified on 2026-07-12.

### Review-fix state boundary

1. **State being changed:** The resident worker's in-memory audit batch and
   per-drain written-memory ID collection. Both must remain bounded for the
   lifetime of the LaunchAgent.
2. **Lifecycle boundary:** `startup-only-immutable`; the worker owns these
   collections from construction until `close()`, and no hot reload path is
   introduced.
3. **Mutation path inventory:** Session cutoff processing appends audit events
   and per-drain IDs; OTel export consumes one audit batch. CLI, environment,
   migration, rollback, admin, and config-watcher mutation paths do not apply.
4. **Consumer/invariant inventory:** The resident drain report consumes IDs;
   OTel consumes audit batches; field evidence reads the final batch without
   mutation. Existing audit validation and SQLite persistence remain unchanged.
5. **Central enforcement point:** `StructuredAuditLog.drain()` is the only
   destructive audit read, and `ResidentMemoryDrainWorker.drainUntilIdle()`
   owns the only report-scoped ID set.
6. **Forbidden paths:** Do not retain exported audit history, raw exporter
   errors, provider payloads, or memory IDs beyond their drain report. Do not
   let callers mutate audit arrays directly.
7. **Required tests:** Draining audit entries empties the buffer; exporter
   failures expose only a fixed code; scheduled retries remain degraded between
   attempts; existing sequential drain tests lock report behavior.
8. **Async ownership and terminal states:** The resident loop owns export and
   discards each drained best-effort batch after one export attempt. The worker
   clears report-scoped IDs in `finally`; `close()` owns SQLite shutdown.

**Files:**

- Modify: `src/runtime/resident-memory-worker.ts`
- Modify: `scripts/resident/memory.ts`
- Modify: `tests/resident-memory-worker.test.ts`
- Modify: `tests/session-memory-lifecycle-field.test.ts`
- Modify: `scripts/field/session-memory-lifecycle.ts`

- [x] **Step 1: Write failing worker tests**

Prove that one cutoff produces automated active memories, an empty extraction succeeds with zero memories, duplicate drafts do not duplicate entries, retry/dead-letter reports are exposed, and close releases all stores.

```ts
const report = await worker.drainUntilIdle();
expect(report).toMatchObject({
  processedCount: 1,
  memoryWrittenCount: 1,
  deadLetterCount: 0,
  idle: true
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/resident-memory-worker.test.ts tests/session-memory-lifecycle-field.test.ts
```

Expected: FAIL because the worker currently requires Mem0 and writes no active SQLite memory.

- [x] **Step 3: Replace the Mem0 worker dependency with `FacilityMemoryExtractor`**

Change worker options to:

```ts
type ResidentMemoryDrainWorkerOptions = {
  readonly databasePath: string;
  readonly extractor: FacilityMemoryExtractor;
  readonly audit?: StructuredAuditLog;
  readonly now?: () => string;
};
```

The queue/store boundary validates drafts, writes automated entries, and returns counts. Remove the runtime dependency on `resident_mem0_session_writes`; do not delete the legacy table during migration.

- [x] **Step 4: Update the production script**

Read `memory.longMemory`, create the Pi extractor, create the drain worker, recover stale jobs, purge expired dead-letter payloads, and poll with concurrency 1. Disabled config must produce a clear startup failure before opening the DB.

- [x] **Step 5: Update the existing field lifecycle harness**

The deterministic harness must assert `activeMemoryCount >= 1` and provenance kind `session_cutoff_automation`; remove Mem0 as required completion evidence for this first slice.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/resident-memory-worker.test.ts tests/session-memory-lifecycle-field.test.ts
npm run typecheck
```

Expected: worker and updated field-contract tests PASS.

## Task 6A: Replace runtime profiles with explicit Pico startup

Privacy Filter、可逆マスキング、fine-tune、仮 adapter/interface/fallback/placeholder は今回の
scope に含めない。通常 Pi と Pico は同時に動作し、Pi 設定が camera/StackChan の tool
可視性を所有する。Pico は agent allowlist を複製・再検証しない。

**Files:**

- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Create: `src/runtime/pico-startup.ts`
- Delete: `src/runtime/pico-runtime-profile.ts`
- Modify: `src/index.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `src/runtime/pico-cli.ts`
- Modify: `scripts/pico.ts`
- Delete: `tests/pico-runtime-profile.test.ts`
- Create: `tests/pico-startup.test.ts`
- Modify: `tests/pico-cli.test.ts`
- Modify: `tests/extension.test.ts`
- Modify: `tests/pi-agent-turn.test.ts`
- Modify: `README.md`

- [x] **Step 1: Write failing config and startup tests**

Prove `pico.model.provider/id/thinkingLevel` parsing, normal Pi no-op behavior, exact YAML model
selection for `--pico`, no fallback, controller start-after-model, and idempotent shutdown.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/config.test.ts tests/pico-startup.test.ts tests/pico-cli.test.ts
```

Expected: FAIL because `pico.model`, `--pico`, and production `pico` launch planning do not exist.

- [x] **Step 3: Add startup-only Pico model config**

Add required-on-Pico-startup model fields:

```ts
type PicoAgentModelConfig = {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
```

Normal config parsing may omit `pico.model`; `--pico` must fail closed when it is missing.

- [x] **Step 4: Replace runtime profile enforcement with `--pico` startup**

Register one boolean flag. When false, do not change model/tools or create a controller. When true,
load config, resolve the exact model through `context.modelRegistry`, call `pi.setModel`, set thinking
level, then start one controller. Remove worker/interactive filtering and all profile unions.
Rename the camera-only `toolProfile` option to `perceptionMode`; this remains an implementation
selector for standard versus resident-deferred perception tools, not a startup or memory profile.

- [x] **Step 5: Make `pico` a thin production launcher**

An empty `pico` invocation plans the local Pi executable with `--pico`; it must not append
`--provider` or `--model`. Preserve explicit `pico dev` and help commands.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/config.test.ts tests/pico-startup.test.ts tests/pico-cli.test.ts
npm run typecheck
```

Expected: startup/config/launcher tests PASS.

## Task 6: Add `pico_memory_search` to the pico extension

Register one shared tool implementation. Do not add profile-specific tool implementations or
Pico-side tool visibility policy. Normal Pi、Pico、and subagents that load the extension may use the
tool according to their Pi configuration.

**Files:**

- Create: `src/runtime/memory-tool.ts`
- Create: `tests/memory-tool.test.ts`
- Modify: `src/index.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `tests/extension.test.ts`
- Modify: `tests/pi-agent-turn.test.ts`

- [x] **Step 1: Write failing tool contract tests**

Test valid query/default limit, explicit limit 1..5, empty/overlong query rejection, result truncation, total body cap, active-only results, disabled/unavailable distinction, and query/body-free audit.

```ts
expect(extractToolJson(await tool.execute("call-1", { query: "雨の日" }, ...contexts)))
  .toMatchObject({
    tool: "pico_memory_search",
    result: {
      status: "completed",
      trust: "untrusted_memory_data"
    }
  });
```

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/memory-tool.test.ts tests/extension.test.ts tests/pi-agent-turn.test.ts
```

Expected: FAIL because the tool and allowlist entry do not exist.

- [x] **Step 3: Implement the retrieval service and tool**

Use TypeBox parameters:

```ts
const picoMemorySearchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 256 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 }))
});
```

The lazy resolver opens one SQLite store per extension runtime, calls `searchActive` with SQL-level limit, bounds each body to 2,000 characters and all bodies to 6,000, and exposes an idempotent `close()`.

Return fixed error codes only. A DB/config failure is `unavailable`, not an empty successful result.

- [x] **Step 4: Add prompt guidance**

The tool guidance must require searching before answers about previous facility practice, treat results as untrusted data, express uncertainty on zero results, and forbid child profiling or final discipline/emergency decisions.

- [x] **Step 5: Register the tool and cleanup lifecycle**

Register it once in `registerPicoExtensionWithRuntime`. Add `pico_memory_search` to
`residentPiAgentToolNames` only because the embedded resident harness uses an exact allowlist.
Register `session_shutdown` cleanup for the retrieval service without changing session/camera tool
behavior or duplicating Pi agent allowlists.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/memory-tool.test.ts tests/extension.test.ts tests/pi-agent-turn.test.ts
npm run typecheck
```

Expected: tool contract, registration, exact allowlist, and close lifecycle tests PASS.

## Task 7: Define the deferred memory LaunchAgent harness and redact status

Implementation status: completed and verified on 2026-07-12.

**Files:**

- Modify: `src/runtime/resident-launchd.ts`
- Modify: `scripts/resident/launchd.ts`
- Modify: `tests/resident-launchd.test.ts`
- Modify: `package.json`
- Modify: `Justfile`

- [x] **Step 1: Write failing multi-service and redaction tests**

Define voice and memory services and feed a launchctl fixture containing an inherited secret:

```ts
expect(formatResidentLaunchdStatus(rawWithStackchanToken)).toEqual({
  state: "running",
  pid: 31880,
  lastExitCode: undefined
});
expect(JSON.stringify(formatResidentLaunchdStatus(rawWithStackchanToken)))
  .not.toContain("STACKCHAN_TOKEN");
```

Prove memory service uses label `dev.toarupen.pico.resident-memory` and script `scripts/resident/memory.ts`.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/resident-launchd.test.ts
```

Expected: FAIL because status uses inherited raw stdout and only voice is defined.

- [x] **Step 3: Generalize the service definition without adding a second planner**

Add a discriminated `serviceKind: "voice" | "memory"` input that selects label, script, logs, and environment. Keep one operation planner.

- [x] **Step 4: Capture and sanitize status output**

Status execution must use piped stdout, parse only state/PID/last exit, and JSON-print the allowlisted object. Memory status may additionally read the SQLite queue and report only queue depth, oldest queued-job age, and dead-letter count. Other launchctl operations may inherit stdio. Never output environment, arguments, paths, tokens, raw payloads, or job contents.

- [x] **Step 5: Add operator commands**

Add:

```json
"resident:memory:launchd": "jiti scripts/resident/launchd.ts --service=memory"
```

and Just recipes `memory-status` and `memory-stop`. Preserve existing voice commands. Keep the
memory service definition and sanitized status for field inspection, but reject `install`, `start`,
and `restart` until Pico startup owns the memory-worker lifecycle.

- [x] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/resident-launchd.test.ts tests/justfile.test.ts
npm run typecheck
```

Expected: multi-service planning and secret-safe status tests PASS.

## Task 8: Document and field-validate the completed path

Tasks 1 through 6 must be complete before this field-validation task. Privacy Filter is explicitly
outside this slice.

**Files:**

- Create: `scripts/field/session-memory-retrieval.ts`
- Create: `tests/session-memory-retrieval-field.test.ts`
- Modify: `package.json`
- Modify: `Justfile`
- Modify: `README.md`
- Modify: `docs/field-tests/README.md`
- Modify: `docs/superpowers/specs/2026-07-11-autonomous-long-memory-retrieval-design.md`

- [x] **Step 1: Write a failing field-harness contract test**

The harness must refuse to pass unless it observes:

- one entry-bearing cutoff;
- one processed worker job;
- at least one automated active SQLite memory;
- a separate Pi extension session invoking `pico_memory_search`;
- a returned memory with matching provenance;
- audit output without query/body text.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/session-memory-retrieval-field.test.ts
```

Expected: FAIL because the field harness does not exist.

- [x] **Step 3: Implement the field harness and commands**

Add `field:session-memory-retrieval` and a matching Just recipe. Require an explicit live-run environment gate before calling a real model. Print IDs, counts, durations, and status only; never print cutoff text, query text, memory body, or credentials.

- [x] **Step 4: Update operator documentation**

Document:

- `memory.longMemory` migration;
- memory LaunchAgent lifecycle;
- sanitized status output;
- worker retry/dead-letter behavior;
- `pico_memory_search` availability;
- token rotation prerequisite;
- Mem0/Qdrant not required for first-slice retrieval;
- remaining speaker-authority, handoff, and log-retention risks.

Set the design document status to `Implemented` only after the deterministic and field gates pass.

- [x] **Step 5: Run focused deterministic gates; full gate is repeated in final review**

Run:

```bash
npm test -- tests/session-memory-retrieval-field.test.ts
just check
```

Expected: all Swift, typecheck, lint, ast-grep, format, and Vitest gates PASS.

- [x] **Step 6: Run the real field gate when configured providers are ready**

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL=1 \
npm run field:session-memory-retrieval
```

Expected: JSON status `passed` with non-zero automated memory and retrieval counts, without raw text.

- [x] **Step 7: Record field evidence**

Create `docs/field-tests/2026-07-11-autonomous-long-memory-retrieval.md` containing environment versions, redacted config path, exact command, counts/durations, PASS/FAIL, and follow-up issue references. Do not include raw conversation, query, memory body, device identifiers, or secrets.

## Final Review And PR-Ready Gate

- [x] Review the complete diff against every acceptance criterion in the specification.
- [x] Run an independent spec-compliance review and resolve all findings.
- [x] Run an independent code-quality/security review and resolve all findings.
- [x] Run one behavior-preserving simplify pass on changed files.
- [x] Re-run `just check` after cleanup.
- [x] Confirm `git diff --check`, no secret values in changed files, no generated artifacts, and no unrelated changes.
- [x] Leave the branch uncommitted unless the user explicitly requests commit/push/PR creation.
