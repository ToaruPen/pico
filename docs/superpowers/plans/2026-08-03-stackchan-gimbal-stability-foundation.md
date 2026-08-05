# StackChan Gimbal Stability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing 8 fps camera and small-amplitude servo path repeatable before resuming subjective person-follow tuning.

**Architecture:** Keep the known-smooth controller frozen and use the existing field evidence to find the first failing boundary. Credit-depth and production-lane A/B did not remove shared-send starvation, so the implemented endpoint now has separate authenticated control/media WebSockets and the firmware uses one dedicated latest-only camera sender lane. No runtime service, retry layer, fallback transport, generic queue, or new control algorithm is added.

**Tech Stack:** Python 3.13, pytest, asyncio, TypeScript 6, Vitest, MCP SDK 1.29, existing StackChan Gateway and field harness.

---

The user explicitly requested no commit. All commit steps normally required by the planning workflow are intentionally omitted.

### Task 1: Limit the existing camera producer to one outstanding frame

Run this task's commands from `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway`.

**Files:**
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_camera_stream.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/camera_stream.py`

- [x] **Step 1: Change the stream lifecycle assertions to require one initial credit**

Update the two credit assertions in `gateway/tests/test_camera_stream.py`:

```python
assert device.credits == [1]
```

and after reconnect:

```python
assert device.credits == [1, 1]
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
uv run pytest tests/test_camera_stream.py -q
```

Expected: the start and reconnect tests fail because the service still sends credit `4`.

- [x] **Step 3: Introduce one named camera in-flight limit and use it at stream start**

Add next to the camera stream constants in `gateway/stackchan_mcp/camera_stream.py`:

```python
CAMERA_STREAM_MAX_IN_FLIGHT_FRAMES = 1
```

Replace the start credit call with:

```python
await self._device.send_camera_stream_credit(
    CAMERA_STREAM_MAX_IN_FLIGHT_FRAMES
)
```

Do not change the one-credit replenishment after each accepted frame and do not add retries.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_camera_stream.py tests/test_esp32_client.py -q
```

Expected: both files pass.

### Task 2: Define the deterministic 20-second stability experiment

**Files:**
- Modify: `/Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing/tests/stackchan-servo-latency-field.test.ts`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing/scripts/field/stackchan-servo-latency.ts`

- [x] **Step 1: Write failing argument and experiment-shape assertions**

Change the contention invocation in the test to:

```ts
expect(
  parseContentionArguments([
    "--enable-live-run",
    "--camera-contention",
    "--duration-ms",
    "20000",
    "--consecutive-load-runs",
    "3",
    "--report-output",
    "/tmp/stackchan-stability.json"
  ])
).toEqual({
  enableLiveRun: true,
  durationMs: 20_000,
  consecutiveLoadRuns: 3,
  reportOutput: "/tmp/stackchan-stability.json"
});
```

Assert the deterministic shape:

```ts
expect(report.details.blockOrder).toEqual([
  "off",
  "stream",
  "load",
  "load",
  "load"
]);
expect(report.details.durationMs).toBe(20_000);
expect(report.details.commandIntervalMs).toBe(500);
expect(report.details.sweepExtentDeg).toBe(3);
```

- [x] **Step 2: Run the focused Vitest file and verify RED**

Run:

```bash
npm test -- --run tests/stackchan-servo-latency-field.test.ts
```

Expected: argument parsing and report-shape assertions fail because the harness still uses `samplesPerBlock`, six symmetric blocks, and 4-degree targets.

- [x] **Step 3: Replace sample-count options with the explicit stability contract**

In `scripts/field/stackchan-servo-latency.ts`, define:

```ts
export type StackChanServoContentionOptions = {
  readonly enableLiveRun: true;
  readonly durationMs: number;
  readonly consecutiveLoadRuns: number;
  readonly reportOutput: string;
};

const contentionWarmupCommands = 4;
const contentionCommandIntervalMs = 500;
const contentionSweepExtentDeg = 3;
const contentionObservationIntervalMs = 125;
```

Parse exact arguments and require an absolute report path:

```ts
return {
  enableLiveRun: true,
  durationMs: requireBoundedPositiveInteger(values, "--duration-ms", 60_000),
  consecutiveLoadRuns: requireBoundedPositiveInteger(
    values,
    "--consecutive-load-runs",
    5
  ),
  reportOutput: requireAbsolutePath(values, "--report-output")
};
```

Construct the block order without adding a new experiment runner:

```ts
const blockOrder: readonly StackChanServoContentionCondition[] = [
  "off",
  "stream",
  ...Array<StackChanServoContentionCondition>(options.consecutiveLoadRuns).fill("load")
];
```

- [x] **Step 4: Make each block deadline-driven and use the safe 3-degree trajectory**

Replace count-driven command iteration with a deadline:

```ts
const startedAtMs = input.monotonicNowMs();
const deadlineMs = startedAtMs + input.durationMs;
let commandIndex = 0;
let nextCommandAtMs = startedAtMs;
while (nextCommandAtMs < deadlineMs) {
  await input.waitMs(Math.max(0, nextCommandAtMs - input.monotonicNowMs()));
  if (input.monotonicNowMs() >= deadlineMs) {
    break;
  }
  const measured = commandIndex >= contentionWarmupCommands;
  const commandStartedAtMs = input.monotonicNowMs();
  await adapter.moveHead(contentionTrajectoryPose(input.homePose, commandIndex), {
    speedDps: input.moveSpeedDps
  });
  if (measured) {
    recordLatency(moveLatencyMs, input.monotonicNowMs() - commandStartedAtMs);
  }
  commandIndex++;
  nextCommandAtMs += contentionCommandIntervalMs;
}
```

Use exactly this trajectory:

```ts
const offsets = [3, 0, -3, 0] as const;
return {
  yaw: homePose.yaw + (offsets[commandIndex % offsets.length] ?? 0),
  pitch: homePose.pitch
};
```

- [x] **Step 5: Write the report atomically instead of relying on shell redirection**

Reuse the repository's existing `open`/`rename`/`unlink` pattern and call it before returning:

```ts
await writeAtomicJsonReport(options.reportOutput, report);
return report;
```

The output file must be created with mode `0600`.

- [x] **Step 6: Run the focused Vitest file and verify GREEN**

Run:

```bash
npm test -- --run tests/stackchan-servo-latency-field.test.ts
```

Expected: the deterministic argument, order, duration, and trajectory tests pass.

### Task 3: Add boundary evidence and the three-run gate to the same field report

**Files:**
- Modify: `/Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing/tests/stackchan-servo-latency-field.test.ts`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing/scripts/field/stackchan-servo-latency.ts`

- [x] **Step 1: Add a field-only diagnostic boundary to the test dependencies**

Define the injected contract in the test and production file:

```ts
type StackChanStabilityDiagnostics = {
  readonly beginNativeTelemetry: () => Promise<void>;
  readonly finishNativeTelemetry: () => Promise<{
    readonly attemptedWrites: number;
    readonly ackFailures: number;
    readonly overflowCount: number;
  }>;
  readonly readGatewaySessionId: () => Promise<string>;
  readonly readAutoSleepEnabled: () => Promise<boolean>;
  readonly close: () => Promise<void>;
};
```

Inject `createDiagnostics` through `StackChanServoContentionDependencies`. The fake must return stable session `session-1`, auto-sleep `false`, and zero native failures.

- [x] **Step 2: Add failing assertions for the required boundary evidence**

For every completed block assert:

```ts
expect(block.gatewaySessionStable).toBe(true);
expect(block.nativeWrites).toEqual({
  attemptedWrites: expect.any(Number),
  ackFailures: 0,
  overflowCount: 0
});
expect(block.autoSleepEnabled).toBe(false);
expect(block.minimumCommandedPitch).toBeGreaterThanOrEqual(23);
expect(block.stopAndHomeMs).toBeLessThanOrEqual(5_000);
```

For stream and load blocks assert:

```ts
expect(block.camera.observationGapMs.maxMs).toBeLessThanOrEqual(500);
```

At report level assert:

```ts
expect(report.details.consecutiveLoadPasses).toBe(3);
expect(report.status).toBe("passed");
```

- [x] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm test -- --run tests/stackchan-servo-latency-field.test.ts
```

Expected: the new evidence fields are absent.

- [x] **Step 4: Observe camera frames for both stream conditions**

Generalize the current load loop so `stream` captures frames without inference and `load` captures then runs PINTO. Record the interval between successful observations:

```ts
if (previousObservationAtMs !== undefined) {
  recordLatency(
    measurements.observationGapMs,
    observedAtMs - previousObservationAtMs
  );
}
previousObservationAtMs = observedAtMs;
```

Keep the 125 ms cadence and retain only aggregate distributions.

- [x] **Step 5: Implement the narrow MCP diagnostic client inside the field harness**

Use the same authenticated MCP SDK connection pattern already present in the file. Call only existing tools:

```ts
set_native_write_diagnostics({
  suppress_duplicate_native_writes: false,
  telemetry_enabled: true,
  clear_telemetry: true
});
get_native_write_telemetry({ offset, limit: 128 });
get_status({});
get_auto_sleep({});
```

Before each block, save the gateway session ID and enable cleared observer-only telemetry. After camera/servo activity is stopped, disable telemetry, read all pages, count only events with `attempted === true`, count `ack_ok === false`, record overflow, re-read the session ID and auto-sleep, then close the diagnostic client. Do not enable duplicate suppression.

- [x] **Step 6: Compute each block gate without retry or fallback**

Use:

```ts
const boundaryPassed =
  gatewaySessionStable &&
  nativeWrites.ackFailures === 0 &&
  nativeWrites.overflowCount === 0 &&
  autoSleepEnabled === false &&
  minimumCommandedPitch >= 23 &&
  home.returnedHome &&
  stopAndHomeMs <= 5_000 &&
  (condition === "off" || camera.observationGapMs.maxMs <= 500);
```

Stop the experiment on the first failed block. Count only consecutive passing `load` blocks and require the requested count for report status.

- [x] **Step 7: Run the focused test and verify GREEN**

Run:

```bash
npm test -- --run tests/stackchan-servo-latency-field.test.ts
```

Expected: all field-harness tests pass, including cleanup after a simulated inference failure.

### Task 4: Run complete offline verification

Run Gateway commands from `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway` and Pico commands from `/Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing`.

**Files:**
- Verify only; do not modify unrelated files.

- [x] **Step 1: Run Gateway tests and lint**

Run:

```bash
uv run pytest tests -q
uv run ruff check stackchan_mcp tests
```

Expected: all Gateway tests pass and Ruff reports no errors.

- [x] **Step 2: Run Pico focused and full gates**

Run:

```bash
npm test -- --run tests/stackchan-servo-latency-field.test.ts tests/stackchan.test.ts
just check
```

Expected: focused tests and every repository gate pass.

- [x] **Step 3: Confirm scope and frozen controller settings**

Run:

```bash
git diff --check
git diff -- scripts/field/stackchan-servo-latency.ts tests/stackchan-servo-latency-field.test.ts .pico-local/field-stackchan.yaml
```

Confirm the field YAML still contains 8 fps, pitch floor 23, 125 ms observations, 10 Hz commands, max step 4, speed 90, round quantization, filter disabled, and auto-sleep is not enabled by code.

### Task 5: Run the attended physical stability gate

**Files:**
- Create evidence under `/Users/monsoon/.pico/field-runs/stackchan-gimbal-stability-foundation.<timestamp>/`
- Do not commit evidence or print environment values.

- [x] **Step 1: Start the Gateway with the existing secret environment file**

Load `/Users/monsoon/.pico/stackchan-mcp/local-gateway.env` without printing its contents and start the current Gateway on WebSocket 18765, camera 18766, MCP HTTP 18767. Wait for one initialized ESP32 connection.

- [x] **Step 2: Verify the preconditions without moving the head**

Confirm camera stopped, actual pose within one degree of yaw 0 / pitch 33, and `get_auto_sleep` returns `enabled=false`.

- [x] **Step 3: Run the deterministic stability field command**

Run from the Pico worktree with `PICO_CONFIG_PATH` pointing at `.pico-local/field-stackchan.yaml`:

```bash
npx jiti scripts/field/stackchan-servo-latency.ts \
  --enable-live-run \
  --camera-contention \
  --duration-ms 20000 \
  --consecutive-load-runs 3 \
  --report-output /Users/monsoon/.pico/field-runs/<run>/stability.json
```

Expected: off and stream baselines pass, followed by three consecutive passing load blocks. No pitch below 23 is commanded.

- [x] **Step 4: Verify terminal safety independently**

After the command exits, independently confirm camera stopped, actual yaw/pitch within one degree of 0/33, `auto-sleep=false`, Gateway session unchanged, and no native telemetry remains enabled.

- [x] **Step 5: Decide from evidence**

If all three load blocks pass, keep one-credit and resume the known-smooth 20-second person-follow baseline in a separate plan. If any block fails, do not tune the controller or retry the run; identify the first failing boundary from the report and write the next minimal TDD slice for that boundary only.

The one-credit run failed first at the stream-only camera observation boundary:
`max=1125.91 ms` with zero disconnects, zero native ACK failures, zero
telemetry overflow, a stable Gateway session, and a safe terminal state. Native
write telemetry excluded the servo UART as the cause (`p95=1948 us`,
`max=10514 us`). The remaining serial wait is the camera credit round trip.

### Task 6: A/B the minimum two-stage latest-only camera pipeline

**Files:**
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Test: `gateway/tests/test_camera_stream.py`
- Create evidence under `/Users/monsoon/.pico/field-runs/stackchan-gimbal-stability-foundation.two-credit.<timestamp>/`

- [x] **Step 1: Require two initial credits and verify RED**

The firmware owns one replaceable latest-camera packet slot. Two credits cover
one WebSocket send plus one replaceable pending frame without restoring the old
four-credit burst window.

- [x] **Step 2: Set the named in-flight limit to two and verify Gateway GREEN**

Focused Gateway tests, the full Gateway suite, and Ruff must pass.

- [x] **Step 3: Run the same attended deterministic stability gate**

Keep every parameter and safety condition from Task 5 unchanged so camera
credit depth is the only A/B variable.

- [x] **Step 4: Verify terminal safety independently**

- [x] **Step 5: Decide from evidence**

If the stream block and all three load blocks pass, retain two credits. If the
first failing boundary remains camera observation, stop without controller
tuning and isolate credit delivery versus firmware packet scheduling with a
single additional timestamp boundary.

The two-credit run materially improved the normal path (`5.7-5.9 fps`; stream
and first load block passed), so one credit was rejected and four credits were
kept out of the still-shared control/media transport at this stage. The second load block still failed with a device capture gap of
`1421 ms`, inference `max=32.37 ms`, zero native ACK failures, zero telemetry
overflow, and a stable Gateway session. Explicit MCP session termination fixed
the validation lifecycle leak but did not remove this intermittent device-side
capture gap. Terminal safety was independently confirmed; a final yaw `0`
command settled at measured `-2`, pitch `33`, with camera stopped and
auto-sleep disabled.

### Task 7: Isolate Gateway credit delivery from device capture scheduling

**Files:**
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Test: `gateway/tests/test_camera_stream.py`
- Test: `gateway/tests/test_esp32_client.py`
- Modify: `scripts/field/stackchan-servo-latency.ts`
- Test: `tests/stackchan-servo-latency-field.test.ts`

- [x] **Step 1: Add a failing Gateway test for bounded credit-send evidence**

Require per-physical-stream `count`, `failures`, and `max_us` in the existing
camera lifecycle status. Initial and replenishment credits must share the same
measurement owner, and a new physical start must reset the aggregate.

- [x] **Step 2: Implement one measured credit-send path and verify Gateway GREEN**

Route both the initial two credits and every accepted-frame replenishment
through `CameraStreamService`. Keep telemetry aggregate-only and do not change
credit depth, frame ownership, or scheduling.

- [x] **Step 3: Add the evidence to the field report with failing-then-passing tests**

Read the three status fields at block end and emit them without using them as a
pass/fail gate. Do not change motion, camera, inference, or safety parameters.

- [x] **Step 4: Run full offline verification**

Run the full Gateway suite and Ruff, focused Pico tests, `just check`,
`git diff --check`, and the frozen-controller configuration check.

- [x] **Step 5: Run one attended deterministic stability gate**

If a capture gap exceeds 500 ms while credit `max_us` stays small and failures
remain zero, the next boundary is inside ESP32 after credit delivery (camera
thread scheduling versus `VIDIOC_DQBUF`). If credit send itself stalls, fix
that Gateway/WebSocket path first. Stop after the first failed block and verify
terminal safety independently.

The first credit-boundary run never reached a camera block. The `off` block
failed with synchronous `move_head` latency `p95=2180 ms`, `max=2640.95 ms`, a
device WebSocket session change, and a 10-second cleanup timeout. Gateway logs
then showed a keepalive ping timeout. The terminal state was independently
restored to measured yaw `-1`, pitch `33`, camera stopped, auto-sleep disabled,
and telemetry disabled. This exposed a validation-path error: the `off` block
uses direct `move_head` with WiFi `min_modem`, while production person follow
uses `stackchan_head_target_lane`, whose lease holds WiFi power save at `none`.
The baseline was therefore measuring a different transport path and power
condition from production.

### Task 8: Put the stability gate on the production latest-only lane

**Files:**
- Modify: `scripts/field/stackchan-servo-latency.ts`
- Test: `tests/stackchan-servo-latency-field.test.ts`
- Modify: `src/modules/stackchan/head-target-lane.ts`
- Test: `tests/stackchan-head-target-lane.test.ts`

- [x] **Step 1: Add failing field tests for one lane lifecycle per block**

Require `connect -> start -> update -> stop -> close` for `stream` and each
`load` block. The invalid `off` block is removed from this production gate;
direct servo/UART evidence remains a separate diagnostic. Assert the production configuration (10 Hz, max step 4,
pending age 180 ms, speed 90), maximum active calls one, maximum pending depth
one, no post-stop dispatch, and lane close before direct home restore.

- [x] **Step 2: Route contention commands through the production lane**

Use the camera adapter for stream ownership, frame reads, and home restore while
its WiFi lease is still active. Use `StackChanHeadTargetLane` for every block's
yaw targets so all production conditions share the same latest-only transport.
Preserve yaw ±3, pitch 33, camera/inference conditions, no retry, and the
existing safety cleanup.

- [x] **Step 3: Terminate the lane's HTTP MCP session explicitly**

Use the already tested `closeStackChanMcpSession` helper in
`createStackChanHeadTargetLaneFromConfig`; do not add another lifecycle layer.

- [x] **Step 4: Run full offline verification**

- [x] **Step 5: Run one attended gate and decide from its first failed boundary**

The first production-lane attempt exposed an ordering error in the harness:
the lane reserved the Gateway servo path before diagnostic setup. After moving
diagnostic setup before lane start, the next run stopped before any motion.
Camera streaming produced two frames, then the lane's initial physical
`get_head_angles` call timed out. Gateway camera-credit sends remained healthy
(`count=3`, `failures=0`, `max=175 us`), while the same ESP32 WebSocket later
missed its keepalive ping. The equal 10-second Gateway/device and Pico/MCP
deadlines also cancelled the HTTP request while the late result was being
written, triggering the MCP SDK's `Request already responded to` assertion.
The head was recovered to measured yaw `-1`, pitch `33`; camera, native
telemetry, and Gateway were stopped, and auto-sleep remained disabled.

### Task 9: Remove the blocking seed read and separate nested deadlines

**Files:**
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Test: `gateway/tests/test_esp32_client.py`
- Modify: `.pico-local/field-stackchan.yaml`

- [x] **Step 1: Add a failing test for a non-bus lane seed**

Require `ESP32Manager.read_head_target_pose()` to call
`self.robot.get_head_angles` with `cached_motion_state=true`. The firmware
already exposes this current interpolator pose specifically without servo-bus
I/O; lane startup must not put a physical `ReadPos` loop on the firmware main
task while camera egress is active.

- [x] **Step 2: Implement the one-argument change and verify GREEN**

Do not add retries, fallback reads, or another state owner. The existing lane
continues to use the returned `yaw` and `pitch` as both confirmed and planned
seed poses.

- [x] **Step 3: Put the field client's deadline outside the Gateway deadline**

Change only the ignored field YAML timeout from 10 seconds to 12 seconds. The
Gateway retains its 10-second device-response timeout, so a stalled device
returns a bounded tool error before the outer MCP client cancels the request.

- [x] **Step 4: Run Gateway focused and full offline verification**

The new test failed with `{}` and passed with
`{"cached_motion_state": true}`. Gateway completed `799 passed, 5 skipped`,
and Ruff passed.

- [x] **Step 5: Run one fresh production-lane gate after a clean device reset**

This is an infrastructure A/B only. Keep two camera credits, active-call depth
one, yaw ±3, pitch 33, and all frozen controller settings. Do not tune the
controller. Stop on the first failed boundary and independently verify home,
camera stopped, telemetry disabled, and auto-sleep disabled.

The fresh run proved that detector and inference latency were not the cause,
but camera binary egress could still block the shared ESP32 WebSocket and the
firmware main task. A camera stop followed by WiFi power-save restoration was
delayed about 10.8 seconds while a synchronous camera send occupied the main
task.

### Task 10: Separate camera media from the MCP control socket

**Files:**
- Modify: `gateway/stackchan_mcp/esp32_client.py`
- Modify: `gateway/stackchan_mcp/camera_stream.py`
- Test: `gateway/tests/test_esp32_client.py`
- Modify: `firmware/main/protocols/websocket_protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.cc`
- Test: `firmware/host_test/test_camera_stream_protocol.cc`

- [x] **Step 1: Require an authenticated, identity-matched media connection**

Use the existing Gateway WebSocket endpoint, Bearer token, and device identity.
The media connection accepts camera credits and SCL1 binary only. A control
connection must already exist; mismatched, unauthenticated, or disconnected
connections are rejected.

- [x] **Step 2: Remove media fallback to the control socket**

Firmware sends camera binary only when the dedicated media connection is
ready. Unexpected media disconnect stops the camera session and reconnects the
pair. Control SCL1 binary is rejected.

- [x] **Step 3: Fix the connection registration ordering race**

Register the control connection before replying to the hello request. Firmware
opens media immediately after hello, so replying first allowed the media attach
to race ahead of registration.

- [x] **Step 4: Verify Gateway and firmware host contracts**

Gateway completed `812 passed, 5 skipped`; Ruff passed. Firmware host tests
covered authentication, identity, media readiness, no fallback, disconnect
behavior, and packet/credit ownership.

### Task 11: Move camera WebSocket send off the firmware main task

**Files:**
- Modify: `firmware/main/camera_stream_protocol.h`
- Modify: `firmware/main/application.h`
- Modify: `firmware/main/application.cc`
- Modify: `firmware/main/protocols/websocket_protocol.h`
- Modify: `firmware/main/protocols/websocket_protocol.cc`
- Test: `firmware/host_test/test_camera_stream_protocol.cc`

- [x] **Step 1: Add one dedicated latest-only sender lane**

Reuse one replaceable packet slot. Capture-side publish never waits for network
send; a replaced or unsent packet refunds exactly one credit. Do not add a
second queue, retry, or fallback.

- [x] **Step 2: Make lane teardown safe**

An owner mutex serializes publish with lane move/reset. The blocking worker join
runs outside that mutex, so new publish is rejected and refunded during
teardown. The concurrent teardown test failed before the owner existed and
passes after the fix.

- [x] **Step 3: Run complete offline verification and review**

Firmware host tests passed `70/70`; the canonical ESP-IDF 5.5.2 StackChan build
completed; diff check passed. Independent review found the initial teardown UAF,
approved the owner fix, and found no remaining race/deadlock in this slice.

- [x] **Step 4: Flash the actually booted OTA slot and run camera-only A/B**

The device boots `ota_1`, so flash `xiaozhi.bin` to 0x410000. A 40-frame run
completed in 8.9 seconds with zero sequence gaps and immediate post-stop control
response. USB-observed repeat completed in 7.1 seconds with p95 201 ms, max
447 ms, and zero gaps. WiFi restore completed in about 1.2 seconds instead of
the previous 10.8-second control starvation. With media isolated and the
firmware still retaining only one pending packet, the initial credit window is
restored to the proven four-credit cadence baseline.

- [x] **Step 5: Run safe motion boundaries**

Camera plus yaw `0 -> +15 -> 0 -> -15 -> home` completed with 40 frames and zero
gaps. Pitch `33 -> 23 -> 37 -> 33` respected the 23-degree floor. Every terminal
check showed camera stopped and auto-sleep disabled.

### Task 12: Resume the known-smooth 20-second person-follow baseline

- [x] **Step 1: Attempt one 20-second run without changing the controller**

The run completed with control `44/44`, active depth one, acknowledgment p95
5 ms, and immediate cleanup, but detected zero target frames and therefore
executed scan behavior only.

- [x] **Step 2: Separate detector behavior from the control result**

A 30-frame detector probe returned zero head/face candidates. Temporary visual
inspection showed a valid but nearly black 320x240 image, unchanged between
pitch 33 and 23. The camera is physically pointed away from the user or covered,
and does not move with the head. Temporary images were deleted.

- [ ] **Step 3: Re-run after the physical camera view contains the user**

Keep all controller parameters frozen. Accept or reject by the user's report of
smoothness, tracking speed, wrong direction, jumps, and freezes. Do not use the
scan-only run or frame rate as subjective acceptance evidence.
