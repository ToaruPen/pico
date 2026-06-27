# TEN VAD Speech Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit resident voice speech-gate layer so noisy non-speech is filtered before STT, with TEN VAD available as an opt-in WASM provider.

**Architecture:** The resident pipeline keeps echo control separate from speech detection. `voice.resident.vad.provider` selects `energy` or `ten_vad`; the gate runs after `echoControl.processNearEnd()` and before `voice-utterance-window`, and the utterance window consumes the gate decision instead of treating every passed echo frame as speech. TEN VAD is opt-in and requires explicit WASM asset paths; no automatic fallback is allowed.

**Tech Stack:** TypeScript, Vitest, Node.js WebAssembly, TEN VAD WASM assets, existing resident voice runtime, existing config parser.

---

## File Structure

- Create `src/runtime/speech-activity-gate.ts`: provider contract, energy provider, TEN WASM provider loader, frame validation, result shape.
- Modify `src/runtime/voice-resident.ts`: add `speechActivity` dependency, call it between echo control and utterance assembly, record `speech_gate` metrics, preserve no-speech hallucination guard.
- Modify `scripts/resident/voice.ts`: create the configured speech gate and pass it into the runtime.
- Modify `src/config/index.ts`: add `voice.resident.vad` config with `energy` and `ten_vad` variants.
- Modify `src/runtime/voice-stage-probe.ts` and `src/runtime/resident-voice-log-files.ts`: allow `speech_gate` metrics and bounded diagnostic attributes.
- Modify `config/pico.example.yaml`: document `voice.resident.vad`.
- Test `tests/speech-activity-gate.test.ts`: energy and TEN provider contract tests with an injected TEN test module factory.
- Test `tests/voice-resident.test.ts`: noisy non-speech after wake does not reach STT/Pi Agent when speech gate suppresses it.
- Test `tests/config.test.ts`: parse `energy` and `ten_vad` config.

## Task 1: Speech Gate Contract and Energy Provider

**Files:**
- Create: `src/runtime/speech-activity-gate.ts`
- Test: `tests/speech-activity-gate.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that assert `createEnergySpeechActivityGate({ minRmsDb: -50 })` suppresses a low-amplitude PCM frame and passes a high-amplitude PCM frame.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/speech-activity-gate.test.ts`

Expected: FAIL because `speech-activity-gate.ts` does not exist.

- [ ] **Step 3: Implement minimal energy provider**

Create the provider contract:

```ts
export type SpeechActivityGateResult = {
  readonly speech: boolean;
  readonly provider: "energy" | "ten_vad";
  readonly probability?: number;
  readonly rmsDb: number;
};

export type SpeechActivityGate = {
  readonly process: (frame: VoicePcmFrame) => Promise<SpeechActivityGateResult>;
  readonly close?: () => Promise<void> | void;
};
```

Implement `createEnergySpeechActivityGate`.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/speech-activity-gate.test.ts`

Expected: PASS.

## Task 2: TEN WASM Provider

**Files:**
- Modify: `src/runtime/speech-activity-gate.ts`
- Test: `tests/speech-activity-gate.test.ts`

- [ ] **Step 1: Write failing tests**

Add an injected TEN test module factory contract test. It should verify that the provider:

- calls `_ten_vad_create(handlePtr, hopSize, threshold)`
- copies PCM16LE samples into WASM memory
- calls `_ten_vad_process(handle, audioPtr, hopSize, probPtr, flagPtr)`
- returns `speech: true` when the injected test module writes probability `0.8` and flag `1`

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/speech-activity-gate.test.ts`

Expected: FAIL because the TEN provider is not implemented.

- [ ] **Step 3: Implement TEN provider**

Add `createTenWasmSpeechActivityGate({ jsPath, wasmPath, hopSize, threshold, moduleFactory? })`. It loads the ESM TEN JS module when no factory is injected, reads `wasmPath`, creates one VAD handle, validates 16kHz mono PCM16LE frames, and processes one hop-sized frame.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/speech-activity-gate.test.ts`

Expected: PASS.

## Task 3: Runtime Integration

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-log-files.ts`
- Test: `tests/voice-resident.test.ts`

- [ ] **Step 1: Write failing test**

Add a test where wake starts a session, then the next noisy frame is suppressed by an injected speech gate. Assert STT is called only for wake and Pi Agent is not called for the suppressed active frame.

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/voice-resident.test.ts -t "speech gate"`

Expected: FAIL because runtime ignores the speech gate.

- [ ] **Step 3: Wire the speech gate**

Add `speechActivity?: SpeechActivityGate` to runtime options. After echo control passes a frame, call the speech gate and pass `speechGateResult.speech` into `utteranceAssembler.accept()`. Record `speech_gate` metrics with action, probability, and RMS.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/voice-resident.test.ts tests/speech-activity-gate.test.ts`

Expected: PASS.

## Task 4: Config and Resident Entrypoint

**Files:**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `scripts/resident/voice.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests for:

- default `voice.resident.vad.provider === "energy"`
- `provider: ten_vad` requires `jsPath` and `wasmPath`
- `threshold` is a probability
- `hopSize` is `160` or `256`

- [ ] **Step 2: Run RED**

Run: `npm run test -- tests/config.test.ts`

Expected: FAIL because the config shape is missing.

- [ ] **Step 3: Implement config and entrypoint**

Parse `voice.resident.vad`, resolve TEN asset paths relative to config, and create the selected provider in `scripts/resident/voice.ts`. Do not fallback from `ten_vad` to `energy`.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- tests/config.test.ts tests/voice-resident.test.ts tests/speech-activity-gate.test.ts`

Expected: PASS.

## Task 5: Verification

**Files:**
- No new implementation files.

- [ ] **Step 1: Run static and focused gates**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test -- tests/speech-activity-gate.test.ts tests/voice-resident.test.ts tests/config.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run full gate**

Run: `just check`

Expected: full project check passes.

- [ ] **Step 3: Field check**

Run resident voice only after TEN asset paths are configured. If `provider: energy`, verify quiet room no longer produces repeated `ご視聴ありがとうございました`. If `provider: ten_vad`, verify TEN assets load and `speech_gate` metrics show pass/suppress decisions.

## Self-Review

- Spec coverage: The plan adds a speech gate layer, keeps TEN opt-in, preserves energy behavior, adds metrics, and avoids automatic fallback.
- Placeholder scan: No placeholder tasks remain.
- Type consistency: `SpeechActivityGate`, `SpeechActivityGateResult`, and config provider names are consistent across tasks.
