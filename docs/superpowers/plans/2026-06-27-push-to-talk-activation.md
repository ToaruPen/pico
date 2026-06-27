# Push To Talk Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure loopback push-to-talk activation for the resident voice runtime so a USB 8BitDo programmable button can start a typed voice session without depending on terminal focus.

**Architecture:** Add a typed activation boundary that separates wake-word session starts from physical-button starts. The first production provider is a loopback-only HTTP endpoint with bearer-token auth, POST-only activation, debounce, and lifecycle cleanup. Button activations start sessions as `button_trigger` triggers and only allow post-activation utterances through to Pi Agent.

**Tech Stack:** TypeScript, Node.js HTTP server, existing YAML config parser, Vitest, existing resident voice runtime interfaces.

---

## Task 1: Configuration Contract

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`

- [x] Add `PicoVoiceResidentActivationConfig` with `mode: "wake_word" | "push_to_talk"`.
- [x] Add loopback HTTP fields for push-to-talk: `provider`, `host`, `port`, `authTokenPath`, `debounceMs`, and `activationWindowMs`.
- [x] Reject non-loopback hosts and invalid ports at config parse time.
- [x] Add config tests for defaults, valid push-to-talk YAML, and invalid remote bind hosts.

## Task 2: Activation Endpoint

**Files:**
- Create: `src/runtime/resident-activation.ts`
- Create: `tests/resident-activation.test.ts`

- [x] Implement a loopback HTTP activation server that accepts only `POST /v1/resident-voice/activate`.
- [x] Require `Authorization: Bearer <token>` from a `0600` token file.
- [x] Return typed results: `accepted`, `ignored_debounce`, `ignored_active`, `unauthorized`, `not_found`, or `method_not_allowed`.
- [x] Close the HTTP server on abort/shutdown and fail closed on bind errors.

## Task 3: Runtime Push-To-Talk Gate

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `tests/voice-resident.test.ts`

- [x] Add an injected activation source interface to the resident runtime.
- [x] In `wake_word` mode, preserve current trigger phrase behavior.
- [x] In `push_to_talk` mode, discard pre-activation utterances and start the session from a typed `button_trigger` trigger.
- [x] Ensure wake acknowledgement is not run for push-to-talk starts.
- [x] Debounce duplicate activations and keep the active/pending turn semantics deterministic.

## Task 4: Resident Wiring And Verification

**Files:**
- Modify: `scripts/resident/voice.ts`
- Modify: `justfile`
- Optionally create: `scripts/field/resident-voice-push-to-talk.ts`

- [x] Wire configured loopback activation into the direct resident harness.
- [x] Document the curl command shape for 8BitDo macro bridge operation in `config/pico.example.yaml`.
- [x] Run focused tests for config, activation server, and voice runtime.
- [x] Run `just check`.
