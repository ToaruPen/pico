# Irodori VoiceDesign Provider Implementation Plan

> **Execution note:** This plan is executed in the current task. Changes remain
> uncommitted unless the user explicitly requests a commit.

**Goal:** Move the Windows Irodori service to VoiceDesign and make Pico speak
through it while retaining AivisSpeech as an explicit configuration rollback.

**Architecture:** Extend the Irodori service contract with a strict style enum
that the server maps to fixed captions. Add an explicit Irodori client beside
the existing AivisSpeech client in Pico's voice module. Startup configuration
selects exactly one provider; playback and interruption stay provider-neutral.

**Tech Stack:** Python 3.11, FastAPI, Pydantic, PyTorch, pytest, TypeScript,
Node.js, Vitest, launchd, OpenSSH local forwarding.

---

## Task 1: Extend the Irodori HTTP contract

**Files:**

- Modify: `/Users/monsoon/Dev/irodori-tts-infra/src/irodori_tts_infra/contracts/synthesis.py`
- Modify: `/Users/monsoon/Dev/irodori-tts-infra/src/irodori_tts_infra/engine/models.py`
- Modify: `/Users/monsoon/Dev/irodori-tts-infra/src/irodori_tts_infra/server/routers/synthesis.py`
- Test: `/Users/monsoon/Dev/irodori-tts-infra/tests/contracts/test_synthesis_contracts.py`
- Test: `/Users/monsoon/Dev/irodori-tts-infra/tests/engine/test_models.py`
- Test: `/Users/monsoon/Dev/irodori-tts-infra/tests/server/test_synthesis.py`

1. Add failing tests for the four accepted styles, rejected unknown styles,
   caption CFG validation, and request-to-job-to-segment propagation.
2. Run focused pytest files and confirm the new assertions fail for missing
   fields.
3. Add `IrodoriStyle`, the fixed style-to-caption mapping, and fields with
   contract-safe defaults.
4. Pass the new fields through queued and segmented synthesis.
5. Run focused tests until green.

## Task 2: Move the runtime to VoiceDesign

**Files:**

- Modify: `/Users/monsoon/Dev/irodori-tts-infra/src/irodori_tts_infra/config.py`
- Modify: `/Users/monsoon/Dev/irodori-tts-infra/src/irodori_tts_infra/engine/backends/irodori.py`
- Test: `/Users/monsoon/Dev/irodori-tts-infra/tests/config/test_settings.py`
- Test: `/Users/monsoon/Dev/irodori-tts-infra/tests/engine/backends/test_irodori.py`

1. Add failing tests for the VoiceDesign checkpoint, calm warmup, and exact
   `SamplingRequest` caption/guidance arguments.
2. Run the focused tests and observe failures.
3. Set the new runtime defaults and pass fixed captions with independent CFG.
4. Run focused tests, then `uv run pytest`.
5. Update infra README, architecture documentation, environment example, and
   repository instructions to describe VoiceDesign plus Speaker Inversion.

## Task 3: Add Pico configuration and Irodori client

**Files:**

- Modify: `src/config.ts`
- Modify: `src/modules/voice/index.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `scripts/voice-provider-smoke.ts`
- Test: `tests/config.test.ts`
- Test: `tests/voice.test.ts`
- Test: `tests/resident-voice-runner.test.ts`
- Test: `tests/voice-provider-smoke.test.ts`

1. Add failing configuration tests for provider selection and strict Irodori
   URL, speaker, style, step, and seed fields, including rejection of a
   provider-owned timeout field.
2. Add failing client tests for request JSON, bounded versioned binary stream
   framing, strict WAV decoding, segmentation, caller cancellation, telemetry,
   and source identity.
3. Add failing runtime tests proving readiness and synthesis call only the
   selected provider.
4. Run the focused Vitest files and confirm the intended failures.
5. Implement the explicit Irodori configuration, bounded health check,
   `/synthesize_stream` client, runtime selection, and smoke selection inside
   the existing voice boundary. The client must reject redirects, cap health at
   64 KiB, cap synthesis at 16 MiB/16 frames/1 KiB headers, and propagate
   service elapsed time for wall/service/RTF reporting.
6. Run focused tests until green, then run `just check`.
7. Update example configuration and operator documentation.

## Task 4: Deploy to Windows and Pico

**Files:**

- Update on Windows: `C:\Users\takut\Dev\irodori-tts-infra\.env`
- Sync to Windows: Irodori infra tracked source and metadata
- Update locally: `/Users/monsoon/Dev/pico/config/pico.local.yaml`
- Sync Pico implementation from the worktree to `/Users/monsoon/Dev/pico`

1. Verify both source worktrees and the Windows service state immediately before
   deployment.
2. Back up the Windows environment file and switch the runtime checkpoint to
   `Aratako/Irodori-TTS-600M-v3-VoiceDesign`.
3. Sync tested infra source, restart only `Pico-Irodori-TTS-8924`, and wait for
   `/health` through `127.0.0.1:18923`.
4. Sync the tested Pico patch to the active checkout and select Irodori in the
   ignored local configuration while retaining the AivisSpeech block.
5. Keep the configured Pico resident service stopped; validate through the
   independent harness without changing tunnel exposure.

## Task 5: Field validation and overhead optimization

1. Run Pico's provider smoke test through the real tunnel.
2. Synthesize short text, an Ishigaki weather-length answer, and a
   Jugemu-length answer with `neutral` and `calm`.
3. Record wall time, service synthesis time, audio duration, RTF, response size,
   and Windows GPU memory peak.
4. Compare caption overhead against run-to-run variance. Adjust only measured
   bottlenecks such as request reuse or step count while preserving acceptable
   audio quality.
5. Execute the production-equivalent pipeline through the independent harness
   and inspect provider/readiness/echo diagnostics without starting the
   resident LaunchAgent.
6. Run `just check` in Pico and `uv run pytest` in infra once more before
   reporting completion.
