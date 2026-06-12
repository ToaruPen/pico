import { describe, expect, it, vi } from "vitest";

import {
  createOnnxPersonDetectionModel,
  createPersonDetectionStream,
  createSharpRgbTensorPreprocessor,
  normalizePersonDetectionFrame,
  type OnnxPersonDetectionRuntime,
  type PersonDetectionModel,
  type SharpRgbTensorRuntime
} from "../src/modules/vision/person-detection.js";

const capturedAt = "2026-06-12T09:00:00.000Z";

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
});
