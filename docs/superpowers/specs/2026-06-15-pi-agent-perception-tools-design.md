# Pi Agent Perception Tools Design

## Goal

Expose pico's already validated Tapo RTSP, person detection, and camera-to-VLM
paths through actual Pi Agent extension tools so field tests can prove the
resident agent can observe the room from its real runtime interface.

This design implements GitHub issue #61. It follows the current production
boundary that Tapo scene understanding uses the high-quality stream and person
detection uses the lower-cost detection stream:

- Scene and VLM operations use `camera.tapo.streams.scene ?? "stream1"`.
- Person detection operations use `camera.tapo.streams.detection ?? "stream2"`.

## Non-Goals

- No LINE integration.
- No PTZ movement or person-follow control.
- No persistent person-detection daemon.
- No automatic long-memory writes.
- No provider fallback chain.
- No alternate VLM provider selection.
- No exposed inbound model ports.
- No child identification, tracking, scoring, profiling, diagnosis, or final
  safety decision making.

## Runtime Tools

### `pico_camera_snapshot`

Captures one Tapo RTSP frame from the scene stream.

The tool returns metadata only:

- `sourceId`
- `streamPurpose: "scene"`
- `mimeType: "image/jpeg"`
- `frameBytes`
- `capturedAt`

The tool must not return image bytes or base64 image content. The actual image
is room imagery, and putting it into tool text would make it part of the Pi Agent
conversation transcript. Scene understanding should happen through
`pico_camera_scene_description`, where the frame stays inside the bounded
runtime pipeline and only structured text returns to the agent.

### `pico_person_detection`

Captures one Tapo RTSP frame from the detection stream and runs the configured
pinto0309 person detector.

The tool returns:

- `sourceId`
- `streamPurpose: "detection"`
- `frameBytes`
- `capturedAt`
- `detectedPeople`
- `detections[]` with `confidence` and normalized bounding boxes

This is a single capture-and-detect operation. It is not a background stream,
not a person-follow controller, and not a PTZ command path.

### `pico_camera_scene_description`

Captures one Tapo RTSP frame from the scene stream, bounds the JPEG for VLM
input, sends it to the configured Ollama endpoint, and returns the existing
`SceneDescription` structure:

- `summary`
- `observedPeople`
- `environment`
- `humanAttention`
- `uncertainty`
- `source`

The existing vision prompt remains the policy boundary: describe only visible
after-school-care scene details, do not identify children, do not infer private
traits, do not diagnose or score, and do not make final safety decisions.

## Architecture

Pi Agent tool definitions live under `src/runtime/`, following the existing
`src/runtime/session-tool.ts` pattern.

The implementation should add a small production runtime service rather than
importing from `scripts/smoke/*`. Smoke scripts contain CLI report, skip, and
exit-code behavior. Runtime tools should share production primitives with smoke
commands, not depend on smoke command wrappers.

Recommended files:

- `src/runtime/perception-service.ts`
  - Builds Tapo snapshot sources for scene and detection operations.
  - Captures RTSP frames through `createRtspSnapshotClient`.
  - Redacts RTSP credentials and URLs in failure messages.
  - Creates configured person detection models.
  - Runs one camera-to-VLM scene description operation.
- `src/runtime/perception-tool.ts`
  - Defines and exports `createPicoCameraSnapshotTool`.
  - Defines and exports `createPicoPersonDetectionTool`.
  - Defines and exports `createPicoCameraSceneDescriptionTool`.
  - Converts service results to `AgentToolResult` text JSON.
- `src/index.ts`
  - Registers the three new tools beside `pico_session`.

Existing production modules remain the source of truth for lower-level behavior:

- `src/config/index.ts` for YAML loading and validation.
- `src/modules/camera/index.ts` for RTSP source and snapshot client behavior.
- `src/modules/vision/index.ts` for bounded Ollama scene descriptions.
- `src/modules/vision/person-detection.ts` for pinto0309 detection.

## Error Handling and Redaction

All tool failures must return a structured failed result through the tool, not
throw raw provider errors into Pi Agent output when the error can contain local
configuration values.

Failure text must redact:

- RTSP URLs.
- Tapo username.
- Tapo password.
- Ollama auth headers or tokens if a selected endpoint has auth.

Tool output must not include:

- Local model file paths.
- Raw RTSP URLs.
- Camera credentials.
- Local auth secrets.
- Raw image bytes or base64 room imagery.

Errors that indicate missing required local config should be staff-actionable,
for example:

- `camera.tapo is required to use pico_camera_snapshot`
- `vision.personDetection.enabled=true is required to use pico_person_detection`
- `vision.ollama is required to use pico_camera_scene_description`

## Testing

Tests should cover runtime tools directly, not only smoke commands.

Required unit coverage:

- Extension registration includes `pico_camera_snapshot`,
  `pico_person_detection`, and `pico_camera_scene_description`.
- Snapshot and scene description operations use `stream1` by default.
- Person detection uses `stream2` by default.
- Explicit `camera.tapo.streams.scene` and `.detection` values are honored.
- Snapshot capture failure redacts RTSP URLs and credentials.
- Person detection capture failure redacts RTSP URLs and credentials.
- Camera-to-VLM failure redacts RTSP URLs and credentials.
- Person detection returns a bounded count and detection boxes.
- Camera scene description returns the existing structured scene object.
- Runtime tool text output contains no raw image bytes or base64 image content.

Existing smoke tests should keep passing. Follow-up cleanup may migrate smoke
commands to call the new production service, but the first implementation can
keep smoke scripts stable if the runtime service is covered independently.

## Field Validation

After implementation and local gates:

1. Run `just check`.
2. Run the existing provider readiness smoke commands with
   `PICO_CONFIG_PATH=config/pico.local.yaml`:
   - `npm run smoke:camera-tapo`
   - `npm run smoke:person-detection`
   - `npm run smoke:camera-vlm-scene`
3. Launch the actual Pi Agent extension and require each new tool in a prompt:
   - `pico_camera_snapshot`
   - `pico_person_detection`
   - `pico_camera_scene_description`
4. Record the field result under `docs/field-tests/`.
5. If any field milestone fails, create a focused GitHub issue with evidence.

## Acceptance Criteria

- Actual Pi Agent runtime can call a bounded camera snapshot tool using
  `stream1` for scene/VLM use.
- Actual Pi Agent runtime can call a bounded person detection tool using
  `stream2` for detection/follow use.
- Actual Pi Agent runtime can call a bounded camera-to-VLM scene tool and return
  a structured scene summary.
- Failure reports redact RTSP credentials and avoid exposing local secrets.
- Field report records Pi Agent launch command, observed tool results, and any
  follow-up issues.
