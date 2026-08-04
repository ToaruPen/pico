# StackChan Continuous Gimbal Follow Design

> **Rejected by attended field evaluation on 2026-08-03.** The seven-degree
> visual setpoint, short-loss target refresh, and local-recovery behavior moved
> farther away from the operator-approved smooth baseline and must not be used
> as the production design. See
> `2026-08-03-stackchan-known-smooth-baseline-restoration-design.md`.

## Context

The production follow loop detects faces and heads reliably while the camera is
stationary, but loses continuity during camera motion. Live measurements on
2026-08-03 showed 50/50 configured-target frames at the home pose while the
operator lowered their face, 43/50 immediately after moving to pitch 23, and
49/50 after the same pose settled for one second. Inference p95 was about 19 ms
and capture-to-command p95 was about 24 ms. The dominant failure is therefore
closed-loop motion behavior, not steady-state model throughput.

The current controller emits a correction capped at the same four-degree value
used by the gateway actuator lane. The gateway is single-flight and the
controller bases every correction on the last confirmed pose, so the resulting
motion is `four degrees -> reply wait -> four degrees`. A missing detection
clears the pending target immediately, and a one-second loss changes into a
wide absolute scan. This explains both the stop-go motion and the observed
freeze-then-jump behavior.

## Goals

- Keep the gateway's one-active-call, one-replaceable-pending-target bound.
- Compute one bounded-lookahead absolute visual setpoint from each observation
  instead of one actuator-sized incremental step.
- Keep the gateway's `maxStepDeg` contract as the physical trajectory limiter,
  while limiting each visual setpoint to seven degrees from confirmed pose.
- Continue toward the last fresh setpoint through a short detection gap.
- Search progressively around the last confirmed pose after the loss timeout,
  without jumping into the configured wide acquisition scan.
- Reacquire the same nearby person through face, head, and upper-body evidence
  without storing identity or image data.
- Preserve home return and the operator-required disabled auto-sleep state.

## Non-goals

- No persistent identity, child profile, face recognition, or durable tracking
  record.
- No new policy, retry, fallback-provider, or generalized safety framework.
- No second concurrent ESP32 servo RPC.
- No firmware change unless post-change measurements isolate a remaining
  firmware defect.
- No attempt to hide a real loss by endlessly integrating predicted motion.

## Design

### Detection and continuity

PINTO class `0` is admitted as `body` in addition to class `1` (`head`) and
class `3` (`face`). It uses the existing head confidence threshold, avoiding a
new tuning parameter before field evidence requires one.

Each detection has a visual anchor:

- face and head: bounding-box center;
- body: horizontal center and a point 15% below the top edge.

The upper-body anchor approximates the head location and prevents a body-only
frame from driving the camera toward the torso. During acquisition, the target
priority remains face, then head, then body. While tracking, candidates close
to the previous anchor are preferred before applying that label priority. The
controller retains only the last normalized anchor and setpoint; it does not
retain images, identity, or a history of people.

### Absolute visual setpoint

The attention controller continues to calculate dead-zone-adjusted proportional
corrections and integer/error-feedback quantization. It clamps each visual
correction to seven degrees, which remains farther than the four-degree gateway
step but cannot reproduce the field-observed 15-degree-plus reactions. It adds
that bounded correction to the gateway-confirmed pose. Yaw uses the mechanical
range; downward pitch is also clamped to the lowest configured acquisition-scan
pitch (23 degrees in the field configuration), because a live run reached seven
degrees and physically struck the lower structure.

`maxStepDeg` remains on the runtime configuration and is passed to the gateway
lane. Repeated observations refresh the same absolute setpoint while the
gateway advances toward it in bounded steps. Because the base remains the
confirmed pose, repeated frames do not integrate an unconfirmed planned pose
and cannot reproduce the rejected runaway-ahead experiment.

### Detection-loss behavior

When a target disappears for less than `lostHoldMs`, the controller re-emits
the last absolute setpoint. This refreshes one latest-only pending target and
allows already justified motion to finish without inventing new motion.

At `lostHoldMs`, the controller anchors a local recovery pattern to the current
confirmed pose. It moves in eight-degree increments, expands to at most 24
degrees on either yaw side, returns through the center, and then checks eight
degrees above and below. It dwells for 250 ms only after each waypoint is
confirmed. This recovers a nearby person who truly moved outside the camera FOV
without reintroducing the old jump to the configured ±35-degree acquisition
scan. Initial acquisition retains that existing global scan because no tracked
pose or local recovery center exists yet.

### Runtime and lane boundary

The Pico runtime continues to refresh the confirmed gateway pose before each
decision and uses the existing latest-only update API. No new worker, queue, or
RPC concurrency is introduced. The TypeScript lane contract is corrected to
report the gateway's actual maximum of one active call.

## Verification

Automated tests must demonstrate:

1. body parsing and upper-body anchoring;
2. nearby cross-label continuity without persistent identity;
3. corrections larger than `maxStepDeg` produce a seven-degree lookahead but
   never an unbounded target;
4. repeated observations against an unchanged confirmed pose do not accumulate;
5. a short loss re-emits the last setpoint;
6. a timed-out post-acquisition loss starts eight-degree local recovery around
   the current confirmed pose and never jumps to the global scan;
7. initial no-target acquisition can still scan;
8. runtime/gateway bounds remain one active call and one pending target.
9. tracking and local recovery never command below the lowest configured scan
   pitch.

The deterministic outside-FOV replay must reacquire within 2,125 ms, reach
every evaluated local waypoint before advancing, dwell at least 250 ms after
arrival, and issue no same-pose scan dispatch.

Field validation uses at least one 20-second production-path run while the
operator moves their head freely. The first acceptance targets are:

- no opposite-direction divergence;
- no post-acquisition wide scan jump;
- target-frame ratio at least 0.85;
- maximum lost gap no more than 500 ms;
- maximum active lane calls exactly one and pending depth no more than one;
- stop completes within 250 ms;
- final home readback within two degrees of configured home;
- auto-sleep remains disabled.

If the objective metrics pass but motion is still visibly stepped, the next
investigation is the firmware spring trajectory and servo command duration. If
target continuity fails, body-anchor association is inspected before changing
thresholds or adding a heavier visual tracker.
