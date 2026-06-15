# 2026-06-15 Pi Agent Perception Tools Field Test

## Scope

Verify that the actual Pi Agent runtime can call pico's bounded perception tools:

- `pico_camera_snapshot`
- `pico_person_detection`
- `pico_camera_scene_description`

This test also records provider readiness for the underlying Tapo RTSP, Core ML
person detection, and Ollama VLM paths.

## Environment

- Repository: `<repo-root>`
- Pi Agent CLI: project-local `node_modules/.bin/pi`
- Extension: `./src/index.ts`
- Config: `config/pico.local.yaml`
- Secrets: not recorded

## Verification Commands

```bash
npm test -- --run tests/perception-service.test.ts tests/perception-tool.test.ts tests/extension.test.ts tests/camera-smoke.test.ts tests/person-detection-smoke.test.ts tests/camera-vlm-scene-smoke.test.ts
just check
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-tapo
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:person-detection
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-vlm-scene
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_snapshot tool を使ってください。最後の返答では sourceId, streamPurpose, frameBytes, capturedAt だけを日本語で簡潔に報告してください。'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_person_detection tool を使ってください。最後の返答では sourceId, streamPurpose, detectedPeople, capturedAt だけを日本語で簡潔に報告してください。'
PICO_CONFIG_PATH=config/pico.local.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テストです。必ず pico_camera_scene_description tool を使ってください。最後の返答では summary, observedPeopleの件数, environmentの件数, uncertaintyの件数だけを日本語で簡潔に報告してください。'
```

## Automated Verification

- Focused runtime and smoke tests: passed, 6 files / 49 tests.
- Full project gate: passed.
- `just check`: typecheck, lint, ast rule tests, ast scan, format check, and full
  Vitest suite passed, 31 files / 335 tests.

## Provider Readiness

### `smoke:camera-tapo`

- Status: passed
- Provider: `tapo-rtsp`
- Source ID: `tapo-rtsp`
- Frame bytes: `114144`
- MIME type: `image/jpeg`

### `smoke:person-detection`

- Status: passed
- Provider: `tapo-rtsp+coreml`
- Source ID: `tapo-rtsp`
- Frame bytes: `47315`
- Detected people: `0`
- Captured at: `2026-06-15T02:01:10.766Z`

### `smoke:camera-vlm-scene`

- Status: passed
- Provider: `tapo-rtsp+ollama`
- Source ID: `tapo-rtsp`
- Frame bytes: `113402`
- VLM frame bytes: `30923`
- MIME type: `image/jpeg`
- Endpoint ID: `windows-ollama-qwen3-5`
- Model: `qwen3.5:9b`
- Timeout: `120000`
- Summary: `A cluttered desk with various items including a computer monitor, keyboard, and a pink plush toy.`
- Observed people: `0`
- Environment items: `9`
- Human attention items: `0`
- Uncertainty items: `3`

## Pi Agent Tool Results

### `pico_camera_snapshot`

- Status: passed
- Source ID: `tapo-rtsp`
- Stream purpose: `scene`
- Frame bytes: `111183`
- Captured at: `2026-06-15T02:01:43.741Z`

### `pico_person_detection`

- Status: passed
- Source ID: `tapo-rtsp`
- Stream purpose: `detection`
- Detected people: `0`
- Captured at: `2026-06-15T02:02:15.648Z`

### `pico_camera_scene_description`

- Status: passed
- Summary: `机上の物品が見えます。`
- Observed people count: `0`
- Environment count: `9`
- Uncertainty count: `3`

## Verdict

Passed. The actual Pi Agent runtime can call all three bounded perception tools,
with scene/VLM traffic using the scene path and person detection using the
detection path. No follow-up issue is required from this field test.
