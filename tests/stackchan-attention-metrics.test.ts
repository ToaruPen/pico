import { describe, expect, it } from "vitest";

import {
  type AttentionMetricSample,
  type AttentionQuantizationAxisSample,
  createAttentionMetricsAccumulator,
  summarizeAttentionQuantizationAxis
} from "../scripts/field/stackchan-attention-metrics.js";

function sample(
  sequence: number,
  observedAtMs: number,
  values: Partial<AttentionMetricSample> = {}
): AttentionMetricSample {
  return {
    sequence,
    observedAtMs,
    pose: { yaw: 0, pitch: 35 },
    ...values
  };
}

describe("StackChan attention metrics", () => {
  it("measures completed and censored quantized-zero runs with residual outcomes", () => {
    const samples: AttentionQuantizationAxisSample[] = [
      quantizationSample(0, { rawCorrectionDeg: 0.4, residualAction: "residual-accumulate" }),
      quantizationSample(125, {
        rawCorrectionDeg: 0.4,
        residualAction: "residual-accumulate",
        ticksWithoutConfirmedUpdate: 2
      }),
      quantizationSample(250, {
        rawCorrectionDeg: 0.4,
        quantizedStepDeg: 1,
        residualAction: "residual-release",
        effectOutcome: "replaced",
        ticksWithoutConfirmedUpdate: 3
      }),
      quantizationSample(375, {
        rawCorrectionDeg: -0.4,
        residualAction: "reset-direction-reversal"
      }),
      quantizationSample(500, { active: false, centered: true }),
      quantizationSample(625, {
        boundary: "next",
        rawCorrectionDeg: 0.4,
        residualAction: "residual-accumulate"
      })
    ];

    expect(summarizeAttentionQuantizationAxis(samples)).toEqual({
      zeroRuns: {
        completedCount: 1,
        censoredCount: 2,
        durationMs: { count: 3, p50: 125, p90: 250, p95: 250, max: 250 },
        lengthTicks: { count: 3, p50: 1, p90: 2, p95: 2, max: 2 },
        releaseStepAbsDeg: { count: 1, p50: 1, p90: 1, p95: 1, max: 1 }
      },
      residualReleaseCount: 1,
      residualReleaseOutcomes: {
        dispatched: 0,
        replaced: 1,
        noop: 0,
        stale: 0,
        none: 0
      },
      residualReleaseTicksWithoutConfirmedUpdate: {
        count: 1,
        p50: 3,
        p90: 3,
        p95: 3,
        max: 3
      },
      unDispatchedResidualReleaseCount: 1,
      directionReversalResetCount: 1,
      exactHalfStepHitCount: 0,
      negativeZeroCount: 0
    });
  });

  it("counts exact half steps and negative zero without serializing either as motion", () => {
    const summary = summarizeAttentionQuantizationAxis([
      quantizationSample(0, {
        rawCorrectionDeg: -0.5,
        clampedCorrectionDeg: -0.5,
        legacyRoundedStepDeg: -0,
        quantizedStepDeg: -0,
        residualAction: "round-disabled"
      })
    ]);

    expect(summary.exactHalfStepHitCount).toBe(1);
    expect(summary.negativeZeroCount).toBe(2);
  });

  it("closes a boundary-interrupted zero run at its last sample", () => {
    const summary = summarizeAttentionQuantizationAxis([
      quantizationSample(0, {
        boundary: "first",
        rawCorrectionDeg: 0.4,
        residualAction: "residual-accumulate"
      }),
      quantizationSample(125, {
        boundary: "first",
        rawCorrectionDeg: 0.4,
        residualAction: "residual-accumulate"
      }),
      quantizationSample(10_000, {
        boundary: "second",
        rawCorrectionDeg: 0.4,
        residualAction: "residual-accumulate"
      })
    ]);

    expect(summary.zeroRuns.durationMs).toEqual({
      count: 2,
      p50: 0,
      p90: 125,
      p95: 125,
      max: 125
    });
  });

  it("deduplicates sequences and counts target labels", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 1_000, deadZone: 0.1 });

    expect(
      metrics.record(
        sample(1, 1_100, {
          target: {
            label: "face",
            horizontalError: -4,
            verticalError: 2,
            centered: false
          }
        })
      )
    ).toBe(true);
    expect(
      metrics.record(
        sample(2, 1_200, {
          target: {
            label: "head",
            horizontalError: 2,
            verticalError: -4,
            centered: true
          }
        })
      )
    ).toBe(true);
    expect(
      metrics.record(
        sample(1, 1_250, {
          target: {
            label: "head",
            horizontalError: 2,
            verticalError: -4,
            centered: true
          }
        })
      )
    ).toBe(false);
    expect(
      metrics.record(
        sample(3, 1_300, {
          target: {
            label: "face",
            horizontalError: 1,
            verticalError: -1,
            centered: false
          }
        })
      )
    ).toBe(true);

    expect(metrics.summarize(1_600)).toMatchObject({
      framesProcessed: 3,
      targetFrames: 3,
      faceFrames: 2,
      headFrames: 1,
      firstTargetMs: 100,
      firstCenteredMs: 200
    });
  });

  it("calculates nearest-rank error statistics rounded to three decimals", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 0, deadZone: 0.5 });
    const targets = [
      { label: "face" as const, horizontalError: -3.3333, verticalError: -0.25, centered: false },
      { label: "face" as const, horizontalError: -1.1111, verticalError: 0.25, centered: false },
      { label: "head" as const, horizontalError: 2.2222, verticalError: 4.4444, centered: true },
      { label: "head" as const, horizontalError: 10.9999, verticalError: -8.8888, centered: true }
    ];

    for (const [index, target] of targets.entries()) {
      metrics.record(sample(index + 1, index * 10, { target }));
    }

    expect(metrics.summarize(100)).toMatchObject({
      horizontal: {
        signedP50: -1.111,
        absoluteP50: 2.222,
        absoluteP95: 11
      },
      vertical: {
        signedP50: -0.25,
        absoluteP50: 0.25,
        absoluteP95: 8.889
      }
    });
  });

  it("counts sign flips only across consecutive target observations outside the dead zone", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 0, deadZone: 1 });

    metrics.record(
      sample(1, 0, {
        target: { label: "face", horizontalError: 2, verticalError: -2, centered: false }
      })
    );
    metrics.record(
      sample(2, 10, {
        target: { label: "head", horizontalError: 0.25, verticalError: 0, centered: true }
      })
    );
    metrics.record(
      sample(3, 20, {
        target: { label: "head", horizontalError: -4, verticalError: 2, centered: false }
      })
    );
    metrics.record(sample(4, 30));
    metrics.record(
      sample(5, 40, {
        target: { label: "face", horizontalError: 5, verticalError: -3, centered: false }
      })
    );
    metrics.record(
      sample(6, 50, {
        target: { label: "head", horizontalError: -6, verticalError: 4, centered: false }
      })
    );

    expect(metrics.summarize(50)).toMatchObject({
      horizontal: { signFlips: 1, eligibleSignComparisons: 1 },
      vertical: { signFlips: 1, eligibleSignComparisons: 1 }
    });
  });

  it("counts positive and negative target errors outside the dead zone after deduplication", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 0, deadZone: 1 });
    const targets = [
      { horizontalError: 2, verticalError: -2 },
      { horizontalError: -3, verticalError: 3 },
      { horizontalError: 1, verticalError: -1 },
      { horizontalError: 0, verticalError: 0 }
    ];

    for (const [index, target] of targets.entries()) {
      metrics.record(
        sample(index + 1, index * 10, {
          target: {
            label: "face",
            ...target,
            centered: false
          }
        })
      );
    }
    metrics.record(
      sample(1, 50, {
        target: {
          label: "head",
          horizontalError: 10,
          verticalError: -10,
          centered: false
        }
      })
    );
    metrics.record(sample(5, 60));

    expect(metrics.summarize(60)).toMatchObject({
      framesProcessed: 5,
      targetFrames: 4,
      horizontal: {
        positiveOutsideFrames: 1,
        negativeOutsideFrames: 1
      },
      vertical: {
        positiveOutsideFrames: 1,
        negativeOutsideFrames: 1
      }
    });
  });

  it("measures initial, intermediate, and final target-loss gaps", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 100, deadZone: 0.1 });

    metrics.record(sample(1, 150, { target: centeredFace() }));
    metrics.record(sample(2, 200));
    metrics.record(sample(3, 220));
    metrics.record(sample(4, 300, { target: centeredFace() }));
    metrics.record(sample(5, 390));

    expect(metrics.summarize(500)).toMatchObject({
      firstTargetMs: 50,
      firstCenteredMs: 50,
      maximumLostGapMs: 110
    });
  });

  it("measures the run end after the final target as a lost gap", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 0, deadZone: 0.1 });

    metrics.record(sample(1, 0, { target: centeredFace() }));

    expect(metrics.summarize(6_000).maximumLostGapMs).toBe(6_000);
  });

  it("treats an all-lost run as one gap through the end of the run", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 100, deadZone: 0.1 });

    metrics.record(sample(1, 150));
    metrics.record(sample(2, 300));

    expect(metrics.summarize(450)).toMatchObject({
      targetFrames: 0,
      firstTargetMs: undefined,
      firstCenteredMs: undefined,
      maximumLostGapMs: 350
    });
    expect(JSON.stringify(metrics.summarize(450))).not.toMatch(/firstTargetMs|firstCenteredMs/);
  });

  it("uses only the five-to-twenty-five-second evaluation window", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 1_000, deadZone: 0.1 });

    metrics.record(sample(1, 5_999, { target: centeredFace(false) }));
    metrics.record(sample(2, 6_000, { target: centeredFace(false) }));
    metrics.record(sample(3, 25_000, { target: centeredFace() }));
    metrics.record(sample(4, 26_000, { target: centeredFace() }));

    expect(metrics.summarize(26_500).evaluationWindow).toEqual({
      targetFrames: 2,
      centeredFrames: 1,
      centeredRatio: 0.5
    });
  });

  it("counts target frames observed within one degree of a servo limit", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 0, deadZone: 0.1 });
    const poses = [
      { yaw: 89, pitch: 35 },
      { yaw: -89, pitch: 35 },
      { yaw: 0, pitch: 4 },
      { yaw: 0, pitch: 86 },
      { yaw: 88, pitch: 35 },
      { yaw: 0, pitch: 3 }
    ];

    for (const [index, pose] of poses.entries()) {
      metrics.record(sample(index + 1, index, { pose, target: centeredFace() }));
    }

    expect(metrics.summarize(10).servoLimitFrames).toBe(4);
  });

  it("serializes only aggregate attention metrics", () => {
    const metrics = createAttentionMetricsAccumulator({ runStartedAtMs: 10, deadZone: 0.1 });

    metrics.record(
      sample(1, 20, {
        pose: { yaw: 89, pitch: 84 },
        target: {
          label: "face",
          horizontalError: 1.2345,
          verticalError: -2.3456,
          centered: true
        }
      })
    );
    const report = JSON.parse(JSON.stringify(metrics.summarize(30))) as Record<string, unknown>;

    expect(report).toEqual({
      framesProcessed: 1,
      targetFrames: 1,
      faceFrames: 1,
      headFrames: 0,
      firstTargetMs: 10,
      firstCenteredMs: 10,
      maximumLostGapMs: 10,
      evaluationWindow: { targetFrames: 0, centeredFrames: 0, centeredRatio: 0 },
      horizontal: {
        signedP50: 1.235,
        absoluteP50: 1.235,
        absoluteP95: 1.235,
        signFlips: 0,
        eligibleSignComparisons: 0,
        positiveOutsideFrames: 1,
        negativeOutsideFrames: 0
      },
      vertical: {
        signedP50: -2.346,
        absoluteP50: 2.346,
        absoluteP95: 2.346,
        signFlips: 0,
        eligibleSignComparisons: 0,
        positiveOutsideFrames: 0,
        negativeOutsideFrames: 1
      },
      servoLimitFrames: 1
    });
    expect(JSON.stringify(report)).not.toMatch(/pose|jpeg|bbox|confidence|observedAtMs/i);
  });
});

function quantizationSample(
  timestampMs: number,
  overrides: Partial<AttentionQuantizationAxisSample> = {}
): AttentionQuantizationAxisSample {
  return {
    timestampMs,
    boundary: "base",
    active: true,
    centered: false,
    rawCorrectionDeg: 0,
    clampedCorrectionDeg: 0,
    legacyRoundedStepDeg: 0,
    quantizedStepDeg: 0,
    residualAction: "reset-zero-correction",
    effectOutcome: "none",
    ticksWithoutConfirmedUpdate: 1,
    ...overrides
  };
}

function centeredFace(centered = true) {
  return {
    label: "face" as const,
    horizontalError: 0,
    verticalError: 0,
    centered
  };
}
