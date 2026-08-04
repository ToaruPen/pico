import { describe, expect, it } from "vitest";

import {
  type CenteringEvaluationInput,
  evaluateCenteringCandidate
} from "../scripts/field/stackchan-centering-evaluation.js";

type Diagnostics = CenteringEvaluationInput["diagnostics"];
type AxisDiagnostics = Diagnostics["horizontal"];

describe("StackChan centering evaluation", () => {
  it("accepts only a candidate that satisfies every acceptance condition", () => {
    expect(evaluateCenteringCandidate(input())).toEqual({
      accepted: true,
      reasons: [],
      classification: "accepted"
    });
  });

  it.each([
    {
      name: "NaN axis statistic",
      candidate: input({
        diagnostics: diagnostics(5_000, { horizontal: axis({ signedP50: Number.NaN }) })
      })
    },
    {
      name: "infinite duration",
      candidate: input({
        diagnostics: diagnostics(5_000, { maximumLostGapMs: Number.POSITIVE_INFINITY })
      })
    },
    {
      name: "negative count",
      candidate: input({ errors: -1 })
    },
    {
      name: "fractional count",
      candidate: input({ targetFrames: 20.5 })
    },
    {
      name: "unsafe integer count",
      candidate: input({ targetFrames: Number.MAX_SAFE_INTEGER + 1 })
    },
    {
      name: "centered count above window target count",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 21, centeredRatio: 1 }
        })
      })
    },
    {
      name: "window target count above total target count",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 21, centeredFrames: 15, centeredRatio: 0.714 }
        })
      })
    },
    {
      name: "servo count above target count",
      candidate: input({
        diagnostics: diagnostics(5_000, { servoLimitFrames: 21 })
      })
    },
    {
      name: "outside counts above target count",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          horizontal: axis({ positiveOutsideFrames: 11, negativeOutsideFrames: 10 })
        })
      })
    },
    {
      name: "sign flips above eligible comparisons",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          horizontal: axis({ signFlips: 2, eligibleSignComparisons: 1 })
        })
      })
    },
    ...[
      {
        name: "no outside frames with an eligible comparison",
        axis: axis({ eligibleSignComparisons: 1 })
      },
      {
        name: "one-sided outside frames with too many eligible comparisons",
        axis: axis({ positiveOutsideFrames: 2, eligibleSignComparisons: 2 })
      },
      {
        name: "one-to-one outside frames with too many eligible comparisons",
        axis: axis({
          positiveOutsideFrames: 1,
          negativeOutsideFrames: 1,
          eligibleSignComparisons: 2,
          signFlips: 1
        })
      },
      {
        name: "two-to-one outside frames with too many eligible comparisons",
        axis: axis({
          positiveOutsideFrames: 2,
          negativeOutsideFrames: 1,
          eligibleSignComparisons: 3,
          signFlips: 2
        })
      },
      {
        name: "more flips than a one-sided minority permits",
        axis: axis({
          positiveOutsideFrames: 4,
          negativeOutsideFrames: 1,
          eligibleSignComparisons: 4,
          signFlips: 3
        })
      },
      {
        name: "impossibly many comparisons and flips for one-to-one outside frames",
        axis: axis({
          positiveOutsideFrames: 1,
          negativeOutsideFrames: 1,
          eligibleSignComparisons: 100,
          signFlips: 25
        })
      }
    ].map(({ name, axis: invalidAxis }) => ({
      name,
      candidate: input({ diagnostics: diagnostics(5_000, { horizontal: invalidAxis }) })
    })),
    {
      name: "ratio outside zero to one",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 20, centeredRatio: 1.001 }
        })
      })
    },
    {
      name: "ratio inconsistent with counts",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 13, centeredRatio: 0.7 }
        })
      })
    },
    {
      name: "negative first centered time",
      candidate: input({ diagnostics: diagnostics(-1) })
    },
    {
      name: "negative absolute statistic",
      candidate: input({
        diagnostics: diagnostics(5_000, { horizontal: axis({ absoluteP50: -0.1 }) })
      })
    },
    {
      name: "absolute p50 above absolute p95",
      candidate: input({
        diagnostics: diagnostics(5_000, {
          horizontal: axis({ absoluteP50: 0.2, absoluteP95: 0.1 })
        })
      })
    },
    {
      name: "infinite fixed-pose statistic",
      candidate: input({
        fixedPose: {
          horizontal: fixedAxis({ signedP50: Number.NEGATIVE_INFINITY }),
          vertical: fixedAxis()
        }
      })
    },
    {
      name: "negative fixed-pose absolute statistic",
      candidate: input({
        fixedPose: {
          horizontal: fixedAxis({ absoluteP50: -0.1 }),
          vertical: fixedAxis()
        }
      })
    },
    {
      name: "fixed-pose absolute p50 above p95",
      candidate: input({
        fixedPose: {
          horizontal: fixedAxis({ absoluteP50: 0.2, absoluteP95: 0.1 }),
          vertical: fixedAxis()
        }
      })
    }
  ])("fails closed for invalid aggregate metrics: $name", ({ candidate }) => {
    expect(evaluateCenteringCandidate(candidate)).toEqual({
      accepted: false,
      reasons: ["invalid-metrics"],
      classification: "unclassified"
    });
  });

  it.each([
    {
      name: "insufficient target frames",
      override: {
        targetFrames: 19,
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 19, centeredFrames: 14, centeredRatio: 0.737 }
        })
      },
      reason: "insufficient-target-frames",
      classification: "insufficient-target"
    },
    {
      name: "missing first centered time",
      override: { diagnostics: diagnostics(undefined) },
      reason: "first-centered-missing",
      classification: "unclassified"
    },
    {
      name: "late first centered time",
      override: { diagnostics: diagnostics(5_001) },
      reason: "first-centered-late",
      classification: "unclassified"
    },
    {
      name: "low evaluation-window centered ratio",
      override: {
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 13, centeredRatio: 0.65 }
        })
      },
      reason: "evaluation-window-centered-ratio-low",
      classification: "unclassified"
    },
    {
      name: "lost gap at the limit",
      override: { diagnostics: diagnostics(5_000, { maximumLostGapMs: 2_000 }) },
      reason: "maximum-lost-gap-too-long",
      classification: "unclassified"
    },
    {
      name: "runtime error",
      override: { errors: 1 },
      reason: "runtime-errors",
      classification: "unclassified"
    },
    {
      name: "home not returned",
      override: { returnedHome: false },
      reason: "home-not-returned",
      classification: "unclassified"
    }
  ])("rejects a candidate with $name", ({ override, reason, classification }) => {
    expect(evaluateCenteringCandidate(input(override))).toEqual({
      accepted: false,
      reasons: [reason],
      classification
    });
  });

  it("returns all acceptance reasons in deterministic contract order", () => {
    const result = evaluateCenteringCandidate(
      input({
        targetFrames: 19,
        errors: 1,
        returnedHome: false,
        diagnostics: diagnostics(undefined, {
          maximumLostGapMs: 2_000,
          evaluationWindow: { targetFrames: 10, centeredFrames: 2, centeredRatio: 0.2 }
        })
      })
    );

    expect(result.reasons).toEqual([
      "insufficient-target-frames",
      "first-centered-missing",
      "evaluation-window-centered-ratio-low",
      "maximum-lost-gap-too-long",
      "runtime-errors",
      "home-not-returned"
    ]);
  });

  it("classifies insufficient target frames before every diagnostic cause", () => {
    const result = evaluateCenteringCandidate(
      input({
        targetFrames: 19,
        diagnostics: diagnostics(undefined, {
          evaluationWindow: { targetFrames: 19, centeredFrames: 0, centeredRatio: 0 },
          horizontal: oscillatingAxis(),
          servoLimitFrames: 1
        }),
        fixedPose: biasedFixedPose()
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      classification: "insufficient-target"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("keeps insufficient-target precedence when runtime safety also fails", () => {
    const result = evaluateCenteringCandidate(
      input({
        targetFrames: 19,
        errors: 1,
        diagnostics: diagnostics(5_000, {
          evaluationWindow: { targetFrames: 19, centeredFrames: 14, centeredRatio: 0.737 },
          horizontal: oscillatingAxis()
        })
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      reasons: ["insufficient-target-frames", "runtime-errors"],
      classification: "insufficient-target"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("classifies invalid geometry before oscillation and position bias", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(undefined, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 0, centeredRatio: 0 },
          horizontal: oscillatingAxis(),
          servoLimitFrames: 1
        }),
        fixedPose: biasedFixedPose()
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      classification: "invalid-geometry"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it.each([
    {
      name: "runtime errors",
      input: input({
        errors: 1,
        diagnostics: diagnostics(5_000, { horizontal: oscillatingAxis() })
      }),
      reasons: ["runtime-errors"]
    },
    {
      name: "home return failure",
      input: input({
        returnedHome: false,
        diagnostics: diagnostics(5_001, {
          horizontal: axis({
            absoluteP95: 0.2,
            positiveOutsideFrames: 7,
            negativeOutsideFrames: 3
          })
        })
      }),
      reasons: ["first-centered-late", "home-not-returned"]
    }
  ])("suppresses controller candidates when $name is present", ({ input: candidate, reasons }) => {
    const result = evaluateCenteringCandidate(candidate);

    expect(result).toEqual({
      accepted: false,
      reasons,
      classification: "unclassified"
    });
  });

  it("does not classify a later empty window as invalid geometry after centering once", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(4_000, {
          evaluationWindow: { targetFrames: 20, centeredFrames: 0, centeredRatio: 0 },
          servoLimitFrames: 1
        })
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      reasons: ["evaluation-window-centered-ratio-low"],
      classification: "unclassified"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("classifies oscillation at all inclusive/exclusive boundaries", () => {
    const result = evaluateCenteringCandidate(
      rejectedInput({
        horizontal: axis({
          signedP50: 0.03,
          absoluteP95: 0.101,
          signFlips: 1,
          eligibleSignComparisons: 4,
          positiveOutsideFrames: 2,
          negativeOutsideFrames: 3
        })
      })
    );

    expect(result).toEqual({
      accepted: false,
      reasons: ["evaluation-window-centered-ratio-low"],
      classification: "oscillation",
      candidate: {
        parameter: "deadZoneRelease",
        operation: "set",
        value: 0.14
      }
    });
  });

  it.each([
    {
      name: "flip ratio below 0.25",
      axis: {
        signedP50: 0,
        absoluteP95: 0.2,
        signFlips: 0,
        eligibleSignComparisons: 4,
        positiveOutsideFrames: 2,
        negativeOutsideFrames: 3
      }
    },
    {
      name: "no eligible sign comparisons",
      axis: { signedP50: 0, absoluteP95: 0.2, signFlips: 0, eligibleSignComparisons: 0 }
    },
    {
      name: "signed p50 outside 0.03",
      axis: {
        signedP50: -0.031,
        absoluteP95: 0.2,
        signFlips: 1,
        eligibleSignComparisons: 4,
        positiveOutsideFrames: 2,
        negativeOutsideFrames: 3
      }
    },
    {
      name: "absolute p95 exactly 0.10",
      axis: {
        signedP50: 0,
        absoluteP95: 0.1,
        signFlips: 1,
        eligibleSignComparisons: 4,
        positiveOutsideFrames: 2,
        negativeOutsideFrames: 3
      }
    }
  ])("does not classify oscillation with $name", ({ axis: axisOverride }) => {
    expect(
      evaluateCenteringCandidate(
        rejectedInput({
          horizontal: axis(axisOverride)
        })
      )
    ).toMatchObject({ classification: "unclassified" });
  });

  it.each([
    {
      name: "positive 70 percent dominance",
      firstCenteredMs: 5_001,
      counts: { positiveOutsideFrames: 7, negativeOutsideFrames: 3 }
    },
    {
      name: "negative 70 percent dominance",
      firstCenteredMs: 5_001,
      counts: { positiveOutsideFrames: 3, negativeOutsideFrames: 7 }
    },
    {
      name: "missing first centered time",
      firstCenteredMs: undefined,
      counts: { positiveOutsideFrames: 7, negativeOutsideFrames: 3 }
    }
  ])("classifies insufficient convergence for $name", ({ firstCenteredMs, counts }) => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(firstCenteredMs, {
          horizontal: axis({ absoluteP95: 0.2, ...counts })
        })
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      classification: "insufficient-convergence",
      candidate: {
        parameter: "yawGainDeg",
        operation: "multiply",
        value: 1.1
      }
    });
  });

  it("does not classify 69 percent same-sign errors as insufficient convergence", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(5_001, {
          horizontal: axis({
            positiveOutsideFrames: 69,
            negativeOutsideFrames: 31
          })
        })
      })
    );

    expect(result).toMatchObject({ classification: "unclassified" });
    expect(result).not.toHaveProperty("candidate");
  });

  it("does not classify convergence when a servo limit was reached", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(5_001, {
          horizontal: axis({
            positiveOutsideFrames: 7,
            negativeOutsideFrames: 3
          }),
          servoLimitFrames: 1
        })
      })
    );

    expect(result).toMatchObject({ classification: "unclassified" });
    expect(result).not.toHaveProperty("candidate");
  });

  it("selects the converging axis with the larger absolute p95", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(5_001, {
          horizontal: axis({
            absoluteP95: 0.2,
            positiveOutsideFrames: 7,
            negativeOutsideFrames: 3
          }),
          vertical: axis({
            absoluteP95: 0.3,
            positiveOutsideFrames: 2,
            negativeOutsideFrames: 8
          })
        })
      })
    );

    expect(result).toMatchObject({
      classification: "insufficient-convergence",
      candidate: {
        parameter: "pitchGainDeg",
        operation: "multiply",
        value: 1.1
      }
    });
  });

  it("selects the horizontal convergence gain when both axes tie", () => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnostics(5_001, {
          horizontal: axis({
            absoluteP95: 0.3,
            positiveOutsideFrames: 7,
            negativeOutsideFrames: 3
          }),
          vertical: axis({
            absoluteP95: 0.3,
            positiveOutsideFrames: 2,
            negativeOutsideFrames: 8
          })
        })
      })
    );

    expect(result).toMatchObject({
      classification: "insufficient-convergence",
      candidate: {
        parameter: "yawGainDeg",
        operation: "multiply",
        value: 1.1
      }
    });
  });

  it.each([
    {
      name: "oscillation",
      diagnostics: diagnostics(5_000, {
        evaluationWindow: { targetFrames: 20, centeredFrames: 13, centeredRatio: 0.65 },
        horizontal: oscillatingAxis()
      })
    },
    {
      name: "insufficient convergence",
      diagnostics: diagnostics(5_001, {
        horizontal: axis({
          absoluteP95: 0.2,
          positiveOutsideFrames: 7,
          negativeOutsideFrames: 3
        })
      })
    }
  ])("classifies fixed position bias before $name", ({ diagnostics: diagnosticSummary }) => {
    const result = evaluateCenteringCandidate(
      input({
        diagnostics: diagnosticSummary,
        fixedPose: biasedFixedPose()
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      classification: "position-bias"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it.each([
    {
      name: "human horizontal bias",
      targetKind: "human" as const,
      fixedPose: biasedFixedPose()
    },
    {
      name: "synthetic vertical bias",
      targetKind: "synthetic" as const,
      fixedPose: {
        horizontal: fixedAxis(),
        vertical: fixedAxis({ signedP50: -0.051, absoluteP50: 0.05, absoluteP95: 0.15 })
      }
    }
  ])("classifies $name without an automatic home or scan candidate", ({
    targetKind,
    fixedPose
  }) => {
    const result = evaluateCenteringCandidate(rejectedInput({}, { targetKind, fixedPose }));

    expect(result).toMatchObject({
      accepted: false,
      classification: "position-bias"
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it.each([
    {
      name: "signed p50 exactly 0.05",
      biasedAxis: fixedAxis({ signedP50: 0.05, absoluteP50: 0.05, absoluteP95: 0.15 })
    },
    {
      name: "absolute spread above 0.10",
      biasedAxis: fixedAxis({ signedP50: 0.051, absoluteP50: 0.05, absoluteP95: 0.151 })
    }
  ])("does not classify position bias with $name", ({ biasedAxis }) => {
    const result = evaluateCenteringCandidate(
      rejectedInput(
        {},
        {
          fixedPose: {
            horizontal: biasedAxis,
            vertical: fixedAxis()
          }
        }
      )
    );

    expect(result).toMatchObject({ classification: "unclassified" });
  });

  it("does not serialize raw observations or privacy-sensitive arrays", () => {
    const privateInput = {
      ...rejectedInput({
        horizontal: oscillatingAxis()
      }),
      rawObservations: [{ centerX: 0.25, boundingBox: [1, 2, 3, 4] }],
      jpegBytes: [255, 216, 255, 217]
    };
    const evaluation = evaluateCenteringCandidate(privateInput);
    const serialized = JSON.stringify(evaluation);

    expect(Object.keys(evaluation)).toEqual(["accepted", "reasons", "classification", "candidate"]);
    expect(serialized).not.toMatch(
      /rawObservations|centerX|boundingBox|jpeg|targetFrames|diagnostics|fixedPose/i
    );
  });
});

function input(overrides: Partial<CenteringEvaluationInput> = {}): CenteringEvaluationInput {
  return {
    targetKind: "human",
    targetFrames: 20,
    errors: 0,
    returnedHome: true,
    diagnostics: diagnostics(5_000),
    ...overrides
  };
}

function rejectedInput(
  diagnosticOverrides: Partial<Omit<Diagnostics, "firstCenteredMs">> = {},
  inputOverrides: Partial<CenteringEvaluationInput> = {}
): CenteringEvaluationInput {
  return input({
    diagnostics: diagnostics(5_000, {
      evaluationWindow: { targetFrames: 20, centeredFrames: 13, centeredRatio: 0.65 },
      ...diagnosticOverrides
    }),
    ...inputOverrides
  });
}

function diagnostics(
  firstCenteredMs: number | undefined,
  overrides: Partial<Omit<Diagnostics, "firstCenteredMs">> = {}
): Diagnostics {
  return {
    ...(firstCenteredMs === undefined ? {} : { firstCenteredMs }),
    maximumLostGapMs: 1_999,
    evaluationWindow: {
      targetFrames: 20,
      centeredFrames: 14,
      centeredRatio: 0.7
    },
    horizontal: axis(),
    vertical: axis(),
    servoLimitFrames: 0,
    ...overrides
  };
}

function axis(overrides: Partial<AxisDiagnostics> = {}): AxisDiagnostics {
  return {
    signedP50: 0,
    absoluteP50: 0,
    absoluteP95: 0,
    signFlips: 0,
    eligibleSignComparisons: 0,
    positiveOutsideFrames: 0,
    negativeOutsideFrames: 0,
    ...overrides
  };
}

function oscillatingAxis(): AxisDiagnostics {
  return axis({
    signedP50: 0,
    absoluteP95: 0.2,
    signFlips: 1,
    eligibleSignComparisons: 4,
    positiveOutsideFrames: 2,
    negativeOutsideFrames: 3
  });
}

function fixedAxis(
  overrides: Partial<NonNullable<CenteringEvaluationInput["fixedPose"]>["horizontal"]> = {}
) {
  return {
    signedP50: 0,
    absoluteP50: 0,
    absoluteP95: 0,
    ...overrides
  };
}

function biasedFixedPose(): NonNullable<CenteringEvaluationInput["fixedPose"]> {
  return {
    horizontal: fixedAxis({
      signedP50: 0.051,
      absoluteP50: 0.05,
      absoluteP95: 0.15
    }),
    vertical: fixedAxis()
  };
}
