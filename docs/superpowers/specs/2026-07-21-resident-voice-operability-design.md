# Resident Voice Operability Design

**Status:** Accepted for implementation

**Date:** 2026-07-21

## 1. Purpose

This design fixes three resident voice problems without adding speculative speech or a new memory subsystem:

1. the terminal control hint can disagree with the configured macOS keys;
2. resident diagnostics have no bounded lifecycle and retain audit events in process memory;
3. Pico waits for the full Pi prompt settlement, including Pi-level extension hooks, before starting final-response TTS.

The changes are delivered as three independently testable pull requests. They preserve the continuously running macOS AVAudioEngine capture design already on `main`.

## 2. Evidence and Constraints

- `src/runtime/resident-voice-terminal-renderer.ts` renders `F1 話す · F2 中断` as a literal.
- `src/runtime/resident-voice-runner.ts` passes configured `talkKey` and `cancelKey` values to the Swift sidecar.
- Pico startup and `createResidentVoiceService` currently load the YAML config independently.
- `~/.pico/resident-voice` contains approximately 4.2 GB. About 97 percent is two legacy metrics files created by the removed continuous-listening `speech_gate` path.
- The current Swift sidecar checks health every second. Node writes each healthy sample to the process log and retains its audit event in an unbounded array.
- Process and metrics file paths use the run-start day, and every append uses synchronous filesystem operations.
- The measured median Pi time to first text was about 10.44 seconds, full Pi prompt time about 21.26 seconds, first TTS chunk about 1.78 seconds, and PTT release to playback dispatch about 24.07 seconds.
- Pi-level Mem0 recall runs before the agent. Mem0 capture runs from `agent_settled`. Pico must not own, configure, wrap, call, or identify the memory provider.
- Ordinary telemetry must not contain PCM, transcript text, response text, conversation content, tool bodies, or session identifiers.
- Existing legacy logs must not be changed or deleted without a separate explicit operator action.

## 3. Non-goals

- No speculative TTS, delta sentence segmenter, staged PCM, or would-match counters.
- No Mem0 capture queue and no changes to the `pi-mem0-oss` repository.
- No native macOS playback migration. ffplay remains the macOS output provider.
- No physical audible-start claim. Physical speaker latency remains a field measurement.
- No runtime config reload. Resident config remains startup-scoped.
- No logging policy YAML surface, generic logging framework, segment store, archive format, or legacy migration.
- No change to config loads performed by independently invoked perception tools.

## 4. PR 1: Startup and Operator Truth

### 4.1 Single resident startup config

`registerPicoStartup` resolves `PicoConfig` once for a Pico host startup. Its `createController` boundary receives that exact frozen object together with the resolved Pi model settings.

`createResidentVoiceService` requires the resolved config as input and no longer calls `loadPicoConfigFromEnvironment`. The service validates resident voice enablement and uses the same config object for the sidecar runtime and operator construction.

This prevents model, sidecar, and operator state from being assembled from different filesystem reads. It does not introduce hot reload.

### 4.2 Configured control display

The terminal display receives required, typed `talkKey` and `cancelKey` values from the validated resident control config. It renders:

```text
<talkKey> 話す · <cancelKey> 中断
```

There is no renderer default and no second validation layer. Existing config parsing remains the sole owner of the supported key allowlist, required fields, and distinct-key rule.

Every rendered line remains within the terminal width. Long supported key names may be ANSI-aware truncated at very narrow widths, but the renderer must never display unrelated fallback keys.

### 4.3 Honest playback latency

The existing `ptt_release_to_playback_start` stage is not a playback-start measurement: it settles before `playback.open` and before the first PCM write.

It is replaced with `ptt_release_to_first_pcm_write`. The stage settles successfully only after the first committed `VoicePlaybackSession.write` completes. If the turn is cancelled or fails before a write, the same PTT measurement settles once with `skipped` or `error`.

The terminal label becomes `音声送出`, not `応答開始`. Historical reports keyed by the removed stage name are not directly comparable and documentation must say so.

No additional capture-ack, dispatch, transport-ready, or audible-start stages are added in this PR.

## 5. PR 2: Bounded Resident Diagnostics

### 5.1 High-volume source reduction

- `speech_gate` is not a persisted stage.
- The Swift sidecar may continue its one-second health check for failure detection.
- Node publishes state changes, restart changes, non-running health, and fatal health immediately.
- Repeated healthy samples are reduced to one aggregate heartbeat per 60 seconds. Dropped-outside-PTT frame counts remain aggregate numeric metadata; frame contents never cross this boundary.

### 5.2 Audit fanout without resident heap retention

The structured audit normalizer gains an explicit non-retaining mode. Resident production audit uses that mode, still validates every event, mirrors permitted summary output, and fans events to configured sinks. `entries()` remains empty in non-retaining mode.

Default structured audit behavior remains retaining for existing callers and tests.

### 5.3 Managed log root and fixed bound

New runtime files are written under a distinct managed root beneath `~/.pico/resident-voice`. Legacy files remain outside that managed root.

The managed layout remains day-oriented:

```text
managed/<mode>/processes/YYYY-MM-DD/<run-id>.log
managed/<mode>/metrics/YYYY-MM-DD/<run-id>.jsonl
managed/<mode>/events/YYYY-MM-DD.jsonl
managed/<mode>/sessions/YYYY-MM-DD/<run-id>/<session-id>.jsonl
```

Process lines use the current writer clock. Metrics and interaction events use their validated occurrence timestamps. A long-running Pico therefore moves to the next UTC day without restart.

Each `normal` and `development` managed root has a fixed 128 MiB total limit. The limit is an internal operational constant, not user configuration.

At startup and when capacity is required, the writer removes only recognized closed files inside the same managed mode root, oldest first. It never follows symlinks, leaves the managed root, deletes an active run file, or touches legacy paths. If active files alone prevent capacity recovery, the new record is dropped and a bounded operator diagnostic is emitted.

### 5.4 Bounded asynchronous writer

Public log sink methods remain synchronous enqueue operations so existing runtime event producers do not await filesystem latency. A single writer-owned FIFO drains records in order.

- queued content is bounded to 1 MiB;
- overflow drops the newest record and increments a content-free dropped-record count;
- runtime filesystem failure disables further file writes and emits one bounded operator diagnostic;
- shutdown waits for queued writes within the existing resident shutdown ownership;
- provider execution does not fall back to another log destination.

The managed root is rejected at startup if its path is a symlink. File creation uses no-follow semantics and private modes. This is a narrow protection for the owned root, not a general filesystem security framework.

### 5.5 Legacy handling

If legacy resident log paths exist, startup emits one aggregate warning. It does not enumerate their content, rewrite them, rename them, include them in the new cap, stop Pico, or delete them.

Removing the existing 4.2 GB remains a separate destructive operator action that requires an exact target check and explicit approval.

## 6. PR 3: Final Response Before Pi Settlement

### 6.1 Two completion boundaries

`PiAgentTurnClient.prompt` returns the final response together with a settlement promise:

```ts
type PiAgentTurnResponse = {
  readonly text: string;
  readonly settled: Promise<void>;
};
```

The adapter continues to own the Pi `AgentSession`, event subscription, active-turn claim, and cleanup until `settled` completes. Pico domain modules do not create or persist Pi sessions.

The resident runtime may start canonical final-response TTS after it receives `text`, while the Pi prompt continues through `agent_settled` hooks. The resident turn does not become idle until playback and `settled` have both converged.

### 6.2 Early final-response admission

An `agent_end` event can publish an early final response only when all of these conditions hold:

- the event has `willRetry === false`;
- the final assistant stop reason is `stop`;
- the Pi agent reports no queued messages after extension `agent_end` handlers;
- the resident generation has not been cancelled;
- no response was already published for the prompt.

Pi extension `agent_end` handlers are awaited before session subscribers receive the event. Therefore the adapter uses the SDK's authoritative queued-message state and does not add an independent compaction/retry revocation state machine.

Successful non-`stop` terminal output, including token-limit output that the current adapter permits, is not discarded. It follows the existing conservative path and is returned after full prompt settlement.

Tool intermediates, retry intermediates, errors, and aborted messages are never published as speech.

### 6.3 Cancellation boundary

Before response publication, F2 aborts the Pi prompt and the rest of the resident generation as it does today.

At response publication, the adapter removes the generation-to-Pi abort listener. After publication, F2 stops or suppresses TTS playback, restores capture/echo boundaries, and waits for Pi settlement without aborting it. This preserves Pi-level capture for a response that was accepted for speech.

No new cancellation class hierarchy is introduced. The response/settlement promises and one response-published state own the split.

### 6.4 Settlement failure and interaction boundaries

If settlement fails after speech has begun or completed:

- Pico does not synthesize or play the response again;
- playback, echo, and capture boundaries still converge;
- `pi_turn` records an error settlement;
- the turn increments the existing failed-turn accounting and returns to a stable control state;
- the resident process does not silently lose the error.

The active Pi turn claim is released only by settlement. Existing `disposeSession`, shutdown, and interaction farewell boundaries wait for the complete resident turn operation, which now includes playback and Pi settlement. Farewell playback cannot overlap the preceding turn.

### 6.5 Minimal telemetry

One stage is added:

- `pi_final_response_ready`: prompt start to canonical response availability.

Existing `pi_turn` remains prompt start to full settlement. Existing `pi_time_to_first_text` remains unchanged. Their separation exposes the post-response settlement tail without naming or depending on Mem0.

No text, provider name, plugin name, session identifier, or tool body is added to telemetry.

## 7. Deterministic Acceptance Tests

### PR 1

- startup loads config once and passes the exact object to the controller;
- non-default `F13` and `F14` reach both the resident runtime boundary and terminal display;
- long supported key labels never exceed terminal width;
- the PTT metric remains open before playback write and settles after the first successful write;
- cancellation and playback failure settle the renamed metric exactly once.

### PR 2

- successful `speech_gate` and repeated one-second healthy samples do not create high-volume persistence;
- state/restart/failure health is immediate and a healthy aggregate heartbeat is emitted at 60 seconds;
- resident production audit validates and fans out events while retaining zero entries;
- writes cross UTC midnight into the next day;
- FIFO order, queue overflow, shutdown flush, write failure, and fixed total capacity are deterministic;
- capacity cleanup affects only recognized closed managed files;
- symlinked managed roots fail safely;
- legacy files remain byte-for-byte unchanged.

### PR 3

- a follow-up queued by an `agent_end` extension handler prevents publication for that run;
- a canonical final response is published once before `agent_settled` completes;
- active turn ownership remains claimed until settlement;
- successful non-`stop` output remains available after settlement;
- F2 before publication aborts Pi;
- F2 after publication cancels playback but does not abort settlement;
- settlement rejection after response publication does not replay speech and converges the turn;
- session disposal and farewell wait for the complete turn boundary.

Test harnesses must use deterministic real implementations of the relevant boundary contracts and comply with repository AST naming rules. Production receives no mock, stub, fake, or provider fallback path.

## 8. Validation and Delivery

Each PR follows Red → Green → Refactor and passes its focused tests, typecheck, lint, AST rules, and formatting. The combined stack then passes:

1. focused resident voice gates;
2. `just apple-speech-check`;
3. `just macos-resident-io-check`;
4. `just check`;
5. `npx secretlint .`;
6. real-provider validation in the order defined by `TOOLS.md`.

Before any exclusive microphone, port, or lock validation, the operator checks for another running Pico checkout and never stops it implicitly.

The final implementation receives native subagent review, polishment, and the explicitly requested AI-slop cleanup pass. Existing legacy logs are not deleted as part of these pull requests.
