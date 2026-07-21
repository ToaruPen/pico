# Resident Cancellation and Telemetry Correction Design

## Position

This design corrects the field-visible behavior observed after an accepted
cancel without changing its interaction scope. Cancel continues to stop the
active turn, not the interaction. Talk remains rejected only while the owned
audio path is stopping. Once capture, STT, playback, capture suppression, and
echo boundaries are safe, the next configured talk control is admitted even
if the preceding Pi prompt is still settling in the background. The inactivity
timer may still end the interaction and request a farewell after all owned Pi
turns have converged.

The production Pico process, AVAudioEngine capture, Apple Speech streaming,
Pi AgentSession ownership, TTS pipeline, and half-duplex echo boundaries remain
unchanged. The correction separates foreground cancellation convergence from
background Pi settlement ownership, then extends typed operator events,
bounded terminal state, low-cardinality stage metadata, and privacy-safe
diagnostics around that boundary.

## Field Evidence

The 2026-07-21 field run established the following sequence:

- F2 cancelled TTS synthesis and playback at `11:10:09.210Z` and
  `11:10:09.220Z`.
- The published Pi response continued settlement until `11:10:16.687Z`, as
  required by the early-final-response ownership contract.
- Four F1 presses reached the macOS control bridge during that interval and
  were rejected as busy, but the terminal retained the preceding phase and did
  not explain the rejection.
- The 60-second inactivity ending later produced a farewell while the terminal
  appeared idle because farewell operator events had no active display
  lifecycle.
- `resident_admission_to_gate` was recorded with `status=ok` for both accepted
  and rejected talk decisions. It measured decision application, not a
  successful gate opening.
- Raw cumulative `droppedFrameCount` increased by 2,880,000 over 60 seconds on
  the 48 kHz input. These were expected source sample-frames discarded outside
  PTT, not buffer loss.

## Decisions

### Turn and interaction states

`ResidentVoiceTurnPhase` gains `cancelling`. An accepted cancel emits this phase
immediately after the controller enters `cancelling`. The convergence owner
emits `idle` after capture, STT, playback or pipeline cleanup, capture resume,
and echo flush have converged. It does not wait for a published Pi response to
finish background settlement. The display retains a content-free cancelled
outcome on the turn after it returns to idle.

Every Pi prompt registers one session admission barrier before it begins. The
barrier remains owned until the prompt either fails before publication or its
published response settles. A subsequent turn starts capture and streaming STT
immediately, but waits at the Pi prompt boundary if the preceding barrier is
still pending. The operator phase is `waiting_for_previous_turn` during that
wait and returns to `processing` before the new prompt starts. The wait is
cancellable by the new generation.

The runtime retains all detached Pi turn operations in a bounded-by-concurrency
owner set. Resident control permits only one foreground capture generation, and
Pi admission permits only one prompt for the interaction session, so normal
operation owns at most one detached predecessor and one foreground turn.
Interaction ending, session disposal, and shutdown drain this owner set before
disposing the AgentSession.

Interaction ending is a separate operator lifecycle, not a synthetic staff
turn. The runtime emits `interaction_ending_started` after the preceding turn
boundary has converged and immediately before farewell work, then emits
`interaction_ending_finished` after farewell and cleanup. This prevents late
events from the preceding turn from being attached to the ending display. The
terminal displays `ending` while this lifecycle is active and may show a
farewell response without inventing a staff transcript. F2 during ending keeps
the existing ending-cancellation behavior.

No talk press or PCM is queued for later admission. A talk press arriving after
foreground cancellation completes starts a new generation immediately. A talk
press rejected during the short foreground stop or interaction ending is
reported through a bounded, non-persistent operator event so the header can
briefly explain why it was not admitted. The event contains only the
low-cardinality control result and control state.

### Configured controls

No production or display behavior assumes F1 or F2. The validated
`talkKey`/`cancelKey` values continue to flow from configuration through the
Node runner into the Swift sidecar and terminal renderer. Field evidence may
name the keys used in that run, but deterministic contract tests use non-default
values such as F13/F14 and arrow keys so hard-coded labels fail visibly.

### Control timing semantics

The macOS sidecar continues to measure physical key event to Node control
decision. The existing `resident_key_to_admission` name remains valid, but its
stage observation carries the low-cardinality decision result.

`resident_admission_to_gate` is emitted only for an accepted talk press. A
rejected decision does not open a PTT gate and therefore must not produce a
successful gate timing. Rejected, stale, and no-op decisions are counted by
result without content, key labels, session identifiers, or generation IDs.

Cancellation adds three bounded milestones:

1. physical cancel key to Node admission;
2. admission to playback or pipeline stop acknowledgement;
3. admission to foreground turn-idle convergence.

The sidecar owns the physical timestamp measurement. Node owns output-stop and
foreground-idle measurements. The existing `pi_turn` and
`pi_final_response_ready` stages expose a detached Pi settlement tail without
making it part of cancel-to-ready latency. Started measurements settle exactly
once as `ok`, `skipped`, or `error` across cancellation and shutdown.

### Terminal latency hierarchy

The normal turn summary separates user-visible response latency from
background settlement:

```text
応答開始 7.75 s · STT 72 ms → Pi確定 5.80 s → TTS 1.12 s · Pi後処理 11.36 s
```

- `ptt_release_to_first_pcm_write` remains the root user-visible response
  latency.
- `stt`, `pi_final_response_ready`, and `tts_time_to_first_chunk` form the
  compact critical-path detail. They are not summed because their measurement
  boundaries differ.
- `pi_turn - pi_final_response_ready`, clamped at zero, is displayed as
  `Pi後処理` only when both stages succeeded and the tail rounds to a visible
  positive duration.
- Cancelled stages render a textual cancelled outcome instead of an error.
- All lines remain ANSI-width bounded through the existing renderer contract.

### Health and discard diagnostics

Expected outside-PTT and TTS-suppressed sample-frame discard counters remain
content-free health metadata. Human-facing process diagnostics call them
`outside-PTT sample frames discarded` and `suppressed sample frames discarded`.
They do not use the unqualified word `dropped`.

The aggregate total remains in the protocol for compatibility within the
stacked PR, but normal healthy process lines omit it. Non-running health and
fatal paths retain the aggregate total for diagnosis. Audio callback handoff
loss remains a distinct abnormal dropped-buffer condition and must not be
combined with expected gate discard in terminal presentation.

## Privacy and bounds

The new events and attributes contain only phase, control result, controller
state, duration, status, and fixed error code. PCM, transcript text, response
text, tool bodies, session identifiers, generation identifiers, key labels,
and provider names do not enter normal logs or OTel.

The terminal continues to retain at most two turns, 32 completed tools per
turn, and one bounded notice. Ending does not create unbounded history.

## Deterministic acceptance

- An accepted cancel emits `cancelling` before foreground cleanup and emits one
  `idle` after the audio path is safe without waiting for published-response
  Pi settlement.
- A talk press after foreground cancellation starts capture and streaming STT
  while the preceding Pi response remains unsettled.
- The new transcript waits at Pi admission until the predecessor settles, then
  starts exactly one new prompt on the same interaction AgentSession.
- A talk press during the foreground stop remains `ignored_busy` and produces
  a bounded reason visible without color.
- An inactivity farewell changes the header from idle to ending and back to
  idle, and its response is visible without a fabricated staff turn.
- Accepted talk emits gate timing; ignored busy, stale, and no-op talk do not.
- Cancel timing settles once for pre-response and post-publication cancel.
- The response summary uses final-response readiness rather than full Pi
  settlement as its Pi critical-path value and shows a separate settlement
  tail.
- Healthy 48 kHz outside-PTT discard is labelled as expected sample-frame
  discard, while abnormal dropped buffers remain distinguishable.
- Existing width, hostile payload, privacy, cancel, farewell, and lifecycle
  ownership tests remain green.
- Non-default configured talk/cancel keys reach the sidecar and widget without
  any F1/F2 production default.

## Alternatives rejected

- **Make F2 end the interaction:** changes the approved turn-only cancel
  contract and would discard conversational continuity.
- **Queue a talk press or PCM until Pi settles:** delays or ambiguously backdates
  audio admission. The selected design admits a new capture generation only
  after the foreground audio path is safe and delays only Pi prompt admission.
- **Abort Pi after final response publication:** breaks the accepted-response
  settlement ownership contract and can corrupt AgentSession lifecycle.
- **Add a trace or session identifier to the widget:** unnecessary for the
  operator task and conflicts with the existing telemetry privacy boundary.
