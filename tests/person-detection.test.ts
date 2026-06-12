import { describe, expect, it, vi } from "vitest";

import {
  createPersonDetectionStream,
  normalizePersonDetectionFrame,
  type PersonDetectionModel
} from "../src/modules/vision/person-detection.js";

const capturedAt = "2026-06-12T09:00:00.000Z";

describe("streaming person detection", () => {
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
});
