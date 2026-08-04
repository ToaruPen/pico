# StackChan Fractional Step Carry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagents and do not commit; the user authorized autonomous inline validation, while repository policy requires separate explicit commit authorization.

**Goal:** Add a gated error-feedback step quantizer that preserves only corrections discarded as zero by legacy rounding, without perturbing existing nonzero steps or releasing stored motion after centering, loss, scan, or reversal.

**Architecture:** `advanceAttentionState` remains the pure control boundary and stores bounded residual state independently for yaw and pitch. A strict `stepQuantization` config selects the legacy `round` path or the candidate `error-feedback` path; the live field config remains `round`, while the deterministic replay fixture exercises the candidate.

**Tech Stack:** TypeScript, YAML, Vitest, Jiti deterministic field replay, ESLint, ast-grep, Biome.

---

### Task 1: Add The Explicit Quantization Configuration Contract

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`
- Modify: `config/pico.local.yaml`
- Modify: `.pico-local/field-stackchan.yaml`
- Modify: every existing enabled StackChan follow fixture found with `rg -n 'commandTransport: ["'"']?async-latest' src scripts tests config .pico-local --hidden`

- [x] **Step 1: Write failing config tests**

Add `stepQuantization: "round"` to the valid StackChan follow input and expected value. Add explicit invalid and missing cases:

```ts
expect(() =>
  definePicoConfig(
    configured({
      ...baseStackChan,
      follow: {
        enabled: true,
        commandTransport: "async-latest",
        stepQuantization: "truncate"
      }
    })
  )
).toThrow("pico config camera.stackchan.follow.stepQuantization");

expect(() =>
  definePicoConfig(
    configured({
      ...baseStackChan,
      follow: { enabled: true, commandTransport: "async-latest" }
    })
  )
).toThrow("pico config camera.stackchan.follow.stepQuantization");
```

- [x] **Step 2: Run the focused config test and confirm RED**

Run:

```bash
npm test -- --run tests/config.test.ts
```

Expected: FAIL because `stepQuantization` is not a known or returned StackChan follow field.

- [x] **Step 3: Implement the strict enum boundary**

Add this property to the enabled `PicoStackChanFollowConfig` branch:

```ts
readonly stepQuantization: "round" | "error-feedback";
```

Add `"stepQuantization"` to `requireKnownConfigFields`, then parse it in the returned object:

```ts
stepQuantization: requireOneOfStrings(
  input.stepQuantization,
  "pico config camera.stackchan.follow.stepQuantization",
  ["round", "error-feedback"] as const
),
```

Set `stepQuantization: round` in the live `.pico-local/field-stackchan.yaml` and general YAML examples. Add `stepQuantization: "round"` to existing baseline test fixtures unless a later task explicitly marks the replay candidate as `"error-feedback"`.

- [x] **Step 4: Run the focused config test and confirm GREEN**

Run:

```bash
npm test -- --run tests/config.test.ts
```

Expected: all `tests/config.test.ts` tests pass.

- [x] **Step 5: Confirm the active field configuration is still baseline-safe**

Run:

```bash
rg --hidden -n -C 2 'stepQuantization|yawGainDeg' .pico-local/field-stackchan.yaml
```

Expected: `stepQuantization: round` and `yawGainDeg: 44` occur in the active field configuration.

### Task 2: Implement Axis-Independent Error Feedback With TDD

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Modify: `tests/stackchan-attention-controller.test.ts`

- [x] **Step 1: Add failing state-transition tests**

Use `stepQuantization: "error-feedback"`, `deadZone: 0.1`, and `yawGainDeg: 40`. A horizontal error of `0.11` produces a continuous `0.4` degree correction. Add tests that verify:

```ts
const candidate = { ...config, deadZone: 0.1, yawGainDeg: 40, stepQuantization: "error-feedback" };
const first = advanceAttentionState(
  initialAttentionState(),
  { nowMs: 0, currentPose: { yaw: 0, pitch: 35 }, detections: [detection("face", 0.61, 0.5)] },
  candidate
);
const second = advanceAttentionState(
  first.state,
  { nowMs: 125, currentPose: { yaw: 0, pitch: 35 }, detections: [detection("face", 0.61, 0.5)] },
  candidate
);

expect(first.effect).toEqual({ kind: "hold" });
expect(first.state.yawStepResidualDeg).toBeCloseTo(0.4);
expect(second.effect).toEqual({ kind: "move", pose: { yaw: 1, pitch: 35 } });
```

Add separate cases for:

- centered resets both axes to residual 0 and direction 0;
- the first target-loss hold resets both axes;
- a positive-to-negative reversal clears the positive residual before adding the negative correction;
- a zero correction on one axis does not clear the other axis;
- a saturated correction returns exactly `maxStepDeg` and residual 0;
- `round` produces the legacy frame-by-frame result and keeps all residual fields at 0;
- scan state never carries a tracking residual.
- a residual never changes a correction that legacy rounding already makes nonzero.

- [x] **Step 2: Run controller tests and confirm RED**

Run:

```bash
npm test -- --run tests/stackchan-attention-controller.test.ts
```

Expected: FAIL because residual and direction fields and the `error-feedback` quantizer do not exist.

- [x] **Step 3: Add the minimal residual state and quantizer**

Add these fields to `StackChanAttentionState` and initialize them to zero:

```ts
readonly yawStepResidualDeg: number;
readonly pitchStepResidualDeg: number;
readonly yawStepDirection: -1 | 0 | 1;
readonly pitchStepDirection: -1 | 0 | 1;
```

Implement one pure helper:

```ts
type QuantizedAxisStep = {
  readonly stepDeg: number;
  readonly residualDeg: number;
  readonly direction: -1 | 0 | 1;
};

function quantizeAxisStep(
  continuousStepDeg: number,
  maximumMagnitude: number,
  mode: StackChanAttentionControllerConfig["stepQuantization"],
  previousResidualDeg: number,
  previousDirection: -1 | 0 | 1
): QuantizedAxisStep {
  const direction = Math.sign(continuousStepDeg) as -1 | 0 | 1;
  if (mode === "round") {
    return {
      stepDeg: boundedStep(continuousStepDeg, maximumMagnitude),
      residualDeg: 0,
      direction: 0
    };
  }
  if (direction === 0) {
    return { stepDeg: 0, residualDeg: 0, direction: 0 };
  }
  const roundedStepDeg = boundedStep(continuousStepDeg, maximumMagnitude);
  if (roundedStepDeg !== 0) {
    return { stepDeg: roundedStepDeg, residualDeg: 0, direction: 0 };
  }
  const carriedResidual =
    previousDirection !== 0 && previousDirection !== direction ? 0 : previousResidualDeg;
  const accumulated = Math.min(
    maximumMagnitude,
    Math.max(-maximumMagnitude, continuousStepDeg + carriedResidual)
  );
  const stepDeg = Math.round(accumulated);
  return { stepDeg, residualDeg: accumulated - stepDeg, direction };
}
```

Compute yaw and pitch independently. Store the returned residual and direction in the next state. Use `stepDeg` in the existing bounded servo pose calculation.

Reset both axes in centered, target-loss hold, and scan paths. A zero continuous correction resets only that axis through `quantizeAxisStep`.

- [x] **Step 4: Run controller tests and confirm GREEN**

Run:

```bash
npm test -- --run tests/stackchan-attention-controller.test.ts
```

Expected: all controller tests pass, including the new residual cases.

- [x] **Step 5: Run runtime tests to catch state-shape and lifecycle regressions**

Run:

```bash
npm test -- --run tests/stackchan-attention-runtime.test.ts tests/stackchan-attention-owner.test.ts
```

Expected: both test files pass; no expected state object omits the new fields.

### Task 3: Qualify The Candidate With The Existing Replay

**Files:**
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `scripts/field/stackchan-attention-replay-report.schema.json`
- Modify: `tests/stackchan-attention-replay-field.test.ts` only when its exact fixture expectation needs the new field
- Create: private report under `/Users/monsoon/.pico/field-reports/`

- [x] **Step 1: Select the candidate only in the canonical replay fixture**

Add this field to `STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow`:

```ts
stepQuantization: "error-feedback",
```

Keep `frameIntervalMs: 125`, `yawGainDeg: 44`, and `maxStepDeg: 4`. Add the strict enum to the replay report schema so the selected mode is evidence-bound. Do not alter scenario inputs or acceptance thresholds.

- [x] **Step 2: Run focused replay and controller gates**

Run:

```bash
npm test -- --run \
  tests/config.test.ts \
  tests/stackchan-attention-controller.test.ts \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-replay-field.test.ts \
  tests/stackchan-attention-replay-gate.test.ts
```

Expected: all focused files pass.

- [x] **Step 3: Compute the fresh producer hash**

Run from the Pico worktree, substituting the existing Gateway worktree only in the final `--gateway-lane-source` value:

```bash
npm run field:stackchan-attention-replay-evidence -- producer-hash \
  --pico-controller-source "$PWD/src/modules/stackchan/attention-controller.ts" \
  --pico-runtime-source "$PWD/src/runtime/stackchan-attention-runtime.ts" \
  --pico-attention-detection-source "$PWD/src/modules/vision/attention-detection.ts" \
  --replay-lane-policy-source "$PWD/scripts/field/stackchan-attention-replay-lane-policy.ts" \
  --gateway-lane-source "/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/head_target_lane.py"
```

Expected: one JSON object containing a lowercase 64-character `producerSourceHash`.

- [x] **Step 4: Generate one qualified three-repeat candidate report**

Recompute and validate the hash in the same shell that runs the replay:

```bash
task_producer_hash="$(
  npm run field:stackchan-attention-replay-evidence -- producer-hash \
    --pico-controller-source "$PWD/src/modules/stackchan/attention-controller.ts" \
    --pico-runtime-source "$PWD/src/runtime/stackchan-attention-runtime.ts" \
    --pico-attention-detection-source "$PWD/src/modules/vision/attention-detection.ts" \
    --replay-lane-policy-source "$PWD/scripts/field/stackchan-attention-replay-lane-policy.ts" \
    --gateway-lane-source "/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream/gateway/stackchan_mcp/head_target_lane.py" \
  | tail -n 1 \
  | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(text).producerSourceHash));'
)"
[[ "$task_producer_hash" =~ ^[a-f0-9]{64}$ ]]
npm run field:stackchan-attention-replay -- \
  --report-output /Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-error-feedback-candidate.json \
  --repeat 3 \
  --producer-source-hash "$task_producer_hash"
```

Expected: exit 0 and report `status: "passed"` with all five scenarios passed and repeat determinism accepted.

- [x] **Step 5: Compare candidate metrics with the retained yaw-gain 44 baseline**

Read only these two reports:

```text
/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-125ms-baseline.json
/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-error-feedback-candidate.json
```

Record a bounded comparison for slow continuous tracking and fast reversals covering progress, target error, centered ratio, settling, roughness, velocity total variation, maximum step, failed, stale, post-stop, overlap, servo-limit, and home error. Reject the candidate if any absolute safety invariant fails or if no tracking or quantization metric improves.

### Task 4: Run Full Gates And Preserve A Safe Review State

**Files:**
- Update: `/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-spring-terminal-and-follow-tuning-validation.md`
- Update: this implementation plan's checkboxes

- [x] **Step 1: Run focused static gates**

Run:

```bash
npm run typecheck
npm run lint
npm run ast:test
npm run ast
npm run format:check
```

Expected: all commands exit 0.

- [x] **Step 2: Run the complete repository gate**

Run:

```bash
just check
```

Expected: Apple Speech, macOS resident I/O, all TypeScript tests, typecheck, lint, AST, and format gates pass.

- [x] **Step 3: Verify baseline-safe activation and no hardware services**

Run:

```bash
rg --hidden -n -C 2 'stepQuantization|yawGainDeg' .pico-local/field-stackchan.yaml
for port in 18765 18766 18767; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "unexpected open port $port"
    exit 1
  fi
done
```

Expected: active field mode is `round`, yaw gain is 44, and all Gateway ports remain closed.

- [x] **Step 4: Update the private validation report and scan it**

Record the candidate decision, exact local results, replay comparison, Pro identity blocker, and physical-test limitation. Keep the file mode at 600 and run:

```bash
chmod 600 /Users/monsoon/.pico/field-reports/2026-08-01-stackchan-spring-terminal-and-follow-tuning-validation.md
rg -n -i '(password|credential|ssid|device[_ -]?id|session[_ -]?id|authorization:|bearer|api[_ -]?key|[0-9a-f]{2}(:[0-9a-f]{2}){5})' \
  /Users/monsoon/.pico/field-reports/2026-08-01-stackchan-spring-terminal-and-follow-tuning-validation.md
```

Expected: `rg` finds no sensitive pattern and returns exit 1; mode is 600.

- [x] **Step 5: Run final diff and scope checks**

Run:

```bash
git diff --check
rg --hidden -n 'stepQuantization' src scripts tests config .pico-local
git status --short
```

Expected: no whitespace errors; the new field appears only in the config owner, controller, intentional fixtures, tests, and YAML files. Compare `git status` with the recorded inherited dirty state and confirm this plan added no firmware, Gateway, dependency, credential, or unrelated change.
