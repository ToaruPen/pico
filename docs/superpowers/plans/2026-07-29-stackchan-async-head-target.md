# StackChan Async Latest Head Target Implementation Plan

> **Historical record — non-executable.** This file preserves the original execution history.
> Do not execute any checkbox or code instruction below. Its active-two/planned-frontier correction
> was also superseded by the later production single-flight contract (`active=1`, one replaceable
> pending target) and the current Gateway tests. Use the current implementation, tests, and latest
> restoration/stability plans as the executable source of truth.

**Goal:** Move StackChan follow commands through a gateway-owned asynchronous latest-only lane so Pico acknowledgments do not wait for ESP32 device responses.

**Architecture:** Add one refcount-safe gateway service with one active device call and one replaceable pending absolute target. Expose it as an authenticated bypass MCP tool, then give Pico a separate typed lane client and replace its local move queue while preserving camera ownership, controller behavior, and stop-before-home ordering.

**Tech Stack:** Python 3.10+, asyncio, MCP Python SDK, pytest, Ruff, TypeScript, MCP TypeScript SDK, Vitest, ONNX Runtime, YAML, Just.

---

Commit steps are intentionally omitted because both repositories require explicit user authorization before committing. Do not stage, commit, push, or open a PR while executing this plan.

## File map

### stackchan-mcp worktree

- Create `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/head_target_lane.py`: owns lease state, latest pending target, rate limiting, device dispatch, Wi-Fi lease, bounded stop, and aggregate status.
- Create `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_head_target_lane.py`: deterministic lane behavior tests.
- Modify `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/esp32_client.py`: owns one lane per ESP32 manager and stops it during gateway shutdown/disconnect.
- Modify `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/stdio_server.py`: validates and dispatches `stackchan_head_target_lane`.
- Modify `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/http_server.py`: bypasses the generic device command queue for local mailbox actions.
- Modify `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_stdio_server.py`: tool schema and lifecycle routing tests.
- Modify `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_http_server.py`: bypass and non-starvation tests.

### Pico worktree

- Create `src/modules/stackchan/head-target-lane.ts`: typed MCP client and strict response validation.
- Create `tests/stackchan-head-target-lane.test.ts`: tool contract and error containment tests.
- Modify `src/config/index.ts`: explicit `async-latest` transport and rate fields.
- Modify `config/pico.example.yaml`: recommended transport values.
- Modify `tests/config.test.ts`: explicit config and invalid boundaries.
- Modify `src/runtime/stackchan-attention-owner.ts`: creates the camera adapter and lane client as separate dependencies.
- Modify `src/runtime/stackchan-attention-runtime.ts`: submits absolute targets, clears pending work, stops the lane before home, and projects lane counters.
- Modify `tests/stackchan-attention-owner.test.ts`: owner wiring and cleanup.
- Modify `tests/stackchan-attention-runtime.test.ts`: asynchronous acknowledgment, clear, failure, and stop ordering.
- Create `scripts/field/stackchan-head-target-lane.ts`: bounded synthetic update/status/stop stress against the live gateway lane.
- Create `tests/stackchan-head-target-lane-field.test.ts`: stress CLI parsing, aggregate-only report shape, and threshold tests.
- Modify `scripts/field/stackchan-face-follow.ts`: acknowledgment and gateway dispatch distributions.
- Modify `tests/stackchan-attention-capacity-field.test.ts`: bounded capacity acceptance.
- Modify `tests/stackchan-face-follow-field.test.ts`: report shape and pass/fail thresholds.
- Modify `package.json`: expose the synthetic lane stress as `field:stackchan-head-target-lane`.
- Modify `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`: append aggregate results only.

### Task 1: Build the gateway latest-target state machine

**Files:**
- Create: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/head_target_lane.py`
- Create: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_head_target_lane.py`

- [ ] **Step 1: Write the failing lease and replacement tests**

Use a gated fake device and injected monotonic clock. The first test must prove that `update()` returns before `call_tool()` completes and that a third update replaces the second:

```python
@pytest.mark.asyncio
async def test_update_acknowledges_before_device_and_replaces_pending() -> None:
    device = GatedDevice(seed={"yaw": 0, "pitch": 33})
    lane = HeadTargetLane(
        device,
        monotonic_now=device.clock,
        sleep=device.sleep,
        lease_id_factory=lambda: "lease-a",
    )
    started = await lane.start(
        rate_hz=10,
        max_step_deg=4,
        max_pending_age_ms=180,
        speed_dps=90,
    )

    first = await lane.update("lease-a", 1, 4, 33)
    await device.wait_until_move_started()
    second = await lane.update("lease-a", 2, 8, 33)
    third = await lane.update("lease-a", 3, 12, 33)

    assert started["lease_id"] == "lease-a"
    assert first["accepted"] is True
    assert second["pending_depth"] == 1
    assert third["replaced"] is True
    assert lane.status()["maximum_pending_depth"] == 1
    device.finish_move()
    await lane.wait_idle()
    assert [call[1]["yaw"] for call in device.moves] == [4, 8]
```

Add separate tests for:

```python
await lane.update("lease-a", 2, 4, 33)
with pytest.raises(ValueError, match="sequence"):
    await lane.update("lease-a", 2, 4, 33)

await lane.clear("lease-a")
assert lane.status()["pending_depth"] == 0
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cd /Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway
uv run pytest tests/test_head_target_lane.py -q
```

Expected: collection fails because `stackchan_mcp.head_target_lane` does not exist.

- [ ] **Step 3: Implement the minimal public contract**

Create these immutable inputs and service methods:

```python
@dataclass(frozen=True)
class HeadTargetLaneConfig:
    rate_hz: float
    max_step_deg: float
    max_pending_age_ms: int
    speed_dps: int


@dataclass(frozen=True)
class PendingHeadTarget:
    sequence: int
    yaw: int
    pitch: int
    accepted_at: float


class HeadTargetLane:
    def __init__(
        self,
        device: DeviceToolCaller,
        *,
        wifi_power_save: WifiPowerSaveCoordinator,
        monotonic_now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        lease_id_factory: Callable[[], str] = default_lease_id,
        device_call_timeout_seconds: float,
    ) -> None: ...

    async def start(
        self,
        *,
        rate_hz: float,
        max_step_deg: float,
        max_pending_age_ms: int,
        speed_dps: int,
    ) -> dict[str, Any]: ...

    async def update(
        self,
        lease_id: str,
        sequence: int,
        yaw: int,
        pitch: int,
    ) -> dict[str, Any]: ...

    async def clear(self, lease_id: str) -> dict[str, Any]: ...
    def status(self, lease_id: str | None = None) -> dict[str, Any]: ...
    async def stop(self, lease_id: str | None = None) -> dict[str, Any]: ...
    async def wait_idle(self) -> None: ...
```

`start()` must synchronously seed from `self.robot.get_head_angles`, acquire
`wifi_power_save.acquire_wifi_power_save()`, create one worker, and reject a second active lease.
`update()` must validate the lease and strictly increasing safe-integer sequence while holding only
the state lock; it must never await the device.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_head_target_lane.py -q
```

Expected: lease, update, replacement, duplicate-sequence, and clear tests pass.

### Task 2: Add dispatch safety, failures, and bounded shutdown

**Files:**
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_head_target_lane.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/head_target_lane.py`

- [ ] **Step 1: Write failing worker safety tests**

Add deterministic tests for:

```python
@pytest.mark.asyncio
async def test_dispatch_reclamps_from_last_confirmed_after_failure() -> None:
    device = GatedDevice(seed={"yaw": 0, "pitch": 33}, fail_move_numbers={1})
    lane = configured_lane(device, lease_id="lease-a", max_step_deg=4)
    await lane.start(**lane_config())
    await lane.update("lease-a", 1, 4, 33)
    await lane.wait_idle()
    await lane.update("lease-a", 2, 12, 33)
    await lane.wait_idle()

    assert [call[1]["yaw"] for call in device.moves] == [4, 4]
    assert lane.status()["failed"] == 1
    assert lane.status()["confirmed_pose"] == {"yaw": 4, "pitch": 33}
```

```python
@pytest.mark.asyncio
async def test_discards_expired_pending_without_dispatch() -> None:
    device = GatedDevice(seed={"yaw": 0, "pitch": 33})
    lane = configured_lane(device, lease_id="lease-a", max_pending_age_ms=180)
    await lane.start(**lane_config())
    device.hold_next_move()
    await lane.update("lease-a", 1, 4, 33)
    await device.wait_until_move_started()
    await lane.update("lease-a", 2, 8, 33)
    device.advance_ms(181)
    device.finish_move()
    await lane.wait_idle()

    assert len(device.moves) == 1
    assert lane.status()["stale_discarded"] == 1
```

Also assert:

- dispatch start gaps are at least `1 / rate_hz`;
- active calls and pending depth never exceed one;
- failed targets are not retried;
- `stop()` clears pending, drains the active call, releases Wi-Fi once, is idempotent, and sends zero commands afterward;
- status contains no `targets`, `series`, `history`, `center_x`, or image fields.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
uv run pytest tests/test_head_target_lane.py -q
```

Expected: failure rebase, TTL, rate limit, or stop assertions fail because the first implementation does not enforce them.

- [ ] **Step 3: Implement one worker with one replaceable slot**

The worker loop must follow this order:

```python
while True:
    await self._pending_event.wait()
    target = await self._take_pending()
    if target is None:
        if self._phase != "running":
            return
        continue
    await self._wait_for_rate_limit()
    if self._pending_age_ms(target) > self._cfg.max_pending_age_ms:
        self._stale_discarded += 1
        continue
    dispatched = self._clamp_from_confirmed(target)
    self._active_calls = 1
    try:
        result, error = await self._device.call_tool(
            "self.robot.set_head_angles",
            {
                "yaw": dispatched.yaw,
                "pitch": dispatched.pitch,
                "speed_dps": self._cfg.speed_dps,
            },
        )
        self._require_success(result, error)
    except Exception as exc:
        self._failed += 1
        self._last_error = bounded_error(exc)
    else:
        self._confirmed += 1
        self._confirmed_pose = {"yaw": dispatched.yaw, "pitch": dispatched.pitch}
        self._confirmed_sequence = target.sequence
    finally:
        self._active_calls = 0
```

Rate limiting is based on dispatch start time. Stop changes phase before clearing pending, waits for
the worker within the existing device-call timeout, then releases the shared Wi-Fi lease in `finally`.

- [ ] **Step 4: Run gateway lane tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_head_target_lane.py -q
uv run ruff check stackchan_mcp/head_target_lane.py tests/test_head_target_lane.py
```

Expected: all tests and Ruff pass.

### Task 3: Expose the lane through authenticated MCP without queue starvation

**Files:**
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/esp32_client.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/stdio_server.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/http_server.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_esp32_client.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_stdio_server.py`
- Modify: `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/tests/test_http_server.py`

- [ ] **Step 1: Write failing ownership and schema tests**

Assert that `ESP32Manager` owns the lane and shuts it down:

```python
assert isinstance(manager.head_target_lane, HeadTargetLane)
await manager.stop()
assert manager.head_target_lane.status()["phase"] == "stopped"
```

Assert the MCP schema exposes exactly five actions and strict bounds:

```python
tool = tools["stackchan_head_target_lane"]
assert tool.inputSchema["properties"]["action"]["enum"] == [
    "start", "update", "clear", "status", "stop"
]
assert tool.inputSchema["properties"]["rate_hz"]["maximum"] == 10
assert tool.inputSchema["properties"]["max_pending_age_ms"] == {
    "type": "integer",
    "minimum": 50,
    "maximum": 500,
}
```

In `test_http_server.py`, assert:

```python
assert "stackchan_head_target_lane" in BYPASS_TOOLS
```

and run 100 concurrent `update` calls through the HTTP handler while a fake device call is gated;
`status` must complete without touching `CommandQueue`.

- [ ] **Step 2: Run focused gateway integration tests and verify RED**

Run:

```bash
uv run pytest \
  tests/test_esp32_client.py \
  tests/test_stdio_server.py \
  tests/test_http_server.py -q
```

Expected: missing manager property, missing tool, and missing bypass assertions fail.

- [ ] **Step 3: Wire the service and strict dispatcher**

Instantiate the service next to camera stream:

```python
self.head_target_lane = HeadTargetLane(self)
```

Stop it before closing the WebSocket server:

```python
try:
    await self.head_target_lane.stop()
except Exception as exc:
    logger.warning("head target lane shutdown cleanup failed: %s", exc)
```

Add `"stackchan_head_target_lane"` to `BYPASS_TOOLS`. In `_dispatch_mcp_tool`, validate every action
before calling the service. Use `_is_int_arg()` so booleans are rejected. Return JSON text with a
bounded generic `error` field; do not return tracebacks or raw device payloads.

- [ ] **Step 4: Run focused and full gateway gates**

Run:

```bash
uv run pytest \
  tests/test_head_target_lane.py \
  tests/test_esp32_client.py \
  tests/test_stdio_server.py \
  tests/test_http_server.py -q
uv run pytest -q
uv run ruff check .
```

Expected: all gateway tests and Ruff pass.

### Task 4: Add Pico config and a typed head-target client

**Files:**
- Create: `src/modules/stackchan/head-target-lane.ts`
- Create: `tests/stackchan-head-target-lane.test.ts`
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing config and client contract tests**

The config test must provide values explicitly:

```ts
expect(config.camera.stackchan?.follow).toMatchObject({
  commandTransport: "async-latest",
  commandRateHz: 10,
  maxPendingCommandAgeMs: 180
});
```

Add parser failures for an unknown transport, `commandRateHz: 11`, and
`maxPendingCommandAgeMs: 49`.

The client test must use a real local fake MCP transport boundary and assert these exact calls:

```ts
await lane.connect();
const lease = await lane.start({
  rateHz: 10,
  maxStepDeg: 4,
  maxPendingAgeMs: 180,
  speedDps: 90
});
await lane.update({
  leaseId: lease.leaseId,
  sequence: 1,
  pose: { yaw: 4, pitch: 33 }
});
await lane.clear(lease.leaseId);
await lane.stop(lease.leaseId);
await lane.close();
```

Also assert malformed JSON, `{"error": ...}`, wrong lease ID, unsafe integers, and missing response
fields fail with bounded StackChan-specific errors.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/config.test.ts tests/stackchan-head-target-lane.test.ts
```

Expected: config reports unknown fields and the lane module import fails.

- [ ] **Step 3: Implement strict types and explicit configuration**

Add these normalized enabled-follow properties:

```ts
readonly commandTransport: "async-latest";
readonly commandRateHz: number;
readonly maxPendingCommandAgeMs: number;
```

`commandTransport` is required whenever follow is enabled and must equal `"async-latest"`.
`commandRateHz` and `maxPendingCommandAgeMs` may be omitted from input YAML, but their parser
defaults must not be asserted as literals. Tests that depend on either value provide it explicitly.

The public lane interface is:

```ts
export type StackChanHeadTargetLane = {
  readonly connect: () => Promise<void>;
  readonly start: (config: StackChanHeadTargetStartConfig) => Promise<StackChanHeadTargetLease>;
  readonly update: (target: StackChanHeadTargetUpdate) => Promise<StackChanHeadTargetStatus>;
  readonly clear: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly status: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly stop: (leaseId: string) => Promise<StackChanHeadTargetStatus>;
  readonly close: () => Promise<void>;
};
```

Create `createStackChanHeadTargetLaneFromConfig(config, environment, dependencies)` with its own MCP
client/session. Parse tool text recursively but accept only the documented fields and safe integer
counters. Never infer success from `isError=false` when the text contains `error`.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npx vitest run tests/config.test.ts tests/stackchan-head-target-lane.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass.

### Task 5: Replace Pico's local move queue with lane submissions

**Files:**
- Modify: `src/runtime/stackchan-attention-owner.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`
- Modify: `tests/stackchan-attention-owner.test.ts`
- Modify: `tests/stackchan-attention-runtime.test.ts`

- [ ] **Step 1: Write failing runtime lifecycle tests**

Add a fake lane with gated device confirmation and assert acknowledgment is enough for the next
observation:

```ts
expect(events).toEqual([
  "camera:connect",
  "camera:home",
  "lane:connect",
  "lane:start",
  "lane:update:1",
  "capture:2",
  "lane:update:2"
]);
```

Add separate tests proving:

```ts
expect(events.slice(-4)).toEqual([
  "lane:stop",
  "camera:home",
  "lane:close",
  "camera:close"
]);
```

and:

- an update failure records `tick_failed` without calling `moveHead` as fallback;
- centered/hold transitions call `clear` once rather than once per frame;
- stop invalidates later tick completions before lane stop;
- lane stop failure records a dedicated cleanup error and does not report success;
- status counters come from the latest lane response and pending depth never exceeds one.

- [ ] **Step 2: Run runtime and owner tests and verify RED**

Run:

```bash
npx vitest run \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-owner.test.ts
```

Expected: `createStackChanAttentionRuntime` lacks the lane dependency and still invokes
`adapter.moveHead()` for every correction.

- [ ] **Step 3: Wire the owner and simplify the runtime command path**

Extend owner dependencies:

```ts
readonly createHeadTargetLane: (config: PicoStackChanConfig) => StackChanHeadTargetLane;
readonly createRuntime: (options: {
  readonly adapter: StackChanAdapter;
  readonly headTargetLane: StackChanHeadTargetLane;
  readonly model: AttentionDetectionModel;
  readonly config: EnabledFollowConfig;
}) => StackChanAttentionRuntime;
```

At runtime start:

```ts
await options.adapter.connect();
await options.adapter.moveHead(homePose, { speedDps: options.config.moveSpeedDps });
await options.headTargetLane.connect();
const lease = await options.headTargetLane.start({
  rateHz: options.config.commandRateHz,
  maxStepDeg: options.config.maxStepDeg,
  maxPendingAgeMs: options.config.maxPendingCommandAgeMs,
  speedDps: options.config.moveSpeedDps
});
commandedPose = { ...lease.confirmedPose };
```

For a move effect, increment one local safe-integer sequence and await only `lane.update()`.
Keep `commandedPose` aligned to the lane's confirmed pose: image-space error is observed from the
physical device pose, so accumulating it against an accepted-but-unconfirmed target compounds the
same error while a device call is active. For hold, call `clear()` only when a prior move may still
be pending. Remove `activeMove`, `PendingAttentionMove`, recursive post-move dispatch, and local
move failure rebase; the gateway owns those states.

Stop order is:

```ts
cancelLoop();
await activeTick;
await headTargetLane.stop(leaseId);
await adapter.moveHead(homePose, { speedDps });
await headTargetLane.close();
await adapter.close();
```

No `moveHead` call is allowed between lane start and lane stop except the final home after stop.
`clear()` is reserved for center/hold transitions while the runtime is running; `stop()` owns
pending invalidation during shutdown, so shutdown does not send a redundant `clear()`.

- [ ] **Step 4: Run focused runtime tests and verify GREEN**

Run:

```bash
npx vitest run \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-owner.test.ts
npm run typecheck
```

Expected: runtime, owner, and typecheck pass.

### Task 6: Update field instrumentation and acceptance

**Files:**
- Create: `scripts/field/stackchan-head-target-lane.ts`
- Create: `tests/stackchan-head-target-lane-field.test.ts`
- Modify: `scripts/field/stackchan-face-follow.ts`
- Modify: `tests/stackchan-attention-capacity-field.test.ts`
- Modify: `tests/stackchan-face-follow-field.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing report assertions**

Require aggregate lane measurements:

```ts
expect(report.details.control.headTargetLane).toMatchObject({
  accepted: expect.any(Number),
  replaced: expect.any(Number),
  dispatched: expect.any(Number),
  confirmed: expect.any(Number),
  failed: 0,
  staleDiscarded: 0,
  maximumActiveCalls: 1,
  maximumPendingDepth: 1,
  postStopDispatches: 0
});
expect(report.details.control.updateAcknowledgmentMs.p95).toBeLessThanOrEqual(25);
expect(report.details.control.updateAcknowledgmentMs.p99).toBeLessThanOrEqual(50);
```

Assert JSON does not contain target series, individual sequences, coordinates, detections, or images.
Capacity pass logic must reject status timeouts, update p99 above 50ms, pending age p99 above 180ms,
or device dispatch rate below 95% of observation rate.

For the synthetic lane stress, parse only these explicit arguments:

```text
--enable-live-run
--duration-ms <1000..60000>
--update-hz <1..50>
--status-hz <1..10>
--report-output <absolute-path>
```

Its tests use an injected lane client and clock. They assert 20Hz updates for 30 simulated seconds,
concurrent 5Hz status calls, one bounded stop, mode `0600`, and an aggregate-only JSON report.

- [ ] **Step 2: Run field tests and verify RED**

Run:

```bash
npx vitest run \
  tests/stackchan-attention-capacity-field.test.ts \
  tests/stackchan-face-follow-field.test.ts
```

Expected: report shape and acceptance assertions fail because instrumentation still wraps
`adapter.moveHead()`, and the synthetic stress script does not exist.

- [ ] **Step 3: Instrument the lane without retaining target history**

Wrap `update()` with fixed distributions for acknowledgment and accepted-to-dispatch aggregate
values returned by lane status. Snapshot only bounded counters at warmup, pre-stop, and post-stop.
Delete the old field-only move latency inference that assumes an awaited `moveHead()` is one follow
command. Preserve home latency separately if needed, outside control throughput.

Implement `scripts/field/stackchan-head-target-lane.ts` with the same config and bearer-token
loading boundary as the camera field scripts. It starts a lane at 10Hz, submits an alternating
bounded absolute yaw target at the requested update rate, polls status independently, stops the
lane, confirms home with the ordinary adapter after lane stop, and writes only:

```ts
type HeadTargetLaneStressReport = {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly requestedUpdateHz: number;
  readonly updateAcknowledgmentMs: FixedDistribution;
  readonly statusLatencyMs: FixedDistribution;
  readonly stopLatencyMs: number;
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly maximumActiveCalls: number;
  readonly maximumPendingDepth: number;
  readonly postStopDispatches: number;
  readonly finalHomeErrorDeg: { readonly yaw: number; readonly pitch: number };
};
```

Do not retain or serialize individual targets, sequences, poses, detections, frames, or raw MCP
responses. Add `"field:stackchan-head-target-lane": "jiti scripts/field/stackchan-head-target-lane.ts"`
to `package.json`.

- [ ] **Step 4: Run focused and full Pico gates**

Run:

```bash
npx vitest run \
  tests/stackchan-head-target-lane.test.ts \
  tests/stackchan-head-target-lane-field.test.ts \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-owner.test.ts \
  tests/stackchan-attention-capacity-field.test.ts \
  tests/stackchan-face-follow-field.test.ts
just check
```

Expected: focused tests, 86-or-more full test files, Swift gates, typecheck, lint, AST checks, format,
and all Vitest tests pass.

### Task 7: Run bounded feature-gateway field verification

**Files:**
- Modify: `.pico-local/field-stackchan.yaml`
- Modify: `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`

- [ ] **Step 1: Verify both local worktrees before touching services**

Run:

```bash
git -C /Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream diff --check
git -C /Users/monsoon/.config/superpowers/worktrees/pico/stackchan-face-follow-vlm-routing diff --check
lsof -nP -iTCP:18767 -sTCP:LISTEN
```

Expected: both diff checks pass and exactly one installed gateway owns port 18767.

- [ ] **Step 2: Temporarily run the feature gateway**

Stop only `dev.pico.stackchan-mcp.gateway`, start the feature worktree's gateway 0.17.0 with
`~/.pico/stackchan-mcp/local-gateway.env`, and wait for `connected=true` with 43 device tools.
Do not stop the named Cloudflare tunnel.

- [ ] **Step 3: Run the 125ms capacity matrix and 20Hz non-starvation stress**

Use:

```bash
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run field:stackchan-face-follow -- \
  --enable-live-run \
  --capacity \
  --capacity-intervals 250,167,125 \
  --model-path ~/.pico/models/pinto-441-s/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx \
  --report-output ~/.pico/field-reports/2026-07-29-stackchan-head-target-capacity.json
```

Then run the independent 20Hz update/status stress:

```bash
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run field:stackchan-head-target-lane -- \
  --enable-live-run \
  --duration-ms 30000 \
  --update-hz 20 \
  --status-hz 5 \
  --report-output ~/.pico/field-reports/2026-07-29-stackchan-head-target-stress.json
```

Required machine results:

- update acknowledgment p95 ≤25ms and p99 ≤50ms;
- accepted update rate ≥7.8Hz at 125ms;
- device dispatch rate ≥95% of observation rate;
- pending age p95 ≤150ms and p99 ≤180ms;
- active and pending maxima ≤1;
- status timeout, stale dispatch, post-stop dispatch, camera interruption, and device error all zero;
- home within ±1°.

- [ ] **Step 4: Restore the installed gateway and verify cleanup**

Stop the feature gateway, bootstrap the existing launchd plist, and verify:

```text
connected=true
tools_count=43
camera latest available=false
feature head-target lane running=false
```

The private report must be mode `0600`, contain no image bytes or target series, and the private
capture directory total size must not increase.

- [ ] **Step 5: Record aggregate results and run final verification**

Append only aggregate metrics and the human-acceptance boundary to the field document. Run:

```bash
just check
npx --yes \
  --package secretlint@13.0.4 \
  --package @secretlint/secretlint-rule-preset-recommend@13.0.4 \
  secretlint .
git diff --check
```

Expected: all commands pass. Leave both worktrees, branches, commits, remotes, and PR state unchanged.
