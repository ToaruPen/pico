# 2026-06-16 Person Follow Runtime Field Test

## Scope

Verify the bounded live person-follow runtime path:

- Tapo RTSP detection stream: `stream2`
- Person detection provider: CoreML execution provider through ONNX Runtime
- PTZ driver: ONVIF
- Live gate: `PICO_ENABLE_LIVE_PERSON_FOLLOW=1`

This test does not verify identity, emotion inference, VLM scene understanding,
or proactive speech prompts.

## Command

```sh
PICO_CONFIG_PATH=/Users/monsoon/Dev/pico/config/pico.local.yaml \
PICO_ENABLE_LIVE_PERSON_FOLLOW=1 \
PICO_PERSON_FOLLOW_SMOKE_DURATION_MS=3000 \
PICO_PERSON_FOLLOW_SMOKE_MAX_FRAMES=3 \
npm run smoke:person-follow-runtime
```

## Result

```json
{
  "status": "passed",
  "provider": "tapo-rtsp+coreml+onvif",
  "details": {
    "sourceId": "tapo-rtsp",
    "framesProcessed": 1,
    "movesIssued": 0,
    "stopsIssued": 1,
    "errors": 0
  }
}
```

## Notes

- The runtime processed one live RTSP detection frame without capture, model, or
  ONVIF errors.
- No PTZ move was issued during this bounded run because the processed frame did
  not require target recentering.
- The runtime issued one stop command during shutdown.
