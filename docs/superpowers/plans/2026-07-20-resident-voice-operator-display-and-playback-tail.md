# Resident Voice Operator Display and Playback Tail Implementation Plan

> Implement with test-first changes. Keep contentful operator events outside normal logs,
> audit, OTel, and Pi model context.

**Goal:** Make resident voice activity inspectable in the `pico` TUI, prevent accepted turns
from inheriting an old inactivity deadline, and add a bounded final playback drain margin.

**Architecture:** A best-effort operator event sink feeds a non-persistent Pi widget. Existing
metadata logs remain unchanged. Voice stage probes optionally notify the sink after validating
their metadata. The playback sink owns final PCM padding because it owns EOF and child drain.

**Tech Stack:** TypeScript, Pi extension UI, Vitest, Swift gates through `just check`.

---

## Task 1: Operator event and widget contracts

**Files:**
- Create: `src/runtime/resident-voice-operator.ts`
- Create: `src/runtime/resident-voice-terminal-display.ts`
- Create: `tests/resident-voice-terminal-display.test.ts`

1. Add failing formatter/state tests for transcript, response, stop reason, tool payload,
   bounded output, and aggregated timing.
2. Define the operator event union and best-effort record helper.
3. Implement the rolling widget model and keep raw content out of other sinks.

## Task 2: Runtime and Pi turn wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `src/runtime/resident-voice-service.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: corresponding tests

1. Add failing propagation and event-order tests.
2. Create the widget sink only for Pi TUI mode.
3. Emit transcript/response/tool/stop-reason events and validated stage observations.
4. Verify normal file and OTel payloads remain content-free.

## Task 3: Session activity admission

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `tests/voice-resident.test.ts`

1. Add a failing second-turn inactivity regression.
2. Refresh an active session at accepted PTT start and after session admission.
3. Preserve playback-completion refresh and ended-session behavior.

## Task 4: Final PCM drain padding

**Files:**
- Modify: `src/runtime/resident-audio-playback.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `tests/resident-audio-playback.test.ts`
- Modify: `tests/resident-voice-runner.test.ts`

1. Add failing tests for one final aligned 300 ms zero write.
2. Route the padding through the existing serialized/backpressure-aware write boundary.
3. Prove cancellation, early close, and repeated finish retain their current settlement.

## Task 5: TTS trailing-silence telemetry

**Files:**
- Modify: `src/runtime/tts-playback-pipeline.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-log-files.ts`
- Modify: `tests/tts-playback-pipeline.test.ts`
- Modify: `tests/voice-stage-probe.test.ts`

1. Add failing PCM tail measurement and stage attribute tests.
2. Measure the last submitted source chunk without recording PCM.
3. Export only the numeric `pico.voice.trailing_silence_ms` attribute.

## Task 6: Verification and handoff

1. Run focused tests after each task.
2. Run identifier/literal `rg` checks for the new event and telemetry fields.
3. Run `just check`.
4. Run the pseudo-audio field harness and inspect timings/content display seams.
5. Review the final diff, then prepare the branch for PR push.

