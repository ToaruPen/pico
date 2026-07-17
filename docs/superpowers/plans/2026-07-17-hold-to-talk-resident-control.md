# Hold-to-Talk Resident Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pico's continuous microphone and transcript-trigger runtime with configurable hold-to-talk and an independent cancel control, then deliver the change as a verified pull request.

**Architecture:** A TypeScript resident-control controller is the only owner of the voice state machine and active turn generation. A project-owned macOS Swift helper consumes configured global key events with one `CGEventTap` implementation and posts authenticated semantic events to a loopback TypeScript server. The TypeScript runner starts capture only for an accepted hold, applies the fixed release tail, and propagates cancellation through STT, Pi, TTS, and owned playback while preserving Pi's parent conversation context.

**Tech Stack:** TypeScript 6, Node.js 24, Vitest, Swift 6.2, CoreGraphics/ApplicationServices, FlyingFox, Biome, ESLint, ast-grep, Just.

---

## Delivery constraints

- Execute inline in this session. Subagents are not authorized for this task.
- Use Red → Green → Refactor for every behavior slice.
- Commit only files in this plan; never add `.codex/` artifacts.
- Do not retain a backward-compatible wake-word, greeting, activation-window, continuous-capture, or automatic fallback path.
- Use a single macOS keyboard implementation. Provider failures fail closed.
- No test identifiers may use the repository-forbidden mock/stub/fake vocabulary.
- The final PR must include the approved design, this plan, implementation, tests, and verification evidence.

## Task 1: Establish the feature branch and immutable configuration contract

**Files:**

- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `tests/config.test.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Add failing config tests**

Add cases proving the accepted shape and all startup rejections:

```ts
voice:
  resident:
    control:
      provider: loopback_http
      host: 127.0.0.1
      port: 8781
      authTokenPath: ~/.pico/resident-voice/control-token
      keyboard:
        provider: macos
        talkKey: F13
        cancelKey: F14
```

Assert that identical keys, modifier-only keys, unknown keys, non-loopback hosts,
unsupported providers, and missing required fields throw exact configuration errors.
Assert that `session.startTriggers`, `voice.resident.activation`,
`minTriggerConfidence`, and `utteranceWindow` are rejected as unknown properties.

- [ ] **Step 2: Run the focused test and confirm Red**

Run: `npx vitest run tests/config.test.ts`

Expected: failures because `voice.resident.control` is not defined and the old
fields still exist.

- [ ] **Step 3: Replace the configuration types and parser**

Define the startup-only contract:

```ts
export type PicoResidentControlConfig = {
  readonly provider: "loopback_http";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authTokenPath: string;
  readonly keyboard: {
    readonly provider: "macos";
    readonly talkKey: PicoMacKey;
    readonly cancelKey: PicoMacKey;
  };
};
```

Use an explicit key allowlist covering letters, digits, punctuation, arrows,
navigation keys, and `F1` through `F20`. Exclude modifier-only identifiers.
Remove `startTriggers` from `PicoSessionConfig`; remove activation, trigger
confidence, and utterance-window fields from `PicoVoiceResidentConfig`. Resolve
the token through the existing home-relative path logic. The helper executable
is a project-owned artifact at a stable package-relative production path, not a
user-selectable provider path.

- [ ] **Step 4: Update example YAML and make focused tests Green**

Run: `npx vitest run tests/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Check repeated identifiers and commit**

Run: `rg -n "PicoResidentControlConfig|talkKey|cancelKey" src tests config`

Commit: `feat(config): define resident hold-to-talk controls`

## Task 2: Replace activation transport with typed resident controls

**Files:**

- Delete: `src/runtime/resident-activation.ts`
- Delete: `tests/resident-activation.test.ts`
- Create: `src/runtime/resident-control.ts`
- Create: `tests/resident-control.test.ts`

- [ ] **Step 1: Write failing transport tests**

Test authenticated `POST /v1/resident-control/events` requests with bodies:

```json
{"event":"talk_pressed"}
{"event":"talk_released"}
{"event":"cancel_pressed"}
```

The handler returns one of `accepted`, `ignored_busy`, `ignored_stale`, or
`noop`, and the HTTP response exposes only that result. Test wrong token,
missing token, unknown events, invalid JSON, wrong method/path, non-loopback
bind rejection, token symlink rejection, wrong file mode, and shutdown.

- [ ] **Step 2: Run the focused test and confirm Red**

Run: `npx vitest run tests/resident-control.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the transport without a pending queue**

Use the contract:

```ts
export type ResidentControlEvent =
  | { readonly kind: "talk_pressed"; readonly occurredAt: string }
  | { readonly kind: "talk_released"; readonly occurredAt: string }
  | { readonly kind: "cancel_pressed"; readonly occurredAt: string };

export type ResidentControlResult =
  | "accepted"
  | "ignored_busy"
  | "ignored_stale"
  | "noop";

export type ResidentControlHandler = (
  event: ResidentControlEvent
) => ResidentControlResult | Promise<ResidentControlResult>;
```

Reuse the existing strict bearer-token file checks. Call the handler directly;
do not buffer or replay events.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/resident-control.test.ts`

Expected: PASS.

Commit: `feat(voice): add semantic resident control transport`

## Task 3: Build the deterministic hold-to-talk state controller

**Files:**

- Create: `src/runtime/resident-control-controller.ts`
- Create: `tests/resident-control-controller.test.ts`

- [ ] **Step 1: Write the state-transition test matrix**

Cover `idle`, `listening`, `tailing`, `transcribing`, `processing`,
`synthesizing`, `speaking`, `cancelling`, `error`, and `stopped`.

Required assertions:

- idle talk press is accepted once;
- keyboard repeat is a no-op;
- talk release without a matching press is stale;
- release schedules exactly 250 ms and cannot schedule twice;
- talk while busy is ignored and never replayed;
- cancel is accepted from every active stage and idempotent while cancelling;
- completion from an invalid generation is suppressed;
- error and stopped reject all controls.

Use a deterministic injected scheduler:

```ts
export type ResidentControlScheduler = {
  readonly schedule: (delayMs: number, operation: () => void) => { readonly cancel: () => void };
};
```

- [ ] **Step 2: Run the focused test and confirm Red**

Run: `npx vitest run tests/resident-control-controller.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the single transition owner**

The public controller contract is:

```ts
export type ResidentControlState =
  | "idle"
  | "listening"
  | "tailing"
  | "transcribing"
  | "processing"
  | "synthesizing"
  | "speaking"
  | "cancelling"
  | "error"
  | "stopped";

export type ResidentTurnGeneration = {
  readonly id: number;
  readonly signal: AbortSignal;
};
```

Only this module may assign the state or current generation. Async owners
receive generation IDs and return typed completion events. Every completion is
checked before it can transition.

- [ ] **Step 4: Run focused tests, structural search, and commit**

Run: `npx vitest run tests/resident-control-controller.test.ts`

Run: `rg -n "state =|currentGeneration" src/runtime/resident-control-controller.ts src/runtime`

Expected: PASS; state mutation appears only in the controller owner.

Commit: `feat(voice): add hold-to-talk state controller`

## Task 4: Make microphone capture on-demand and playback stoppable

**Files:**

- Modify: `src/runtime/resident-audio-io.ts`
- Modify: `tests/resident-audio-io.test.ts`
- Modify: `tests/resident-audio-input-smoke.test.ts`
- Modify: `scripts/smoke/resident-audio-input.ts`

- [ ] **Step 1: Add failing ownership tests**

Prove that creating the input owner spawns nothing, `start()` spawns exactly one
capture process, `stop()` terminates only that process and resolves after close,
and a second start is rejected until the first capture ends. Prove playback
`stop()` terminates only the active output child and is idempotent.

- [ ] **Step 2: Run the focused tests and confirm Red**

Run: `npx vitest run tests/resident-audio-io.test.ts tests/resident-audio-input-smoke.test.ts`

- [ ] **Step 3: Implement explicit capture and playback ownership**

Replace the eager frame source with:

```ts
export type ResidentCaptureSession = {
  readonly frames: AsyncIterable<VoicePcmFrame>;
  readonly stop: () => Promise<void>;
};

export type ResidentAudioCapture = {
  readonly start: (signal: AbortSignal) => ResidentCaptureSession;
  readonly close: () => Promise<void>;
};

export type VoicePlaybackSink = {
  readonly play: (
    chunk: TtsAudioChunk,
    startedAt: string,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
};
```

Track the exact owned child. Treat the expected signal exit during stop as
successful cancellation; retain nonzero unexpected exit as an error. Keep temp
WAV cleanup in `finally`.

- [ ] **Step 4: Update the input smoke tool to use a bounded capture session**

The smoke tool starts capture, measures the requested interval, stops and drains
the session, and never reads removed utterance-window config.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/resident-audio-io.test.ts tests/resident-audio-input-smoke.test.ts`

Expected: PASS.

Commit: `feat(audio): own capture and playback lifecycles`

## Task 5: Propagate AbortSignal through Apple Speech STT

**Files:**

- Modify: `src/modules/voice/index.ts`
- Modify: `tests/voice.test.ts`

- [ ] **Step 1: Add a failing cancellation test**

Abort while the Apple Speech HTTP request is pending and assert one terminal
`reason: "aborted"` result, no late success, and no retry.

- [ ] **Step 2: Run the focused test and confirm Red**

Run: `npx vitest run tests/voice.test.ts`

- [ ] **Step 3: Add the request signal**

```ts
export type SttTranscriptionRequest = {
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly signal?: AbortSignal;
};
```

Pass it to `fetch`; map aborts to the existing aborted failure category without
changing provider selection or adding a retry.

- [ ] **Step 4: Run focused tests and commit**

Run: `npx vitest run tests/voice.test.ts`

Commit: `feat(voice): make speech transcription cancellable`

## Task 6: Replace the production resident voice loop

**Files:**

- Rewrite: `src/runtime/voice-resident.ts`
- Rewrite: `tests/voice-resident.test.ts`
- Delete: `src/runtime/voice-utterance-window.ts`
- Delete: `tests/voice-utterance-window.test.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `tests/voice-stage-probe.test.ts`

- [ ] **Step 1: Replace legacy tests with the approved behavior matrix**

The test driver submits semantic control events and controlled async completions.
It must prove:

- idle creates no capture and makes zero STT calls;
- press starts capture with no pre-press frames;
- release waits 249 ms, then one more millisecond before stop;
- the final submitted audio contains tail frames;
- no-speech returns idle without STT or Pi;
- speech calls STT exactly once and submits exactly one literal Pi prompt;
- later holds reuse the Pi parent session;
- busy talk is ignored and cannot run later;
- cancel converges from listening, tailing, transcribing, processing,
  synthesizing, and speaking;
- Pi receives one abort signal and converges through its host boundary;
- playback stop is called once;
- parent session is not disposed or farewelled by cancel;
- stale STT, Pi, TTS, and playback results emit nothing;
- shutdown drains every owned resource.

- [ ] **Step 2: Run the focused test and confirm Red**

Run: `npx vitest run tests/voice-resident.test.ts`

- [ ] **Step 3: Implement the event-driven runtime**

Expose one long-running runtime plus its handler:

```ts
export type VoiceResidentRuntime = {
  readonly handleControl: (event: ResidentControlEvent) => Promise<ResidentControlResult>;
  readonly completion: Promise<VoiceResidentRuntimeResult>;
  readonly stop: () => Promise<void>;
};

export function createVoiceResidentRuntime(
  options: VoiceResidentRuntimeOptions
): VoiceResidentRuntime;
```

On tail completion, drain capture frames into one PCM frame, run the existing
echo/speech gate only as empty-hold admission, and invoke STT once. Create a
`button_trigger` interaction only if no active Pi parent interaction exists.
Refresh activity only after a successful turn. Reuse existing Pi host prompt,
deferred-result delivery, TTS segmentation, echo-control playback reference,
and normal inactivity farewell behavior where they remain compatible.

- [ ] **Step 4: Remove trigger and utterance-window production code**

Delete transcript matching, wake acknowledgement, activation source, pending
activation, utterance assembler, and trigger-confidence paths. Rename probe
stages to control/capture/turn stages without recording keys or text.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/voice-resident.test.ts tests/pi-agent-turn.test.ts tests/voice-stage-probe.test.ts`

Expected: PASS.

Commit: `feat(voice): run one turn per hold-to-talk activation`

## Task 7: Implement and verify the project-owned macOS key bridge

**Files:**

- Create: `sidecars/macos-control/Package.swift`
- Create: `sidecars/macos-control/Sources/PicoMacOSControlCore/ControlConfiguration.swift`
- Create: `sidecars/macos-control/Sources/PicoMacOSControlCore/ControlEvent.swift`
- Create: `sidecars/macos-control/Sources/PicoMacOSControlCore/ControlTransport.swift`
- Create: `sidecars/macos-control/Sources/PicoMacOSControl/PicoMacOSControl.swift`
- Create: `sidecars/macos-control/Tests/PicoMacOSControlCoreTests/ControlConfigurationTests.swift`
- Create: `sidecars/macos-control/Tests/PicoMacOSControlCoreTests/ControlEventTests.swift`
- Create: `sidecars/macos-control/Tests/PicoMacOSControlCoreTests/ControlTransportTests.swift`
- Create: `scripts/ci/run-macos-control-gates.sh`
- Modify: `justfile`

- [ ] **Step 1: Record the bounded native API spike result in the approved design**

Verify from Apple primary documentation and the local SDK that `CGEvent.tapCreate`
can observe and suppress key-down/up events, that listen-event authorization can
be preflighted/requested, and that the run-loop source can be removed during
deterministic shutdown. Record the fixed choice and permission caveat; do not
add a second provider.

- [ ] **Step 2: Add failing Swift core tests**

Test CLI/config decoding, explicit key-name-to-keycode mapping, repeat-keydown
suppression, orphan-release suppression, cancel keydown emission, bearer header,
semantic JSON body, non-2xx failure, and token file validation.

- [ ] **Step 3: Implement the CoreGraphics bridge**

Use a session event tap at head insertion. Return `nil` for configured key events
so the bound controls are consumed; pass all unrelated events through. Emit
`talk_pressed`, `talk_released`, and `cancel_pressed` only. Before printing the
single ready line, verify Input Monitoring authorization, event-tap creation,
token readiness, and server health. SIGTERM removes the run-loop source and
exits zero.

- [ ] **Step 4: Add the platform gate and run it**

Run: `just macos-control-check`

Expected: Swift format check, build, and tests PASS on Darwin.

- [ ] **Step 5: Commit**

Commit: `feat(macos): add global resident control bridge`

## Task 8: Wire server, controller, bridge, and provider lifecycle

**Files:**

- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `tests/resident-voice-runner.test.ts`
- Create: `src/runtime/macos-control-bridge.ts`
- Create: `tests/macos-control-bridge.test.ts`
- Modify: `src/runtime/resident-voice-service.ts`

- [ ] **Step 1: Add failing runner and bridge lifecycle tests**

Prove startup order `server → runtime → bridge ready`, no microphone before a
control event, actionable permission failure, ready timeout, unexpected helper
exit causing runtime error, shutdown order `reject controls → cancel turn → stop
bridge → close server`, and no provider fallback.

- [ ] **Step 2: Run focused tests and confirm Red**

Run: `npx vitest run tests/macos-control-bridge.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-service.test.ts`

- [ ] **Step 3: Implement managed bridge ownership**

Spawn the project-owned helper from its stable package-relative production path
with host, port, token path, talk key, and cancel key arguments. Do not put the
token contents on the command line or in environment variables. Accept exactly
one machine-readable ready record. Capture bounded stderr for actionable
startup/exit errors and kill only the owned child during shutdown.

- [ ] **Step 4: Replace runner activation wiring**

Create on-demand capture, controller/runtime, loopback control server, and
keyboard bridge. Remove `createConfiguredActivation`, eager frames, trigger
phrases, wake acknowledgement, and utterance-window arguments.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/macos-control-bridge.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-service.test.ts`

Expected: PASS.

Commit: `feat(voice): manage hold-to-talk production runtime`

## Task 9: Remove obsolete field paths and add hold-to-talk validation

**Files:**

- Delete: `scripts/field/resident-voice-pseudo-input.ts`
- Delete: `scripts/field/resident-voice-deferred-rallies.ts`
- Delete: `scripts/field/voice-echo-pickup.ts`
- Delete: `tests/voice-echo-pickup-field.test.ts`
- Delete: `src/runtime/live-voice-turn.ts`
- Delete: `tests/live-voice-turn.test.ts`
- Create: `scripts/field/resident-hold-to-talk.ts`
- Create: `docs/superpowers/research/2026-07-17-hold-to-talk-field-validation.md`
- Modify: `package.json`
- Modify: `justfile`
- Modify: relevant runtime/spec references found by structural search

- [ ] **Step 1: Add a failing field-contract test if reusable logic is extracted**

The field harness reports only bounded measurements: accepted/ignored outcomes,
capture startup latency, hold duration, tail duration, frame count, stage and
cancellation timings, idle STT count, CPU, and RSS. It must not record keys,
audio, transcript, prompts, or completions.

- [ ] **Step 2: Delete obsolete continuous-input and transcript-trigger harnesses**

Remove package scripts and Just recipes for deleted paths. Update smoke and docs
that read removed config. Keep unrelated provider smoke tools.

- [ ] **Step 3: Add the field harness and run available Mac validation**

Run: `npm run field:resident-hold-to-talk -- --help`

If a Moonlander and microphone are available, run the bounded validation and
record measured evidence. Otherwise, record the exact unavailable hardware
check and keep the automated bridge/controller evidence separate from hardware
claims.

- [ ] **Step 4: Prove obsolete production identifiers are gone**

Run:

```sh
rg -n "wake_word|wakeNames|greetings|minTriggerConfidence|activationWindowMs|utteranceWindow|ResidentActivation|resident-activation|triggerPhrases" src tests config scripts package.json justfile
```

Expected: no production or test matches; any retained historical documentation
is explicitly marked superseded.

- [ ] **Step 5: Commit**

Commit: `refactor(voice): remove continuous trigger runtime`

## Task 10: Full verification, self-review, and pull request

**Files:**

- Modify only defects found within this plan's scope.
- Include: `docs/superpowers/specs/2026-07-17-hold-to-talk-resident-control-design.md`
- Include: `docs/superpowers/plans/2026-07-17-hold-to-talk-resident-control.md`

- [ ] **Step 1: Format changed files**

Run: `just format`

- [ ] **Step 2: Run focused native and TypeScript gates**

Run: `just macos-control-check`

Run: `just apple-speech-check`

Run: `just typecheck`

Run: `just lint`

Run: `just ast`

Run: `just test`

- [ ] **Step 3: Run the repository gate**

Run: `just check`

Expected: PASS with no skipped required Darwin gate.

- [ ] **Step 4: Review the exact diff and working tree**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff origin/main...HEAD --stat`

Run: `git diff origin/main...HEAD`

Confirm `.codex/` is absent, no secret/token/audio/transcript data is present,
the approved configuration matches the implementation, and no unrelated files
changed.

- [ ] **Step 5: Commit final documentation or review corrections**

Commit: `docs(voice): document hold-to-talk delivery`

Skip this commit if the documentation was already included and there are no
remaining changes.

- [ ] **Step 6: Push and open the PR**

Push the feature branch, create a PR against `main`, and include:

- product behavior and state ownership;
- removed legacy paths;
- macOS permission and launch-path behavior;
- automated verification commands and results;
- hardware field evidence or an explicit statement that hardware validation is
  pending, without presenting it as automated proof.

- [ ] **Step 7: Verify the remote PR**

Read back the PR URL, title, base/head, changed-file scope, and checks status.
Report the PR and any genuinely pending external/hardware item to the user.
