# Resident Voice Latency Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record real wall-clock latency for resident STT, Pi turns, TTS requests, and playback while keeping provider-reported utterance length as a separate bounded metric attribute.

**Architecture:** The resident runtime owns wall-clock timing through its existing monotonic clock dependency. Provider-reported media duration remains diagnostic metadata and never substitutes for elapsed stage time. The fixed probe enum removes the misleading `tts_synthesize` and unused `tts_audio_duration` stages in favor of `tts_request_wall` and `tts_playback`.

**Tech Stack:** TypeScript, Vitest, Pi extension runtime, structured audit JSONL, Biome, ESLint

---

## Task 1: Specify the corrected probe contract

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-hold-to-talk-resident-control-design.md`

- [x] **Step 1: Add the latency measurement contract**

Add a section stating that `pico.voice.stage_duration_ms` is monotonic wall-clock elapsed time for `stt`, `pi_turn`, `tts_request_wall`, and `tts_playback`; `pico.voice.utterance_duration_ms` is provider/media duration only; and the removed `tts_synthesize` and `tts_audio_duration` names must not be emitted.

- [x] **Step 2: Review the contract against the runtime boundary**

Confirm that the section records no transcript, prompt, completion, endpoint, model name, key name, or session ID.

## Task 2: Prove the current STT and TTS measurements are wrong

**Files:**
- Modify: `tests/voice-resident.test.ts`

- [x] **Step 1: Add a failing STT wall-clock test**

Create a controlled monotonic clock and deferred STT result. Assert that the emitted `stt` event uses elapsed wall time and preserves the provider duration as metadata:

```ts
expect(stageEvent(audit, "stt")).toMatchObject({
  attributes: {
    "pico.voice.stage": "stt",
    "pico.voice.stage_duration_ms": 175,
    "pico.voice.utterance_duration_ms": 1_000
  }
});
```

- [x] **Step 2: Run the STT test and verify RED**

Run:

```bash
npx vitest run tests/voice-resident.test.ts -t "records STT wall time separately from utterance duration"
```

Expected: FAIL because the runtime currently records the provider duration as `pico.voice.stage_duration_ms` and emits no utterance-duration attribute.

- [x] **Step 3: Add a failing TTS request/playback wall-clock test**

Use deferred synthesis and playback gates. Advance the monotonic clock from `450` to `1_500` before playback completes so the `1_050` ms playback wall time cannot be confused with the synthesized media duration. Assert that synthesis emits `tts_request_wall` with real request latency and playback emits `tts_playback` with real playback latency:

```ts
expect(stageEvent(audit, "tts_request_wall")).toMatchObject({
  attributes: {
    "pico.voice.stage_duration_ms": 450,
    "pico.voice.utterance_duration_ms": 1_200,
    "pico.voice.chunk_count": 1
  }
});
expect(stageEvent(audit, "tts_playback")).toMatchObject({
  attributes: {
    "pico.voice.stage_duration_ms": 1_050,
    "pico.voice.utterance_duration_ms": 1_200,
    "pico.voice.chunk_count": 1
  }
});
```

- [x] **Step 4: Run the TTS test and verify RED**

Run:

```bash
npx vitest run tests/voice-resident.test.ts -t "records TTS request and playback wall time"
```

Expected: FAIL because the runtime currently emits `tts_synthesize` with audio duration and emits no playback event.

## Task 3: Implement monotonic wall-clock stage measurement

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Test: `tests/voice-resident.test.ts`

- [x] **Step 1: Measure STT request wall time**

Pass the runtime monotonic clock into `transcribeHold`, capture the value before awaiting the provider, and emit elapsed time after settlement. On success attach the provider result as `pico.voice.utterance_duration_ms`; on cancellation use `skipped`; on provider failure use `error` with the existing reason.

- [x] **Step 2: Measure Pi turn and TTS request wall time**

Preserve elapsed `pi_turn` timing on success, cancellation, and failure. Pass the monotonic clock into `requestTts`. Emit `tts_request_wall` with elapsed wall time. On success attach `pico.voice.utterance_duration_ms` and `pico.voice.chunk_count`; on cancellation emit `skipped`; on failure emit `error`.

- [x] **Step 3: Measure playback wall time**

Pass the monotonic clock into `playTurnChunks`. Emit one `tts_playback` event for the whole response, using elapsed wall time and attaching total chunk media duration plus chunk count. Preserve current cancellation and cleanup behavior.

- [x] **Step 4: Run the focused runtime tests and verify GREEN**

Run:

```bash
npx vitest run tests/voice-resident.test.ts
```

Expected: PASS.

## Task 4: Remove misleading TTS stage names

**Files:**
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `tests/voice-stage-probe.test.ts`
- Modify: `tests/resident-voice-measurements.test.ts`

- [x] **Step 1: Add a failing removed-stage test**

Assert that `recordVoiceStageProbe` rejects both removed stage names:

```ts
for (const stage of ["tts_synthesize", "tts_audio_duration"]) {
  expect(() => recordVoiceStageProbe(...)).toThrow("pico voice runtime stage is invalid");
}
```

- [x] **Step 2: Run the probe test and verify RED**

Run:

```bash
npx vitest run tests/voice-stage-probe.test.ts -t "rejects removed TTS stage names"
```

Expected: FAIL because both names are currently accepted.

- [x] **Step 3: Remove both names from all fixed stage sets**

Keep `tts_request_wall` and `tts_playback` in the runtime enum, audit summary filter, and resident metric filter. Update measurement fixtures to compare `tts_request_wall` instead of `tts_synthesize`.

- [x] **Step 4: Run probe, audit, runner, and measurement tests**

Run:

```bash
npx vitest run tests/voice-stage-probe.test.ts tests/resident-voice-audit-log.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-measurements.test.ts
```

Expected: PASS.

## Task 5: Centralize stage persistence and summary policy

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-voice-resident-runtime-design.md`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Test: `tests/resident-voice-audit-log.test.ts`
- Test: `tests/voice-stage-probe.test.ts`

- [x] **Step 1: Add a failing exhaustive policy test**

Assert that every accepted stage has exactly one `persisted` and `summary` policy, with no duplicate
stage values and no policy-less accepted stage.

- [x] **Step 2: Run the policy test and verify RED**

Run:

```bash
npx vitest run tests/voice-stage-probe.test.ts -t "assigns one persistence and summary policy"
```

Expected: FAIL because the accepted enum, metrics filter, and summary filter are separate sets.

- [x] **Step 3: Derive all three consumers from one registry**

Define the accepted stage type and stage list from one policy registry. Use that same registry for
probe validation, metrics JSONL filtering, and summary stdout filtering.

- [x] **Step 4: Verify registry consumers**

Run:

```bash
npx vitest run tests/voice-stage-probe.test.ts tests/resident-voice-audit-log.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-measurements.test.ts
```

Expected: PASS.

## Task 6: Verify and converge the stacked latency PR

**Files:**
- Modify only when required by deterministic formatting or review findings.

- [x] **Step 1: Search the completed change surface**

Run:

```bash
rg -n "tts_synthesize|tts_audio_duration|tts_request_wall|tts_playback|pico.voice.utterance_duration_ms" src tests docs/superpowers/specs
```

Expected: removed names appear only in explicit rejection/supersession documentation; new names appear in their intended owners.

- [x] **Step 2: Run the full local gate**

Run:

```bash
just check
```

Expected: PASS.

- [x] **Step 3: Run polishment and ai-slop-cleaner**

Apply only behavior-preserving cleanup within the changed files, then rerun focused tests and `just check`.

- [x] **Step 4: Commit and push**

```bash
git add docs/superpowers/plans/2026-07-17-resident-voice-latency-observability-implementation-plan.md docs/superpowers/specs/2026-06-18-voice-resident-runtime-design.md docs/superpowers/specs/2026-07-17-hold-to-talk-resident-control-design.md src/runtime/voice-resident.ts src/runtime/voice-stage-probe.ts src/runtime/resident-voice-audit-log.ts src/runtime/resident-voice-runner.ts tests/voice-resident.test.ts tests/voice-stage-probe.test.ts tests/resident-voice-audit-log.test.ts tests/resident-voice-measurements.test.ts
git commit -m "fix(voice): measure resident latency by wall clock"
git push origin codex/resident-latency-observability
```

- [ ] **Step 5: Converge the stacked draft PR**

Open the draft PR against `feat/hold-to-talk-resident-control`, wait for GitHub checks, address only
actionable review or CI findings, and leave both PRs ready for the next user decision.
