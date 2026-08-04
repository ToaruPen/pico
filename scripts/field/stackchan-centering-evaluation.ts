export type CenteringAcceptanceReason =
  | "invalid-metrics"
  | "insufficient-target-frames"
  | "first-centered-missing"
  | "first-centered-late"
  | "evaluation-window-centered-ratio-low"
  | "maximum-lost-gap-too-long"
  | "runtime-errors"
  | "home-not-returned";

export type CenteringClassification =
  | "accepted"
  | "insufficient-target"
  | "invalid-geometry"
  | "position-bias"
  | "oscillation"
  | "insufficient-convergence"
  | "unclassified";

export type CenteringAxisDiagnostics = {
  readonly signedP50: number;
  readonly absoluteP50: number;
  readonly absoluteP95: number;
  readonly signFlips: number;
  readonly eligibleSignComparisons: number;
  readonly positiveOutsideFrames: number;
  readonly negativeOutsideFrames: number;
};

export type CenteringEvaluationInput = {
  readonly targetKind: "synthetic" | "human";
  readonly targetFrames: number;
  readonly errors: number;
  readonly returnedHome: boolean;
  readonly diagnostics: {
    readonly firstCenteredMs?: number;
    readonly maximumLostGapMs: number;
    readonly evaluationWindow: {
      readonly targetFrames: number;
      readonly centeredFrames: number;
      readonly centeredRatio: number;
    };
    readonly horizontal: CenteringAxisDiagnostics;
    readonly vertical: CenteringAxisDiagnostics;
    readonly servoLimitFrames: number;
  };
  readonly fixedPose?: {
    readonly horizontal: CenteringFixedPoseAxis;
    readonly vertical: CenteringFixedPoseAxis;
  };
};

type CenteringFixedPoseAxis = Pick<
  CenteringAxisDiagnostics,
  "signedP50" | "absoluteP50" | "absoluteP95"
>;

export type CenteringEvaluation = {
  readonly accepted: boolean;
  readonly reasons: readonly CenteringAcceptanceReason[];
  readonly classification: CenteringClassification;
  readonly candidate?: {
    readonly parameter: "deadZoneRelease" | "yawGainDeg" | "pitchGainDeg" | "maxStepDeg";
    readonly operation: "set" | "multiply" | "increment";
    readonly value: number;
  };
};

type RejectedClassification = Pick<CenteringEvaluation, "classification" | "candidate">;
type ConvergenceAxis = "horizontal" | "vertical";

export function evaluateCenteringCandidate(input: CenteringEvaluationInput): CenteringEvaluation {
  if (!hasValidMetrics(input)) {
    return {
      accepted: false,
      reasons: ["invalid-metrics"],
      classification: "unclassified"
    };
  }

  const reasons = collectAcceptanceReasons(input);
  if (reasons.length === 0) {
    return {
      accepted: true,
      reasons,
      classification: "accepted"
    };
  }

  return {
    accepted: false,
    reasons,
    ...classifyRejectedCandidate(input)
  };
}

function collectAcceptanceReasons(input: CenteringEvaluationInput): CenteringAcceptanceReason[] {
  const reasons: CenteringAcceptanceReason[] = [];
  if (input.targetFrames < 20) {
    reasons.push("insufficient-target-frames");
  }
  if (input.diagnostics.firstCenteredMs === undefined) {
    reasons.push("first-centered-missing");
  } else if (input.diagnostics.firstCenteredMs > 5_000) {
    reasons.push("first-centered-late");
  }
  if (input.diagnostics.evaluationWindow.centeredRatio < 0.7) {
    reasons.push("evaluation-window-centered-ratio-low");
  }
  if (input.diagnostics.maximumLostGapMs >= 2_000) {
    reasons.push("maximum-lost-gap-too-long");
  }
  if (input.errors !== 0) {
    reasons.push("runtime-errors");
  }
  if (!input.returnedHome) {
    reasons.push("home-not-returned");
  }
  return reasons;
}

function classifyRejectedCandidate(input: CenteringEvaluationInput): RejectedClassification {
  const nonTunableClassification = classifyNonTunableRejection(input);
  if (nonTunableClassification !== undefined) {
    return nonTunableClassification;
  }
  if ([input.diagnostics.horizontal, input.diagnostics.vertical].some(isOscillatingAxis)) {
    return {
      classification: "oscillation",
      candidate: {
        parameter: "deadZoneRelease",
        operation: "set",
        value: 0.14
      }
    };
  }
  const convergenceAxis = selectConvergenceAxis(input);
  if (convergenceAxis !== undefined) {
    return {
      classification: "insufficient-convergence",
      candidate: {
        parameter: convergenceAxis === "horizontal" ? "yawGainDeg" : "pitchGainDeg",
        operation: "multiply",
        value: 1.1
      }
    };
  }
  return { classification: "unclassified" };
}

function classifyNonTunableRejection(
  input: CenteringEvaluationInput
): RejectedClassification | undefined {
  if (input.targetFrames < 20) {
    return { classification: "insufficient-target" };
  }
  if (input.errors > 0 || !input.returnedHome) {
    return { classification: "unclassified" };
  }
  if (isInvalidGeometry(input)) {
    return { classification: "invalid-geometry" };
  }
  if (isPositionBiased(input.fixedPose)) {
    return { classification: "position-bias" };
  }
  return undefined;
}

function hasValidMetrics(input: CenteringEvaluationInput): boolean {
  const checks = [
    isNonnegativeSafeInteger(input.targetFrames),
    isNonnegativeSafeInteger(input.errors),
    isNonnegativeFinite(input.diagnostics.maximumLostGapMs),
    isOptionalNonnegativeFinite(input.diagnostics.firstCenteredMs),
    isValidEvaluationWindow(input.diagnostics.evaluationWindow, input.targetFrames),
    isValidAxis(input.diagnostics.horizontal, input.targetFrames),
    isValidAxis(input.diagnostics.vertical, input.targetFrames),
    isNonnegativeSafeInteger(input.diagnostics.servoLimitFrames),
    input.diagnostics.servoLimitFrames <= input.targetFrames,
    isValidFixedPose(input.fixedPose)
  ];
  return checks.every((check) => check);
}

function isValidEvaluationWindow(
  window: CenteringEvaluationInput["diagnostics"]["evaluationWindow"],
  targetFrames: number
): boolean {
  const checks = [
    isNonnegativeSafeInteger(window.targetFrames),
    isNonnegativeSafeInteger(window.centeredFrames),
    window.centeredFrames <= window.targetFrames,
    window.targetFrames <= targetFrames,
    Number.isFinite(window.centeredRatio),
    window.centeredRatio >= 0,
    window.centeredRatio <= 1,
    window.centeredRatio === calculateCenteredRatio(window.centeredFrames, window.targetFrames)
  ];
  return checks.every((check) => check);
}

function isValidAxis(axis: CenteringAxisDiagnostics, targetFrames: number): boolean {
  const outsideFrames = axis.positiveOutsideFrames + axis.negativeOutsideFrames;
  const smallestOutsideSign = Math.min(axis.positiveOutsideFrames, axis.negativeOutsideFrames);
  const maximumSignFlips =
    smallestOutsideSign === 0
      ? 0
      : axis.positiveOutsideFrames === axis.negativeOutsideFrames
        ? 2 * smallestOutsideSign - 1
        : 2 * smallestOutsideSign;
  const checks = [
    isValidStatistics(axis),
    isNonnegativeSafeInteger(axis.signFlips),
    isNonnegativeSafeInteger(axis.eligibleSignComparisons),
    isNonnegativeSafeInteger(axis.positiveOutsideFrames),
    isNonnegativeSafeInteger(axis.negativeOutsideFrames),
    axis.signFlips <= axis.eligibleSignComparisons,
    axis.eligibleSignComparisons <= Math.max(0, outsideFrames - 1),
    axis.signFlips <= maximumSignFlips,
    outsideFrames <= targetFrames
  ];
  return checks.every((check) => check);
}

function isValidFixedPose(fixedPose: CenteringEvaluationInput["fixedPose"]): boolean {
  if (fixedPose === undefined) {
    return true;
  }
  return [fixedPose.horizontal, fixedPose.vertical].every(isValidStatistics);
}

function isValidStatistics(input: CenteringFixedPoseAxis): boolean {
  const checks = [
    Number.isFinite(input.signedP50),
    Number.isFinite(input.absoluteP50),
    Number.isFinite(input.absoluteP95),
    input.absoluteP50 >= 0,
    input.absoluteP95 >= 0,
    input.absoluteP50 <= input.absoluteP95
  ];
  return checks.every((check) => check);
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isOptionalNonnegativeFinite(value: number | undefined): boolean {
  return value === undefined || isNonnegativeFinite(value);
}

function calculateCenteredRatio(centeredFrames: number, targetFrames: number): number {
  if (targetFrames === 0) {
    return 0;
  }
  return Math.round((centeredFrames / targetFrames) * 1_000) / 1_000;
}

function isInvalidGeometry(input: CenteringEvaluationInput): boolean {
  return input.diagnostics.servoLimitFrames > 0 && input.diagnostics.firstCenteredMs === undefined;
}

function isOscillatingAxis(axis: CenteringAxisDiagnostics): boolean {
  return (
    axis.eligibleSignComparisons > 0 &&
    axis.signFlips / axis.eligibleSignComparisons >= 0.25 &&
    Math.abs(axis.signedP50) <= 0.03 &&
    axis.absoluteP95 > 0.1
  );
}

function selectConvergenceAxis(input: CenteringEvaluationInput): ConvergenceAxis | undefined {
  if (!canEvaluateConvergence(input)) {
    return undefined;
  }

  const horizontalConverges = isConvergenceDominated(input.diagnostics.horizontal);
  const verticalConverges = isConvergenceDominated(input.diagnostics.vertical);
  if (!horizontalConverges && !verticalConverges) {
    return undefined;
  }
  if (
    horizontalConverges &&
    (!verticalConverges ||
      input.diagnostics.horizontal.absoluteP95 >= input.diagnostics.vertical.absoluteP95)
  ) {
    return "horizontal";
  }
  return "vertical";
}

function canEvaluateConvergence(input: CenteringEvaluationInput): boolean {
  return (
    input.diagnostics.servoLimitFrames === 0 &&
    (input.diagnostics.firstCenteredMs === undefined || input.diagnostics.firstCenteredMs > 5_000)
  );
}

function isConvergenceDominated(axis: CenteringAxisDiagnostics): boolean {
  const outsideFrames = axis.positiveOutsideFrames + axis.negativeOutsideFrames;
  return (
    outsideFrames > 0 &&
    Math.max(axis.positiveOutsideFrames, axis.negativeOutsideFrames) / outsideFrames >= 0.7
  );
}

function isPositionBiased(fixedPose: CenteringEvaluationInput["fixedPose"]): boolean {
  return (
    fixedPose !== undefined &&
    [fixedPose.horizontal, fixedPose.vertical].some(
      (axis) => Math.abs(axis.signedP50) > 0.05 && axis.absoluteP95 - axis.absoluteP50 <= 0.1
    )
  );
}
