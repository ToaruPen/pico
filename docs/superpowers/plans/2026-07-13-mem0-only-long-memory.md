# Mem0-only Long Memory Implementation Plan

**Goal:** Replace Pico's custom SQLite/FTS long-memory engine and durable worker queue with one Mem0 OSS write/search path while keeping facility-memory extraction and safety validation.

**Architecture:** The resident runtime synchronously hands each ended-session cutoff to a one-shot in-process worker. The worker uses the Pi model configured under `memory.mem0.worker`, validates 0–5 facility-memory drafts, and awaits Mem0 `add` calls with `infer:false`. `pico_memory_search` lazily creates the same scoped Mem0 provider and returns bounded untrusted results. Mem0/Qdrant/history are the only durable memory owners.

**Tech Stack:** TypeScript, Pi Agent SDK, Mem0 OSS, Qdrant, Vitest, TypeBox.

---

## Task 1: Collapse the configuration contract

**Files:** `src/config/index.ts`, `config/pico.example.yaml`, `tests/config.test.ts`, test fixtures.

- Add failing tests for `memory.mem0.worker`, required thinking level, arbitrary model pass-through, removed `infer`, and rejection of `memory.longMemory`.
- Remove long-memory config types/parser/path resolution.
- Replace Mem0 `llm` alternatives with a required Pi worker model configuration.
- Update the example without a Luna-specific contract.

## Task 2: Make Mem0 accept validated facility drafts

**Files:** `src/modules/long-memory/index.ts`, `extractor.ts`, `pi-extractor.ts`, `mem0.ts`, `mem0-runtime.ts`, new `worker.ts`, focused tests.

- Add failing tests for 0-draft no-op, 1–5 draft add, provenance metadata, fail-fast error propagation, and arbitrary model lookup.
- Reduce `index.ts` to facility-memory/cutoff contracts and structural high-risk rejection.
- Change the provider from raw transcript add to validated draft add.
- Force `infer:false` in the OSS client.
- Implement a one-shot worker that composes extractor and provider.

## Task 3: Replace SQLite search with Mem0 search

**Files:** `src/runtime/memory-tool.ts`, `tests/memory-tool.test.ts`, extension wiring tests.

- Add failing tests proving lazy Mem0 client/provider creation, scoped search, limit forwarding, bounded output, and no fallback.
- Replace SQLite store ownership with the Mem0 provider.
- Preserve untrusted-memory guidance, input bounds, output bounds, and redacted audit.

## Task 4: Connect the resident lifecycle

**Files:** `src/runtime/resident-voice-runner.ts`, `src/runtime/voice-resident.ts`, related tests.

- Change the memory worker contract to async `processCutoff`.
- Await extraction/add before acknowledging cutoff and disposing the Pi session.
- Surface failure and keep the cutoff unacknowledged.
- Build the extractor/provider once from `memory.mem0` during resident startup.

## Task 5: Delete the duplicate implementation

**Files:** old worker/store/scripts/tests, launchd, npm/Just targets, smoke/field harnesses, README/spec references.

- Delete custom SQLite/FTS/candidate/review/lifecycle/queue code and tests.
- Delete independent resident-memory service and field harnesses.
- Update milestone/smoke coverage to use Mem0-only operations.
- Run similarity/identifier searches to confirm no old owner remains.

## Task 6: Verify and publish

- Run focused tests after each Red/Green slice.
- Run `just format`, `just check`, and the repository-standard secretlint command against changed files.
- Run polishment, ai-slop-cleaner, and independent review; apply scoped findings.
- Commit, push `codex/mem0-only-memory`, create a draft PR referencing #96, then converge CI/review.
