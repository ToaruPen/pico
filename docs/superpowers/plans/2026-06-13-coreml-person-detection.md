# CoreML Person Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit CoreML-accelerated pinto0309 person-detection path using ONNX Runtime CoreML EP, YOLOX raw COCO decode, and live smoke support.

**Architecture:** Keep the current TypeScript `PersonDetectionModel` boundary. `provider: coreml` creates an ONNX Runtime session with a single CoreML execution provider and no CPU secondary provider; ONNX Runtime owns graph execution while pico owns config, preprocessing, raw YOLOX decode, NMS, and smoke reporting.

**Tech Stack:** TypeScript, Vitest, `onnxruntime-node`, `sharp`, YAML config, Tapo RTSP smoke scripts.

---

## File Structure

- Modify `src/config/index.ts`: add `coreml` provider, `yolox_coco_raw` layout, `coremlFlags`, `nmsIouThreshold`, defaults, and provider-specific validation.
- Modify `src/modules/vision/person-detection.ts`: add CoreML ONNX Runtime session options, YOLOX raw COCO row decode, and NMS.
- Modify `scripts/smoke/person-detection.ts`: allow `onnxruntime` and `coreml`, construct the correct model, and report the effective provider.
- Modify `scripts/smoke/milestone-suite.ts`: keep the person-detection milestone provider label compatible with either configured provider.
- Modify `tests/config.test.ts`: lock config parsing, defaults, and validation.
- Modify `tests/person-detection.test.ts`: lock CoreML session options, YOLOX raw decode, and NMS.
- Modify `tests/person-detection-smoke.test.ts`: lock smoke planning and run reporting for `coreml`.
- Modify `tests/milestone-smoke.test.ts`: update provider assertions if needed.

## Task 1: Config Boundary

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests to `tests/config.test.ts` near the existing person detection config tests:

```ts
it("loads CoreML person detection defaults for pinto YOLOX raw output", () => {
  expect(
    definePicoConfig({
      vision: {
        personDetection: {
          enabled: true,
          sourceCameraId: "tapo-main",
          modelFamily: "pinto0309",
          provider: "coreml",
          modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
          inputWidth: 320,
          inputHeight: 320,
          outputLayout: "yolox_coco_raw",
          coordinateScale: "pixel",
          frameIntervalMs: 500,
          confidenceThreshold: 0.55
        }
      }
    }).vision.personDetection
  ).toMatchObject({
    enabled: true,
    provider: "coreml",
    outputLayout: "yolox_coco_raw",
    coremlFlags: 18,
    nmsIouThreshold: 0.45
  });
});

it("requires YOLOX raw output for CoreML person detection", () => {
  expect(() =>
    definePicoConfig({
      vision: {
        personDetection: {
          enabled: true,
          sourceCameraId: "tapo-main",
          modelFamily: "pinto0309",
          provider: "coreml",
          modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
          inputWidth: 320,
          inputHeight: 320,
          outputLayout: "xyxy_score_class",
          frameIntervalMs: 500,
          confidenceThreshold: 0.55
        }
      }
    })
  ).toThrow("pico config vision.personDetection.outputLayout must be yolox_coco_raw when provider is coreml");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/config.test.ts`

Expected: FAIL because `coreml`, `yolox_coco_raw`, `coremlFlags`, and `nmsIouThreshold` do not exist yet.

- [ ] **Step 3: Implement config support**

Update `src/config/index.ts`:

```ts
export type PicoPersonDetectionProvider = "onnxruntime" | "coreml" | "tflite" | "openvino";
export type PicoPersonDetectionOutputLayout =
  | "xyxy_score_class"
  | "cxcywh_score_class"
  | "yolox_coco_raw";
```

Add optional fields to `PicoPersonDetectionConfig` and `OptionalPersonDetectionFields`:

```ts
readonly coremlFlags?: number;
readonly nmsIouThreshold?: number;
```

Read values in `definePersonDetectionConfig`:

```ts
const coremlFlags = readOptionalNonNegativeInteger(
  input.coremlFlags,
  "pico config vision.personDetection.coremlFlags"
);
const nmsIouThreshold = readOptionalOpenUnit(
  input.nmsIouThreshold,
  "pico config vision.personDetection.nmsIouThreshold"
);
```

For enabled config, default only when needed:

```ts
const resolvedCoremlFlags = provider === "coreml" ? (coremlFlags ?? 18) : coremlFlags;
const resolvedNmsIouThreshold =
  outputLayout === "yolox_coco_raw" || provider === "coreml"
    ? (nmsIouThreshold ?? 0.45)
    : nmsIouThreshold;

if (provider === "coreml" && outputLayout !== "yolox_coco_raw") {
  throw new Error(
    "pico config vision.personDetection.outputLayout must be yolox_coco_raw when provider is coreml"
  );
}
```

Update provider/layout error strings to include `coreml` and `yolox_coco_raw`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/config.test.ts`

Expected: PASS.

## Task 2: CoreML Runtime Adapter and YOLOX Decode

**Files:**
- Modify: `src/modules/vision/person-detection.ts`
- Test: `tests/person-detection.test.ts`

- [ ] **Step 1: Write failing runtime/decode tests**

Add tests to `tests/person-detection.test.ts` after the existing ONNX model tests:

```ts
it("creates a CoreML ONNX Runtime session without adding a CPU secondary provider", async () => {
  const createCalls: unknown[] = [];
  const runtime: OnnxPersonDetectionRuntime = {
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: readonly number[]
      ) {}
    },
    InferenceSession: {
      create(modelPath, options) {
        createCalls.push({ modelPath, options });
        return Promise.resolve({
          inputNames: ["images"],
          outputNames: ["output"],
          run() {
            return Promise.resolve({
              output: {
                data: Float32Array.of(160, 120, 80, 100, 0.9, 0.8, 0.1),
                dims: [1, 1, 7]
              }
            });
          }
        });
      }
    }
  };

  const model = await createCoremlPersonDetectionModel({
    modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
    frameSize: { width: 320, height: 240 },
    runtime,
    preprocessFrame: () => Promise.resolve({ data: Float32Array.of(0), dims: [1, 3, 320, 320] }),
    coremlFlags: 18,
    confidenceThreshold: 0.5
  });

  await model.detect(Buffer.from("frame"));

  expect(createCalls).toEqual([
    {
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      options: {
        executionProviders: [{ name: "coreml", coreMlFlags: 18 }]
      }
    }
  ]);
});

it("decodes raw YOLOX COCO output and suppresses duplicate person boxes", async () => {
  const runtime = createOneOutputRuntime(
    Float32Array.of(
      160, 120, 80, 100, 0.9, 0.8, 0.1,
      162, 122, 82, 102, 0.88, 0.76, 0.1,
      40, 40, 20, 20, 0.95, 0.2, 0.7
    ),
    [1, 3, 7]
  );

  const model = await createOnnxPersonDetectionModel({
    modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
    frameSize: { width: 320, height: 240 },
    outputLayout: "yolox_coco_raw",
    coordinateScale: "pixel",
    runtime,
    preprocessFrame: () => Promise.resolve({ data: Float32Array.of(0), dims: [1, 3, 320, 320] }),
    confidenceThreshold: 0.5,
    nmsIouThreshold: 0.45
  });

  await expect(model.detect(Buffer.from("frame"))).resolves.toEqual([
    {
      label: "person",
      confidence: 0.72,
      box: { x: 120, y: 70, width: 80, height: 100 }
    }
  ]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/person-detection.test.ts`

Expected: FAIL because `createCoremlPersonDetectionModel`, CoreML session options, `yolox_coco_raw`, and NMS do not exist.

- [ ] **Step 3: Implement adapter and decode**

Update `src/modules/vision/person-detection.ts`:

```ts
export type OnnxPersonDetectionOutputLayout =
  | "xyxy_score_class"
  | "cxcywh_score_class"
  | "yolox_coco_raw";

export type CoremlPersonDetectionModelOptions = Omit<
  OnnxPersonDetectionModelOptions,
  "outputLayout"
> & {
  readonly coremlFlags?: number;
};
```

Allow session options in the runtime type:

```ts
readonly create: (
  modelPath: string,
  options?: unknown
) => Promise<OnnxPersonDetectionSession>;
```

Add:

```ts
export function createCoremlPersonDetectionModel(
  options: CoremlPersonDetectionModelOptions
): Promise<PersonDetectionModel> {
  return createOnnxPersonDetectionModel({
    ...options,
    outputLayout: "yolox_coco_raw",
    coordinateScale: options.coordinateScale ?? "pixel",
    sessionOptions: {
      executionProviders: [
        {
          name: "coreml",
          coreMlFlags: options.coremlFlags ?? 18
        }
      ]
    }
  });
}
```

Add `sessionOptions?: unknown` and `nmsIouThreshold?: number` to options and resolved options. Parse YOLOX rows as:

```ts
const objectness = requireConfidenceThreshold(row[4]);
const personClassScore = requireConfidenceThreshold(row[5 + options.personClassId]);
const confidence = roundDetectionScore(objectness * personClassScore);
const box = parseCxcywhBox(row[0], row[1], row[2], row[3], options);
```

Then run NMS for `yolox_coco_raw` detections sorted by descending confidence.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/person-detection.test.ts`

Expected: PASS.

## Task 3: Smoke Wiring

**Files:**
- Modify: `scripts/smoke/person-detection.ts`
- Modify: `scripts/smoke/milestone-suite.ts`
- Test: `tests/person-detection-smoke.test.ts`
- Test: `tests/milestone-smoke.test.ts`

- [ ] **Step 1: Write failing smoke tests**

Add a CoreML-config fixture and test:

```ts
const configuredCoreml = definePicoConfig({
  camera: configured.camera,
  vision: {
    personDetection: {
      enabled: true,
      sourceCameraId: "tapo-main",
      modelFamily: "pinto0309",
      provider: "coreml",
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      inputWidth: 320,
      inputHeight: 320,
      outputLayout: "yolox_coco_raw",
      coordinateScale: "pixel",
      frameIntervalMs: 500,
      confidenceThreshold: 0.55,
      coremlFlags: 18,
      nmsIouThreshold: 0.45
    }
  }
});

it("runs Tapo snapshot through the configured CoreML detector once", async () => {
  const model: PersonDetectionModel = {
    detect: () =>
      Promise.resolve([
        { label: "person", confidence: 0.92, box: { x: 64, y: 48, width: 128, height: 192 } }
      ])
  };

  await expect(
    runPersonDetectionSmoke(configuredCoreml, {
      pathExists: () => true,
      captureFrame: () =>
        Promise.resolve({
          ok: true,
          sourceId: "tapo-main",
          mimeType: "image/jpeg",
          frame: Buffer.from("jpeg-frame")
        }),
      createModel: () => Promise.resolve(model),
      now: () => "2026-06-12T09:00:00.000Z"
    })
  ).resolves.toMatchObject({
    status: "passed",
    provider: "tapo-rtsp+coreml",
    details: { detectedPeople: 1 }
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/person-detection-smoke.test.ts tests/milestone-smoke.test.ts`

Expected: FAIL because smoke skips non-ONNX providers and reports only `tapo-rtsp+onnxruntime`.

- [ ] **Step 3: Implement smoke provider branching**

Update `scripts/smoke/person-detection.ts` to:

```ts
type EnabledPersonDetectionConfig = {
  readonly provider: "onnxruntime" | "coreml";
  readonly outputLayout?: "xyxy_score_class" | "cxcywh_score_class" | "yolox_coco_raw";
  readonly coremlFlags?: number;
  readonly nmsIouThreshold?: number;
};
```

Add a helper:

```ts
function smokeProvider(config: PicoConfig): "tapo-rtsp+onnxruntime" | "tapo-rtsp+coreml" {
  return config.vision.personDetection.provider === "coreml"
    ? "tapo-rtsp+coreml"
    : "tapo-rtsp+onnxruntime";
}
```

Use `createCoremlPersonDetectionModel` when `provider === "coreml"` and pass `coremlFlags` plus `nmsIouThreshold`; otherwise keep the existing ONNX path.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/person-detection-smoke.test.ts tests/milestone-smoke.test.ts`

Expected: PASS.

## Task 4: Verification and Live Smoke

**Files:**
- No source edits expected.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- tests/config.test.ts tests/person-detection.test.ts tests/person-detection-smoke.test.ts tests/milestone-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full local gate**

Run: `just check`

Expected: PASS.

- [ ] **Step 3: Run live CoreML smoke when local model exists**

Use a temporary config derived from `config/pico.local.yaml` with `vision.personDetection.provider: coreml` and the local pinto0309 ONNX model path. Do not print camera credentials.

Run:

```bash
PICO_CONFIG_PATH=/tmp/pico-coreml-person-detection.local.yaml npm run smoke:person-detection
```

Expected: `status` is `passed` when Tapo and the model are available, or `skipped` only when the model file is missing. The report must not print Tapo credentials.

## Task 5: Polishment, AI Slop Cleanup, and Ready PR

**Files:**
- Changed implementation and tests only.

- [ ] **Step 1: Run independent review**

Use an independent review instance with the diff, repository instructions, and verification evidence. Required verdict: `APPROVE` or `REQUEST_CHANGES`.

- [ ] **Step 2: Run AI slop cleanup**

Scope the cleanup to the changed files. Lock behavior with the focused tests from Task 4. Remove only concrete dead code, duplication, weak names, or missing regression coverage.

- [ ] **Step 3: Re-run verification**

Run:

```bash
npm test -- tests/config.test.ts tests/person-detection.test.ts tests/person-detection-smoke.test.ts tests/milestone-smoke.test.ts
just check
```

Expected: PASS.

- [ ] **Step 4: Commit, push, and open ready PR**

Commit the implementation, push `codex/coreml-person-detection`, and create a ready-for-review PR with implementation scope, verification, independent approval, and AI slop cleanup evidence.

## Self-Review

- Spec coverage: Config provider, CoreML EP session options, no CPU secondary provider, YOLOX raw decode, NMS, smoke support, and local gates all map to tasks above.
- Placeholder scan: No unresolved implementation slots remain.
- Type consistency: Provider names, config field names, output layout names, and smoke provider labels are consistent across tasks.
