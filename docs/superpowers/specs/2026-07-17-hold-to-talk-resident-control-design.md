
# Pico Hold-to-Talk Resident Control Design

## Status

Approved product direction on 2026-07-17. This document is the source of truth for
the first production hold-to-talk and cancellation slice.

## Purpose

Pico accepts facility speech only while an explicitly configured keyboard control
is held. Releasing the control closes the utterance, waits for a 250 ms speech
tail, transcribes that one utterance, and submits exactly one Pi turn.

A separate configured control cancels recording, STT, the active Pi turn, TTS,
or playback. Cancellation preserves the Pi parent conversation context and
returns Pico to idle without farewell output.

## Superseded Behavior

This design supersedes the following production behavior in
`docs/superpowers/specs/2026-06-18-voice-resident-runtime-design.md`:

- continuous microphone capture while idle;
- pre-trigger Apple Speech transcription;
- transcript substring matching for wake names and greetings;
- speech/silence utterance-window splitting as the production turn boundary;
- timed active interaction as implicit permission for additional microphone
  turns;
- playback that cannot be stopped independently.

The old `wake_word` and greeting-trigger activation path is removed. No
backward-compatible alias, fallback path, or hidden continuous-STT mode remains.
A future KWS provider, if selected after field testing, will be a new semantic
control producer and will not revive substring matching over general STT.

## Non-Goals

- KWS or hands-free activation;
- double-tap latched recording;
- barge-in through the talk control while Pi or Pico output is busy;
- speaker identification;
- real AEC, microphone arrays, or hardware DSP;
- Raspberry Pi keyboard-provider implementation;
- durable audio, transcript, or Pico-owned conversation storage;
- a product-level maximum hold duration;
- automatic provider fallback.

## Product Decisions

1. The talk and cancel controls are configurable. `F13` and `F14` are examples,
   not fixed values.
2. The talk control is hold-to-talk:
   - press starts capture;
   - release starts a 250 ms tail;
   - tail completion stops capture and closes the utterance.
3. Release automatically proceeds to STT and Pi. There is no separate send
   control.
4. Only idle accepts a new talk press. Talk presses during transcribing,
   processing, cancellation, or speaking are ignored and never queued.
5. One completed hold produces at most one Pi turn.
6. A cancel press is accepted in every active turn state and is idempotent;
   cancelling, error, stopped, and idle treat it as a no-op.
7. Cancel preserves the Pi parent conversation context, emits no farewell, and
   returns to idle after owned work reaches its cancellation terminal state.
   If normal interaction ending has already started, cancel suppresses its
   remaining farewell Pi/TTS/playback work but does not reverse session cleanup.
8. Pi owns conversation context and history. Pico owns only facility control,
   audio, and ephemeral per-turn state.
9. No maximum hold duration is added. Audio exists only in process memory for
   the current hold and is discarded after submission or cancellation.
10. Bound keys are consumed by the keyboard bridge so they do not reach the
    foreground application.

## Approaches Considered

### Direct global keyboard listener inside Pico

This has fewer processes but introduces macOS keyboard APIs, Input Monitoring
permission, and native lifecycle failure into the Pi-hosted TypeScript runtime.
It also couples the resident runtime to one operating system.

### Project-owned semantic keyboard bridge — selected

A small macOS bridge observes configured key press/release events and converts
them into authenticated loopback semantic control events:

- `talk_pressed`
- `talk_released`
- `cancel_pressed`

Pico receives only semantic events. Moonlander, physical key names, macOS key
codes, and Input Monitoring permission remain outside the voice state machine.
The bridge is project-owned and production-managed; Hammerspoon and Karabiner
are not production dependencies.

The implementation plan begins with a bounded macOS bridge spike. The spike
must prove global press/release delivery, bound-key consumption, stable Input
Monitoring authorization under the production launch path, and deterministic
shutdown. The selected macOS API is then fixed in the implementation plan; no
runtime fallback is added.

### macOS bridge spike result (2026-07-17)

The production bridge uses one active Core Graphics session event tap created
with `CGEvent.tapCreate`, `.cgSessionEventTap`, `.headInsertEventTap`, and
`.defaultTap`. Apple's callback contract explicitly permits an active filter to
return `nil` to delete a matched event, which provides bound-key consumption.
The tap observes only key-down and key-up masks. It does not request HID/root
placement or synthesize events.

The installed SDK exposes `CGPreflightListenEventAccess` and
`CGRequestListenEventAccess` from macOS 10.15. Startup preflights and, when
needed, requests Input Monitoring access before tap creation. A failed
preflight/request or a `nil` event tap is an actionable startup failure; there
is no listen-only or external-automation fallback. The local production host
reported both listen and post preflight access as available during the spike,
but the bridge depends only on listen access.

The event tap's `CFMachPort` is wrapped in a run-loop source. Shutdown removes
the source, invalidates the port, stops the run loop, and releases the retained
bridge context. Apple documents that an event-tap callback runs on the run loop
to which the source is attached, that returning `NULL` from an active filter
deletes the event, and that a `CFMachPort` must be invalidated before its source
and port are released. Primary references:

- <https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:)>
- <https://developer.apple.com/documentation/coregraphics/cgeventtapcallback>
- <https://developer.apple.com/documentation/coregraphics/cgpreflightlisteneventaccess()>
- <https://developer.apple.com/documentation/coregraphics/cgrequestlisteneventaccess()>
- <https://developer.apple.com/documentation/corefoundation/cfmachport>
- <https://developer.apple.com/documentation/corefoundation/cfrunloopremovesource(_:_:_:)>

### External automation calling HTTP endpoints

Hammerspoon or Karabiner can validate the semantic HTTP contract during field
work, but external automation is not the production owner. It may be used only
as a bounded diagnostic adapter.

## Configuration Contract

The production YAML shape is:

```yaml
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

The 250 ms release tail is a product constant in this slice, not a runtime
configuration field. Changing it requires a reviewed behavior change.

Configuration is startup-only and immutable. Startup rejects:

- identical talk and cancel keys;
- empty or unknown key identifiers;
- modifier-only bindings;
- non-loopback hosts;
- unreadable, symlinked, empty, or non-0600 token files;
- unsupported control providers;
- unsupported keyboard providers.

`talkKey` and `cancelKey` are required. There are no implicit key defaults;
`F13` and `F14` are example values in `config/pico.example.yaml` only. The old
`activation`, `minTriggerConfidence`, and `utteranceWindow` configuration is
removed. The configured speech gate remains only for empty/no-speech rejection.

Normal character keys may be configured intentionally. The bridge consumes
configured controls globally so they do not type into other applications.

## Runtime State Machine

```text
idle
  └─ talk_pressed
       → listening
          ├─ cancel_pressed
          │    → cancelling → idle
          └─ talk_released
               → tailing
                  ├─ cancel_pressed
                  │    → cancelling → idle
                  └─ tail elapsed
                       → transcribing
                          ├─ no speech / empty transcript
                          │    → idle
                          ├─ cancel_pressed
                          │    → cancelling → idle
                          └─ transcript accepted
                               → processing
                                  ├─ cancel_pressed
                                  │    → cancelling → idle
                                  └─ Pi response
                                       → synthesizing
                                          ├─ cancel_pressed
                                          │    → cancelling → idle
                                          └─ audio ready
                                               → speaking
                                                  ├─ cancel_pressed
                                                  │    → cancelling → idle
                                                  └─ playback complete
                                                       → idle
```

Talk presses received outside `idle` produce an `ignored_busy` result. They are
not stored, debounced into a later action, or replayed.

A talk release without the matching accepted press is ignored. Repeated keydown
events caused by keyboard repeat do not start additional turns. Repeated release
or cancel events are idempotent.

`error` is terminal for this first slice. It rejects controls, cancels any owned
generation, and causes the resident runtime to fail so its production owner can
restart the full runtime. In-process provider recovery is part of the later
audio-reliability design.

## Audio Data Flow

1. Idle owns no microphone process and no audio buffer.
2. An accepted `talk_pressed` starts the configured capture provider.
3. Audio captured before that accepted press is impossible by construction.
4. Captured frames remain process-local and belong to one turn generation.
5. `talk_released` keeps capture open for 250 ms.
6. Tail completion stops capture and closes the per-turn audio input.
7. The existing speech gate is used only to reject an empty/no-speech hold. It
   does not activate Pico or split one hold into multiple turns.
8. A non-empty hold is sent to Apple Speech once.
9. The accepted transcript is sent as one literal user message through the Pi
   parent session.
10. TTS output is played once unless cancellation invalidates the turn.
11. Audio is released after STT admission, failure, or cancellation. It is not
    logged, persisted, or attached to Pico interaction state.

The first implementation retains the current configured capture and STT
providers. Cold capture startup latency is a field acceptance criterion. If it
causes first-phoneme loss, the AVAudioEngine provider work is promoted to the
next implementation slice rather than adding idle capture.

## Session Semantics

A control activation grants permission for one microphone turn. It does not
create a second Pi session.

The Pi parent conversation session remains the owner of context and history
across multiple hold-to-talk operations. Pico may retain its existing
interaction identifier and inactivity lifecycle for facility cleanup, but an
active interaction never grants microphone permission. Every spoken turn still
requires a new accepted `talk_pressed`.

Cancel does not end the Pi conversation, dispose the parent session, refresh
activity as a successful turn, or run farewell. Normal inactivity and shutdown
continue to own interaction ending.

## State Boundary: Interaction Ending Notification

1. **State being changed:** `SessionLifecycle` gains an ended-session
   notification owned by the same lifecycle that mutates `active` to `ended`.
   The resident voice runtime owns the resulting farewell, deferred-work
   cancellation, Pi-session disposal, and lifecycle removal operation.
2. **Lifecycle boundary:** `hot-reloadable` subscription. A resident runtime
   subscribes once at construction and unsubscribes during shutdown; session
   ending configuration remains startup-only.
3. **Mutation path inventory:** the inactivity timer and explicit
   `SessionLifecycle.end()` both pass through the existing `endSession`
   boundary. Resident shutdown explicitly ends its active interaction through
   that same boundary. Cancel, config watchers, CLI, environment variables,
   migrations, admin jobs, and background workers are not interaction-ending
   mutation paths.
4. **Consumer/invariant inventory:** session audit observes the state mutation;
   the resident runtime observes the notification and serializes farewell,
   deferred cancellation, Pi disposal, session removal, and shutdown drain.
   Microphone ownership and hold-to-talk admission remain independent.
5. **Central enforcement point:** `endSession` performs the state transition
   exactly once and then notifies subscribers. Timer and explicit ending may
   not notify independently.
6. **Forbidden paths:** no polling loop, idle microphone, direct session-field
   mutation, cancel-triggered interaction end, concurrent farewell and active
   Pi turns, or new talk admission while ended-session cleanup is active.
7. **Required tests:** timer and explicit ending notify once; unsubscribe stops
   notification; inactivity and shutdown-initiated ending run one farewell and
   cleanup; cancel runs neither when it initiates from an active turn; cancel or
   shutdown during an existing interaction ending suppresses its remaining
   farewell but preserves cleanup; a later hold starts only after cleanup
   reaches terminal state.
8. **Async ownership and terminal states:** the resident runtime owns one
   serialized interaction-ending promise. It waits for the active turn,
   suppresses new talk admission while ending, drains farewell playback,
   cancels deferred work, disposes the Pi session, removes the ended lifecycle
   record, and awaits that terminal promise before closing shared owners.

## Cancellation Contract

Each accepted talk operation owns one turn generation and one
`AbortController`. The generation is the central validity token for all async
results.

- Listening or tailing: stop capture and discard buffered audio.
- Transcribing: abort the STT request where supported and ignore every result
  from the cancelled generation.
- Processing: abort the Pi host turn exactly once and wait for Pi
  `agent_settled` before considering Pi work terminal.
- Synthesizing: abort TTS and suppress completed chunks from the cancelled
  generation.
- Speaking: stop Pico-owned playback exactly once, clear echo suppression
  state, and suppress later playback completion.
- Interaction ending: abort remaining farewell Pi/TTS/playback work, clear echo
  suppression state, and continue terminal session cleanup.
- Cancelling: repeated cancel is a no-op.
- Idle: cancel is a no-op.

Cancellation never kills Pi-owned subprocesses directly. It uses the Pi host
abort boundary. Playback stop targets only the process or audio engine instance
owned by the current Pico turn.

## Playback Contract

The playback boundary becomes controllable rather than fire-and-wait. It owns:

- play;
- stop for the current generation;
- completion;
- shutdown drain.

`afplay`/`aplay` implementations stop only their owned child process. A later
native audio provider implements the same contract without changing the voice
state machine.

A completed or failed process callback from an invalidated generation cannot
advance state or emit audio.

## Control Transport

The existing authenticated loopback activation transport becomes a typed
resident-control transport. It accepts only the three semantic events defined
above.

The transport:

- binds only to `127.0.0.1` or `::1`;
- uses the existing protected bearer-token file discipline;
- rejects unknown event types and invalid methods;
- returns whether an event was accepted, ignored as busy, ignored as stale, or
  treated as an idempotent no-op;
- closes on Pico shutdown;
- stores no unbounded event queue.

The keyboard bridge reads the same resolved startup configuration and posts
semantic events. Physical key identity is never part of session, transcript,
audit, or metric state.

## Failure Behavior

- Control bridge unavailable at startup: fail closed and do not start resident
  voice listening.
- Input Monitoring permission missing: fail closed with an actionable startup
  error.
- Control bridge exits during operation: cancel the owned generation and move
  to error; no automatic provider fallback.
- Capture startup failure: return to error without STT or Pi input.
- Capture failure during a hold: discard that hold and move to error.
- Empty/no-speech hold: return to idle without STT or Pi input.
- STT failure: return to idle without Pi input.
- Pi failure: return to idle without TTS.
- TTS failure: return to idle without playback.
- Playback failure: stop owned playback, clear echo state, and return to idle.
- Shutdown: reject new controls, cancel the active generation, drain owned
  capture/STT/Pi/TTS/playback work, close control transport, then release state.

Partial device recovery and AVAudioEngine reconstruction are a later slice.
The first slice remains fail closed.

## Observability

Probe and structured log data may include:

- semantic control event kind;
- accepted/ignored outcome;
- resident state transition;
- stage duration;
- cancellation stage and reason;
- capture startup latency;
- utterance duration and frame count;
- whether speech was detected;
- STT/Pi/TTS/playback success, failure, or cancellation.

Probe and logs must not include physical key names, raw audio, transcript text,
prompt text, completion text, secrets, endpoint query data, or high-cardinality
generation IDs.

Required counters include:

- idle STT calls;
- accepted holds;
- ignored busy talk presses;
- empty holds;
- cancelled turns by stage;
- late async results suppressed;
- capture failures;
- playback stop success/failure.

## State Boundary

1. **State being changed:** The resident activation queue is replaced by a
   resident control state machine owning the current state, accepted
   talk-press identity, per-turn generation, release-tail timer, audio capture,
   abort controller, and playback ownership. Startup configuration adds
   immutable key bindings and control transport settings.
2. **Lifecycle boundary:** `restart-required`. Key mappings, provider choice,
   and loopback settings are resolved at startup.
   No config watcher or hot reload mutates a running control state machine.
3. **Mutation path inventory:** Semantic loopback control events, release-tail
   timer completion, capture/STT/Pi/TTS/playback completion, cancellation,
   inactivity cleanup, shutdown, and deterministic test adapters mutate state.
   CLI mutation, environment overrides, admin APIs, config watchers, database
   migrations, rollback jobs, and background workers are not mutation paths.
4. **Consumer/invariant inventory:** Config parser and validator, resident
   runner/service, control transport, keyboard bridge, audio capture, speech
   gate, Apple Speech client, Pi host turn client, TTS, playback, echo control,
   session lifecycle, probes, launchd management, smoke tests, and field
   harnesses consume the boundary.
5. **Central enforcement point:** A single resident control controller owns all
   transitions and the active generation. Transport handlers, timers, and async
   completion callbacks submit typed events to that controller; they never
   mutate voice/session state directly.
6. **Forbidden paths:** Direct active-state assignment outside the controller;
   STT before an accepted press; microphone capture in idle; implicit turn
   permission from an active session; queuing talk while busy; physical-key
   handling inside the voice loop; direct Pi process kill; playback outside the
   generation-aware controller; tests mutating private state; fallback to
   wake-word or continuous STT.
7. **Required tests:** Valid and invalid config; accepted press/release;
   repeated keydown; orphan/repeated release; 250 ms tail with a deterministic
   scheduler; empty hold; one activation/one turn; no idle STT; no pre-press
   audio; busy talk ignored and not replayed; cancel in every state; repeated
   cancel; late result suppression; Pi abort once; playback stop once; session
   context preserved; transport authentication; bridge failure; capture
   failure; shutdown drain; removed wake-word/greeting paths unreachable.
8. **Async ownership and terminal states:** The resident control controller
   owns the release timer, capture, STT request, Pi abort convergence, TTS,
   playback, and generation invalidation. Cancellation acknowledges only after
   owned work reaches its defined terminal state. Terminal generation state is
   removed on successful playback, empty hold, failure, cancellation drain, or
   shutdown drain. Tests use injected schedulers and controlled promises rather
   than wall-clock races.

## Delivery Slices

### Slice 1: Control contract and state machine

- Replace activation events with typed control events.
- Add immutable configuration and validation.
- Implement deterministic state transitions and generation invalidation.
- Remove wake-word and greeting configuration/runtime paths.

### Slice 2: On-demand capture and STT hard gate

- Replace the continuous frame source boundary with on-demand capture ownership.
- Capture only from accepted press through the release tail.
- Reject empty holds and call STT exactly once for accepted speech.
- Remove utterance-window splitting from the production hold-to-talk path.

### Slice 3: Cancellation convergence

- Propagate the generation abort signal through STT, Pi, and TTS.
- Add controllable playback and late-result suppression.
- Preserve the Pi parent conversation after cancellation.

### Slice 4: macOS keyboard bridge

- Run the bounded native API spike.
- Implement the selected project-owned bridge.
- Validate configurable mappings, key consumption, permissions, and lifecycle.
- Do not add external automation as a production fallback.

### Slice 5: Field validation

- Validate Moonlander keydown/keyup and cancel.
- Measure capture startup and first-phoneme retention.
- Verify release-tail behavior.
- Verify idle microphone and idle STT are both off.
- Verify cancellation during capture, Pi processing, TTS, and playback.
- Record CPU/RSS and device/process failure evidence.

### Later independent design

- AVAudioEngine capture/playback/AEC/device recovery provider;
- explicit facility mute and visible state indicators if a future always-on
  attention provider requires them;
- optional KWS producer after field evidence;
- Raspberry Pi/Linux control bridge.

## Acceptance Criteria

- Production config has no `wake_word`, wake-name, greeting-trigger, trigger
  confidence, debounce, activation-window, or utterance-window path.
- Idle owns no microphone process and produces zero STT calls.
- One accepted press/release produces no more than one Pi user message.
- The audio sent to STT contains no pre-press frames and includes the fixed
  250 ms release tail.
- Talk presses while busy are ignored and cannot execute later.
- Cancel converges from every active turn state without farewell or
  parent-session disposal; during existing interaction ending it suppresses the
  farewell while preserving terminal cleanup.
- Cancelled or stale async results cannot synthesize or play audio.
- Configured talk and cancel keys can be changed without modifying TypeScript
  voice logic.
- The selected keyboard bridge works under the managed macOS production launch
  path and consumes bound controls.
- All focused tests and `just check` pass.
- A field report records real Moonlander operation, capture latency,
  cancellation behavior, idle STT count, and any provider limitations.
