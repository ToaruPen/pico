# Person-Follow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect continuous person detection frames to the existing bounded
ONVIF person-follow controller behind an explicit live gate.

**Architecture:** Add a focused `src/runtime/person-follow-runtime.ts` wiring
layer and a `scripts/smoke/person-follow-runtime.ts` command. Reuse existing
camera and vision modules without adding identity, emotion, or tracking logic.

**Tech Stack:** TypeScript, Vitest, existing RTSP/ONVIF camera modules, existing
CoreML/ONNX person detection modules, jiti smoke scripts.

---

### Task 1: Runtime Wiring

**Files:**

- Create: `src/runtime/person-follow-runtime.ts`
- Test: `tests/person-follow-runtime.test.ts`

- [x] Write a failing test that runs an injected person-follow runtime and
      verifies frames from `publish` are passed to a follow controller.
- [x] Run:
      `npm test -- tests/person-follow-runtime.test.ts`
      and verify it fails because the runtime module does not exist.
- [x] Implement `runPersonFollowRuntime()` with injected stream, model, frame
      capture, and controller dependencies.
- [x] Re-run the focused test and verify it passes.

### Task 2: Smoke Command

**Files:**

- Create: `scripts/smoke/person-follow-runtime.ts`
- Test: `tests/person-follow-runtime-smoke.test.ts`
- Modify: `package.json`

- [x] Write failing tests for live-gate skip, config-derived plan, and exit
      code behavior.
- [x] Run:
      `npm test -- tests/person-follow-runtime-smoke.test.ts`
      and verify it fails because the smoke script does not exist.
- [x] Implement the smoke script using `PICO_ENABLE_LIVE_PERSON_FOLLOW=1`.
- [x] Add `smoke:person-follow-runtime` to `package.json`.
- [x] Re-run the focused tests and verify they pass.

### Task 3: Local Gates

**Files:**

- Modify only files touched by Tasks 1 and 2 if gates reveal issues.

- [x] Run focused tests:
      `npm test -- tests/person-follow-runtime.test.ts tests/person-follow-runtime-smoke.test.ts`
- [x] Run full gates:
      `just check`
- [x] Run formatting if needed:
      `just format`

### Task 4: Field Test

**Files:**

- Add field report only after a live run:
  `docs/field-tests/2026-06-16-person-follow-runtime.md`

- [x] Run:
      `PICO_CONFIG_PATH=config/pico.local.yaml PICO_ENABLE_LIVE_PERSON_FOLLOW=1 npm run smoke:person-follow-runtime`
- [x] If skipped or failed, record the blocker instead of claiming live pass.
- [x] If passed, add the field report with command, bounded duration/frame
      limits, and observed report JSON.
