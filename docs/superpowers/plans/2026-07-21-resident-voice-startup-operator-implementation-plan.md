# Resident Voice Startup and Operator Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure resident input and terminal controls use one resolved startup config and report PTT latency at the first accepted PCM write.

**Architecture:** `pico-startup` becomes the sole resident startup config loader and passes the frozen config through the service boundary. The terminal view receives typed configured keys. The existing release measurement remains owned by `voice-resident`, but a new pipeline callback settles it only after the first playback write succeeds.

**Tech Stack:** TypeScript, Pi extension API, pi-tui, Vitest, strict ESLint, ast-grep, Biome

---

## Task 1: Pass the resolved startup config through the controller boundary

**Files:**
- Modify: `src/runtime/pico-startup.ts`
- Modify: `src/runtime/resident-voice-service.ts`
- Modify: `src/index.ts`
- Test: `tests/pico-startup.test.ts`
- Test: `tests/resident-voice-service.test.ts`

- [ ] **Step 1: Write the failing startup identity test**

Add a test that captures the third `createController` argument and asserts identity, not deep equality:

```ts
const config = configuredPicoModel();
let receivedConfig: PicoConfig | undefined;

registerPicoStartup(harness.api as never, {
  loadConfig: () => config,
  createController: (_context, _settings, resolvedConfig) => {
    receivedConfig = resolvedConfig;
    return completedController();
  }
});

await harness.emit("session_start", { type: "session_start" }, createContext([]));
expect(receivedConfig).toBe(config);
```

- [ ] **Step 2: Run the focused test and verify Red**

Run: `npx vitest run tests/pico-startup.test.ts`

Expected: typecheck/test failure because `createController` does not receive `PicoConfig`.

- [ ] **Step 3: Implement the minimal startup signature**

Change the option boundary to:

```ts
readonly createController: (
  context: ExtensionContext,
  agentSettings: PicoStartupAgentSettings,
  config: PicoConfig
) => PicoController;
```

Pass the exact `config` local from `startPico` as the third argument.

- [ ] **Step 4: Verify Green**

Run: `npx vitest run tests/pico-startup.test.ts`

Expected: all startup tests pass.

- [ ] **Step 5: Write the failing service single-config test**

Build a valid resident config with `F13` / `F14`, leave the environment loader unavailable, and construct the service with an operator factory:

```ts
let receivedKeyboard: PicoResidentControlConfig["keyboard"] | undefined;
const residentPiAgent: PiAgentTurnClient = {
  prompt: () => Promise.resolve({ text: "unused" })
};

createResidentVoiceService({
  config,
  createOperator: (keyboard) => {
    receivedKeyboard = keyboard;
    return { record() {} };
  },
  createPiAgent: () => residentPiAgent,
  onError() {}
});

expect(receivedKeyboard).toBe(config.voice.resident.control?.keyboard);
```

The test must fail against the current constructor because it has no `config` or `createOperator` input and reloads the environment.

- [ ] **Step 6: Run the service test and verify Red**

Run: `npx vitest run tests/resident-voice-service.test.ts`

Expected: failure because the service still loads config internally and has no operator factory input.

- [ ] **Step 7: Implement service config injection**

Make `config: PicoConfig` required by `createResidentVoiceService`, remove its `loadPicoConfigFromEnvironment` call, and let `src/index.ts` pass the startup config. Change `requireResidentVoiceEnabled(config)` to return the validated `PicoResidentControlConfig`. Add this optional factory to the service input:

```ts
readonly createOperator?: (
  keyboard: PicoResidentControlConfig["keyboard"]
) => ResidentVoiceOperatorSink | undefined;
```

Construct the operator from the returned keyboard config and pass it to the runner. Do not re-parse or re-validate the keys.

- [ ] **Step 8: Verify focused Green and commit**

Run: `npx vitest run tests/pico-startup.test.ts tests/resident-voice-service.test.ts`

Expected: both files pass.

Commit: `refactor: share resolved resident startup config`

## Task 2: Render configured controls

**Files:**
- Modify: `src/runtime/resident-voice-terminal-display.ts`
- Modify: `src/runtime/resident-voice-terminal-renderer.ts`
- Modify: `src/index.ts`
- Test: `tests/resident-voice-terminal-display.test.ts`
- Test: `tests/resident-voice-terminal-renderer.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Add required controls to the test view and assert:

```ts
controls: { talkKey: "F13", cancelKey: "F14" }
```

The rendered header must contain `F13 話す · F14 中断` and must not contain `F1 話す`. Add a `RightArrow` / `LeftArrow` case that checks `visibleWidth(line) <= width` for narrow and wide widths.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/resident-voice-terminal-renderer.test.ts`

Expected: failure because the renderer still uses the fixed literal.

- [ ] **Step 3: Add the typed view contract**

Define a required control value using the existing config key type:

```ts
export type ResidentVoiceTerminalControls = {
  readonly talkKey: PicoMacKey;
  readonly cancelKey: PicoMacKey;
};
```

Add it to `ResidentVoiceTerminalView` and render its values. Do not add defaults.

- [ ] **Step 4: Add the display integration test and implementation**

Require controls in `createResidentVoiceTerminalOperator`, retain them in its view state, and pass the validated keyboard values from `src/index.ts` through the service's operator factory.

- [ ] **Step 5: Verify Green and commit**

Run: `npx vitest run tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts tests/resident-voice-service.test.ts`

Expected: all tests pass and every rendered line satisfies the width invariant.

Commit: `fix: display configured resident voice controls`

## Task 3: Move the PTT metric to the first accepted playback write

**Files:**
- Modify: `src/runtime/tts-playback-pipeline.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-terminal-renderer.ts`
- Test: `tests/tts-playback-pipeline.test.ts`
- Test: `tests/voice-resident.test.ts`
- Test: `tests/voice-stage-probe.test.ts`
- Test: `tests/resident-voice-terminal-renderer.test.ts`

- [ ] **Step 1: Write the failing pipeline ordering test**

Record pipeline events and assert the new callback occurs after the first session write resolves:

```ts
expect(events).toEqual([
  "admit-playback",
  "open-playback",
  "write:first",
  "first-write-accepted"
]);
```

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/tts-playback-pipeline.test.ts`

Expected: failure because no post-write callback exists.

- [ ] **Step 3: Implement one post-write notification**

Add `onFirstPlaybackWriteAccepted?: () => void` to pipeline options. Invoke it once after the first successful `session.write(chunk)` and before incrementing the played chunk count. Operator callback failure must not change playback success.

- [ ] **Step 4: Write the failing resident metric tests**

Assert that release leaves the measurement open through playback admission and open, then records `ptt_release_to_first_pcm_write` only after the first write. Add cancelled-before-write and write-failure cases and assert exactly one terminal settlement.

- [ ] **Step 5: Rename and relocate the stage**

Replace `ptt_release_to_playback_start` with `ptt_release_to_first_pcm_write` in the policy and resident runtime. Keep `onFirstPlaybackStart` for half-duplex admission only. Settle the PTT measurement from `onFirstPlaybackWriteAccepted`.

- [ ] **Step 6: Update terminal wording**

Read the renamed stage and render `音声送出 <duration>`. Remove the old `応答開始` wording.

- [ ] **Step 7: Verify Green and commit**

Run: `npx vitest run tests/tts-playback-pipeline.test.ts tests/voice-resident.test.ts tests/voice-stage-probe.test.ts tests/resident-voice-terminal-renderer.test.ts`

Expected: all focused tests pass.

Commit: `fix: measure first resident playback write`

## Task 4: Update contracts and run PR 1 gates

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-hold-to-talk-resident-control-design.md`
- Modify: `docs/superpowers/specs/2026-07-19-resident-voice-opentelemetry-design.md`
- Modify: `docs/superpowers/specs/2026-07-20-resident-voice-terminal-telemetry-hierarchy-design.md`

- [ ] **Step 1: Update the accepted specifications**

Document configured control labels, single startup config ownership, the renamed first-write stage, and the historical stage-name break. Do not change the separate visual hierarchy design.

- [ ] **Step 2: Run focused quality gates**

Run: `just typecheck`

Run: `just lint`

Run: `just ast`

Run: `npx vitest run tests/pico-startup.test.ts tests/resident-voice-service.test.ts tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts tests/tts-playback-pipeline.test.ts tests/voice-resident.test.ts tests/voice-stage-probe.test.ts`

Expected: all commands exit 0.

- [ ] **Step 3: Format and verify diff**

Run: `just format`

Run: `git diff --check`

Run: `rg -n "ptt_release_to_playback_start|F1 話す · F2 中断" src tests docs/superpowers/specs`

Expected: no obsolete production or accepted-spec literals remain; historical references are explicitly marked if retained.

- [ ] **Step 4: Commit documentation**

Commit: `docs: align resident controls and playback timing`
