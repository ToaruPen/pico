# 2026-06-15 Tapo ONVIF PTZ Nudge Field Test

## Scope

Verify that pico can issue one explicitly enabled, bounded ONVIF PTZ nudge
through the person-follow camera boundary.

This field test validates camera movement plumbing only. It does not validate a
continuous person-follow loop, identity recognition, child tracking, scoring, or
profiling.

## Environment

- Repository: `<repo-root>`
- Worktree: `codex/field-roadmap-next`
- Config: `config/pico.local.yaml`
- Secrets: not recorded
- Live movement gate: `PICO_ENABLE_LIVE_PTZ_NUDGE=1`

## Command

```bash
PICO_CONFIG_PATH=config/pico.local.yaml PICO_ENABLE_LIVE_PTZ_NUDGE=1 npm run smoke:camera-ptz
```

## Observed Result

```json
{
  "status": "passed",
  "provider": "tapo-onvif-ptz",
  "details": {
    "sourceId": "tapo-rtsp",
    "pan": 0.05,
    "tilt": 0,
    "speed": 0.2
  }
}
```

## Verdict

Passed. Pico can issue one bounded Tapo ONVIF PTZ nudge when live movement is
explicitly enabled.

## Follow-Up

No follow-up issue is required for the bounded nudge path.

Continuous person-follow behavior still needs a separate live field validation
that combines live person detection frames with the person-follow controller.
