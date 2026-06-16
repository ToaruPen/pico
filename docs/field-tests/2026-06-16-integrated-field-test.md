# 2026-06-16 Integrated Field Test

## Scope

Verify the current live pico path across Pi Agent loading, voice providers, Tapo
camera capture, person detection, VLM scene understanding, PTZ control,
person-follow runtime startup, session tooling, memory candidate processing, and
audit/OTel export.

This run used the actual local config and real providers where available. It
does not record secrets.

## Environment

- Repository: main checkout
- Branch: `main`
- Config: `config/pico.local.yaml`
- Pi Agent CLI: `node_modules/.bin/pi`
- Extension: `./src/index.ts`
- Tapo camera: local RTSP/ONVIF device from local config
- VLM: protected Ollama endpoint from local config

## Commands

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:milestone
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:pi-runtime
PICO_CONFIG_PATH=config/pico.local.yaml PICO_ENABLE_LIVE_PTZ_NUDGE=1 npm run smoke:camera-ptz
PICO_CONFIG_PATH=config/pico.local.yaml PICO_ENABLE_LIVE_PERSON_FOLLOW=1 PICO_PERSON_FOLLOW_SMOKE_DURATION_MS=5000 PICO_PERSON_FOLLOW_SMOKE_MAX_FRAMES=5 npm run smoke:person-follow-runtime
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt requiring pico_camera_snapshot>'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt requiring pico_person_detection>'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt requiring pico_camera_scene_description>'
PICO_CONFIG_PATH=config/pico.local.yaml npm run field:voice-echo-pickup
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt requiring pico_session start/append/read>'
PICO_CONFIG_PATH=.pico-local/field-session-cutoff.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt requiring pico_session timed cutoff>'
```

## Observed Results

### Milestone Smoke

- Top-level status: `skipped`
- Skip reason: `tapo_ptz` requires the explicit live movement gate
  `PICO_ENABLE_LIVE_PTZ_NUDGE=1`.
- Passed sections: `pi_runtime`, `voice_stt`, `voice_tts`, `tapo_snapshot`,
  `person_detection`, `ollama_vlm`, `camera_vlm_scene`, `mem0_runtime`,
  `memory_candidate`, and `audit_otel`.

Selected details:

- Pi runtime identity: `pico`
- STT provider: `mlx-whisper`
- TTS provider: `aivis-speech`
- Tapo snapshot frame bytes: `114919`
- Person detection provider: `tapo-rtsp+coreml`
- Person detection result: `detectedPeople=0`
- Ollama model: `qwen3.5:9b`
- Camera VLM summary: `A desk setup with multiple monitors, a keyboard, a pink mug, and a plush toy.`
- Mem0 runtime: `memoryCount=2`, `searchResultCount=2`
- Audit OTel export: `exportedOtelRecordCount=4`

### Explicit Live PTZ Nudge

- Status: `passed`
- Provider: `tapo-onvif-ptz`
- Source ID: `tapo-rtsp`
- Command: `pan=0.05`, `tilt=0`, `speed=0.2`

### Person-Follow Runtime

- Status: `passed`
- Provider: `tapo-rtsp+coreml+onvif`
- Source ID: `tapo-rtsp`
- Frames processed: `1`
- Moves issued: `0`
- Stops issued: `1`
- Errors: `0`

No person was visible in the camera view during this run, so this proves live
startup, frame processing, and safe stop behavior. It does not prove PTZ movement
toward a visible person.

### Pi Agent Perception Tools

`pico_camera_snapshot`:

- Source ID: `tapo-rtsp`
- Stream purpose: `scene`
- Frame bytes: `112175`
- Captured at: `2026-06-15T23:55:52.231Z`

`pico_person_detection`:

- Source ID: `tapo-rtsp`
- Stream purpose: `detection`
- Detected people: `0`
- Captured at: `2026-06-15T23:56:05.920Z`

`pico_camera_scene_description`:

- Summary: `机まわりの作業スペース` (workspace around the desk/machine)
- Observed people count: `0`
- Environment count: `7`
- Uncertainty count: `2`

### Voice Echo Pickup

- Status: `passed`
- Echo action: `suppress`
- Transcript length during suppression: `0`
- Resume transcript length: `14`
- Would trigger session: `false`

### Pi Agent Session Tool

Start, append, and read:

- Session ID: `session-1`
- State: `active`
- Entry count: `1`

Timed cutoff:

- Session ID: `session-1`
- Source entry IDs: `0`
- Requested by: `session_lifecycle`

The timed cutoff returned successfully, but the cutoff payload was empty because
the short field timer expired before the model/tool sequence could append an
entry.

## Verdict

Passed for the currently wired live runtime paths:

- Pi Agent extension loading
- STT/TTS provider readiness
- Tapo scene capture through `stream1`
- Tapo detection capture through `stream2`
- Core ML person detection provider execution
- Ollama VLM scene description
- Explicit ONVIF PTZ nudge
- Person-follow runtime startup and safe stop
- Pi Agent perception tools
- Pi Agent session start/append/read
- Voice echo suppression
- Mem0 runtime smoke
- SQLite memory candidate smoke
- Audit OTel smoke export

Not yet complete for the full resident-agent field milestone:

- Person-follow did not issue a movement because no person was visible.
- Timed cutoff did not carry session entries into the cutoff payload.
- Long-memory/Mem0/OTel were verified in the smoke path, not from the same
  entry-bearing Pi Agent session cutoff.

## Follow-Up Issues

- #65: Validate entry-bearing session cutoff through long-memory and OTel. This
  was completed later by PR #67.
- #66: Validate person-follow PTZ movement with a visible person. This remains
  open until a visible-person run proves bounded PTZ movement.
