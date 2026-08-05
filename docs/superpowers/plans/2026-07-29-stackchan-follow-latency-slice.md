# StackChan Follow Latency Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Pico-side head-of-line delay so StackChan observes at 125 ms, acts on fresh frames, and keeps only the latest unsent head correction.

**Architecture:** Keep the existing detector, gateway, and firmware boundaries. Split the adapter's global hardware lane by operation kind, add center hysteresis to the pure controller, and replace the runtime's busy-command suppression plus post-move refresh with an in-flight-one/latest-pending-one pipeline. Production values remain configurable; tests provide explicit values rather than asserting default literals.

**Tech Stack:** TypeScript, Vitest, MCP Streamable HTTP adapter, ONNX Runtime attention detector, YAML configuration, Just task runner.

---

## File map

- `src/modules/stackchan/index.ts`: owns independent process-wide capture and move lanes.
- `src/modules/stackchan/attention-controller.ts`: owns deterministic center enter/release hysteresis.
- `src/runtime/stackchan-attention-runtime.ts`: owns frame freshness, command reference pose, and bounded pending dispatch.
- `src/config/index.ts`: owns `maxFrameAgeMs` and `deadZoneRelease` validation.
- `config/pico.example.yaml`: carries the recommended 125 ms / 180 ms / hysteresis values without making tests depend on them.
- `scripts/field/stackchan-face-follow.ts`: reports freshness and bounded command-flow evidence.
- `tests/stackchan.test.ts`: proves capture and move no longer block each other while same-kind calls remain serialized.
- `tests/config.test.ts`: proves explicit config values and invalid hysteresis boundaries.
- `tests/stackchan-attention-controller.test.ts`: proves enter/release hysteresis.
- `tests/stackchan-attention-runtime.test.ts`: proves latest-pending, send-time reference pose, stale-frame rejection, failure rebase, and removal of refresh bursts.
- `tests/stackchan-face-follow-field.test.ts`: proves new report fields and acceptance checks.

### Task 1: Split capture and move lanes

**Files:**
- Modify: `tests/stackchan.test.ts`
- Modify: `src/modules/stackchan/index.ts`

- [x] **Step 1: Write the failing concurrency tests**

Replace the existing cross-adapter priority assertion with two deterministic gate tests:

```ts
it("does not make a move wait for an active capture", async () => {
  const captureGate = deferred<StackChanLatestJpegFrame>();
  const calls: string[] = [];
  const capture = followAdapter.captureJpeg();
  const move = followAdapter.moveHead({ yaw: 4, pitch: 35 });

  await nextTurn();
  expect(calls).toEqual(["capture", "move"]);
  captureGate.resolve(latestFrame(1));
  await Promise.all([capture, move]);
});

it("serializes captures across adapters", async () => {
  const firstGate = deferred<StackChanLatestJpegFrame>();
  const first = firstAdapter.captureJpeg();
  const second = secondAdapter.captureJpeg();

  await nextTurn();
  expect(calls).toEqual(["capture:first"]);
  firstGate.resolve(latestFrame(1));
  await Promise.all([first, second]);
  expect(calls).toEqual(["capture:first", "capture:second"]);
});
```

Use the existing client and deferred-promise helpers in the test file; do not add timer sleeps.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/stackchan.test.ts
```

Expected: the capture/move independence test fails because both operations currently use `stackChanHardwareLaneTail`.

- [x] **Step 3: Implement two typed lanes**

Replace the single tail and runner with:

```ts
type StackChanHardwareLane = "capture" | "move";

let stackChanCaptureLaneTail: Promise<void> = Promise.resolve();
let stackChanMoveLaneTail: Promise<void> = Promise.resolve();

function getStackChanLaneTail(lane: StackChanHardwareLane): Promise<void> {
  return lane === "capture" ? stackChanCaptureLaneTail : stackChanMoveLaneTail;
}

function setStackChanLaneTail(lane: StackChanHardwareLane, tail: Promise<void>): void {
  if (lane === "capture") {
    stackChanCaptureLaneTail = tail;
  } else {
    stackChanMoveLaneTail = tail;
  }
}

async function runStackChanHardwareOperation<T>(
  lane: StackChanHardwareLane,
  operation: () => Promise<T>
): Promise<T> {
  let releaseLane = (): void => undefined;
  const currentLane = new Promise<void>((resolveLane) => {
    releaseLane = resolveLane;
  });
  const previousLane = getStackChanLaneTail(lane).catch(() => undefined);
  setStackChanLaneTail(lane, previousLane.then(() => currentLane));

  try {
    await previousLane;
    return await operation();
  } finally {
    releaseLane();
  }
}
```

Call it as `runStackChanHardwareOperation("capture", ...)` and
`runStackChanHardwareOperation("move", ...)`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/stackchan.test.ts
```

Expected: all StackChan adapter tests pass.

### Task 2: Add explicit freshness and center-release configuration

**Files:**
- Modify: `tests/config.test.ts`
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`

- [x] **Step 1: Write failing parser boundary tests**

Parse an explicitly configured follow block and assert only the supplied behavior values:

```ts
expect(config.camera.stackchan?.follow).toMatchObject({
  enabled: true,
  frameIntervalMs: 125,
  maxFrameAgeMs: 180,
  deadZone: 0.1,
  deadZoneRelease: 0.14
});
```

Add failures for `maxFrameAgeMs: 0`, `deadZoneRelease: 0.5`, and
`deadZone: 0.2` with `deadZoneRelease: 0.1`. The last error must name both fields:

```text
pico config camera.stackchan.follow.deadZoneRelease must be >= deadZone
```

- [x] **Step 2: Run config tests and verify RED**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: boundary failures for invalid values, a missing-field failure for `maxFrameAgeMs`, and
normalization of an omitted `deadZoneRelease` to `0.14`.

- [x] **Step 3: Extend the config contract and parser**

Add these required properties to the normalized enabled union returned by the parser. Raw YAML may
omit `deadZoneRelease`; omission normalizes to `0.14`, so TypeScript runtime consumers always
receive a required numeric value:

```ts
readonly maxFrameAgeMs: number;
readonly deadZoneRelease: number;
```

Read both fields before constructing the result:

```ts
const deadZone =
  readOptionalBoundedDeadZone(input.deadZone, "pico config camera.stackchan.follow.deadZone") ??
  0.1;
const deadZoneRelease =
  readOptionalBoundedDeadZone(
    input.deadZoneRelease,
    "pico config camera.stackchan.follow.deadZoneRelease"
  ) ?? 0.14;
if (deadZoneRelease < deadZone) {
  throw new Error("pico config camera.stackchan.follow.deadZoneRelease must be >= deadZone");
}
```

Add both names to `requireKnownConfigFields`, use bounded positive-integer parsing for
`maxFrameAgeMs`, and recommend these example values:

```yaml
frameIntervalMs: 125
maxFrameAgeMs: 180
deadZone: 0.10
deadZoneRelease: 0.14
```

- [x] **Step 4: Run config tests and verify GREEN**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: all config tests pass.

### Task 3: Implement center enter/release hysteresis

**Files:**
- Modify: `tests/stackchan-attention-controller.test.ts`
- Modify: `src/modules/stackchan/attention-controller.ts`

- [x] **Step 1: Write failing state-transition tests**

Use explicit `deadZone: 0.1` and `deadZoneRelease: 0.14`:

```ts
it("holds inside the release zone after entering center", () => {
  const entered = advanceAttentionState(
    initialAttentionState(),
    targetInput({ centerX: 0.58 }),
    config
  );
  const retained = advanceAttentionState(
    entered.state,
    targetInput({ centerX: 0.63 }),
    config
  );

  expect(entered.target?.centered).toBe(true);
  expect(retained.target?.centered).toBe(true);
  expect(retained.effect).toEqual({ kind: "hold" });
});

it("leaves center beyond the release zone", () => {
  const entered = advanceAttentionState(
    initialAttentionState(),
    targetInput({ centerX: 0.58 }),
    config
  );
  const released = advanceAttentionState(
    entered.state,
    targetInput({ centerX: 0.65 }),
    config
  );

  expect(released.target?.centered).toBe(false);
  expect(released.effect.kind).toBe("move");
});
```

- [x] **Step 2: Run controller tests and verify RED**

Run:

```bash
npx vitest run tests/stackchan-attention-controller.test.ts
```

Expected: the first release-zone test reports `centered: false`.

- [x] **Step 3: Store only the hysteresis state**

Add `readonly centered: boolean` to `StackChanAttentionState`, initialize it to `false`,
and derive the next value without adding filters or history:

```ts
const threshold = state.centered ? config.deadZoneRelease : config.deadZone;
const centered =
  Math.abs(horizontalError) <= threshold && Math.abs(verticalError) <= threshold;
```

Set `centered: false` when transitioning to scan, preserve it during loss hold, and include
`deadZoneRelease` in `attentionControllerConfig`.

- [x] **Step 4: Run controller tests and verify GREEN**

Run:

```bash
npx vitest run tests/stackchan-attention-controller.test.ts
```

Expected: all controller tests pass.

### Task 4: Replace busy suppression with bounded latest-pending control

**Files:**
- Modify: `tests/stackchan-attention-runtime.test.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`

- [x] **Step 1: Write failing pipeline tests**

Use deferred move promises and manual scheduler ticks to prove all contracts:

```ts
it("replaces a busy pending move and dispatches only the latest pose", async () => {
  await tickWithTarget(0.75);
  await tickWithTarget(0.25);
  await tickWithTarget(0.8);

  expect(movePoses).toEqual([home, { yaw: 4, pitch: 35 }]);
  firstMove.resolve();
  await nextTurn();
  expect(movePoses).toEqual([home, { yaw: 4, pitch: 35 }, { yaw: 8, pitch: 35 }]);
  expect(runtime.status().flow.pendingMoveDepth).toBe(0);
  expect(runtime.status().flow.pendingMoveReplacements).toBe(1);
});

it("clears the pending correction when the latest observation is centered", async () => {
  await tickWithTarget(0.75);
  await tickWithTarget(0.8);
  await tickWithTarget(0.5);
  firstMove.resolve();
  await nextTurn();
  expect(movePoses).toEqual([home, { yaw: 4, pitch: 35 }]);
});

it("rejects stale and repeated stream frames before inference dispatch", async () => {
  frameQueue.push(frame({ sequence: 10, receivedAtMs: 800 }));
  nowMs = 1_000;
  await tick();
  frameQueue.push(frame({ sequence: 10, receivedAtMs: 990 }));
  await tick();

  expect(detectCalls).toBe(0);
  expect(runtime.status().flow.staleFramesDiscarded).toBe(2);
  expect(runtime.status().flow.staleFrameDispatches).toBe(0);
});
```

Add separate assertions that:

- the second busy observation computes from the in-flight target, not from the earlier pending pose;
- `commandedPose` advances before the first move promise resolves;
- a failed in-flight move clears pending and rebases the next correction on the last successful pose;
- completing a move does not trigger another capture;
- stop clears pending and never dispatches it.

- [x] **Step 2: Run runtime tests and verify RED**

Run:

```bash
npx vitest run tests/stackchan-attention-runtime.test.ts
```

Expected: failures show busy commands are suppressed, pose updates on completion, stale frames reach
the detector, and post-move capture still runs.

- [x] **Step 3: Implement frame freshness before inference**

Track the last accepted sequence and reject a stream frame before `model.detect`:

```ts
function isFreshAttentionFrame(
  frame: StackChanJpegFrame,
  nowMs: number,
  lastSequence: number | undefined,
  maximumAgeMs: number
): boolean {
  return (
    frame.sequence !== undefined &&
    frame.receivedAtMs !== undefined &&
    frame.sequence > (lastSequence ?? -1) &&
    nowMs - frame.receivedAtMs >= 0 &&
    nowMs - frame.receivedAtMs <= maximumAgeMs
  );
}
```

Record sequence only when accepted. Missing production stream metadata is fail-closed. Increment
`staleFramesDiscarded`; never call `startMove` for rejected frames.

- [x] **Step 4: Implement the bounded command pipeline**

Replace refresh flags and counters with:

```ts
type PendingMove = {
  readonly pose: StackChanHeadPose;
  readonly token: number;
};

let confirmedPose: StackChanHeadPose | undefined;
let commandedPose: StackChanHeadPose | undefined;
let pendingMove: PendingMove | undefined;
```

At send time, set `commandedPose = pose`. While a move is active, replace `pendingMove`; a hold
effect clears it. On success, set `confirmedPose`, increment `moveCount`, and dispatch the current
pending move directly. On failure, restore `commandedPose` from `confirmedPose`, clear pending, and
record `tick_failed`. Token and phase checks must happen before pending dispatch. Stop invalidation
clears pending before draining the one active move.

Expose:

```ts
readonly lastAcceptedFrameSequence?: number;
readonly staleFramesDiscarded: number;
readonly staleFrameDispatches: number;
readonly pendingMoveDepth: 0 | 1;
readonly pendingMoveReplacements: number;
readonly pendingMoveDispatches: number;
readonly activeMoves: number;
readonly maximumConcurrentMoves: number;
```

Remove `postMoveRefreshRequests`, `postMoveRefreshRuns`, and the microtask refresh path.

- [x] **Step 5: Run runtime tests and verify GREEN**

Run:

```bash
npx vitest run tests/stackchan-attention-runtime.test.ts
```

Expected: all runtime tests pass; maximum concurrent moves remains one and capture count does not
increase when a move settles.

### Task 5: Update field evidence and run repository gates

**Files:**
- Modify: `tests/stackchan-face-follow-field.test.ts`
- Modify: `tests/stackchan-attention-capacity-field.test.ts`
- Modify: `tests/stackchan-attention-owner.test.ts`
- Modify: `scripts/field/stackchan-face-follow.ts`
- Modify: any typed fixtures reported by TypeScript after the preceding contract changes

- [x] **Step 1: Write failing field-report assertions**

Require the report to carry p99 distributions and the new flow counters:

```ts
expect(report.control).toMatchObject({
  lastAcceptedFrameSequence: expect.any(Number),
  staleFramesDiscarded: 0,
  staleFrameDispatches: 0,
  maximumPendingMoveDepth: 1,
  cameraMoveMutualWaits: 0
});
expect(report.performance.observationIntervalMs.p99Ms).toBeLessThanOrEqual(200);
expect(report.performance.frameAgeMs.p99Ms).toBeLessThanOrEqual(180);
```

Update fixture configs by explicitly supplying `maxFrameAgeMs` and `deadZoneRelease`. Do not assert
the parser's default literal values.

- [x] **Step 2: Run field and owner tests and verify RED**

Run:

```bash
npx vitest run tests/stackchan-face-follow-field.test.ts tests/stackchan-attention-capacity-field.test.ts tests/stackchan-attention-owner.test.ts
```

Expected: compile or assertion failures identify the old refresh counters and missing p99/control
evidence.

- [x] **Step 3: Update instrumentation and acceptance**

Replace refresh-counter serialization with the runtime flow fields from Task 4. Extend the existing
distribution summarizer to include:

```ts
readonly p99Ms: number;
```

Use percentile `0.99`, record maximum pending depth from status snapshots, and evaluate the accepted
125 ms block with:

```ts
observationIntervalMs.p95Ms <= 150 &&
observationIntervalMs.p99Ms <= 200 &&
frameAgeMs.p95Ms <= 140 &&
frameAgeMs.p99Ms <= 180 &&
staleFrameDispatches === 0 &&
maximumPendingMoveDepth <= 1 &&
cameraMoveMutualWaits === 0
```

Keep centered-ratio reporting separate from machine acceptance when no human target is present.

- [x] **Step 4: Run focused tests and static checks**

Run:

```bash
npx vitest run tests/stackchan.test.ts tests/config.test.ts tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-face-follow-field.test.ts tests/stackchan-attention-capacity-field.test.ts tests/stackchan-attention-owner.test.ts
just typecheck
just lint
just ast
```

Expected: every command exits zero.

- [x] **Step 5: Run all local gates**

Run:

```bash
just check
npx secretlint .
```

Expected: both commands exit zero. Do not create a commit or open a pull request.

- [x] **Step 6: Run bounded pre-human field diagnostics**

With the existing authenticated local StackChan gateway and explicit live flag, run the repository's
bounded capacity and follow commands documented in `TOOLS.md`. Accept the machine slice only if:

```text
observation interval p95 <= 150 ms and p99 <= 200 ms
decision frame age p95 <= 140 ms and p99 <= 180 ms
stale dispatches = 0
maximum pending depth <= 1
camera/move mutual waits = 0
runtime errors = 0
home returned = true
```

Do not claim the provisional human centered-ratio threshold until a person is in frame.
