# Bounded Resident Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound resident diagnostic disk and heap use while retaining actionable health and stage metadata.

**Architecture:** High-frequency healthy signals are reduced before audit fanout. Resident audit validates without retaining. A resident-owned asynchronous FIFO writes only to a managed daily root with a fixed per-mode total cap; legacy paths remain untouched.

**Tech Stack:** TypeScript, Node.js filesystem promises, Vitest, OpenTelemetry audit boundary, strict ESLint, ast-grep, Biome

---

### Task 1: Add non-retaining structured audit mode

**Files:**
- Modify: `src/modules/audit/index.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Test: `tests/audit.test.ts`
- Test: `tests/resident-voice-audit-log.test.ts`

- [ ] **Step 1: Write the failing audit behavior tests**

Add a test that records a valid event through `createStructuredAuditLog({ retainEntries: false })`, asserts the returned event is normalized, and asserts `entries()` and `drain()` stay empty. Add a resident audit test that records many events, verifies the sink received all of them, and verifies resident entries remain empty.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/audit.test.ts tests/resident-voice-audit-log.test.ts`

Expected: failure because the audit constructor has no non-retaining option.

- [ ] **Step 3: Implement minimal optional retention**

Use a default-preserving option:

```ts
export type StructuredAuditLogOptions = {
  readonly retainEntries?: boolean;
};

export function createStructuredAuditLog(
  options: StructuredAuditLogOptions = {}
): DrainableStructuredAuditLog
```

Normalize every event, but push only when `retainEntries !== false`. Construct resident audit with `retainEntries: false`.

- [ ] **Step 4: Verify Green and commit**

Run: `npx vitest run tests/audit.test.ts tests/resident-voice-audit-log.test.ts`

Expected: all tests pass and default callers still retain.

Commit: `fix: stop retaining resident audit events`

### Task 2: Reduce healthy health publication and disable speech-gate persistence

**Files:**
- Create: `src/runtime/resident-health-publication.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Create: `tests/resident-health-publication.test.ts`
- Modify: `tests/voice-stage-probe.test.ts`

- [ ] **Step 1: Write failing deterministic health cadence tests**

Use an injected monotonic clock. Assert the gate publishes the initial state, suppresses repeated healthy samples before 60 seconds, publishes one aggregate at 60 seconds, and immediately publishes non-running state or restart-count changes. Normal dropped-frame counter growth alone must not bypass the 60-second cadence.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/resident-health-publication.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the minimal gate**

Expose one stateful decision function with no timers:

```ts
export type ResidentHealthEvent = Extract<ResidentIoMessage, { kind: "health_event" }>;

export type ResidentHealthPublicationGate = {
  readonly accept: (event: ResidentHealthEvent, nowMs: number) => boolean;
};
```

The existing health callback calls it and only writes process/audit/telemetry when accepted.

- [ ] **Step 4: Lock speech-gate persistence off**

Change the policy to `speech_gate: { persisted: false, summary: false }` and assert successful or suppressed speech-gate events are not selected for file persistence.

- [ ] **Step 5: Verify Green and commit**

Run: `npx vitest run tests/resident-health-publication.test.ts tests/voice-stage-probe.test.ts tests/resident-voice-runner.test.ts`

Expected: all focused tests pass.

Commit: `fix: reduce resident health persistence`

### Task 3: Replace synchronous legacy-path writes with a bounded managed writer

**Files:**
- Rewrite within scope: `src/runtime/resident-voice-log-files.ts`
- Test: `tests/resident-voice-log-files.test.ts`

- [ ] **Step 1: Write failing managed-path and rollover tests**

Assert new paths contain `/.pico/resident-voice/managed/<mode>/`, process and metrics records use their current/occurred day, and a writer that crosses UTC midnight writes to two day paths without restart.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/resident-voice-log-files.test.ts`

Expected: path assertions fail because current process/metrics paths are run-start scoped and outside `managed`.

- [ ] **Step 3: Introduce the asynchronous sink lifecycle**

Return the existing record methods plus:

```ts
readonly ready: Promise<void>;
readonly flush: () => Promise<void>;
readonly close: () => Promise<void>;
readonly droppedRecordCount: () => number;
```

Enqueue immutable `{ path, content }` records in FIFO order. Track queued UTF-8 bytes and reject the newest enqueue above the fixed 1 MiB queue bound.

- [ ] **Step 4: Write and pass queue tests**

Use a real temporary directory and a controllable filesystem-operation barrier. Assert FIFO order, newest-record drop on overflow, content-free dropped count, and `close()` draining accepted records.

- [ ] **Step 5: Write failing capacity and safety tests**

Populate recognized managed files with deterministic mtimes. Assert oldest closed files are removed to satisfy a fixed 128 MiB mode cap, active run files are retained, unknown files are not removed, a symlinked managed root rejects `ready`, and a no-follow target cannot be opened.

- [ ] **Step 6: Implement fixed managed capacity**

Inventory only recognized regular files within the selected managed mode root. Prune oldest closed files when capacity is required. If capacity remains unavailable, drop the new record and emit one bounded diagnostic through an injected `onDiagnostic` callback. Do not add YAML options.

- [ ] **Step 7: Write failing legacy-isolation test and implement warning**

Create a legacy file outside `managed`, start and close the sink, and assert its bytes and mtime are unchanged. Emit one aggregate `legacy_resident_logs_detected` diagnostic without reading file contents.

- [ ] **Step 8: Verify Green and commit**

Run: `npx vitest run tests/resident-voice-log-files.test.ts`

Expected: all managed writer tests pass.

Commit: `feat: bound resident diagnostic files`

### Task 4: Integrate writer startup and shutdown ownership

**Files:**
- Modify: `src/runtime/resident-voice-runner.ts`
- Test: `tests/resident-voice-runner.test.ts`
- Test: `tests/resident-voice-log-files.test.ts`

- [ ] **Step 1: Write failing runner lifecycle tests**

Assert providers do not start before `fileLog.ready`, runtime shutdown awaits `fileLog.close`, and a runtime write failure disables the file sink while the voice runtime continues and emits one bounded diagnostic.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/resident-voice-runner.test.ts`

Expected: failure because the runner does not await log lifecycle methods.

- [ ] **Step 3: Implement lifecycle ownership**

Await `ready` before provider construction. In the runner `finally`, flush/close the writer without replacing a preceding runtime error. Route diagnostics to the existing bounded process/operator error boundary without recursively enqueuing them into the failed sink.

- [ ] **Step 4: Verify focused Green**

Run: `npx vitest run tests/resident-voice-runner.test.ts tests/resident-voice-log-files.test.ts tests/resident-voice-audit-log.test.ts tests/resident-health-publication.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run PR 2 quality gates and commit**

Run: `just typecheck`

Run: `just lint`

Run: `just ast`

Run: `just format`

Run: `git diff --check`

Expected: all commands exit 0.

Commit: `test: lock bounded resident diagnostics`
