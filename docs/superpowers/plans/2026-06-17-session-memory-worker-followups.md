# Session Memory Worker Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session-ended long-memory processing safe to run asynchronously while later sessions start and end, and wire the selected Mem0 model providers into the runtime.

**Architecture:** Keep session lifecycle, durable-memory storage, provider runtime, and field verification as separate boundaries. Ended sessions become immutable cutoff payloads; a worker owns enqueue/drain/recovery/backpressure around `long_memory_candidate_jobs`; Mem0 provider selection remains replaceable through config.

**Tech Stack:** TypeScript, SQLite via `node:sqlite`, Vitest, Pi Agent SDK, Mem0 OSS, Qdrant, local embedding sidecar, OTel audit exporter.

---

### Task 1: Codex Responses and Jina Provider Runtime

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/modules/long-memory/mem0-runtime.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/long-memory-mem0-runtime.test.ts`
- Create: `scripts/sidecars/jina-embedding-sidecar.py`
- Create: `scripts/smoke/embedding-sidecar.ts`
- Create: `tests/embedding-sidecar-smoke.test.ts`
- Modify: `package.json`
- Modify: `Justfile`
- Modify: `config/pico.example.yaml`

- [x] Add config union types for `memory.mem0.llm.provider: ollama | pi_model`.
- [x] Add config union types for `memory.mem0.embedder.provider: ollama | sidecar`.
- [x] Map `pi_model/openai-codex/openai-codex-responses` to a Langchain-compatible Mem0 LLM through Pi Agent SDK sessions.
- [x] Map sidecar embeddings to a Langchain-compatible Mem0 embedder against `/v1/embeddings`.
- [x] Add sidecar smoke coverage and example config.

### Task 2: Durable Session Memory Worker

**Files:**
- Modify: `src/modules/long-memory/index.ts`
- Create: `src/modules/long-memory/session-worker.ts`
- Create/modify: `tests/long-memory-session-worker.test.ts`
- Modify: `scripts/field/session-memory-lifecycle.ts`

- [x] Add a worker boundary that accepts ended session cutoff payloads and enqueues them without blocking live session handling.
- [x] Drain queued jobs sequentially by default.
- [x] Recover stuck `processing` jobs by lease age before draining.
- [x] Enforce queue depth backpressure as an explicit failure signal, not a silent fallback.
- [x] Emit structured audit events for enqueue, drain, recovery, backpressure, and processing outcomes.

### Task 3: Overlap and Field Evidence

**Files:**
- Modify: `tests/long-memory-candidates.test.ts`
- Modify: `tests/long-memory-session-worker.test.ts`
- Modify: `scripts/field/session-memory-lifecycle.ts`
- Modify: `tests/session-memory-lifecycle-field.test.ts`

- [x] Add a regression test where session A memory processing is in flight while session B starts, ends, enqueues, and both jobs drain exactly once.
- [x] Extend the field harness report with worker recovery/backpressure-safe evidence.
- [x] Verify OTel export includes memory lifecycle events.

### Task 4: Gates and PR

**Files:**
- Modify: docs and tests touched above only.

- [x] Run targeted tests for config, Mem0 runtime, candidate jobs, worker, and field harness.
- [x] Run `just check`.
- [x] Run field tests that are possible from the current machine; report skipped external dependencies explicitly.
- [x] Run independent review, `ai-slop-cleaner`, and verification.
- [ ] Open a Ready PR with verification evidence.
