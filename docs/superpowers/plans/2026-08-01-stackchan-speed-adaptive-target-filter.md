# StackChan Speed-Adaptive Target Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagents and do not commit; the user requested autonomous inline validation, while repository policy requires separate explicit commit authorization.

**Goal:** Add an explicitly gated One Euro target-center filter that reduces deterministic detection jitter without materially delaying reversals or changing the unattended field configuration.

**Architecture:** A new pure `target-center-filter.ts` module owns the two-axis filter math and short-lived state. The existing pure attention controller applies the filter before centered/dead-zone logic and clears it on loss or scan. A strict nested config union evidence-binds candidate parameters; deterministic noisy traces select the candidate and the existing canonical replay qualifies safety.

**Tech Stack:** TypeScript, YAML, Vitest, Jiti field scripts, JSON Schema, Biome, ESLint, ast-grep.

---

### Task 1: Add The Strict Target Filter Configuration Contract

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`
- Modify: `config/pico.local.yaml`
- Modify: `.pico-local/field-stackchan.yaml`
- Modify: all existing enabled StackChan follow fixtures containing `stepQuantization`

- [x] **Step 1: Write failing config tests**

Add `targetFilter: { enabled: false }` to the valid StackChan follow input and expected config. Add enabled parsing and failure cases:

```ts
targetFilter: {
  enabled: true,
  minimumCutoffHz: 1,
  speedCoefficient: 2,
  derivativeCutoffHz: 1
}
```

Verify that missing `targetFilter`, unknown nested fields, missing enabled parameters, `minimumCutoffHz`/`derivativeCutoffHz` outside `0.1..30`, and `speedCoefficient` outside `0..30` throw paths beginning with `pico config camera.stackchan.follow.targetFilter`.

- [x] **Step 2: Run config tests and confirm RED**

Run:

```bash
npm test -- --run tests/config.test.ts
```

Expected: FAIL because `targetFilter` is unknown and absent from the returned config.

- [x] **Step 3: Implement the nested strict union**

Add:

```ts
export type PicoStackChanTargetFilterConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly minimumCutoffHz: number;
      readonly speedCoefficient: number;
      readonly derivativeCutoffHz: number;
    };
```

Add `readonly targetFilter: PicoStackChanTargetFilterConfig` to enabled `PicoStackChanFollowConfig`, add `"targetFilter"` to the known fields, and parse it with a dedicated `defineStackChanTargetFilterConfig`. The helper must require the object and `enabled` boolean, reject unknown fields per union branch, and use this bounded helper:

```ts
function requireBoundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  const parsed = readOptionalNumber(value, label);
  if (parsed === undefined) {
    throw new Error(`${label} is required when ${parentLabel(label)} is set`);
  }
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be >= ${minimum} and <= ${maximum}`);
  }
  return parsed;
}
```

Every existing fixture and all three field YAML files use `{ enabled: false }`. Do not enable it in `.pico-local/field-stackchan.yaml`.

- [x] **Step 4: Run config tests and typecheck for GREEN**

Run:

```bash
npm test -- --run tests/config.test.ts
npm run typecheck
```

Expected: config tests and typecheck pass after every enabled fixture is updated.

### Task 2: Implement The Pure One Euro Filter With TDD

**Files:**
- Create: `src/modules/stackchan/target-center-filter.ts`
- Create: `tests/stackchan-target-center-filter.test.ts`

- [x] **Step 1: Write failing pure-filter tests**

Define the wished-for API in tests:

```ts
const result = filterStackChanTargetCenter(
  previousState,
  { observedAtMs: 125, label: "face", centerX: 0.61, centerY: 0.5 },
  { enabled: true, minimumCutoffHz: 1, speedCoefficient: 2, derivativeCutoffHz: 1 }
);
```

Cover separately:

- disabled mode returns raw center and no state;
- first enabled observation initializes raw/filtered values and zero derivatives;
- a repeated noisy observation is low-pass filtered independently on both axes;
- higher estimated speed increases the adaptive cutoff and moves output closer to the new sample than `speedCoefficient: 0`;
- label change, non-increasing timestamp, and non-finite carried state reinitialize from raw input;
- output is clamped to `0..1`;
- input and previous state are not mutated.

- [x] **Step 2: Run filter tests and confirm RED**

Run:

```bash
npm test -- --run tests/stackchan-target-center-filter.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimal pure filter**

Export these contracts:

```ts
export type StackChanTargetFilterAxisState = {
  readonly rawValue: number;
  readonly filteredValue: number;
  readonly filteredDerivative: number;
};

export type StackChanTargetFilterState = {
  readonly observedAtMs: number;
  readonly label: "face" | "head";
  readonly horizontal: StackChanTargetFilterAxisState;
  readonly vertical: StackChanTargetFilterAxisState;
};

export type StackChanFilteredTargetCenter = {
  readonly centerX: number;
  readonly centerY: number;
  readonly state?: StackChanTargetFilterState;
};
```

Implement `smoothingFactor`, `lowPass`, `initializeAxis`, `filterAxis`, and `filterStackChanTargetCenter` using the equations and reset rules in the spec. Clone all returned state and clamp only the final center values to `0..1`.

- [x] **Step 4: Run filter tests and confirm GREEN**

Run:

```bash
npm test -- --run tests/stackchan-target-center-filter.test.ts
```

Expected: all pure-filter tests pass.

### Task 3: Integrate Filtering Into The Pure Attention Controller

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`
- Modify: `tests/stackchan-attention-controller.test.ts`
- Modify: `tests/stackchan-attention-runtime.test.ts`

- [x] **Step 1: Write failing controller lifecycle tests**

Add `targetFilter: { enabled: false }` to the baseline controller config. Add tests proving:

- disabled filtering produces the exact legacy transition and never adds filter state;
- enabled filtering uses the filtered center in `horizontalError`, centered hysteresis, and the generated move;
- centered observations retain and update filter state while clearing only step residuals;
- first target-loss hold and every scan state omit filter state;
- reacquisition initializes from the new raw center;
- face/head label changes reinitialize without releasing an old filtered center.

- [x] **Step 2: Run controller tests and confirm RED**

Run:

```bash
npm test -- --run tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts
```

Expected: FAIL because the controller does not store or apply filter state and runtime does not pass the config.

- [x] **Step 3: Implement minimal integration**

Add optional state:

```ts
readonly targetFilterState?: StackChanTargetFilterState;
```

In `trackAttentionTarget`, compute the raw center, call `filterStackChanTargetCenter` with `input.observedAtMs ?? input.nowMs`, then derive errors and centered status from the returned center. Include returned state only when present.

Replace the target-loss spread with an explicit helper that omits `targetFilterState`; keep `scanState` explicit so it also omits it. Centered tracking retains the new filter state but clears all four step-feedback fields.

Add `targetFilter: config.targetFilter` in `attentionControllerConfig`.

- [x] **Step 4: Run controller and runtime tests for GREEN**

Run:

```bash
npm test -- --run tests/stackchan-target-center-filter.test.ts tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-attention-owner.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck pass.

### Task 4: Add Deterministic Noisy Trace Qualification

**Files:**
- Create: `scripts/field/stackchan-target-filter-evaluation.ts`
- Create: `tests/stackchan-target-filter-evaluation.test.ts`
- Create: private report under `/Users/monsoon/.pico/field-reports/`

- [x] **Step 1: Write failing deterministic evaluation tests**

Define an exported `evaluateStackChanTargetFilterCandidates()` that returns the raw baseline, all 16 candidates, the selected candidate or `undefined`, and stationary-jitter/noisy-reversal metrics. Tests must assert:

- identical output across two runs;
- exactly 16 ordered candidates;
- every metric is finite and counts are non-negative safe integers;
- selection considers only candidates satisfying all five spec acceptance rules;
- lexicographic selection is stable;
- deliberately impossible thresholds return no selection;
- the default thresholds select a candidate that reduces stationary command path total variation to at most 70% of raw and delays reversal by at most 250 ms.

- [x] **Step 2: Run evaluation tests and confirm RED**

Run:

```bash
npm test -- --run tests/stackchan-target-filter-evaluation.test.ts
```

Expected: FAIL because the evaluation module does not exist.

- [x] **Step 3: Implement deterministic traces and metrics**

Use a local seeded linear-congruential generator with seed `20_260_801`, 125 ms samples, and no wall clock or random global state. Run the pure controller for raw and each filter candidate so command metrics include centered logic, error-feedback quantization, and servo bounds. Compute nearest-rank p50/p95, total variation, normalized roughness, first correct reversal latency, extra direction reversals, request count, and maximum step.

Provide a CLI guarded by the existing direct-execution pattern. It accepts only:

```text
--report-output <absolute path>
```

Write JSON atomically with mode 600 and fail closed on symlinks, non-absolute paths, unknown flags, missing selection, or failed acceptance.

- [x] **Step 4: Run evaluation tests and generate the private report**

Run:

```bash
npm test -- --run tests/stackchan-target-filter-evaluation.test.ts
npm run field:stackchan-target-filter-evaluation -- \
  --report-output /Users/monsoon/.pico/field-reports/2026-08-01-stackchan-target-filter-candidate.json
```

If a package script is added, it must invoke `jiti scripts/field/stackchan-target-filter-evaluation.ts`. Expected: tests pass and the report status is `passed`, mode is 600, and one candidate is selected.

- [x] **Step 5: Apply only the selected parameters to the canonical replay fixture**

Set the exact selected `targetFilter` object in `STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow`. Keep `.pico-local/field-stackchan.yaml` disabled. Add the nested object to the strict replay report JSON schema and exact fixture test.

### Task 5: Qualify Canonical Safety And Preserve Review State

**Files:**
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `scripts/field/stackchan-attention-replay-report.schema.json`
- Modify: `tests/stackchan-attention-replay-field.test.ts`
- Update: `/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-spring-terminal-and-follow-tuning-validation.md`
- Update: this plan's checkboxes

- [x] **Step 1: Run focused replay gates**

Run:

```bash
npm test -- --run \
  tests/config.test.ts \
  tests/stackchan-target-center-filter.test.ts \
  tests/stackchan-target-filter-evaluation.test.ts \
  tests/stackchan-attention-controller.test.ts \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-replay-field.test.ts \
  tests/stackchan-attention-replay-gate.test.ts
```

Expected: all focused files pass without changing acceptance thresholds.

- [x] **Step 2: Generate a fresh three-repeat canonical report**

Compute the producer source hash using the current controller, target-center filter, runtime, attention detection, replay lane policy, and Gateway lane source. Generate:

```text
/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-target-filter-candidate.json
```

with `--repeat 3` and the fresh hash. Expected: five scenarios passed, deterministic true, three evidence runs, all absolute safety true, and fresh producer equality.

- [x] **Step 3: Compare against raw and error-feedback-only reports**

Compare the selected candidate with:

```text
/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-125ms-baseline.json
/Users/monsoon/.pico/field-reports/2026-08-01-stackchan-attention-replay-error-feedback-candidate.json
```

Record slow and fast progress, target error, centered ratio, settling, command/confirmed roughness, velocity total variation, maximum step, error, stale, post-stop, overlap, angle bounds, and home error. Reject the filter if canonical safety fails.

- [x] **Step 4: Run all repository gates**

Run:

```bash
npm run typecheck
npm run lint
npm run ast:test
npm run ast
npm run format:check
just check
```

Expected: all static checks, Apple Speech, macOS resident I/O, and every TypeScript test pass.

- [x] **Step 5: Verify unattended safety and update evidence**

Confirm `.pico-local/field-stackchan.yaml` has `targetFilter.enabled: false`, `stepQuantization: round`, and `yawGainDeg: 44`. Confirm ports 18765, 18766, and 18767 are closed. Update the private validation report with selected parameters, deterministic metrics, canonical comparison, Pro identity blocker, and physical-review limitation. Keep all private reports mode 600 and scan the Markdown report for sensitive patterns.

- [x] **Step 6: Run final scope checks**

Run:

```bash
git diff --check
rg --hidden --no-ignore -n 'targetFilter|stepQuantization|yawGainDeg' src scripts tests config .pico-local
git status --short
```

Expected: no whitespace errors; filter changes are limited to the approved config, controller, pure filter, deterministic evaluation, replay evidence, tests, YAML, specs, and plans. Do not commit, push, start Gateway, perform OTA, or move the device.

## Execution Result

The deterministic grid selected `minimumCutoffHz: 1`, `speedCoefficient: 4`, and `derivativeCutoffHz: 1`. Its stationary command-path total variation fell from 26 to 3, but the canonical replay rejected it: the static boundary invariant failed and fast-reversal response p95 rose from the allowed 125 ms to 750 ms. The other four locally accepted candidates also failed the static boundary invariant and produced fast-reversal p95 values from 625 through 750 ms. The canonical fixture and unattended field config were therefore restored to `targetFilter.enabled: false`; the three-repeat rejected report is retained as negative evidence.

The full repository gate passed with 95 files and 1,481 tests. A full-gate integration failure exposed that the replay evidence builder had not copied or integrity-bound the controller's new direct `target-center-filter.ts` dependency. The producer contract was expanded from five to six fixed roles, evidence schema version 5 now archives and attests the filter source, and a dedicated tamper test confirms that modified filter bytes are rejected. The evidence suite passed 37/37, the focused filter/replay suite passed 234/234, and the regenerated safe baseline passed all five scenarios across three deterministic repeats with the current six-source hash.
