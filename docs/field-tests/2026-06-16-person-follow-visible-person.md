# 2026-06-16 Person Follow Visible-Person Field Attempt

## Scope

Verify the stricter visible-person person-follow field gate:

- The live runtime must observe at least one aggregate person detection.
- The live runtime must issue at least one bounded PTZ move.
- The report must remain non-identifying and must not record bounding boxes,
  identities, tracking IDs, or profiling data.

## Environment

- Repository: field issue worktree
- Config: `config/pico.local.yaml`
- Tapo RTSP detection stream: `stream2`
- Person detection provider: Core ML
- PTZ driver: ONVIF

## Command

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE=1 \
PICO_PERSON_FOLLOW_VISIBLE_DURATION_MS=30000 \
PICO_PERSON_FOLLOW_VISIBLE_MAX_FRAMES=60 \
npm run field:person-follow-visible-person
```

## Result

```json
{
  "status": "failed",
  "provider": "tapo-rtsp+coreml+onvif",
  "reason": "visible-person field validation requires at least one person detection"
}
```

## Verdict

Failed for the field milestone. The runtime command and stricter field gate are
available, but the camera view did not contain a detected person during this
run. Issue #66 remains open until a visible-person run records aggregate person
detections and at least one bounded PTZ move.
