# Resident Cancellation Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit configured PTT capture immediately after the cancelled audio path is safe, serialize the next Pi prompt behind any detached predecessor settlement, and make cancellation, interaction ending, control decisions, latency, and expected gate discard understandable in privacy-safe telemetry.

**Architecture:** `voice-resident.ts` separates foreground audio cancellation from a session-scoped Pi admission barrier and retains detached operations until ending or shutdown. Typed operator events drive a bounded terminal state machine; the Swift/Node control protocol records accepted gate timing separately from rejected decisions. The renderer shows response readiness and settlement tail as different values while preserving configured key labels and width bounds.

**Tech Stack:** TypeScript strict mode, Vitest, Swift 6, Swift Testing, AVAudioEngine sidecar protocol, Pi TUI ANSI-width helpers, Just.

---

### Task 1: Release PTT after foreground cancellation

**Files:**
- Modify: `tests/voice-resident.test.ts`
- Modify: `src/runtime/voice-resident.ts`

- [x] **Step 1: Write the failing re-entry test**

Replace the post-response cancellation expectation with a test that holds the
first `settled` promise, cancels playback, and starts a second configured PTT
turn before releasing the predecessor:

```ts
it("captures and transcribes the next hold before the cancelled Pi turn settles", async () => {
  const firstSettlement = createGate<undefined>();
  const firstPlayback = createGate<undefined>();
  let promptCount = 0;
  const driver = createDriver({
    piResponse: () => {
      promptCount += 1;
      return Promise.resolve(
        promptCount === 1
          ? { text: "中断する応答", settled: firstSettlement.promise }
          : { text: "次の応答" }
      );
    },
    playbackCompletion: () => firstPlayback.promise
  });

  await startReleasedHold(driver);
  await driver.tailComplete();
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
  await expect(driver.cancel()).resolves.toBe("accepted");
  firstPlayback.resolve(undefined);
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));

  await expect(driver.press()).resolves.toBe("accepted");
  driver.capture.emit(frame("second", [1, 0]));
  await driver.release();
  await driver.tailComplete();
  await vi.waitFor(() => expect(driver.sttRequests).toHaveLength(2));
  expect(driver.piRequests).toHaveLength(1);

  firstSettlement.resolve(undefined);
  await vi.waitFor(() => expect(driver.piRequests).toHaveLength(2));
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
  await driver.runtime.stop();
});
```

- [x] **Step 2: Run RED**

Run:

```bash
npm test -- tests/voice-resident.test.ts -t "captures and transcribes the next hold"
```

Expected: FAIL because the controller remains `cancelling` until
`firstSettlement` resolves and the second press returns `ignored_busy`.

- [x] **Step 3: Add the foreground/background ownership split**

In `ActiveTurn`, add an optional playback operation. In the runtime closure,
retain a `Set<Promise<void>>` of owned turn operations and a session Pi
admission barrier with `{ pending, promise }` state.

Start each Pi prompt through one owner that registers its completion before the
request can publish or reject:

```ts
await waitForPriorPiTurn(
  state.piAdmission(),
  turn.generation.signal,
  options.operator
);
const responseOperation = requestPiTurn(
  transcript,
  sessionId,
  deferredResults,
  turn,
  options,
  counters
);
const settlement = responseOperation.then((response) =>
  response === undefined
    ? undefined
    : settlePiResponse(response, options, piStartedAt, piStartedAtMs, state.monotonicNow)
);
state.ownPiSettlement(settlement.then(() => undefined));
const response = await responseOperation;
```

Assign `turn.playbackOperation` before awaiting it. Change
`convergeCancellation` to await capture/STT stop, `turn.frameCollection`, the
playback operation when present, capture resume performed by
`runTurnPlayback`, and echo cleanup. Do not await `turn.operation` before
`completeCancellation`.

Track `turn.operation` independently so replacing `activeTurn` cannot orphan
the predecessor. Interaction ending and shutdown drain the tracked set before
Pi session disposal.

- [x] **Step 4: Run GREEN and the lifecycle neighborhood**

Run:

```bash
npm test -- tests/voice-resident.test.ts
```

Expected: all voice resident tests pass, including shutdown, cancellation,
farewell, and disposal ordering.

- [x] **Step 5: Commit the ownership change**

```bash
git add src/runtime/voice-resident.ts tests/voice-resident.test.ts
git commit -m "fix: admit voice after foreground cancellation"
```

### Task 2: Represent cancellation and interaction ending

**Files:**
- Modify: `src/runtime/resident-voice-operator.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-voice-terminal-display.ts`
- Modify: `src/runtime/resident-voice-terminal-renderer.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/resident-voice-terminal-display.test.ts`
- Modify: `tests/resident-voice-terminal-renderer.test.ts`

- [x] **Step 1: Write failing runtime operator tests**

Add assertions that accepted cancellation emits:

```ts
{ kind: "turn_cancelled" }
{ kind: "turn_phase", phase: "cancelling" }
```

before delayed foreground cleanup, then exactly one idle. Add an inactivity
test asserting `interaction_ending_started` precedes farewell prompt/playback
events and `interaction_ending_finished` follows cleanup.

Add a prior-settlement test asserting the second turn emits
`waiting_for_previous_turn` after STT and returns to `processing` before its Pi
prompt.

- [x] **Step 2: Run RED**

```bash
npm test -- tests/voice-resident.test.ts -t "operator|previous turn|inactivity farewell"
```

Expected: FAIL because the new phases and lifecycle events do not exist.

- [x] **Step 3: Write failing display and renderer tests**

Use `configuredControls = { talkKey: "F13", cancelKey: "F14" }`. Assert the
following text-only states and bounded notices:

```text
◐ 中断処理中
◐ 前の処理を整理中
◐ セッション終了中
− F13: 中断処理中のため受理せず
− 中断済み
```

Exercise ending start, farewell `pi_response`, ending finish, 40/60/100-column
widths, and a subsequent accepted turn that clears the notice. Assert the
output never contains `F1 話す`.

- [x] **Step 4: Run display RED**

```bash
npm test -- tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts
```

Expected: FAIL on missing event variants, phases, and labels.

- [x] **Step 5: Implement the bounded operator state**

Add phases `cancelling` and `waiting_for_previous_turn`. Add events:

```ts
| { readonly kind: "turn_cancelled" }
| { readonly kind: "control_decision"; readonly control: "talk"; readonly result: ResidentControlResult; readonly state: ResidentControlState | "interaction_ending" }
| { readonly kind: "interaction_ending_started" }
| { readonly kind: "interaction_ending_finished" }
```

The display retains `cancelled?: true`, one low-cardinality control notice, and
an ending lifecycle card without a staff transcript. It clears the notice on
the next `turn_started`. Interaction ending becomes active only after the
preceding owned-turn boundary has drained.

- [x] **Step 6: Run GREEN and width regressions**

```bash
npm test -- tests/voice-resident.test.ts tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts
```

Expected: all selected tests pass and every rendered line remains within its
viewport.

- [x] **Step 7: Commit operator visibility**

```bash
git add src/runtime/resident-voice-operator.ts src/runtime/voice-resident.ts src/runtime/resident-voice-terminal-display.ts src/runtime/resident-voice-terminal-renderer.ts tests/voice-resident.test.ts tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts
git commit -m "fix: show resident cancellation ownership"
```

### Task 3: Correct control timing decisions

**Files:**
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/ResidentIoMessage.swift`
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIO/ResidentIoOwner.swift`
- Modify: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/ResidentIoCodecTests.swift`
- Modify: `src/runtime/resident-io-protocol.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `tests/resident-io-protocol.test.ts`
- Modify: `tests/macos-resident-io-bridge.test.ts`
- Modify: `tests/resident-voice-runner.test.ts`
- Modify: `tests/voice-resident.test.ts`

- [x] **Step 1: Write failing Swift and TypeScript protocol tests**

Extend timing fixtures with optional control results and add
`cancel_key_to_admission`:

```json
{
  "kind": "timing_event",
  "stage": "key_to_admission",
  "durationMs": 1.25,
  "controlResult": "ignored_busy"
}
```

Assert malformed results fail closed and old non-control timings remain valid.

- [x] **Step 2: Run protocol RED**

```bash
npm test -- tests/resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts
swift test --package-path sidecars/macos-resident-io
```

Expected: FAIL on the unknown timing field/stage contract.

- [x] **Step 3: Implement decision-aware timing**

Add optional `controlResult` to timing metadata. In Swift, emit
`key_to_admission` with the talk result for every talk decision, emit
`admission_to_gate` only when the result is `accepted`, and emit
`cancel_key_to_admission` for cancel decisions. Node records
`pico.voice.control_result` as a fixed enum attribute and never records key
labels or generation identifiers.

Record `resident_cancel_admission_to_output_stopped` after playback/pipeline
stop and capture-resume ownership settles, then
`resident_cancel_admission_to_idle` after echo cleanup and controller idle.
Settle each measurement once across success, failure, and shutdown.

- [x] **Step 4: Run protocol GREEN and native gate**

```bash
npm test -- tests/resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts tests/resident-voice-runner.test.ts
just macos-resident-io-check
```

Expected: TypeScript protocol tests and all Swift format/test/release-build
checks pass.

- [x] **Step 5: Commit timing semantics**

```bash
git add sidecars/macos-resident-io src/runtime/resident-io-protocol.ts src/runtime/resident-voice-runner.ts src/runtime/voice-stage-probe.ts tests/resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts tests/resident-voice-runner.test.ts
git commit -m "fix: distinguish resident control decisions"
```

### Task 4: Render the response critical path and clarify discard diagnostics

**Files:**
- Modify: `src/runtime/resident-voice-terminal-renderer.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIO/ResidentIoOwner.swift`
- Modify: `tests/resident-voice-terminal-display.test.ts`
- Modify: `tests/resident-voice-terminal-renderer.test.ts`
- Modify: `tests/resident-voice-runner.test.ts`

- [x] **Step 1: Write failing renderer and health-line tests**

Add `pi_final_response_ready=5_800`, `pi_turn=17_158`, `stt=72`,
`tts_time_to_first_chunk=1_120`, and root response latency `7_747`. Assert:

```text
応答開始 7.75 s
STT 72 ms → Pi確定 5.80 s → TTS 1.12 s
Pi後処理 11.36 s
```

Assert the normal running health line uses
`outside_ptt_discarded_sample_frames` and
`suppressed_discarded_sample_frames`, omits unqualified `dropped=`, and the
non-running line retains an explicit `abnormal_dropped_sample_frames` value.

- [x] **Step 2: Run RED**

```bash
npm test -- tests/resident-voice-terminal-renderer.test.ts tests/resident-voice-runner.test.ts
```

Expected: FAIL on the old `音声送出`/`最長 Pi` summary and raw `dropped=` line.

- [x] **Step 3: Implement pure formatting helpers**

Replace longest-stage selection with a compact ordered critical path. Compute
the settlement tail as:

```ts
Math.max(0, piTurn.durationMs - finalResponse.durationMs)
```

only when both stages succeeded. Add one pure health-line formatter that uses
explicit expected-discard names for running health and an abnormal-drop name
for non-running health. Preserve `visibleWidth`/`truncateToWidth` guards.
Every Swift health event carries the expected-discard breakdown so abnormal
loss can be derived without treating ordinary outside-PTT samples as loss.

- [x] **Step 4: Run GREEN and identifier inventory**

```bash
npm test -- tests/resident-voice-terminal-renderer.test.ts tests/resident-voice-runner.test.ts
rg -n "outside_ptt_discarded_sample_frames|abnormal_dropped_sample_frames|Pi後処理" src tests
```

Expected: focused tests pass and each identifier appears only in its formatter,
tests, or protocol owner.

- [x] **Step 5: Commit presentation corrections**

```bash
git add src/runtime/resident-voice-terminal-renderer.ts src/runtime/resident-voice-runner.ts tests/resident-voice-terminal-renderer.test.ts tests/resident-voice-runner.test.ts
git commit -m "fix: clarify resident latency and discard telemetry"
```

### Task 5: Cleanup, independent review, and PR convergence

**Files:**
- Review all files changed since `786c57c`
- Update: draft PR `#109`

- [x] **Step 1: Run focused and repository gates**

```bash
npm test -- tests/voice-resident.test.ts tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts tests/resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts tests/resident-voice-runner.test.ts
just macos-resident-io-check
just apple-speech-check
just check
npx --yes --package secretlint@9.3.4 --package @secretlint/secretlint-rule-preset-recommend@9.3.4 secretlint .
```

Expected: every command exits zero. Do not run an exclusive microphone field
test while the user's Pico process is active.

- [x] **Step 2: Run AI slop cleaner**

Lock the focused tests, then inspect only files changed since `786c57c` for
dead state, duplicate promise ownership, needless wrappers, boundary leaks,
debug residue, and missing behavior locks. Apply one smell category at a time
and rerun the focused tests after each material change.

- [x] **Step 3: Obtain fresh native subagent reviews**

Dispatch correctness and overdesign reviewers with the design, plan, complete
diff, Red/Green evidence, and gate output. Fix every actionable in-scope
finding, rerun affected tests, and obtain a fresh verdict.

- [x] **Step 4: Verify real providers without disturbing the live process**

Run non-exclusive Apple Speech health/provider validation and Aivis/provider
validation allowed by the existing process. Defer microphone-exclusive field
capture until the user stops Pico or explicitly coordinates it.

Validated the live Apple Speech `/health` and `/ready` endpoints and the Aivis
`/version` endpoint. The existing Pico process retained the microphone and
Apple Speech admission lease; no exclusive capture or transcription smoke was
started.

- [ ] **Step 5: Push and converge PR #109**

```bash
git push origin codex/resident-voice-final-response
gh pr view 109 --json headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments
```

Wait for checks on the pushed head. The endpoint is a green, reviewed draft PR;
merge remains a separate explicit action.
