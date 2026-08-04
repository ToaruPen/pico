import { describe, expect, it } from "vitest";

import {
  type AttentionOnnxRuntime,
  type AttentionSharpRuntime,
  createPintoAttentionDetectionModel,
  createSharpBgrTensorPreprocessor,
  parsePintoAttentionDetections,
  selectAttentionTarget
} from "../src/modules/vision/attention-detection.js";

describe("PINTO head and face attention detection", () => {
  it("parses postprocessed PINTO head and face rows while filtering body and hand classes", () => {
    const detections = parsePintoAttentionDetections(
      Float32Array.of(
        0,
        1,
        0.8,
        32,
        24,
        160,
        200,
        0,
        3,
        0.75,
        60,
        50,
        120,
        130,
        0,
        0,
        0.99,
        0,
        0,
        320,
        256,
        0,
        2,
        0.99,
        10,
        10,
        20,
        20
      ),
      [4, 7],
      {
        inputWidth: 320,
        inputHeight: 256,
        headConfidenceThreshold: 0.35,
        faceConfidenceThreshold: 0.4
      }
    );

    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({
      label: "head",
      boundingBox: {
        xMin: 0.1,
        yMin: 0.09375,
        xMax: 0.5,
        yMax: 0.78125
      }
    });
    expect(detections[0]?.confidence).toBeCloseTo(0.8, 5);
    expect(detections[1]?.label).toBe("face");
    expect(detections[1]?.confidence).toBeCloseTo(0.75, 5);
  });

  it("applies per-label thresholds, clamps coordinates, and drops zero-area rows", () => {
    const detections = parsePintoAttentionDetections(
      Float32Array.of(
        0,
        1,
        0.34,
        10,
        10,
        100,
        100,
        0,
        3,
        0.39,
        10,
        10,
        100,
        100,
        0,
        1,
        0.9,
        -50,
        -20,
        400,
        300,
        0,
        3,
        0.9,
        20,
        20,
        20,
        40
      ),
      [1, 4, 7],
      {
        inputWidth: 320,
        inputHeight: 256,
        headConfidenceThreshold: 0.35,
        faceConfidenceThreshold: 0.4
      }
    );

    expect(detections).toMatchObject([
      {
        label: "head",
        boundingBox: {
          xMin: 0,
          yMin: 0,
          xMax: 1,
          yMax: 1
        }
      }
    ]);
    expect(detections[0]?.confidence).toBeCloseTo(0.9, 5);
  });

  it("rejects malformed output dimensions", () => {
    const options = {
      inputWidth: 320,
      inputHeight: 256,
      headConfidenceThreshold: 0.35,
      faceConfidenceThreshold: 0.4
    };

    expect(() =>
      parsePintoAttentionDetections(Float32Array.of(0, 1, 0.8), [1, 3], options)
    ).toThrow("PINTO attention output must end in rows of seven values");
    expect(() =>
      parsePintoAttentionDetections(Float32Array.of(0, 1, 0.8, 0, 0, 1, 1), [2, 7], options)
    ).toThrow("PINTO attention output dimensions do not match its data");
  });

  it("selects a face before a head", () => {
    const target = selectAttentionTarget([
      {
        label: "head",
        confidence: 0.99,
        boundingBox: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 }
      },
      {
        label: "face",
        confidence: 0.9,
        boundingBox: { xMin: 0.1, yMin: 0.1, xMax: 0.2, yMax: 0.2 }
      },
      {
        label: "face",
        confidence: 0.7,
        boundingBox: { xMin: 0.4, yMin: 0.2, xMax: 0.8, yMax: 0.8 }
      }
    ]);

    expect(target).toEqual({
      label: "face",
      confidence: 0.7,
      boundingBox: { xMin: 0.4, yMin: 0.2, xMax: 0.8, yMax: 0.8 }
    });
    expect(selectAttentionTarget([])).toBeUndefined();
  });

  it("ranks same-label targets by confidence times the square root of normalized area", () => {
    const expected = {
      label: "face" as const,
      confidence: 0.9,
      boundingBox: { xMin: 0.1, yMin: 0.1, xMax: 0.4, yMax: 0.4 }
    };
    const target = selectAttentionTarget([
      expected,
      {
        label: "face",
        confidence: 0.4,
        boundingBox: { xMin: 0.2, yMin: 0.2, xMax: 0.8, yMax: 0.8 }
      }
    ]);

    expect(target).toBe(expected);
  });

  it("keeps the first same-label target when ranks tie", () => {
    const first = {
      label: "face" as const,
      confidence: 0.6,
      boundingBox: { xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 }
    };
    const second = {
      label: "face" as const,
      confidence: 0.3,
      boundingBox: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 }
    };

    expect(selectAttentionTarget([first, second])).toBe(first);
  });

  it("preprocesses RGB pixels as unnormalized NCHW BGR and runs one reused session", async () => {
    const operations: string[] = [];
    const sharpRuntime: AttentionSharpRuntime = () => ({
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
          data: Uint8Array.of(10, 20, 30),
          info: { width: 1, height: 1, channels: 3 }
        });
      }
    });
    const createdModels: string[] = [];
    const tensors: Array<{
      readonly type: string;
      readonly data: Float32Array;
      readonly dims: readonly number[];
    }> = [];
    const onnxRuntime: AttentionOnnxRuntime = {
      Tensor: class {
        constructor(
          readonly type: "float32",
          readonly data: Float32Array,
          readonly dims: readonly number[]
        ) {
          tensors.push({ type, data, dims });
        }
      },
      InferenceSession: {
        create(modelPath) {
          createdModels.push(modelPath);
          return Promise.resolve({
            inputNames: ["images"],
            outputNames: ["output"],
            run() {
              return Promise.resolve({
                output: {
                  data: Float32Array.of(0, 3, 0.9, 0, 0, 1, 1),
                  dims: [1, 7]
                }
              });
            }
          });
        }
      }
    };
    const preprocess = createSharpBgrTensorPreprocessor({
      inputWidth: 1,
      inputHeight: 1,
      runtime: sharpRuntime
    });
    const model = await createPintoAttentionDetectionModel({
      modelPath: "/opt/pico/models/pinto-attention.onnx",
      inputWidth: 1,
      inputHeight: 1,
      headConfidenceThreshold: 0.35,
      faceConfidenceThreshold: 0.4,
      runtime: onnxRuntime,
      preprocess
    });

    const firstDetections = await model.detect(Uint8Array.of(1));
    expect(firstDetections).toMatchObject([
      {
        label: "face",
        boundingBox: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 }
      }
    ]);
    expect(firstDetections[0]?.confidence).toBeCloseTo(0.9, 5);
    await model.detect(Uint8Array.of(2));
    expect(createdModels).toEqual(["/opt/pico/models/pinto-attention.onnx"]);
    expect(tensors[0]).toEqual({
      type: "float32",
      data: Float32Array.of(30, 20, 10),
      dims: [1, 3, 1, 1]
    });
    expect(operations).toEqual([
      "rotate",
      "resize:1x1",
      "removeAlpha",
      "raw",
      "rotate",
      "resize:1x1",
      "removeAlpha",
      "raw"
    ]);
  });
});
