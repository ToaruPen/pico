# StackChan Face Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and field-validate a conversation-scoped StackChan head/face follow loop using the CoreS3 camera, PINTO 441-S Dist, and the existing authenticated stackchan-mcp gateway.

**Architecture:** Add a thin StackChan MCP adapter, a PINTO-specific head/face detector, and a stateful attention controller. The controller is optional, bounded, and isolated from the voice critical path; it starts once per interaction and returns to an optical home pose on interaction end or shutdown.

**Tech Stack:** TypeScript 6, Vitest, `@modelcontextprotocol/sdk` v1, ONNX Runtime Node, Sharp, Pi Agent resident runtime, stackchan-mcp 0.15.0.

---

Repository policy forbids commits unless the user explicitly requests them. Replace each normal commit step with a diff/status checkpoint.

## Task 1: Add strict StackChan and attention config

**Files:**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests that call `definePicoConfig()` with `camera.stackchan` and
`vision.attentionDetection`, then assert immutable normalized values. Add separate tests that
reject an invalid MCP URL, non-environment token name, out-of-range servo values, empty scan
arrays, a non-PINTO model family, and enabled follow without enabled attention detection.

Representative assertion:

```ts
expect(config.camera.stackchan?.follow).toEqual({
  enabled: true,
  frameIntervalMs: 1000,
  homeYaw: 0,
  homePitch: 35,
  deadZone: 0.08,
  yawGainDeg: 40,
  pitchGainDeg: 30,
  flipYaw: 1,
  flipPitch: 1,
  maxStepDeg: 8,
  lostHoldMs: 1000,
  scanYaw: [-35, 0, 35],
  scanPitch: [35, 25]
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL because `camera.stackchan` and `vision.attentionDetection` are unknown.

- [ ] **Step 3: Implement the config union and validation**

Add `PicoStackChanConfig`, `PicoStackChanFollowConfig`, and
`PicoAttentionDetectionConfig`. Validate:

Accept only the closed attention model family literal
`pinto441-yolox-body-head-hand-face-dist`; reject earlier families without compatibility or
fallback behavior.

```ts
type PicoStackChanFollowConfig = {
  readonly enabled: boolean;
  readonly frameIntervalMs: number;
  readonly homeYaw: number;
  readonly homePitch: number;
  readonly deadZone: number;
  readonly yawGainDeg: number;
  readonly pitchGainDeg: number;
  readonly flipYaw: -1 | 1;
  readonly flipPitch: -1 | 1;
  readonly maxStepDeg: number;
  readonly lostHoldMs: number;
  readonly scanYaw: readonly number[];
  readonly scanPitch: readonly number[];
};
```

Resolve `modelPath` relative to the YAML file like the existing person-detection model path.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run `git diff --check` and inspect only the intended config/test/example files.

## Task 2: Add an authenticated StackChan MCP adapter

**Files:**
- Create: `src/modules/stackchan/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/stackchan.test.ts`

- [ ] **Step 1: Add the direct SDK dependency**

Run:

```bash
npm install --save-exact @modelcontextprotocol/sdk@1.25.2
```

Do not add a second HTTP or MCP implementation.

- [ ] **Step 2: Write failing adapter tests**

Use a deterministic injected transport client contract, not a network double. Test:

```ts
const adapter = createStackChanAdapter({
  client: deterministicClient,
  readCaptureFile: deterministicCaptureReader,
  maxFrameBytes: 5 * 1024 * 1024
});

await expect(adapter.captureJpeg()).resolves.toEqual({
  bytes: jpegBytes,
  mimeType: "image/jpeg"
});
```

Cover `{"image_path":...}`, nested text content, MCP `isError`, malformed JSON, path outside
`~/.stackchan/captures`, missing JPEG markers, oversized file, head-angle parsing, and bounded
integer move arguments.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/stackchan.test.ts
```

Expected: FAIL because the StackChan module does not exist.

- [ ] **Step 4: Implement minimal adapter**

Expose:

```ts
export type StackChanAdapter = {
  readonly connect: () => Promise<void>;
  readonly captureJpeg: () => Promise<StackChanJpegFrame>;
  readonly getHeadAngles: () => Promise<StackChanHeadPose>;
  readonly moveHead: (pose: StackChanHeadPose) => Promise<void>;
  readonly close: () => Promise<void>;
};
```

The production factory uses `Client` and `StreamableHTTPClientTransport` with
`requestInit.headers.authorization`. Resolve the token from the configured environment variable
and reject missing/empty values. Set `requestInit.redirect` to `"error"` on every transport that
attaches this header so the bearer token is never forwarded across a redirect. Never place the
token or capture path in thrown messages.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run tests/stackchan.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run `git diff --check` and confirm the lockfile contains only the new direct dependency and its
required transitive entries.

## Task 3: Implement PINTO 441-S Dist head/face detection

**Files:**
- Create: `src/modules/vision/attention-detection.ts`
- Test: `tests/attention-detection.test.ts`

- [ ] **Step 1: Write failing parser and selection tests**

Test postprocessed rows in the exact model order:

```ts
const rows = new Float32Array([
  0, 1, 0.80, 32, 24, 160, 200,
  0, 3, 0.75, 60, 50, 120, 130
]);

expect(parsePintoAttentionDetections(rows, [2, 7], options)).toEqual([
  expect.objectContaining({ label: "head", confidence: 0.8 }),
  expect.objectContaining({ label: "face", confidence: 0.75 })
]);
```

Cover body/hand filtering, per-label threshold, coordinate clamping, malformed dimensions,
zero-area boxes, face-first target selection, and `score * sqrt(area)` ranking.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/attention-detection.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the parser and target selector**

Use fixed labels:

```ts
export type AttentionTargetLabel = "head" | "face";
```

Return normalized boxes only. Do not expose batch IDs, identity labels, or other model classes.

- [ ] **Step 4: Write the failing preprocess/model test**

Inject a Sharp runtime and ONNX runtime. Assert that one RGB pixel `[10, 20, 30]` becomes BGR
channels `[30, 20, 10]`, values are not divided by 255, dimensions are `[1, 3, H, W]`, and the
session output flows through the parser.

- [ ] **Step 5: Verify RED**

Run the focused test and confirm it fails on missing model/preprocessor code.

- [ ] **Step 6: Implement the ONNX model**

Expose:

```ts
export type AttentionDetectionModel = {
  readonly detect: (jpeg: Uint8Array) => Promise<readonly AttentionDetection[]>;
};
```

Create one ONNX session at startup and reuse it. Require the postprocessed row length to be seven.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npx vitest run tests/attention-detection.test.ts
npm run typecheck
```

Expected: PASS.

## Task 4: Implement the bounded attention state machine

**Files:**
- Create: `src/modules/stackchan/attention-controller.ts`
- Test: `tests/stackchan-attention-controller.test.ts`

- [ ] **Step 1: Write failing pure-controller tests**

Cover:

- first target changes `acquire` to `track`
- dead-zone target emits no move
- target right/below produces signed bounded step
- mechanical ranges clamp to yaw `-90..90`, pitch `5..85`
- loss holds the last pose before `lostHoldMs`
- loss after the hold starts at the bounded scan pose nearest the last detected pose
- face wins over head
- repeated `stop()` is idempotent

Use a pure transition API:

```ts
const next = advanceAttentionState(state, {
  nowMs: 1200,
  currentPose: { yaw: 0, pitch: 35 },
  detections
}, config);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/stackchan-attention-controller.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement minimal transitions**

Separate immutable state calculation from MCP effects. The effect shape is:

```ts
type AttentionEffect =
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly pose: StackChanHeadPose };
```

- [ ] **Step 4: Verify GREEN**

Run the focused test and `npm run typecheck`.

## Task 5: Implement the asynchronous StackChan attention runtime

**Files:**
- Create: `src/runtime/stackchan-attention-runtime.ts`
- Test: `tests/stackchan-attention-runtime.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use deterministic real contract implementations with event arrays. Verify:

- `start()` connects, moves home, and schedules one loop
- no overlapping capture/inference tick
- capture or inference error does not move the head and is reported in status
- `stop()` stops scheduling, drains the active tick, returns home, and closes MCP
- a second `stop()` is idempotent and a stopped runtime rejects reuse

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/stackchan-attention-runtime.test.ts
```

Expected: FAIL because the runtime does not exist.

- [ ] **Step 3: Implement the runtime**

Expose:

```ts
export type StackChanAttentionRuntime = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly status: () => StackChanAttentionStatus;
};
```

Use `setInterval().unref()`, one active tick promise, and a run token to suppress late results.

- [ ] **Step 4: Verify GREEN**

Run focused tests, typecheck, lint, and ast-grep.

## Task 6: Bind attention to the resident interaction lifecycle

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Test: `tests/voice-resident.test.ts`
- Test: `tests/resident-voice-runner.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add an optional `attention` owner with non-throwing `startInteraction()` and `stopInteraction()`.
Assert one start for the first turn, no restart for a reused session, one stop during interaction
cleanup, and a stop during runtime shutdown.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/voice-resident.test.ts tests/resident-voice-runner.test.ts
```

Expected: FAIL because no attention owner exists.

- [ ] **Step 3: Add lifecycle hooks**

Start attention after `sessionLifecycle.start()` returns. Stop it in interaction cleanup and
shutdown. Do not await start on the prompt critical path. The production owner catches its own
errors and exposes them through status only.

- [ ] **Step 4: Build the configured production runtime**

Create the StackChan adapter and PINTO model only when both config sections are enabled. Disabled
config must allocate no MCP connection, ONNX session, or timer.

- [ ] **Step 5: Verify GREEN**

Run the focused tests and `npm run typecheck`.

## Task 7: Add bounded field harnesses and verify the real device

**Files:**
- Create: `scripts/field/stackchan-camera-grid.ts`
- Create: `scripts/field/stackchan-face-follow.ts`
- Modify: `package.json`
- Modify: `TOOLS.md`
- Test: `tests/stackchan-camera-grid-field.test.ts`
- Test: `tests/stackchan-face-follow-field.test.ts`

- [ ] **Step 1: Write failing CLI parsing/report tests**

Require `--enable-live-run`. Require explicit output path, duration/max frames for follow, and a
model path. Reports contain only aggregate metadata from the design.

- [ ] **Step 2: Verify RED**

Run the two focused tests and confirm missing harness exports.

- [ ] **Step 3: Implement field harnesses**

Camera grid moves only to configured safe poses, captures one frame at each pose, runs detection,
and writes JSON to the explicit output. Follow uses the production runtime with a hard duration
and frame cap.

- [ ] **Step 4: Verify unit gates**

Run:

```bash
npx vitest run tests/stackchan*.test.ts tests/attention-detection.test.ts
npm run typecheck
npm run lint
npm run ast
```

- [ ] **Step 5: Download the selected PINTO 441-S Dist model outside git**

Download the official archive to a temporary directory, verify archive paths, extract the
postprocessed 256x320 ONNX model to a private local model directory, and record its SHA-256 in the
field report. Do not add model bytes to git.

- [ ] **Step 6: Run camera grid**

Source the existing private StackChan gateway environment without printing it, then run the grid
harness for home, left, and right poses. Confirm the device returns home.

- [ ] **Step 7: Run bounded follow**

Run a short explicit live follow with the operator in view. Stop immediately if motion is not
bounded or a mechanical limit is approached. Confirm the final head-angle readback equals home.

- [ ] **Step 8: Final gates**

Run:

```bash
just check
npx secretlint .
git diff --check
```

Expected: all pass and no secret or captured image is tracked.
