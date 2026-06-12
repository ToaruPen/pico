# Mem0 Memory Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first local-only Mem0-backed long-memory slice for pico.

**Architecture:** Pico remains the lifecycle owner: YAML validates local-only providers, SQLite owns review/provenance/decay metadata, and Mem0 is accessed through a narrow injected adapter. This first slice avoids real network integration by defining the adapter boundary and deterministic session-cutoff mapping.

**Tech Stack:** TypeScript strict ESM, Vitest, YAML config, SQLite long-memory module, Mem0 OSS-compatible client contract.

---

### Task 1: Local Mem0 Config Boundary

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`

- [ ] **Step 1: Write failing config tests**

Add tests that expect `definePicoConfig()` to parse:

```yaml
memory:
  mem0:
    enabled: true
    historyDbPath: /var/lib/pico/mem0-history.sqlite
    vectorStore:
      provider: qdrant
      localBaseUrl: http://127.0.0.1:6333
      collectionName: pico_long_memory
    llm:
      provider: ollama
      localBaseUrl: http://127.0.0.1:11434
      model: qwen3.5:9b
    embedder:
      provider: ollama
      localBaseUrl: http://127.0.0.1:11434
      model: nomic-embed-text
```

Also add tests that reject `provider: openai`, non-loopback URLs, empty collection names, and missing model names.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run test -- tests/config.test.ts
```

Expected: FAIL because `memory.mem0` is absent from `PicoConfig`.

- [ ] **Step 3: Implement minimal config parser**

Add `PicoMem0Config`, `PicoMem0VectorStoreConfig`, `PicoMem0ModelConfig`, defaults with `enabled: false`, and local-only validation using the existing URL validation helpers generalized away from vision-specific error text.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test -- tests/config.test.ts
```

Expected: PASS.

### Task 2: Mem0 Adapter Contract and Cutoff Mapping

**Files:**
- Create: `src/modules/long-memory/mem0.ts`
- Modify: `src/modules/long-memory/index.ts`
- Create: `tests/long-memory-mem0.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add tests for:

```typescript
createMem0MemoryProvider({ client, now }).addSessionCutoff(cutoff)
```

Expected behavior:
- Maps session entries to Mem0 messages with role/content only.
- Sends metadata with `source_session_id`, `source_entry_ids`, and `cutoff_at`.
- Does not include raw transcript in audit attributes.
- Rejects child profiling/scoring/tracking text before calling the client.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run test -- tests/long-memory-mem0.test.ts
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement minimal adapter**

Define a narrow `Mem0Client` interface with `add`, `search`, and `delete`. Implement `createMem0MemoryProvider()` using an injected client only; do not instantiate `mem0ai/oss` in this slice.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test -- tests/long-memory-mem0.test.ts
```

Expected: PASS.

### Task 3: Quality Gate and PR

**Files:**
- Modify only files touched by Tasks 1-2.

- [ ] **Step 1: Run full gate**

Run:

```bash
just check
```

Expected: PASS.

- [ ] **Step 2: Clean and review**

Run targeted searches for new public identifiers:

```bash
rg "PicoMem0|Mem0Memory|source_session_id|pico.memory.mem0" src tests config
```

Expected: identifiers appear only in config and long-memory ownership boundaries.

- [ ] **Step 3: Commit and open stacked PR**

Commit the #46 slice and open a PR targeting `feat/session-lifecycle-timed-end` unless #50 has merged by then.

```bash
git add .
git commit -m "Add local Mem0 memory stack boundary"
gh pr create --base feat/session-lifecycle-timed-end --title "Add local Mem0 memory stack boundary" --body "Refs #46"
```
