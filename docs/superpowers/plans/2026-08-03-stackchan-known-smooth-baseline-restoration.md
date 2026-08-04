# StackChan Known-Smooth Baseline Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the operator-approved face/head incremental controller while retaining single-flight Gateway dispatch, disabled auto-sleep, and the temporary 23-degree pitch safety floor.

**Architecture:** Revert only post-approval behavior at the detector/controller boundary. Keep the existing transport and firmware surfaces unchanged, then validate the restored boundary with deterministic unit/runtime tests before any attended hardware motion.

**Tech Stack:** TypeScript, Vitest, PINTO postprocessed detections, Python asyncio Gateway.

---

### Task 1: Restore face/head-only target admission

**Files:**
- Modify: `src/modules/vision/attention-detection.ts`
- Test: `tests/attention-detection.test.ts`

- [x] **Step 1: Change the parser regression test to require body rows to be ignored**

Keep the input fixture with class IDs 1, 3, 0, and 2. Require only the head and face detections.

- [x] **Step 2: Run the focused test and verify RED**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts`

Expected: the parser returns three targets because class 0 is still admitted.

- [x] **Step 3: Remove body from the target label, parser mapping, priority list, and anchor special case**

The resulting label union is `"head" | "face"`; every anchor is the bounding-box center.

- [x] **Step 4: Re-run the focused test and verify GREEN**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts`

### Task 2: Restore bounded incremental tracking and ordinary loss handling

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Test: `tests/stackchan-attention-controller.test.ts`

- [x] **Step 1: Change controller regressions to require a configured four-degree cap, short-loss hold, and ordinary scan after timeout**

Use an off-center face whose proportional correction exceeds four degrees. Require `yaw: 4`, not `yaw: 7`. After a missing detection before `lostHoldMs`, require `{ kind: "hold" }`. At timeout, require the configured scan waypoint instead of an eight-degree local waypoint.

- [x] **Step 2: Run the controller test and verify RED**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-controller.test.ts`

Expected: failures show `yaw: 7`, repeated last setpoint, and local recovery.

- [x] **Step 3: Remove the rejected state and behavior**

Remove `lastRequestedPose`, `recoveryCenterPose`, the seven-degree cap, local recovery offsets/dwell, and short-loss re-emission. Quantize against `config.maxStepDeg`, retain the configured scan-pitch floor, and call the ordinary scan after loss timeout.

- [x] **Step 4: Re-run the controller test and verify GREEN**

Run: `./node_modules/.bin/vitest run tests/stackchan-attention-controller.test.ts`

### Task 3: Restore the runtime boundary

**Files:**
- Test: `tests/stackchan-attention-runtime.test.ts`

- [x] **Step 1: Update runtime expectations to the configured step cap and no short-loss refresh**

The runtime already delegates to the pure controller, so no production runtime change is expected.

- [x] **Step 2: Run controller, detector, runtime, lane, and config tests**

Run: `./node_modules/.bin/vitest run tests/attention-detection.test.ts tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-head-target-lane.test.ts tests/config.test.ts`

Expected: all focused tests pass and the lane constant remains one.

### Task 4: Verify the local patch without device motion

**Files:**
- Verify only.

- [x] **Step 1: Run static gates**

Run: `just typecheck && just lint && just ast`

- [x] **Step 2: Run the full repository test gate**

Run: `just test`

- [x] **Step 3: Confirm restored settings and owner boundaries**

Use `rg` to confirm `commandRateHz: 10`, `frameIntervalMs: 125`, `yawGainDeg: 44`, `pitchGainDeg: 30`, `stepQuantization: round`, filter disabled, `maxStepDeg: 4`, `moveSpeedDps: 90`, and Gateway `MAX_ACTIVE_HEAD_TARGET_CALLS = 1`.

- [x] **Step 4: Do not commit**

The user explicitly requested an uncommitted handoff.

### Task 5: Run attended A/B validation later

**Files:**
- Generate: a new private field report directory.

- [x] **Step 1: Confirm the operator is present before starting Gateway or motion**
- [x] **Step 2: Run a small-amplitude yaw test with pitch commands clamped to at least 23 degrees**

  The operator reported no visible motion. The run observed 20 targets and 14 apply replies but zero centered frames; because no physical trajectory was retained, the result is rejected rather than treated as a motion success.

- [x] **Step 3: Verify home and `auto-sleep=false` after the small-amplitude test**

  Final measured state was yaw -1, pitch 33, camera stopped, auto-sleep false. Gateway ports were then closed before unattended work continued.
- [ ] **Step 4: Run a bounded up/down safety test**
- [ ] **Step 5: Verify home and `auto-sleep=false` again**
- [ ] **Step 6: Run one 20-second free-follow trial**
- [ ] **Step 7: Ask the operator to rate smoothness, speed, opposite motion, jumps, and freezes before changing one variable**

### Task 6: Remove post-approval terminal stop-go and repair field evidence

**Files:**
- Modify: `firmware/main/boards/stackchan/head_spring_motion.h`
- Test: `firmware/host_test/test_head_spring_motion.cc`
- Modify: `scripts/field/stackchan-face-follow.ts`
- Test: `tests/stackchan-face-follow-field.test.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`

- [x] **Step 1: Recover the pre-terminal-write spring behavior from the retained positive-state source bundle and task history**
- [x] **Step 2: Add a failing test requiring spring rest not to schedule a second exact-target servo frame**
- [x] **Step 3: Clear the terminal pending flag on the rest frame while retaining stale-write freshness and non-blocking retarget acceptance**
- [x] **Step 4: Add failing field tests for duration-after-start and actual home polling**
- [x] **Step 5: Start the duration budget after runtime startup and poll actual head angles for up to five seconds**
- [x] **Step 6: Report successful firmware responses as `applyReplies`, not physical confirmations**
- [x] **Step 7: Run full Pico, Gateway, and firmware host verification without starting hardware services**
