# CoreML Person Detection Design

## Goal

Make pico's local person detection path CoreML-accelerated for the M4 Mac
deployment target while preserving the existing provider boundary and
no-fallback rule.

This design supersedes issue #54's CPU-first assumption for production
direction. The M4 Mac path uses the pinto0309 ONNX package through ONNX Runtime's
CoreML execution provider. ONNX is the model interchange package; CoreML is the
accelerated execution provider. CPU execution remains a separate explicit
provider and is not an automatic fallback.

## Context

Real-device validation showed:

- Tapo RTSP frame capture works against the configured Tapo camera.
- Tapo ONVIF PTZ nudge works when enabled through explicit local config.
- Pi Agent can load the pico extension.
- mlx-whisper and Aivis Speech provider smokes pass.
- Ollama VLM connectivity passes, but the full camera-to-VLM scene request needs
  a separate timeout fix tracked in issue #55.
- pinto0309 `132_YOLOX` nano ONNX loads on the M4 Mac, but its output shape is
  `[1, 2100, 85]`, which is raw YOLOX COCO output and not the current six-column
  pico detection-row layout.
- pinto0309 `132_YOLOX` nano also ships `model_coreml_float32.mlmodel`, but it
  fails to compile in this environment with a CoreML compiler error:
  `generic_general_slice: Invalid values in end_ids`.
- The same pinto0309 ONNX model loads successfully through `onnxruntime-node`
  with `executionProviders: ['coreml']`. ONNX Runtime reports that CoreML
  supports 366 of 367 graph nodes, with shape-related work assigned outside the
  preferred provider.
- `onnxruntime-common` exposes `CoreMLExecutionProviderOption` and
  `coreMlFlags` for the Node binding.

## Non-Goals

- Do not add automatic fallback from CoreML to ONNX, TFLite, or OpenVINO.
- Do not add identity recognition, face recognition, child tracking, child
  scoring, or child profiling.
- Do not add a Swift sidecar unless ONNX Runtime CoreML EP proves insufficient.
- Do not solve camera-to-VLM timeout behavior in this slice; that remains issue
  #55.
- Do not implement the full always-on camera loop in this slice. This slice
  provides the correct provider boundary, smoke command, and benchmark contract.

## Architecture

CoreML acceleration runs behind the existing TypeScript ONNX Runtime boundary:

```text
Tapo RTSP JPEG
  -> pico TypeScript smoke/runtime boundary
  -> ONNX Runtime session configured with CoreML EP
  -> CoreML-accelerated YOLOX model prediction
  -> YOLOX raw COCO decode + NMS
  -> normalized person boxes JSON
  -> pico PersonDetectionFrame
  -> person-follow controller or smoke report
```

The TypeScript side owns configuration, camera capture, image preprocessing,
ONNX Runtime session creation, CoreML EP selection, YOLOX raw output decoding,
audit-safe smoke reporting, and integration with the existing
`PersonDetectionModel` interface.

This keeps acceleration explicit and prevents hidden runtime chains. A
configured provider either creates a CoreML EP-backed ONNX Runtime session or
fails/skips with an actionable reason. It must not silently retry with CPU.

## Configuration

Extend `vision.personDetection.provider` with `coreml`.

CoreML provider configuration uses the existing `vision.personDetection`
section:

```yaml
vision:
  personDetection:
    enabled: true
    sourceCameraId: tapo-rtsp
    modelFamily: pinto0309
    provider: coreml
    modelPath: /Users/monsoon/.cache/pico/models/pinto0309/132_YOLOX/nano/resouces_new/saved_model_yolox_nano_320x320/yolox_nano_320x320.onnx
    inputWidth: 320
    inputHeight: 320
    outputLayout: yolox_coco_raw
    coordinateScale: pixel
    frameIntervalMs: 500
    confidenceThreshold: 0.55
    coremlFlags: 18
    nmsIouThreshold: 0.45
```

Rules:

- `provider: coreml` uses `onnxruntime-node` with a CoreML execution provider.
- `provider: coreml` requires `outputLayout: yolox_coco_raw`.
- `provider: coreml` requires an ONNX `modelPath`.
- `coremlFlags` is optional and defaults to `18`, which enables CoreML on
  subgraphs and ML Program creation (`0x002 | 0x010`).
- `nmsIouThreshold` defaults to `0.45` when omitted and must be `> 0` and
  `<= 1`.

## Runtime Contract

The CoreML provider is an in-process `PersonDetectionModel` implementation that
wraps `onnxruntime-node`.

Session creation:

```ts
InferenceSession.create(modelPath, {
  executionProviders: [
    {
      name: "coreml",
      coreMlFlags
    }
  ]
});
```

This is not an automatic fallback chain. ONNX Runtime may assign shape-related
nodes outside CoreML internally, but pico must not add `cpu` as a second
provider for the CoreML path.

## YOLOX Decode

For pinto0309 YOLOX raw COCO output:

- Expected output shape is `[1, candidateCount, 85]`.
- Row fields are interpreted as:
  - `centerX`
  - `centerY`
  - `width`
  - `height`
  - `objectness`
  - `80 COCO class scores`
- COCO class `0` is `person`.
- Person confidence is `objectness * classScore[0]`.
- Rows below `confidenceThreshold` are discarded.
- Boxes are converted from center-size to pixel `x`, `y`, `width`, `height`.
- Boxes are clamped to the configured frame dimensions.
- Non-maximum suppression removes duplicate person boxes above
  `nmsIouThreshold`.

The decoder must reject malformed shapes and non-finite values with explicit
errors.

## Smoke And Benchmark

`npm run smoke:person-detection` should support the CoreML provider:

- Capture one Tapo RTSP frame.
- Invoke the CoreML EP-backed ONNX Runtime model.
- Normalize detections through the existing `PersonDetectionFrame` boundary.
- Report `detectedPeople`, `frameBytes`, `capturedAt`, execution provider, and
  timing totals.

Add a benchmark mode or companion smoke that can run repeated inference on one
captured frame and report:

- iteration count
- p50 latency
- p95 latency
- effective FPS
- whether p95 is within `frameIntervalMs`

The benchmark does not need to drive PTZ. It only measures the detection path.

## Testing

TypeScript tests cover:

- Config parsing for `provider: coreml`.
- Required `outputLayout: yolox_coco_raw` for CoreML.
- Required ONNX `modelPath` for CoreML.
- `nmsIouThreshold` validation and defaulting.
- `coremlFlags` validation and defaulting.
- CoreML ONNX Runtime session options.
- CoreML provider does not include a CPU fallback provider.
- Smoke planning for missing model paths.
- YOLOX raw decode math.
- Thresholding.
- COCO person class filtering.
- NMS duplicate suppression.
- Malformed output shape rejection.

Live CoreML smoke is explicitly skippable when the local model file is missing.

## Operational Notes

- Live CoreML execution requires macOS with ONNX Runtime CoreML EP support.
- The local model file remains untracked.
- Local config stays in `config/pico.local.yaml` and is ignored by git.
- The smoke command must redact or avoid credentials in all errors.
- Direct `.mlmodel` execution remains out of scope until the pinto CoreML model
  compile error is resolved.

## Acceptance Criteria

- `vision.personDetection.provider: coreml` is a valid explicit provider.
- CoreML config fails fast when required model/layout settings are absent
  or malformed.
- The CoreML ONNX Runtime contract is represented in TypeScript by a narrow
  `PersonDetectionModel` adapter.
- The pinto YOLOX raw decode path is tested with deterministic rows.
- `npm run smoke:person-detection` can run the CoreML plan when the local ONNX
  model path exists.
- `just check` passes.
- A ready PR includes polishment, AI slop cleanup evidence, and independent
  approval before review.
