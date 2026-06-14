# 2026-06-14 Voice Echo Pickup Field Test

## Purpose

Verify that pico does not start or continue session-triggering speech input from
its own Aivis Speech output.

## Environment

- Config: `config/pico.local.yaml`
- Echo control mode: `half_duplex`
- TTS provider: Aivis Speech at local endpoint
- STT provider: mlx-whisper sidecar at local endpoint
- Recording transport: `ffmpeg` AVFoundation input `:0`
- Playback transport: `afplay`

## Command

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run field:voice-echo-pickup
```

## Result

```json
{
  "status": "passed",
  "details": {
    "echoAction": "suppress",
    "transcriptLength": 0,
    "resumedTranscriptLength": 11,
    "wouldTriggerSession": false
  }
}
```

## Notes

- Raw audio artifacts were written under `.pico-local/field-voice/` and are not
  tracked.
- This validates the explicit half-duplex safety mode.
- The harness also records a post-tail resume window and checks it against the
  configured session wake/greeting triggers. The resume window produced
  non-empty STT text, but it did not match configured session triggers.
- The AEC provider contract is implemented for a local sidecar endpoint, but no
  WebRTC AEC3 sidecar was running for this field test.
