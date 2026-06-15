# 2026-06-16 Person-Follow Runtime Design

## Scope

Add a bounded runtime path that connects the existing continuous person detection
stream to the existing ONVIF person-follow controller.

The first slice is a controlled runtime/smoke boundary, not an autonomous social
behavior system. It supports short, explicit live tests and later resident-agent
integration.

## Goals

- Use the configured Tapo detection stream, usually `stream2`, for repeated
  person-detection frames.
- Feed normalized person detections into `createPersonFollowController`.
- Move the Tapo camera only through the existing bounded ONVIF relative-move
  controller.
- Require explicit live authorization before any real PTZ movement.
- Stop deterministically after a configured smoke duration or frame budget.
- Emit a compact report with frame, movement, stop, and error counts.
- Fail the report when no frames are processed or when runtime errors are
  observed.

## Non-Goals

- No identity recognition, child tracking, scoring, profiling, or emotion
  classification.
- No long-running production daemon in this slice.
- No VLM scene interpretation in the follow loop itself.
- No automatic voice prompts or unsolicited interaction in this slice.
- No hidden provider fallback chain.

## Runtime Architecture

```text
Tapo detection RTSP stream
  -> frame capture function
  -> createPersonDetectionStream()
  -> publish(PersonDetectionFrame)
  -> createPersonFollowController().processFrame()
  -> createOnvifPersonFollowPtzDriver()
```

The runtime layer owns wiring and lifecycle only. Camera movement math stays in
`src/modules/camera/index.ts`. Model execution and normalized detection frames
stay in `src/modules/vision/person-detection.ts`.

Shutdown drains both lifecycle layers before reporting:

- `PersonDetectionStream.drain()` waits for an in-flight capture/model tick to
  settle after `stop()`.
- The runtime separately drains published `processFrame()` calls before issuing
  the final controller stop.
- The final controller stop is also bounded.
- If any drain or final stop times out or rejects, the report fails instead of
  returning a clean pass.

## Safety Boundary

Live camera movement has two gates:

- The exported runtime requires `enableLiveRun: true`.
- The smoke command requires `PICO_ENABLE_LIVE_PERSON_FOLLOW=1` before passing
  runtime authorization.

Without the environment variable, the smoke returns `skipped`.

The runtime uses only observable person bounding boxes. It does not identify a
person or infer emotions. It selects the controller target through the existing
controller logic.

## Configuration

The first slice reuses existing config:

- `camera.tapo`: RTSP and ONVIF connection details.
- `camera.tapo.streams.detection`: detection stream, defaulting to `stream2`.
- `camera.personFollow`: source camera id, dead zone, max step, speed,
  cooldown, and lost-target timeout.
- `vision.personDetection`: model provider, model path, input size, interval,
  and confidence threshold.

No new YAML keys are needed for this slice.

## Testing

Unit tests cover:

- Skip behavior when the live gate is missing.
- Plan construction from existing YAML config.
- Detection stream frames forwarded to the follow controller.
- Live runtime authorization.
- Detection/follow source id mismatch rejection.
- Zero-frame and runtime-error failure reports.
- In-flight capture/model ticks and frame processing drained before the final
  report.
- Reported frame, move, stop, and error counts.
- Exit code behavior for pass, skip, and fail.

Field validation will run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml PICO_ENABLE_LIVE_PERSON_FOLLOW=1 npm run smoke:person-follow-runtime
```

The smoke must stop on its own.
