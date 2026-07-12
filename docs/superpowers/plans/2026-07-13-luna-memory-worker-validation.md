# Luna Memory Worker Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the facility-memory extraction worker with `openai-codex/gpt-5.6-luna` at `high` thinking effort and prove the real worker can drain the configured queue once without installing a LaunchAgent or running retention/decay.

**Architecture:** Add an explicit startup-only `thinkingLevel` field to the existing long-memory extraction configuration and forward it unchanged to the existing no-tools, in-memory Pi extraction session. Keep the Pico conversation model independent at `gpt-5.6-sol / medium`. Validate with unit gates first, then back up the configured SQLite database and run `resident:memory --once` against the two queued production jobs.

**Tech Stack:** TypeScript 6, Node.js 24, Pi Agent SDK 0.80.6, YAML, SQLite, Vitest

**Specification:** `docs/superpowers/specs/2026-07-11-autonomous-long-memory-retrieval-design.md`

**Commit policy:** Repository instructions require explicit user permission before commits. This plan leaves all changes uncommitted.

---

## File Map

- `src/config/index.ts`: validate and freeze the extractor thinking level at the startup config boundary.
- `src/modules/long-memory/pi-extractor.ts`: forward the configured thinking level into the no-tools Pi session.
- `tests/config.test.ts`: fix the extraction config contract and invalid-value behavior.
- `tests/long-memory-extractor.test.ts`: use a non-production model sentinel to prove arbitrary configured model IDs and the configured thinking level reach the Pi session unchanged.
- Other long-memory test fixtures: add the newly required extraction field without changing behavior.
- `config/pico.example.yaml`: document Luna/high as the extraction worker configuration.
- `/Users/monsoon/Dev/pico/config/pico.local.yaml`: select Luna/high for the real local worker without changing the Pico conversation model.
- `docs/field-tests/2026-07-11-autonomous-long-memory-retrieval.md`: record the bounded one-shot validation result without raw conversation or memory content.

## State Boundary

1. **State being changed:** `memory.longMemory.extraction.thinkingLevel`, consumed by each short-lived Pi extraction session; the configured SQLite queue transitions for the one-shot field run.
2. **Lifecycle boundary:** `startup-only-immutable`. YAML is loaded and frozen before worker construction. A config change requires the next worker process start.
3. **Mutation path inventory:** YAML load and test fixtures are allowed. CLI hardcoding, environment override, hot reload, admin API, migration, and runtime assignment are forbidden. The field run may transition existing queued jobs through the repository-owned worker path.
4. **Consumer/invariant inventory:** config validator, example config, extractor session configuration, model registry resolution, unit tests, field report, SQLite queue status, audit exporter, shutdown drain.
5. **Central enforcement point:** `defineLongMemoryExtractionConfig()` validates the value once; `createPiModelFacilityMemoryExtractor()` passes the frozen config to `createAgentSession()`.
6. **Forbidden paths:** hardcoded extractor model/thinking level, hardcoded provider session ID, inheritance from `pico.model`, CLI model arguments, fallback model, LaunchAgent install/load, direct SQLite updates, retention/decay execution.
7. **Required tests:** valid `high`, missing/invalid field failure, frozen config, arbitrary model/thinking-level forwarding, Pi-owned in-memory session identity, model/API resolution, focused tests, full `just check`.
8. **Async ownership and terminal states:** `resident:memory --once` owns one drain until idle/degraded, waits for the in-flight extraction, records processed/retry/dead-letter through the existing repository transaction, closes SQLite, and shuts down the audit exporter before exit.

## Task 1: Add the extractor thinking-level config boundary

**Files:**

- Modify: `tests/config.test.ts`
- Modify: `src/config/index.ts`
- Modify: long-memory config fixtures under `tests/`

- [x] **Step 1: Write the failing configuration tests**

Add `thinkingLevel: "high"` to the accepted long-memory extraction example and expected frozen result. Add invalid and missing cases that require these errors:

```ts
"pico config memory.longMemory.extraction.thinkingLevel is required"
"pico config memory.longMemory.extraction.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max"
```

- [x] **Step 2: Run the config test and verify RED**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `thinkingLevel` is an unknown extraction field or is not validated.

- [x] **Step 3: Implement the minimal config contract**

Extend the extraction type and parser:

```ts
export type PicoLongMemoryExtractionConfig = {
  readonly provider: "pi_model";
  readonly piProvider: "openai-codex";
  readonly api: "openai-codex-responses";
  readonly model: string;
  readonly thinkingLevel: PicoAgentModelConfig["thinkingLevel"];
  readonly timeoutMs: number;
};
```

Use one shared validator for `pico.model.thinkingLevel` and `memory.longMemory.extraction.thinkingLevel`; do not add a default.

- [x] **Step 4: Update only affected test fixtures**

Add an explicit thinking level to every enabled `memory.longMemory.extraction` fixture. Do not change Mem0 LLM fixtures.

- [x] **Step 5: Verify GREEN and fixture ownership**

Run:

```bash
npm test -- tests/config.test.ts
npm run typecheck
rg -n "thinkingLevel: \"high\"" tests src config scripts
```

Expected: config tests and typecheck PASS; new literals appear only in the long-memory extractor config path and its tests/docs.

## Task 2: Forward configured model/thinking level to the Pi extraction session

**Files:**

- Modify: `tests/long-memory-extractor.test.ts`
- Modify: `src/modules/long-memory/pi-extractor.ts`
- Modify: `config/pico.example.yaml`

- [x] **Step 1: Write the failing forwarding test**

Use a non-production sentinel so the test proves pass-through rather than locking one model ID:

```ts
model: "test-extraction-model",
thinkingLevel: "high"
```

Require the captured `PiFacilityMemorySessionConfiguration` to contain the same model and thinking level.

- [x] **Step 2: Run the extractor test and verify RED**

Run:

```bash
npm test -- tests/long-memory-extractor.test.ts
```

Expected: FAIL because the extractor still forwards `thinkingLevel: "off"`.

- [x] **Step 3: Implement exact forwarding**

Change `PiFacilityMemorySessionConfiguration["thinkingLevel"]` to the shared config type and construct it with:

```ts
thinkingLevel: config.thinkingLevel
```

Keep `noTools: "all"`, in-memory session storage, disabled compaction, the fixed extraction cwd, Pi-owned session identity, and zero provider retries unchanged.

- [x] **Step 4: Update the tracked example**

Document:

```yaml
model: gpt-5.6-luna
thinkingLevel: high
```

- [x] **Step 5: Verify focused and full gates**

Run:

```bash
npm test -- tests/config.test.ts tests/long-memory-extractor.test.ts tests/resident-memory-script.test.ts
just check
```

Expected: all focused tests and the complete repository gate PASS.

## Task 3: Run the real one-shot Luna worker validation

**Files:**

- Modify: `/Users/monsoon/Dev/pico/config/pico.local.yaml`
- Modify: `docs/field-tests/2026-07-11-autonomous-long-memory-retrieval.md`

- [x] **Step 1: Preflight the model and queue without exposing content**

Run:

```bash
./node_modules/.bin/pi --list-models gpt-5.6-luna
sqlite3 -header -column /Users/monsoon/Dev/pico/.pico-local/mem0-history.sqlite \
  "SELECT status, count(*) AS count FROM long_memory_candidate_jobs GROUP BY status ORDER BY status;"
```

Expected: `openai-codex/gpt-5.6-luna` is available with thinking support; two queued jobs remain before the run.

- [x] **Step 2: Update local startup config and create a timestamped DB backup**

Change only the extraction model/thinking level in the untracked local YAML. Copy the SQLite database plus existing WAL/SHM companions, if present, to a timestamped backup directory:

```bash
backup_dir="/Users/monsoon/Dev/pico/.pico-local/backups/$(date +%Y%m%d-%H%M%S)-luna-worker"
mkdir -p "$backup_dir"
for source in \
  /Users/monsoon/Dev/pico/.pico-local/mem0-history.sqlite \
  /Users/monsoon/Dev/pico/.pico-local/mem0-history.sqlite-wal \
  /Users/monsoon/Dev/pico/.pico-local/mem0-history.sqlite-shm; do
  if test -f "$source"; then cp -p "$source" "$backup_dir/"; fi
done
```

- [x] **Step 3: Start a temporary loopback OTel Collector**

Run the already-available official `otel/opentelemetry-collector:0.154.0` image with an OTLP HTTP receiver bound to loopback and a debug exporter. Validate readiness before starting the worker. Remove the container after the worker exits.

- [x] **Step 4: Run the configured worker once**

Run:

```bash
PICO_CONFIG_PATH=/Users/monsoon/Dev/pico/config/pico.local.yaml \
npm run resident:memory -- --once
```

Expected: one bounded JSON status report, no raw conversation/model output, successful audit delivery, and process exit after the drain reaches idle or a deterministic degraded retry state.

- [x] **Step 5: Verify post-run state without reading memory content**

Query status counts, active memory count, provenance count, observation count, and event kinds only. Confirm no LaunchAgent was installed or loaded and no lifecycle event has kind `archive` or `delete` from this validation.

- [x] **Step 6: Record evidence and run the final verification gate**

Append the model, thinking level, before/after bounded counts, duration, worker report, and LaunchAgent/decay exclusions to the field report. Do not record source text, memory title/body, query, raw model output, device identifier, or credentials.

Run:

```bash
git diff --check
just check
```

Expected: clean diff check and complete repository gate PASS.
