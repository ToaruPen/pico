# Hold-to-Talk Lifecycle Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge PR #99 around one terminal-ownership contract while moving resident latency observability into a stacked PR.

**Architecture:** PR #99 keeps the hold-to-talk control and resource lifecycle. Every asynchronous owner retains state until terminal settlement, preserves the first terminal cause, and uses deterministic cancellation or bounded process termination. The existing latency commit is reverted from PR #99 and later replayed onto a stacked branch.

**Tech Stack:** TypeScript, Vitest, Swift Testing, AsyncStream, Node child processes, Pi Agent SDK, GitHub pull requests

---

## Task 1: Split the latency commit and repair the original plan inventory

**Files:**
- Modify: `docs/superpowers/plans/2026-07-17-hold-to-talk-resident-control.md`
- Remove from PR #99 through revert: `docs/superpowers/plans/2026-07-17-resident-voice-latency-observability-implementation-plan.md`

- [ ] **Step 1: Preserve the latency commit identity**

Record `3bbb97b` as the commit to replay on the stacked branch. Confirm the worktree is clean with `git status --short`.

- [ ] **Step 2: Revert the latency commit from PR #99**

Run `git revert --no-edit 3bbb97b`. Expected: the latency plan and runtime metrics changes leave PR #99 while the lifecycle brief and this plan remain.

- [ ] **Step 3: Repair stale file paths in the original plan**

Replace every lifecycle inventory/command reference as follows:

```text
justfile                                      -> Justfile
src/runtime/resident-voice-service.ts         -> src/runtime/resident-launchd.ts
tests/resident-voice-service.test.ts           -> tests/resident-launchd.test.ts
```

Run `rg -n "justfile|resident-voice-service" docs/superpowers/plans/2026-07-17-hold-to-talk-resident-control.md` and expect no matches.

## Task 2: Preserve every semantic keyboard event

**Files:**
- Modify: `sidecars/macos-control/Sources/PicoMacOSControlCore/ControlEvent.swift`
- Modify: `sidecars/macos-control/Tests/PicoMacOSControlCoreTests/ControlEventTests.swift`

- [ ] **Step 1: Add the failing burst-delivery test**

Create a channel, synchronously send `talkPressed` and `talkReleased` before starting iteration, then assert the first two iterator values preserve both events in order.

- [ ] **Step 2: Verify RED**

Run `cd sidecars/macos-control && swift test --filter ControlEventTests`. Expected: the second value times out or is absent because `.bufferingOldest(1)` drops it.

- [ ] **Step 3: Implement lossless ordered buffering**

Use `AsyncStream.makeStream(bufferingPolicy: .unbounded)` in `ControlEventChannel.init`. Keep the existing `send` result handling so terminated channels still fail closed.

- [ ] **Step 4: Verify GREEN**

Run the focused Swift test and expect both events in arrival order.

## Task 3: Terminalize controller state when transition observation fails

**Files:**
- Modify: `src/runtime/resident-control-controller.ts`
- Modify: `tests/resident-control-controller.test.ts`

- [ ] **Step 1: Add failing observer-failure tests**

Add deterministic tests proving an `onTransition` throw during `listening -> tailing` leaves state `error`, aborts the generation, installs no tail callback, and does not invoke the observer recursively for the error transition.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/resident-control-controller.test.ts -t "transition observer"`. Expected: state remains `tailing`.

- [ ] **Step 3: Centralize direct error terminalization**

Add one private closure that clears the release timer, aborts the owned generation with the original error, and assigns `currentState = "error"` without invoking `onTransition`. Route all callback/observer failure paths through it. `transition` updates state, invokes the observer, and on throw calls the direct terminalizer before rethrowing.

- [ ] **Step 4: Verify GREEN**

Run the complete controller test file and expect all transition/cancel cases to pass.

## Task 4: Require audio frames from a completed field hold

**Files:**
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `tests/resident-hold-to-talk-field-runtime.test.ts`

- [ ] **Step 1: Add the failing mixed-hold test**

Drive one completed hold with zero frames and one cancelled hold with frames. Assert field validation rejects the run rather than using aggregate cancelled frames as completed evidence.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/resident-hold-to-talk-field-runtime.test.ts -t "completed hold frames"`. Expected: validation incorrectly succeeds.

- [ ] **Step 3: Track completed-hold evidence at the owner**

Replace the two-argument aggregate guard with `requireCompletedAudioCapture(completedHoldsWithFrames)`. Increment that counter only in the completed-hold path when the completed turn's `frameCount > 0`; keep aggregate frame count solely for the bounded report.

- [ ] **Step 4: Verify GREEN**

Run the complete field runtime test file.

## Task 5: Preserve the first Apple Speech abort cause

**Files:**
- Modify: `src/modules/voice/index.ts`
- Modify: `tests/voice.test.ts`

- [ ] **Step 1: Add the failing timeout-then-caller-abort test**

Use fake timers and a fetch promise that rejects only after both the timeout and caller abort occur. Assert the result reason remains `timeout`.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/voice.test.ts -t "preserves timeout as the first abort cause"`. Expected: current mutable `requestAborted` classification returns `aborted`.

- [ ] **Step 3: Implement first-cause-wins**

Replace the mutable request-aborted boolean with `let abortCause: "timeout" | "request" | undefined`. The timeout callback assigns `"timeout"` only when unset before aborting. The caller listener assigns `"request"` only when unset. Classify the failure from this immutable first cause.

- [ ] **Step 4: Verify GREEN**

Run the complete voice module test file.

## Task 6: Make Pi session bootstrap cancellation observable and non-blocking

**Files:**
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Add the failing bootstrap-cancel test**

Keep `createAgentSession()` pending, call `prompt()` with a signal, abort it, and assert the prompt rejects with the bounded cancellation error before session creation resolves. Resolve the background session afterward and assert no unhandled rejection and one reusable cached session.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/pi-agent-turn.test.ts -t "cancels while the session is starting"`. Expected: the prompt remains pending.

- [ ] **Step 3: Add abort-aware acquisition at the Pi owner boundary**

Check the signal before acquisition. Start `getOrCreateTurnSession()`, attach a rejection observer, and race its settlement against a one-shot abort promise. Remove the abort listener after either side settles. Keep the background session promise cached so a later prompt can reuse it.

- [ ] **Step 4: Verify GREEN**

Run the complete Pi turn test file.

## Task 7: Bound managed bridge termination

**Files:**
- Modify: `src/runtime/macos-control-bridge.ts`
- Modify: `tests/macos-control-bridge.test.ts`

- [ ] **Step 1: Add failing TERM-to-KILL tests**

Inject a deterministic scheduler. Prove readiness failure and `close()` send `SIGTERM`, send `SIGKILL` after the grace period if no `exit` occurs, clear escalation after `exit`, and reject with a bounded termination error after the final deadline.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/macos-control-bridge.test.ts -t "escalates bridge termination"`. Expected: only `SIGTERM` is observed and completion remains pending.

- [ ] **Step 3: Keep termination inside the bridge owner**

Extend the bridge operation with one idempotent termination promise. It owns the grace timer, `SIGTERM`, conditional `SIGKILL`, final deadline, and exit listener cleanup. Readiness failure and `close()` await that same promise.

- [ ] **Step 4: Verify GREEN**

Run the complete bridge test file.

## Task 8: Retain playback child ownership until exit

**Files:**
- Modify: `src/runtime/resident-audio-io.ts`
- Modify: `tests/resident-audio-io.test.ts`

- [ ] **Step 1: Add the failing stdin-error ownership test**

Make child stdin fail while child exit remains pending. Assert `play()` reports the write failure, `stop()` still signals that same child, and a later play is not admitted until the child exit settles.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/resident-audio-io.test.ts -t "retains playback ownership after stdin failure"`. Expected: `stop()` observes no active child.

- [ ] **Step 3: Separate write settlement from child termination**

Represent the active playback operation with the child and an exit promise. A write error may reject the play call but must not clear the active operation. Only child exit or bounded stop completion clears `active`; all cleanup paths compare operation identity before clearing it.

- [ ] **Step 4: Verify GREEN**

Run the complete audio I/O test file.

## Task 9: Close the late-review terminal ownership gaps

**Files:**
- Modify: `docs/superpowers/research/2026-07-17-hold-to-talk-field-validation.md`
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `sidecars/macos-control/Sources/PicoMacOSControl/PicoMacOSControl.swift`
- Modify: `src/modules/session/index.ts` only if the regression test disproves audit isolation
- Modify: `src/runtime/macos-control-bridge.ts`
- Modify: `src/runtime/resident-control.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/voice-resident.ts`
- Test: `tests/resident-hold-to-talk-field-runtime.test.ts`
- Test: `tests/session.test.ts`
- Test: `tests/macos-control-bridge.test.ts`
- Test: `tests/resident-control.test.ts`
- Test: `tests/voice-resident.test.ts`

- [x] **Step 1: Separate released and cancelled field metrics**

Add a failing cancellation-during-tail test proving a cancelled hold does not add hold or
release-tail samples. Move those samples into the completed-release terminalizer while leaving
aggregate capture and cancellation metrics in their respective owners.

- [x] **Step 2: Keep the Core Graphics callback context alive**

Keep `BridgeContext` strongly alive from event tap creation through run-loop exit, tap invalidation,
and semantic sender drain. Run the native macOS control gate.

- [x] **Step 3: Prove session notification is audit-independent**

Extend the audit-failure regression test to subscribe before ending and require exactly one ended
notification. Change `endSession` only if the test fails; the audit helper already claims to isolate
sink failures.

- [x] **Step 4: Settle bridge spawn failure on process close**

Add a failing spawn-error-without-exit test. Settle the managed child from `close`, including the
post-error close path, and update listener cleanup without weakening TERM-to-KILL ownership.

- [x] **Step 5: Share and bound loopback server close**

Add deterministic tests proving abort and explicit close await one cached operation and that an
active request is force-closed after the configured resident shutdown grace. Pass the existing
startup-only `voice.resident.shutdownGraceMs` into the server owner; do not add another config field.

- [x] **Step 6: Classify cancelled TTS as skipped**

Add a failing stage-probe test for a provider cancellation. Preserve failure accounting for other
provider errors and emit `skipped/cancelled` for normal cancellation.

- [x] **Step 7: Refresh field validation evidence**

Run the full current suite, then update the field validation record with the exact test count and
validated commit SHA. Do not mark the unperformed physical keyboard/microphone path as passing.

- [x] **Step 8: Settle a tail-completion cancellation once**

Add a delayed capture-stop regression test for tail expiry followed by cancel. Keep one shared
terminal operation per capture, claim the matching controller terminal state before metrics, and
record exactly one released or cancelled outcome.

- [x] **Step 9: Settle final-timeout and shutdown failures**

Add failing tests for a release-timer observer exception, capture/playback children that never
close after SIGKILL, exit-only playback after abort, active cancellation cleanup rejection, and
shutdown cleanup rejection. Contain scheduled observer failure, release child listeners and active
ownership on the bounded terminal error, await cancellation as an owned shutdown boundary, and
reject runtime completion with the same shutdown failure returned by stop.

## Task 10: Verify and converge PR #99

**Files:**
- Modify only review findings within the lifecycle brief.

- [x] **Step 1: Run focused tests**

Run the focused TypeScript/native test targets from Tasks 2-9.

- [x] **Step 2: Run the full gate**

Run `just check`, `git diff --check`, and the repository secret scan enforced by pre-commit.

- [x] **Step 3: Run independent review and cleanup**

Require a fresh `APPROVE`, then apply the requested `polishment` and `ai-slop-cleaner` sequence only to changed files. Re-run `just check` after cleanup.

- [x] **Step 4: Commit, push, and update PR #99**

Use a conventional commit, update the PR body to remove latency-observability scope, push without force, and request current-head review.

- [ ] **Step 5: Converge all review surfaces**

Wait for CI and CodeRabbit. Address every current actionable finding, verify review-thread state, and stop at draft, green, reviewed, mergeable PR #99.

## Task 11: Replay latency observability as a stacked PR

**Files:**
- Restore from commit: `3bbb97b`
- Modify: `docs/superpowers/plans/2026-07-17-resident-voice-latency-observability-implementation-plan.md`
- Modify: `docs/superpowers/specs/2026-06-18-voice-resident-runtime-design.md`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `src/runtime/resident-voice-runner.ts`

- [ ] **Step 1: Create the stacked branch**

After PR #99 converges, create `codex/resident-latency-observability` from the current PR #99 head and cherry-pick `3bbb97b`.

- [ ] **Step 2: Fix plan heading structure**

Change Task headings in the restored latency implementation plan from H3 to H2 and run the formatting gate.

- [ ] **Step 3: Centralize stage policy**

Define the fixed stage registry once in `voice-stage-probe.ts`, including whether a stage is persisted and mirrored in summary output. Derive the probe validator, resident JSONL metric filter, and summary filter from that registry. Update the old voice spec to distinguish the complete probe stage enum from the persisted subset rather than claiming they are the same contract.

- [ ] **Step 4: Add RED/GREEN registry tests**

Before implementation, add tests proving every accepted stage has exactly one policy and that runner/audit behavior derives from it. Verify RED against the duplicated sets, then GREEN after centralization.

- [ ] **Step 5: Create and converge the stacked PR**

Push the branch, create a draft PR with base `feat/hold-to-talk-resident-control`, state the stack in its body, run `just check`, independent review, cleanup, CI, and current-head review evidence gates.
