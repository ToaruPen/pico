# StackChan Continuous Gimbal Follow Implementation Plan

> **Rejected by attended field evaluation on 2026-08-03.** Do not execute the
> remaining hardware task or treat the completed lookahead/local-recovery tasks
> as accepted production behavior. The restoration plan is
> `2026-08-03-stackchan-known-smooth-baseline-restoration.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace response-paced incremental visual corrections with continuous absolute setpoints that survive brief detector gaps and reacquire locally through face, head, or upper-body evidence.

**Architecture:** The attention detector supplies a normalized visual anchor and bounded cross-label continuity. The controller converts each fresh observation into a seven-degree-lookahead absolute pose relative to the confirmed gateway pose; the existing latest-only gateway lane remains the physical trajectory limiter and stays single-flight.

**Tech Stack:** TypeScript, Vitest, PINTO YOLOX postprocessed detections, MCP Streamable HTTP, Python asyncio gateway, pytest, Ruff.

---

### Task 1: Lock the single-flight lane contract

**Files:**
- Modify: `src/modules/stackchan/head-target-lane.ts`
- Test: `tests/stackchan-head-target-lane.test.ts`

- [x] **Step 1: Write a failing assertion that the Pico boundary exposes one active call**

```ts
expect(STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS).toBe(1);
```

- [x] **Step 2: Run the focused test and verify that it fails with `expected 2 to be 1`**

Run: `./node_modules/.bin/vitest run tests/stackchan-head-target-lane.test.ts`

- [x] **Step 3: Change only the exported contract constant**

```ts
export const STACKCHAN_HEAD_TARGET_MAXIMUM_ACTIVE_CALLS = 1;
```

- [x] **Step 4: Re-run the focused test and verify it passes**

Run: `./node_modules/.bin/vitest run tests/stackchan-head-target-lane.test.ts`

### Task 2: Add body evidence and normalized target anchors

**Files:**
- Modify: `src/modules/vision/attention-detection.ts`
- Test: `tests/attention-detection.test.ts`

- [x] **Step 1: Add failing tests for class-zero parsing, upper-body anchoring, and nearby cross-label continuity**

```ts
expect(parsePintoAttentionDetections(bodyRow, [1, 7], options)[0]?.label).toBe("body");
expect(attentionTargetAnchor(bodyDetection)).toEqual({ centerX: 0.5, centerY: 0.22 });
expect(selectAttentionTarget([remoteFace, nearbyBody], { centerX: 0.5, centerY: 0.22 })).toBe(
  nearbyBody
);
```

- [x] **Step 2: Run the detector test and verify the new assertions fail because body and anchor support are absent**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts`

- [x] **Step 3: Implement the minimal target-label, anchor, and continuity behavior**

```ts
export type AttentionTargetLabel = "body" | "head" | "face";

export function attentionTargetAnchor(detection: AttentionDetection) {
  const { xMin, yMin, xMax, yMax } = detection.boundingBox;
  return {
    centerX: (xMin + xMax) / 2,
    centerY: detection.label === "body" ? yMin + (yMax - yMin) * 0.15 : (yMin + yMax) / 2
  };
}
```

Selection first considers candidates within the fixed normalized continuity
radius of the prior anchor, then applies face/head/body priority and the
existing confidence-area rank. Body uses `headConfidenceThreshold`.

- [x] **Step 4: Re-run detector tests and verify all pass**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts`

### Task 3: Emit absolute setpoints and retain the last fresh setpoint

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Test: `tests/stackchan-attention-controller.test.ts`

- [x] **Step 1: Add failing tests for full correction, non-accumulation, short-loss continuation, and bounded post-loss recovery**

```ts
expect(requireMovePose(fullCorrection.effect).yaw).toBeGreaterThan(config.maxStepDeg);
expect(repeated.effect).toEqual(fullCorrection.effect);
expect(shortLoss.effect).toEqual({ kind: "move", pose: fullCorrection.effect.pose });
expect(timedOutLoss).toMatchObject({
  state: { mode: "scan", recoveryCenterPose: currentPose },
  effect: { kind: "move", pose: firstLocalWaypoint }
});
```

Also retain the existing test proving that initial acquisition without a target
enters the configured scan.

- [x] **Step 2: Run the controller test and verify the failures show the current four-degree clamp, immediate pending clear, and post-loss wide scan**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-controller.test.ts`

- [x] **Step 3: Add only the state needed for continuity**

```ts
readonly lastTargetAnchor?: { readonly centerX: number; readonly centerY: number };
readonly lastRequestedPose?: StackChanHeadPose;
```

Use `selectAttentionTarget(detections, state.lastTargetAnchor)`, use
`attentionTargetAnchor()` as the filter input, quantize the proportional
correction with a seven-degree visual-lookahead cap, clamp downward pitch to
the lowest configured scan pitch, and store the resulting absolute pose.

- [x] **Step 4: Implement bounded loss behavior**

Before `lostHoldMs`, return the stored `lastRequestedPose` as a move effect.
After the timeout, anchor local recovery at the confirmed pose and traverse
eight-degree waypoints up to ±24 degrees with a 250 ms post-arrival dwell. Call
the configured global `advanceScan` only when no target has ever been acquired.

- [x] **Step 5: Run the controller tests and update only obsolete incremental-step expectations**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-controller.test.ts`

Expected: all controller tests pass, including the new regression tests.

### Task 4: Verify runtime loss handling and field metric label compatibility

**Files:**
- Modify: `scripts/field/stackchan-attention-metrics.ts`
- Test: `tests/stackchan-attention-runtime.test.ts`
- Test: `tests/stackchan-attention-metrics.test.ts`

- [x] **Step 1: Add a failing runtime test that a missing frame before timeout refreshes the previous lane target and a timed-out loss starts local recovery**

Record lane `update` and `clear` calls over a detected frame, a short missing
frame, and a timed-out missing frame. Expect two updates with the same absolute
pose followed by an eight-degree local recovery update and no clear.

- [x] **Step 2: Run the runtime test and verify current behavior clears on the first missing frame**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-runtime.test.ts`

- [x] **Step 3: Expand field metric target labels to accept body**

```ts
label: "body" | "face" | "head";
```

No new report field is added; body frames already count toward `targetFrames`.

- [x] **Step 4: Run the focused runtime and metric tests**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-runtime.test.ts tests/stackchan-attention-metrics.test.ts`

### Task 5: Run deterministic project and gateway gates

**Files:**
- Verify only; no expected production changes.

- [ ] **Step 1: Run the Pico focused suite**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-attention-metrics.test.ts tests/stackchan-head-target-lane.test.ts`

- [ ] **Step 2: Run Pico type, lint, AST, and full test gates**

Run: `just typecheck && just lint && just ast && just test`

- [ ] **Step 3: Run the unchanged gateway lane tests and lint**

Run from the StackChan worktree:

```bash
uv run pytest tests/test_head_target_lane.py
uv run ruff check stackchan_mcp/head_target_lane.py tests/test_head_target_lane.py
```

### Task 6: Restore the proven observation rate and validate on hardware

**Files:**
- Modify: `.pico-local/field-stackchan.yaml`
- Generate: private aggregate reports under `/Users/monsoon/.pico/field-runs/`

- [ ] **Step 1: Change the local field configuration from 8 Hz to the previously user-approved 10 Hz; leave auto-sleep disabled**

```yaml
commandRateHz: 10
```

- [ ] **Step 2: Run preflight and confirm home pose, camera ownership, gateway health, and `autoSleepFinal: false`**

- [ ] **Step 3: Run at least one 20-second production-path face-follow test while the operator moves freely**

Run the existing `field:stackchan-face-follow` harness with live-run enabled,
the configured PINTO model, and a new mode-`0600` aggregate report path.

- [ ] **Step 4: Inspect the acceptance metrics and repeat tuning when any objective fails**

Require no direction divergence, no post-acquisition scan jump, target ratio at
least 0.85, maximum loss gap at most 500 ms, one active call, pending depth at
most one, stop at most 250 ms, and home error at most two degrees.

- [ ] **Step 5: Return home and verify camera stopped and auto-sleep remains disabled**
