# Resident Voice Terminal Telemetry Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat resident voice widget with a width-aware turn card that prioritizes conversation, current phase, tool outcome, end-to-end response start, and one bottleneck summary.

**Architecture:** `resident-voice-terminal-display.ts` owns bounded event-to-state transitions, while a new pure renderer owns Pi theme styling, Japanese wrapping, and responsive layout. `voice-resident.ts` emits display-only phase events from already-successful controller transitions so the header never guesses whether a turn is still active.

**Tech Stack:** TypeScript 6, Vitest, Pi extension custom widgets, `@earendil-works/pi-tui`, OpenTelemetry-compatible voice stage events

---

### Task 1: Build and publish the structured turn-card widget

**Files:**
- Create: `src/runtime/resident-voice-terminal-renderer.ts`
- Create: `tests/resident-voice-terminal-renderer.test.ts`
- Modify: `src/runtime/resident-voice-terminal-display.ts`
- Modify: `src/runtime/resident-voice-operator.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/index.ts`
- Modify: `tests/resident-voice-terminal-display.test.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the direct Pi TUI development and peer dependency**

Use `apply_patch` to add `@earendil-works/pi-tui` at the same `0.80.6` family as the installed Pi peer:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-tui": "^0.80.6"
  }
}
```

Run: `npm install --package-lock-only`

Expected: `package.json` and `package-lock.json` contain the direct dependency; no unrelated dependency versions change.

- [ ] **Step 2: Write failing pure-renderer tests**

Create `tests/resident-voice-terminal-renderer.test.ts` around this public contract:

```ts
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  renderResidentVoiceTerminal,
  type ResidentVoiceTerminalView
} from "../src/runtime/resident-voice-terminal-renderer.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

const completedView: ResidentVoiceTerminalView = {
  phase: "idle",
  turns: [
    {
      staffText: "スタックチャンの状態を教えて",
      picoText: "準備できています。",
      tools: [{ name: "stackchan_get_status", status: "ok", durationMs: 350 }],
      timings: new Map([
        ["stt", { durationMs: 125, status: "ok" }],
        ["pi_time_to_first_text", { durationMs: 750, status: "ok" }],
        ["pi_turn", { durationMs: 20_350, status: "ok" }],
        ["tts_time_to_first_chunk", { durationMs: 1_450, status: "ok" }],
        ["tts_playback", { durationMs: 4_410, status: "ok" }],
        ["ptt_release_to_playback_start", { durationMs: 22_420, status: "ok" }]
      ])
    }
  ]
};

it.each([40, 60, 100])("keeps every rendered line within %i columns", (width) => {
  const lines = renderResidentVoiceTerminal(completedView, width, plainTheme);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
});

it("shows only the user-facing latency and longest comparable stage", () => {
  const output = renderResidentVoiceTerminal(completedView, 100, plainTheme).join("\n");
  expect(output).toContain("応答開始 22.42 s");
  expect(output).toContain("最長 Pi 20.35 s");
  expect(output).not.toContain("Pi初字");
  expect(output).not.toContain("再生 4.41 s");
});
```

Add focused assertions for:

- `YOU`, `PICO`, and `TOOL` role hierarchy;
- Japanese continuation-line wrapping at 40 columns;
- phase labels and symbol-plus-text semantics without color;
- normal and failed tool markers;
- no `[stop=stop]`, raw args, raw result, trace/span IDs, or trailing-silence details;
- current plus previous turn only;
- a narrow positive width never throwing and never exceeding the width.

- [ ] **Step 3: Run renderer tests and verify RED**

Run: `npm test -- tests/resident-voice-terminal-renderer.test.ts`

Expected: FAIL because `resident-voice-terminal-renderer.ts` and its exports do not exist.

- [ ] **Step 4: Implement the pure responsive renderer**

Create these view contracts in `src/runtime/resident-voice-terminal-renderer.ts`:

```ts
export type ResidentVoiceTerminalPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "processing"
  | "synthesizing"
  | "speaking";

export type ResidentVoiceTerminalTheme = {
  readonly fg: (
    color: "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text",
    text: string
  ) => string;
  readonly bold: (text: string) => string;
};

export type ResidentVoiceTerminalToolView = {
  readonly name: string;
  readonly status: VoiceStageStatus | "cancelled";
  readonly durationMs?: number;
  readonly errorCode?: string;
};

export type ResidentVoiceTerminalTurnView = {
  readonly staffText?: string;
  readonly picoText?: string;
  readonly failure?: string;
  readonly tools: readonly ResidentVoiceTerminalToolView[];
  readonly timings: ReadonlyMap<VoiceRuntimeStage, StageTimingView>;
};

export type ResidentVoiceTerminalView = {
  readonly phase: ResidentVoiceTerminalPhase;
  readonly activeToolName?: string;
  readonly turns: readonly ResidentVoiceTerminalTurnView[];
};
```

Implement `renderResidentVoiceTerminal(view, width, theme)` with
`wrapTextWithAnsi`, `truncateToWidth`, and `visibleWidth` from
`@earendil-works/pi-tui`. It must:

- return `[]` for non-positive width;
- render one fixed-position header with phase symbol/text and F1/F2 affordances;
- render role-labelled, indented wrapped text;
- render only tool name, symbol/status, duration, and bounded error code;
- show `ptt_release_to_playback_start` as `応答開始`;
- select the maximum duration only from `stt`, `pi_turn`, and
  `tts_time_to_first_chunk`;
- omit the divider below 48 columns and wrap controls/metrics below 72 columns;
- apply a final ANSI-aware width guard to every returned line.

- [ ] **Step 5: Run renderer tests and verify GREEN**

Run: `npm test -- tests/resident-voice-terminal-renderer.test.ts`

Expected: PASS with all renderer cases green.

- [ ] **Step 6: Write failing display-state and custom-widget tests**

Replace flat-line assertions in `tests/resident-voice-terminal-display.test.ts` with
tests against a structured display object:

```ts
const display = createResidentVoiceTerminalDisplay({ onChange });
display.record({ kind: "turn_phase", phase: "listening" });
display.record({ kind: "staff_transcript", text: "状態を教えて" });
display.record({
  kind: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "stackchan_get_status",
  args: hostileArgs
});
display.record({
  kind: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "stackchan_get_status",
  status: "ok",
  durationMs: 350,
  result: hostileResult
});

const output = display.render(100, plainTheme).join("\n");
expect(output).toContain("TOOL");
expect(output).toContain("stackchan_get_status");
expect(output).not.toContain("detail");
expect(sideEffect).not.toHaveBeenCalled();
```

Also require:

- widget registration only in TUI mode via a component factory;
- `tui.requestRender()` after each accepted event;
- component `render(width)` uses the current state and supplied theme;
- normal stop reason is hidden; a terminal failure without response remains visible;
- pending tools are capped at 32 and completed tools are bounded by the two-turn state;
- only the current and previous turn remain after three `turn_started` events;
- malformed events, theme failures, renderer failures, widget registration failures, and
  refresh failures do not escape into the voice runtime.

- [ ] **Step 7: Run display tests and verify RED**

Run: `npm test -- tests/resident-voice-terminal-display.test.ts`

Expected: FAIL because the current display accepts `setLines`, stores flat history and raw
payload snapshots, and registers a string-array widget.

- [ ] **Step 8: Refactor event state and widget integration**

In `resident-voice-operator.ts`, add the display-only event:

```ts
| {
    readonly kind: "turn_phase";
    readonly phase:
      | "idle"
      | "listening"
      | "transcribing"
      | "processing"
      | "synthesizing"
      | "speaking";
  }
```

In `resident-voice-terminal-display.ts`:

- replace `history: string[]` with at most two structured turn records;
- keep only bounded safe tool names in `pendingTools`; never read `args` or `result`;
- keep normal stop reason out of the view and expose only a response-less terminal failure;
- expose `{ record, render }`, with `onChange` as a best-effort callback;
- delete the now-unused payload serializer and all payload-budget options;
- register one Pi custom component in `createResidentVoiceTerminalOperator`;
- route component rendering to the pure renderer and event changes to
  `tui.requestRender()`;
- catch widget registration, rendering, theme, and refresh failures locally.

Update `src/index.ts` so its `setWidget` bridge preserves the custom component factory rather
than spreading line arrays.

- [ ] **Step 9: Run focused display and renderer tests and verify GREEN**

Run:

```bash
npm test -- tests/resident-voice-terminal-renderer.test.ts tests/resident-voice-terminal-display.test.ts
```

Expected: PASS.

- [ ] **Step 10: Write failing authoritative phase-event tests**

Update the operator event expectation in `tests/voice-resident.test.ts` so a normal turn contains
these events in lifecycle order around the existing transcript and response:

```ts
expect(operatorEvents).toEqual([
  { kind: "turn_started" },
  { kind: "turn_phase", phase: "listening" },
  { kind: "turn_phase", phase: "transcribing" },
  { kind: "turn_phase", phase: "processing" },
  { kind: "staff_transcript", text: "職員の発話" },
  { kind: "pi_response", text: "Picoの応答" },
  { kind: "turn_phase", phase: "synthesizing" },
  { kind: "turn_phase", phase: "speaking" },
  { kind: "turn_phase", phase: "idle" }
]);
```

Add separate assertions that no-speech and cancellation end with exactly one effective
`turn_phase: idle` transition and do not remain visually active.

- [ ] **Step 11: Run voice resident tests and verify RED**

Run: `npm test -- tests/voice-resident.test.ts`

Expected: FAIL because `voice-resident.ts` does not publish phase events.

- [ ] **Step 12: Publish phases from successful controller transitions**

Add a small `recordTurnPhase(operator, phase)` helper that delegates to
`recordResidentVoiceOperatorEvent`. Call it only after the corresponding controller operation
has been accepted:

- `listening` immediately after the existing `turn_started` event;
- `transcribing` in accepted release-tail processing;
- `processing` after the `transcribing → processing` advance;
- `synthesizing` after the `processing → synthesizing` advance;
- `speaking` after the `synthesizing → speaking` advance;
- `idle` on normal, no-speech, empty transcript, failed, and cancellation convergence.

Keep these events out of validation, normal logs, audit, and OTel. Avoid duplicate `idle`
notifications by settling each turn through one display lifecycle owner.

- [ ] **Step 13: Run focused runtime tests and verify GREEN**

Run:

```bash
npm test -- tests/voice-resident.test.ts tests/resident-voice-terminal-display.test.ts tests/resident-voice-terminal-renderer.test.ts
```

Expected: PASS.

- [ ] **Step 14: Refactor only after GREEN**

Remove duplicated phase/status lookup, centralize duration formatting used by the renderer, and
keep state mutation separate from rendering. Do not introduce a generic dashboard framework,
persisted UI state, runtime configuration flags, or alternate render backends.

- [ ] **Step 15: Run repository verification**

Run:

```bash
just format
just check
npx secretlint .
git diff --check
```

Expected: all commands exit 0; the Vitest summary has zero failures; only task-owned files are
modified.

- [ ] **Step 16: Commit the implementation**

```bash
git add package.json package-lock.json \
  src/index.ts \
  src/runtime/resident-voice-operator.ts \
  src/runtime/resident-voice-terminal-display.ts \
  src/runtime/resident-voice-terminal-renderer.ts \
  src/runtime/voice-resident.ts \
  tests/resident-voice-terminal-display.test.ts \
  tests/resident-voice-terminal-renderer.test.ts \
  tests/voice-resident.test.ts
git commit -m "feat(voice): clarify resident terminal telemetry"
```
