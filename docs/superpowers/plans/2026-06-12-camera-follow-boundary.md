# Camera Follow Boundary Plan

Date: 2026-06-12
Issue: #48

## Scope

Add the first bounded person-follow camera slice:

- YAML config for an explicitly disabled-by-default person-follow controller.
- Pure nudge math that converts a normalized person bounding box into a bounded
  relative PTZ command.
- A controller boundary that consumes detection frames, enforces dead zone,
  cooldown, lost-target timeout, and manual stop.
- Audit hook for issued movement and stop commands.
- Lost-target timeout is frame-driven in this slice; a stalled detection pipeline
  is handled by the surrounding runtime/smoke layer rather than an internal
  wall-clock timer.

## Non-goals

- No Tapo cloud control.
- No face recognition, identity tracking, or durable memory writes.
- No hidden provider chain or automatic fallback.
- No live hardware move by default.

## Verification

- Config tests for defaults, valid config, and invalid bounds.
- Camera tests for nudge math, dead zone, cooldown, lost target, and manual stop.
- `just check` before PR.
