import { describe, expect, it, vi } from "vitest";

import {
  createCoremlPersonDetectionModel,
  createOnnxPersonDetectionModel,
  createPersonDetectionStream,
  createSharpRgbTensorPreprocessor,
  normalizePersonDetectionFrame,
  type OnnxPersonDetectionRuntime,
  type PersonDetectionModel,
  type SharpRgbTensorRuntime
} from "../src/modules/vision/person-detection.js";

const capturedAt = "2026-06-12T09:00:00.000Z";

function createOneOutputRuntime(
  data: Float32Array,
  dims: readonly number[]
): OnnxPersonDetectionRuntime {
  return {
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: readonly number[]
      ) {}
    },
    InferenceSession: {
      create() {
        return Promise.resolve({
          inputNames: ["images"],
          outputNames: ["output"],
          run() {
            return Promise.resolve({
              output: { data, dims }
            });
          }
        });
      }
    }
  };
}

function yoloxCocoRow(input: {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly objectness: number;
  readonly personScore: number;
  readonly bicycleScore?: number;
}): readonly number[] {
  const classScores = Array.from({ length: 80 }, () => 0);
  classScores[0] = input.personScore;
  classScores[1] = input.bicycleScore ?? 0;

  return [
    input.centerX,
    input.centerY,
    input.width,
    input.height,
    input.objectness,
    ...classScores
  ];
}

describe("streaming person detection", () => {
  it("preprocesses image frames into NCHW RGB float tensors", async () => {
    const operations: string[] = [];
    const runtime: SharpRgbTensorRuntime = () => ({
      rotate() {
        operations.push("rotate");

        return this;
      },
      resize(options) {
        operations.push(`resize:${options.width}x${options.height}`);

        return this;
      },
      removeAlpha() {
        operations.push("removeAlpha");

        return this;
      },
      raw() {
        operations.push("raw");

        return this;
      },
      toBuffer() {
        return Promise.resolve({
          data: Buffer.from([0, 127, 255, 255, 0, 127]),
          info: {
            width: 2,
            height: 1,
            channels: 3
          }
        });
      }
    });
    const preprocessFrame = createSharpRgbTensorPreprocessor({
      inputWidth: 2,
      inputHeight: 1,
      runtime
    });

    const tensor = await preprocessFrame(Buffer.from("jpeg-frame"));

    expect(tensor.dims).toEqual([1, 3, 1, 2]);
    expect(Array.from(tensor.data)).toEqual(
      Array.from(Float32Array.of(0, 1, 127 / 255, 0, 1, 127 / 255))
    );
    expect(operations).toEqual(["rotate", "resize:2x1", "removeAlpha", "raw"]);
  });

  it("runs an ONNX Runtime person model and maps xyxy rows to detections", async () => {
    const createdModels: string[] = [];
    const createdTensors: unknown[] = [];
    const runtime: OnnxPersonDetectionRuntime = {
      Tensor: class {
        readonly type: string;
        readonly data: Float32Array;
        readonly dims: readonly number[];

        constructor(type: string, data: Float32Array, dims: readonly number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
          createdTensors.push({ type, data, dims });
        }
      },
      InferenceSession: {
        create(modelPath) {
          createdModels.push(modelPath);

          return Promise.resolve({
            inputNames: ["images"],
            outputNames: ["detections"],
            run(feeds) {
              expect(Object.keys(feeds)).toEqual(["images"]);

              return Promise.resolve({
                detections: {
                  data: Float32Array.of(10, 20, 50, 80, 0.9, 0, 1, 2, 3, 4, 0.95, 2),
                  dims: [2, 6]
                }
              });
            }
          });
        }
      }
    };

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/person.onnx",
      frameSize: {
        width: 100,
        height: 100
      },
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0, 1, 2),
          dims: [1, 3, 1, 1]
        })
    });

    await expect(model.detect(Buffer.from("frame"))).resolves.toEqual([
      {
        label: "person",
        confidence: 0.9,
        box: {
          x: 10,
          y: 20,
          width: 40,
          height: 60
        }
      }
    ]);
    expect(createdModels).toEqual(["/opt/pico/models/pinto0309/person.onnx"]);
    expect(createdTensors).toHaveLength(1);
  });

  it("maps normalized center-size ONNX output rows to pixel boxes", async () => {
    const runtime: OnnxPersonDetectionRuntime = {
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[]
        ) {}
      },
      InferenceSession: {
        create() {
          return Promise.resolve({
            inputNames: ["input"],
            outputNames: ["output"],
            run() {
              return Promise.resolve({
                output: {
                  data: Float32Array.of(0.5, 0.5, 0.25, 0.5, 0.7, 0),
                  dims: [1, 1, 6]
                }
              });
            }
          });
        }
      }
    };

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/person.onnx",
      frameSize: {
        width: 640,
        height: 480
      },
      outputLayout: "cxcywh_score_class",
      coordinateScale: "normalized",
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 1, 1]
        })
    });

    await expect(model.detect(Buffer.from("frame"))).resolves.toEqual([
      {
        label: "person",
        confidence: 0.7,
        box: {
          x: 240,
          y: 120,
          width: 160,
          height: 240
        }
      }
    ]);
  });

  it("rejects malformed ONNX person output rows", async () => {
    const runtime: OnnxPersonDetectionRuntime = {
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: readonly number[]
        ) {}
      },
      InferenceSession: {
        create() {
          return Promise.resolve({
            inputNames: ["input"],
            outputNames: ["output"],
            run() {
              return Promise.resolve({
                output: {
                  data: Float32Array.of(1, 2, 3, 4, 0.9),
                  dims: [1, 5]
                }
              });
            }
          });
        }
      }
    };

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/person.onnx",
      frameSize: {
        width: 640,
        height: 480
      },
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 1, 1]
        })
    });

    await expect(model.detect(Buffer.from("frame"))).rejects.toThrow(
      "pico person detection ONNX output row must contain at least 6 values"
    );
  });

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
                  data: Float32Array.from(
                    yoloxCocoRow({
                      centerX: 160,
                      centerY: 120,
                      width: 80,
                      height: 100,
                      objectness: 0.9,
                      personScore: 0.8
                    })
                  ),
                  dims: [1, 1, 85]
                }
              });
            }
          });
        }
      }
    };

    const model = await createCoremlPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      frameSize: {
        width: 320,
        height: 240
      },
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 320, 320]
        }),
      coremlFlags: 18,
      confidenceThreshold: 0.5
    });

    await model.detect(Buffer.from("frame"));

    expect(createCalls).toEqual([
      {
        modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
        options: {
          executionProviders: [
            {
              name: "coreml",
              coreMlFlags: 18
            }
          ]
        }
      }
    ]);
  });

  it("decodes raw YOLOX COCO output and suppresses duplicate person boxes", async () => {
    const runtime = createOneOutputRuntime(
      Float32Array.from([
        ...yoloxCocoRow({
          centerX: 160,
          centerY: 120,
          width: 80,
          height: 100,
          objectness: 0.9,
          personScore: 0.8
        }),
        ...yoloxCocoRow({
          centerX: 162,
          centerY: 122,
          width: 82,
          height: 102,
          objectness: 0.88,
          personScore: 0.76
        }),
        ...yoloxCocoRow({
          centerX: 40,
          centerY: 40,
          width: 20,
          height: 20,
          objectness: 0.95,
          personScore: 0.2,
          bicycleScore: 0.7
        })
      ]),
      [1, 3, 85]
    );

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      frameSize: {
        width: 320,
        height: 240
      },
      outputLayout: "yolox_coco_raw",
      coordinateScale: "pixel",
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 320, 320]
        }),
      confidenceThreshold: 0.5,
      nmsIouThreshold: 0.45
    });

    await expect(model.detect(Buffer.from("frame"))).resolves.toEqual([
      {
        label: "person",
        confidence: 0.72,
        box: {
          x: 120,
          y: 70,
          width: 80,
          height: 100
        }
      }
    ]);
  });

  it("clamps raw YOLOX COCO boxes to the frame", async () => {
    const runtime = createOneOutputRuntime(
      Float32Array.from(
        yoloxCocoRow({
          centerX: 10,
          centerY: 230,
          width: 40,
          height: 40,
          objectness: 0.9,
          personScore: 0.8
        })
      ),
      [1, 1, 85]
    );

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      frameSize: {
        width: 320,
        height: 240
      },
      outputLayout: "yolox_coco_raw",
      coordinateScale: "pixel",
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 320, 320]
        }),
      confidenceThreshold: 0.5
    });

    await expect(model.detect(Buffer.from("frame"))).resolves.toEqual([
      {
        label: "person",
        confidence: 0.72,
        box: {
          x: 0,
          y: 210,
          width: 30,
          height: 30
        }
      }
    ]);
  });

  it("identifies malformed YOLOX objectness scores", async () => {
    const runtime = createOneOutputRuntime(
      Float32Array.from(
        yoloxCocoRow({
          centerX: 160,
          centerY: 120,
          width: 80,
          height: 100,
          objectness: 1.1,
          personScore: 0.8
        })
      ),
      [1, 1, 85]
    );

    const model = await createOnnxPersonDetectionModel({
      modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
      frameSize: {
        width: 320,
        height: 240
      },
      outputLayout: "yolox_coco_raw",
      runtime,
      preprocessFrame: () =>
        Promise.resolve({
          data: Float32Array.of(0),
          dims: [1, 3, 320, 320]
        })
    });

    await expect(model.detect(Buffer.from("frame"))).rejects.toThrow(
      "pico person detection YOLOX objectness must be >= 0 and <= 1"
    );
  });

  it("normalizes person boxes and filters by confidence threshold", () => {
    expect(
      normalizePersonDetectionFrame({
        sourceId: "tapo-main",
        capturedAt,
        frameSize: {
          width: 640,
          height: 480
        },
        confidenceThreshold: 0.55,
        detections: [
          {
            label: "person",
            confidence: 0.9,
            box: {
              x: 64,
              y: 48,
              width: 320,
              height: 240
            }
          },
          {
            label: "person",
            confidence: 0.54,
            box: {
              x: 10,
              y: 10,
              width: 20,
              height: 20
            }
          },
          {
            label: "chair",
            confidence: 0.99,
            box: {
              x: 0,
              y: 0,
              width: 100,
              height: 100
            }
          }
        ]
      })
    ).toEqual({
      sourceId: "tapo-main",
      capturedAt,
      detections: [
        {
          label: "person",
          confidence: 0.9,
          boundingBox: {
            xMin: 0.1,
            yMin: 0.1,
            xMax: 0.6,
            yMax: 0.6
          }
        }
      ]
    });
  });

  it("rejects identity labels before publishing detections", () => {
    expect(() =>
      normalizePersonDetectionFrame({
        sourceId: "tapo-main",
        capturedAt,
        frameSize: {
          width: 640,
          height: 480
        },
        confidenceThreshold: 0.5,
        detections: [
          {
            label: "person:child-a",
            confidence: 0.95,
            box: {
              x: 0,
              y: 0,
              width: 100,
              height: 100
            }
          }
        ]
      })
    ).toThrow("pico person detection must not include identity labels");
  });

  it("runs low-FPS detection without overlapping model calls", async () => {
    vi.useFakeTimers();
    const frames = [Buffer.from("frame-a"), Buffer.from("frame-b")];
    const processedFrames: Uint8Array[] = [];
    let releaseDetection: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDetection = resolve;
    });
    const model: PersonDetectionModel = {
      async detect(frame) {
        processedFrames.push(frame);
        await gate;

        return [
          {
            label: "person",
            confidence: 0.9,
            box: {
              x: 0,
              y: 0,
              width: 100,
              height: 100
            }
          }
        ];
      }
    };
    const published: unknown[] = [];
    const stream = createPersonDetectionStream({
      sourceId: "tapo-main",
      frameIntervalMs: 500,
      confidenceThreshold: 0.5,
      frameSize: {
        width: 200,
        height: 200
      },
      captureFrame: () => Promise.resolve(frames.shift()),
      model,
      publish: (frame) => {
        published.push(frame);
      },
      now: () => capturedAt
    });

    try {
      stream.start();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      expect(processedFrames).toHaveLength(1);

      releaseDetection?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(published).toHaveLength(1);
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });

  it("reports stream errors without publishing a detection frame", async () => {
    vi.useFakeTimers();
    const failure = new Error("detector unavailable");
    const reported: Error[] = [];
    const published: unknown[] = [];
    const stream = createPersonDetectionStream({
      sourceId: "tapo-main",
      frameIntervalMs: 500,
      confidenceThreshold: 0.5,
      frameSize: {
        width: 200,
        height: 200
      },
      captureFrame: () => Promise.resolve(Buffer.from("frame-a")),
      model: {
        detect: () => Promise.reject(failure)
      },
      publish: (frame) => {
        published.push(frame);
      },
      reportError: (error) => {
        reported.push(error);
      },
      now: () => capturedAt
    });

    try {
      stream.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(reported).toEqual([failure]);
      expect(published).toEqual([]);
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });

  it("does not publish an in-flight detection after the stream stops", async () => {
    vi.useFakeTimers();
    let releaseDetection: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDetection = resolve;
    });
    const published: unknown[] = [];
    const stream = createPersonDetectionStream({
      sourceId: "tapo-main",
      frameIntervalMs: 500,
      confidenceThreshold: 0.5,
      frameSize: {
        width: 200,
        height: 200
      },
      captureFrame: () => Promise.resolve(Buffer.from("frame-a")),
      model: {
        async detect() {
          await gate;

          return [
            {
              label: "person",
              confidence: 0.9,
              box: {
                x: 0,
                y: 0,
                width: 100,
                height: 100
              }
            }
          ];
        }
      },
      publish: (frame) => {
        published.push(frame);
      },
      now: () => capturedAt
    });

    try {
      stream.start();
      await vi.advanceTimersByTimeAsync(500);
      stream.stop();
      releaseDetection?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(published).toEqual([]);
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });

  it("does not publish a detection captured before a stop and restart", async () => {
    vi.useFakeTimers();
    let releaseFirstDetection: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstDetection = resolve;
    });
    const published: unknown[] = [];
    let detectionCalls = 0;
    const stream = createPersonDetectionStream({
      sourceId: "tapo-main",
      frameIntervalMs: 500,
      confidenceThreshold: 0.5,
      frameSize: {
        width: 200,
        height: 200
      },
      captureFrame: () => Promise.resolve(Buffer.from("frame")),
      model: {
        async detect() {
          detectionCalls += 1;

          if (detectionCalls === 1) {
            await firstGate;
          }

          return [
            {
              label: "person",
              confidence: 0.9,
              box: {
                x: 0,
                y: 0,
                width: 100,
                height: 100
              }
            }
          ];
        }
      },
      publish: (frame) => {
        published.push(frame);
      },
      now: () => capturedAt
    });

    try {
      stream.start();
      await vi.advanceTimersByTimeAsync(500);
      stream.stop();
      stream.start();

      releaseFirstDetection?.();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);

      expect(published).toHaveLength(1);
      expect(detectionCalls).toBe(2);
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });

  it("timestamps a published detection at frame capture time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));
    const published: Array<{ readonly capturedAt: string }> = [];
    const stream = createPersonDetectionStream({
      sourceId: "tapo-main",
      frameIntervalMs: 500,
      confidenceThreshold: 0.5,
      frameSize: {
        width: 200,
        height: 200
      },
      captureFrame: () => Promise.resolve(Buffer.from("frame")),
      model: {
        detect() {
          vi.setSystemTime(new Date("2026-06-12T09:00:05.000Z"));

          return Promise.resolve([
            {
              label: "person",
              confidence: 0.9,
              box: {
                x: 0,
                y: 0,
                width: 100,
                height: 100
              }
            }
          ]);
        }
      },
      publish: (frame) => {
        published.push(frame);
      },
      now: () => new Date(Date.now()).toISOString()
    });

    try {
      stream.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(published).toMatchObject([
        {
          capturedAt: "2026-06-12T09:00:00.500Z"
        }
      ]);
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });
});
