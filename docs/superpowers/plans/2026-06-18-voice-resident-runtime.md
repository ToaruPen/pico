# Voice Resident Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the resident voice runtime that keeps listening, starts/stops timed sessions, calls Pi Agent through the SDK, plays Aivis output through echo control, enqueues ended sessions for long-memory processing, and records bounded stage probes. Pi Agent remains the production startup owner and loads pico as an extension; direct resident scripts are low-level validation and transition harnesses.

**Architecture:** The resident runtime is a dependency-injected loop that owns microphone frames, echo control, STT, trigger/session state, Pi Agent SDK turns, TTS playback, and memory enqueue ordering. `SessionLifecycle` separates cutoff generation from cleanup so a session is not discarded until its cutoff has been durably enqueued. Stage probes are recorded through the existing audit sink with a fixed schema and no raw audio, transcript, prompt, completion, secret, or profile payloads.

**Tech Stack:** TypeScript, Vitest, Pi Agent SDK, existing pico STT/TTS/AEC clients, existing structured audit log, existing long-memory session worker.

---

## File Structure

- Modify `src/modules/session/index.ts`: add `acknowledgeCutoff(sessionId)` and keep ended sessions until explicit acknowledgement or retention expiry.
- Modify `tests/session.test.ts`: cover cutoff retention, acknowledgement cleanup, and retention expiry.
- Modify `src/runtime/session-tool.ts`: let the tool use the shared lifecycle and acknowledge tool-driven cutoffs after payload generation.
- Modify `src/index.ts`: expose an extension factory that can receive shared runtime lifecycle dependencies.
- Create `src/runtime/voice-stage-probe.ts`: record bounded stage events through `StructuredAuditLog`.
- Create `tests/voice-stage-probe.test.ts`: validate allowed stages, attributes, and raw payload rejection.
- Create `src/runtime/voice-resident.ts`: implement the dependency-injected resident loop.
- Create `tests/voice-resident.test.ts`: cover pre-trigger ephemerality, active-session turn flow, TTS far-end timing, cutoff enqueue ordering, and concurrent cutoff queueing.
- Create `src/runtime/pi-agent-turn.ts`: adapt a resident turn to Pi Agent SDK `createAgentSession` without CLI subprocesses.
- Create `tests/pi-agent-turn.test.ts`: verify SDK prompt/subscribe path and shared extension factory usage with injected SDK factory.
- Modify `src/config/index.ts`, `tests/config.test.ts`, and `config/pico.example.yaml`: add `voice.resident` and `voice.probes` production config.
- Create `scripts/resident/voice.ts`: direct resident harness entrypoint that loads config, creates clients, installs signal cleanup, and runs the resident runtime.
- Modify `package.json`: add `resident:voice`.

## Task 1: Session Cutoff Acknowledgement

**Files:**
- Modify: `src/modules/session/index.ts`
- Modify: `src/runtime/session-tool.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write failing tests for cutoff retention and acknowledgement**

Add these cases to `tests/session.test.ts`:

```ts
it("keeps an ended session after cutoff until the cutoff is acknowledged", () => {
  vi.useFakeTimers();

  try {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 1 },
      endedSessionRetentionMs: 1_000
    });
    const session = lifecycle.start({ kind: "wake_name", label: "ピコ", source: "voice" });
    lifecycle.appendEntry(session.id, { role: "staff", content: "記憶に残す発話です。" });

    vi.advanceTimersByTime(1);

    const cutoff = lifecycle.cutoff(session.id);
    expect(cutoff.sessionId).toBe(session.id);
    expect(lifecycle.read(session.id)?.state).toBe("ended");

    lifecycle.acknowledgeCutoff(session.id);
    expect(lifecycle.read(session.id)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
```

Update the existing timed-ending test so it calls `lifecycle.acknowledgeCutoff(session.id)` before expecting `read()` to be `undefined`.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/session.test.ts`

Expected: TypeScript/Vitest fails because `acknowledgeCutoff` is not defined.

- [ ] **Step 3: Implement session acknowledgement**

Change `SessionLifecycle` to include:

```ts
readonly acknowledgeCutoff: (id: string) => void;
```

Change `cutoff(id)` so it returns the cutoff and clears the cleanup timer but does not delete the session. Add `acknowledgeCutoff(id)` that clears timers and deletes the session.

- [ ] **Step 4: Update session tool cutoff behavior**

In `src/runtime/session-tool.ts`, after `const cutoff = lifecycle.cutoff(id)`, call `lifecycle.acknowledgeCutoff(id)` so model-triggered tool cutoffs keep the old one-shot behavior. The resident runtime will call `cutoff()`, enqueue memory, then call `acknowledgeCutoff()`.

- [ ] **Step 5: Run GREEN**

Run: `npm run test -- tests/session.test.ts tests/extension.test.ts`

Expected: all listed tests pass.

## Task 2: Shared Pico Runtime Tools

**Files:**
- Modify: `src/index.ts`
- Test: `tests/extension.test.ts`

- [ ] **Step 1: Write failing test for injected lifecycle**

Add a test that creates a lifecycle, registers the extension through a new exported helper, invokes `pico_session`, and verifies the same lifecycle sees the started session.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/extension.test.ts`

Expected: fails because the helper is not exported.

- [ ] **Step 3: Implement extension factory options**

Export:

```ts
export type PicoExtensionRuntimeOptions = {
  readonly sessionLifecycle?: SessionLifecycle;
  readonly loadConfig?: () => PicoConfig;
};

export function registerPicoExtensionWithRuntime(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions = {}
): void
```

Have the default export call `registerPicoExtensionWithRuntime(pi)`. Pass `options.sessionLifecycle` and `options.loadConfig` into `createPicoSessionTool`.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/extension.test.ts`

Expected: pass.

## Task 3: Voice Stage Probe

**Files:**
- Create: `src/runtime/voice-stage-probe.ts`
- Test: `tests/voice-stage-probe.test.ts`

- [ ] **Step 1: Write failing probe tests**

Cover these behaviors:

```ts
expect(() => recordVoiceStageProbe(probe, {
  stage: "stt",
  status: "ok",
  startedAt: "2026-06-18T00:00:00.000Z",
  durationMs: 12,
  attributes: { "pico.voice.frame_count": 1 }
})).not.toThrow();

expect(() => recordVoiceStageProbe(probe, {
  stage: "stt",
  status: "ok",
  startedAt: "2026-06-18T00:00:00.000Z",
  durationMs: 12,
  attributes: { transcript: "raw text" }
})).toThrow("pico voice stage probe attribute is not allowed");
```

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/voice-stage-probe.test.ts`

Expected: fails because the module does not exist.

- [ ] **Step 3: Implement bounded probe recorder**

Implement `VoiceStageProbe`, `VoiceRuntimeStage`, `recordVoiceStageProbe()`, and fixed allowlists for stages and attributes. Record audit events with category `transport_event`, name `voice.runtime.stage`, and summary `Pico voice runtime stage completed.`

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/voice-stage-probe.test.ts tests/audit.test.ts`

Expected: pass.

## Task 4: Resident Runtime Core

**Files:**
- Create: `src/runtime/voice-resident.ts`
- Test: `tests/voice-resident.test.ts`

- [ ] **Step 1: Write failing tests for the resident turn flow**

Test with in-memory dependencies:

- A near-end frame is echo-processed before STT.
- Transcripts before a trigger do not call `sessionLifecycle.appendEntry`.
- A trigger starts a session.
- The active staff transcript is appended.
- The Pi Agent response is appended as assistant.
- TTS chunks are sent to playback and echo-control far-end reference with the same `capturedAt` timestamp.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/voice-resident.test.ts`

Expected: fails because the runtime module does not exist.

- [ ] **Step 3: Implement minimal resident loop**

Define dependency interfaces:

```ts
export type VoiceFrameSource = AsyncIterable<VoicePcmFrame>;
export type VoicePlaybackSink = {
  readonly play: (chunk: TtsAudioChunk, startedAt: string) => Promise<void>;
};
export type PiAgentTurnClient = {
  readonly prompt: (input: { readonly sessionId: string; readonly text: string; readonly signal?: AbortSignal }) => Promise<{ readonly text: string }>;
};
```

Implement `runVoiceResidentRuntime(options)` with a stop signal, trigger phrase matching, session start, turn processing, probe recording, TTS playback, far-end reference, and final echo-control flush.

- [ ] **Step 4: Add cutoff enqueue ordering test**

Use fake timers and a worker that records calls. Verify ended session handling order is:

```text
cutoff -> enqueueCutoff -> acknowledgeCutoff
```

When `enqueueCutoff` throws, verify `acknowledgeCutoff` is not called and the ended session remains readable.

- [ ] **Step 5: Run GREEN**

Run: `npm run test -- tests/voice-resident.test.ts`

Expected: pass.

## Task 5: Pi Agent SDK Turn Adapter

**Files:**
- Create: `src/runtime/pi-agent-turn.ts`
- Test: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Write failing SDK adapter tests**

Inject a fake `createAgentSession` function and assert:

- no CLI command is spawned,
- `prompt()` receives the resident turn text,
- `subscribe()` output is collected,
- the extension factory is called with the shared `SessionLifecycle`.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/pi-agent-turn.test.ts`

Expected: fails because the module does not exist.

- [ ] **Step 3: Implement SDK adapter**

Create `createPiAgentTurnClient()` that accepts injected SDK factory options for tests and defaults to `createAgentSession` in production. The resource loader must register pico through `registerPicoExtensionWithRuntime()` so the SDK session and resident runtime share the same lifecycle.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/pi-agent-turn.test.ts tests/long-memory-mem0-runtime.test.ts`

Expected: pass.

## Task 6: Production Config And Entrypoint

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`
- Create: `scripts/resident/voice.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing config tests**

Assert defaults:

```ts
expect(config.voice.resident.enabled).toBe(false);
expect(config.voice.resident.singleInstanceLockPath).toBe("tmp/pico-voice-resident.lock");
expect(config.voice.probes.enabled).toBe(true);
```

Assert configured microphone/playback values parse from YAML.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/config.test.ts`

Expected: fails because `voice.resident` and `voice.probes` are missing.

- [ ] **Step 3: Implement config parser and example YAML**

Add `PicoVoiceResidentConfig` with `enabled`, explicit `audioInput` and
`audioOutput` provider objects, `singleInstanceLockPath`, `minTriggerConfidence`,
and `shutdownGraceMs`. Add `PicoVoiceProbeConfig` with `enabled`. The original
first slice used direct microphone/playback device fields; the current resident
host decision replaces those with explicit macOS `avfoundation`/`afplay` and
Linux `alsa` provider boundaries.

- [ ] **Step 4: Add resident harness entrypoint**

Create `scripts/resident/voice.ts` that loads `PICO_CONFIG_PATH`, refuses to start unless `voice.resident.enabled` is true, creates the shared lifecycle and clients, installs `SIGINT`/`SIGTERM`, and calls `runVoiceResidentRuntime()`.

- [ ] **Step 5: Run GREEN**

Run: `npm run test -- tests/config.test.ts && npm run typecheck`

Expected: pass.

## Task 7: Verification, Polish, And PR Readiness

**Files:**
- Review all modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm run test -- tests/session.test.ts tests/extension.test.ts tests/voice-stage-probe.test.ts tests/voice-resident.test.ts tests/pi-agent-turn.test.ts tests/config.test.ts
```

- [ ] **Step 2: Run full gate**

Run: `just check`

- [ ] **Step 3: Run resident dry startup with disabled config**

Run: `npm run resident:voice`

Expected: exits with a clear configuration error if no production config enables resident mode.

- [ ] **Step 4: Run polishment and ai slop cleaner**

Use the repository skills after implementation is green. Fix only scoped issues.

- [ ] **Step 5: Create ready PR**

Commit the pico changes, push `codex/voice-resident-runtime`, create the PR, dispatch fresh role-free review agents using the subagent dispatch recovery pattern, address actionable findings, and converge.

## Self-Review

- Spec coverage: the plan covers resident runtime, SDK instead of CLI, shared lifecycle, cutoff/enqueue ordering, pre-trigger ephemerality, AEC far-end timing, stage probes, config, signal entrypoint, and PR gates. LINE and human review gates are intentionally absent.
- Placeholder scan: no `TBD`, `TODO`, or open-ended implementation placeholders remain.
- Type consistency: the same `acknowledgeCutoff`, `VoiceStageProbe`, `runVoiceResidentRuntime`, `PiAgentTurnClient`, and `registerPicoExtensionWithRuntime` names are used throughout.
