import type { PicoStackChanFollowConfig } from "../../config/index.js";
import { type AttentionDetection, selectAttentionTarget } from "../vision/attention-detection.js";
import type { StackChanHeadPose } from "./index.js";
import {
  filterStackChanTargetCenter,
  type StackChanTargetFilterState
} from "./target-center-filter.js";

export type StackChanAttentionMode = "acquire" | "track" | "hold" | "scan";

export type StackChanAttentionState = {
  readonly mode: StackChanAttentionMode;
  readonly centered: boolean;
  readonly yawStepResidualDeg: number;
  readonly pitchStepResidualDeg: number;
  readonly yawStepDirection: -1 | 0 | 1;
  readonly pitchStepDirection: -1 | 0 | 1;
  readonly targetFilterState?: StackChanTargetFilterState;
  readonly lastTargetAtMs?: number;
  readonly lastTrackedPose?: StackChanHeadPose;
  readonly scanArrivedAtMs?: number;
  readonly scanIndex: number;
};

export type StackChanAttentionControllerConfig = Omit<
  Extract<PicoStackChanFollowConfig, { readonly enabled: true }>,
  | "enabled"
  | "commandTransport"
  | "commandRateHz"
  | "maxPendingCommandAgeMs"
  | "frameIntervalMs"
  | "maxFrameAgeMs"
  | "homeYaw"
  | "homePitch"
  | "moveSpeedDps"
>;

export type StackChanAttentionInput = {
  readonly nowMs: number;
  readonly observedAtMs?: number;
  readonly currentPose: StackChanHeadPose;
  readonly detections: readonly AttentionDetection[];
};

export type StackChanAttentionEffect =
  | {
      readonly kind: "hold";
    }
  | {
      readonly kind: "move";
      readonly pose: StackChanHeadPose;
    };

export type StackChanAttentionTargetObservation = {
  readonly label: AttentionDetection["label"];
  readonly confidence: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly horizontalError: number;
  readonly verticalError: number;
  readonly centered: boolean;
};

export type StackChanAttentionResidualAction =
  | "round-disabled"
  | "reset-centered"
  | "reset-zero-correction"
  | "reset-direct-step"
  | "reset-direction-reversal"
  | "residual-accumulate"
  | "residual-release";

export type StackChanAttentionAxisQuantizationDiagnostic = {
  readonly normalizedError: number;
  readonly rawCorrectionDeg: number;
  readonly clampedCorrectionDeg: number;
  readonly legacyRoundedStepDeg: number;
  readonly quantizedStepDeg: number;
  readonly residualBeforeDeg: number;
  readonly residualAfterDeg: number;
  readonly residualAction: StackChanAttentionResidualAction;
};

export type StackChanAttentionDecisionDiagnostic = {
  readonly decisionAtMs: number;
  readonly observedAtMs: number;
  readonly quantizationMode: StackChanAttentionControllerConfig["stepQuantization"];
  readonly centered: boolean;
  readonly baseConfirmedPose: StackChanHeadPose;
  readonly requestedPose?: StackChanHeadPose;
  readonly yaw: StackChanAttentionAxisQuantizationDiagnostic;
  readonly pitch: StackChanAttentionAxisQuantizationDiagnostic;
};

export type StackChanAttentionTransition = {
  readonly state: StackChanAttentionState;
  readonly effect: StackChanAttentionEffect;
  readonly target?: StackChanAttentionTargetObservation;
  readonly diagnostic?: StackChanAttentionDecisionDiagnostic;
};

export function initialAttentionState(): StackChanAttentionState {
  return {
    mode: "acquire",
    centered: false,
    yawStepResidualDeg: 0,
    pitchStepResidualDeg: 0,
    yawStepDirection: 0,
    pitchStepDirection: 0,
    scanIndex: 0
  };
}

export function advanceAttentionState(
  state: StackChanAttentionState,
  input: StackChanAttentionInput,
  config: StackChanAttentionControllerConfig
): StackChanAttentionTransition {
  const target = selectAttentionTarget(input.detections);

  if (target !== undefined) {
    return trackAttentionTarget(state, input, config, target);
  }
  if (
    state.lastTargetAtMs !== undefined &&
    input.nowMs - state.lastTargetAtMs < config.lostHoldMs
  ) {
    return {
      state: holdState(state),
      effect: { kind: "hold" }
    };
  }

  return advanceScan(state, input, config);
}

function trackAttentionTarget(
  state: StackChanAttentionState,
  input: StackChanAttentionInput,
  config: StackChanAttentionControllerConfig,
  target: AttentionDetection
): StackChanAttentionTransition {
  const { xMin, yMin, xMax, yMax } = target.boundingBox;
  const filteredCenter = filterStackChanTargetCenter(
    state.targetFilterState,
    {
      observedAtMs: input.observedAtMs ?? input.nowMs,
      label: target.label,
      centerX: (xMin + xMax) / 2,
      centerY: (yMin + yMax) / 2
    },
    config.targetFilter
  );
  const { centerX, centerY } = filteredCenter;
  const horizontalError = centerX - 0.5;
  const verticalError = centerY - 0.5;
  const centerThreshold = state.centered ? config.deadZoneRelease : config.deadZone;
  const centered =
    Math.abs(horizontalError) <= centerThreshold && Math.abs(verticalError) <= centerThreshold;
  const observation: StackChanAttentionTargetObservation = {
    label: target.label,
    confidence: target.confidence,
    centerX,
    centerY,
    horizontalError,
    verticalError,
    centered
  };
  const nextState: StackChanAttentionState = {
    mode: "track",
    centered,
    yawStepResidualDeg: state.yawStepResidualDeg,
    pitchStepResidualDeg: state.pitchStepResidualDeg,
    yawStepDirection: state.yawStepDirection,
    pitchStepDirection: state.pitchStepDirection,
    lastTargetAtMs: input.observedAtMs ?? input.nowMs,
    lastTrackedPose: { ...input.currentPose },
    ...optionalTargetFilterState(filteredCenter.state),
    scanIndex: state.scanIndex
  };

  const yawCorrectionDeg = axisCorrection(
    horizontalError,
    config.deadZone,
    config.yawGainDeg,
    config.flipYaw
  );
  const pitchCorrectionDeg = axisCorrection(
    verticalError,
    config.deadZone,
    config.pitchGainDeg,
    config.flipPitch
  );

  if (centered) {
    return centeredTargetTransition(
      state,
      input,
      config,
      observation,
      nextState,
      yawCorrectionDeg,
      pitchCorrectionDeg
    );
  }
  const yawStep = quantizeAxisStep(
    yawCorrectionDeg,
    config.maxStepDeg,
    config.stepQuantization,
    state.yawStepResidualDeg,
    state.yawStepDirection
  );
  const pitchStep = quantizeAxisStep(
    pitchCorrectionDeg,
    config.maxStepDeg,
    config.stepQuantization,
    state.pitchStepResidualDeg,
    state.pitchStepDirection
  );

  const pose = {
    yaw: boundedServoAngle(input.currentPose.yaw + yawStep.stepDeg, -90, 90),
    pitch: boundedServoAngle(
      input.currentPose.pitch + pitchStep.stepDeg,
      minimumTrackingPitch(config),
      85
    )
  };

  const effect: StackChanAttentionEffect = samePose(pose, input.currentPose)
    ? { kind: "hold" }
    : { kind: "move", pose };
  return {
    state: {
      ...nextState,
      yawStepResidualDeg: yawStep.residualDeg,
      pitchStepResidualDeg: pitchStep.residualDeg,
      yawStepDirection: yawStep.direction,
      pitchStepDirection: pitchStep.direction
    },
    effect,
    target: observation,
    diagnostic: createAttentionDecisionDiagnostic({
      input,
      config,
      centered,
      ...(effect.kind === "move" ? { requestedPose: effect.pose } : {}),
      yaw: axisDiagnostic(horizontalError, yawCorrectionDeg, yawStep),
      pitch: axisDiagnostic(verticalError, pitchCorrectionDeg, pitchStep)
    })
  };
}

function optionalTargetFilterState(
  state: StackChanTargetFilterState | undefined
): Pick<StackChanAttentionState, "targetFilterState"> | object {
  return state === undefined ? {} : { targetFilterState: state };
}

function centeredTargetTransition(
  state: StackChanAttentionState,
  input: StackChanAttentionInput,
  config: StackChanAttentionControllerConfig,
  observation: StackChanAttentionTargetObservation,
  nextState: StackChanAttentionState,
  yawCorrectionDeg: number,
  pitchCorrectionDeg: number
): StackChanAttentionTransition {
  return {
    state: {
      ...nextState,
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    },
    effect: { kind: "hold" },
    target: observation,
    diagnostic: createAttentionDecisionDiagnostic({
      input,
      config,
      centered: true,
      yaw: centeredAxisDiagnostic(
        observation.horizontalError,
        yawCorrectionDeg,
        config.maxStepDeg,
        state.yawStepResidualDeg
      ),
      pitch: centeredAxisDiagnostic(
        observation.verticalError,
        pitchCorrectionDeg,
        config.maxStepDeg,
        state.pitchStepResidualDeg
      )
    })
  };
}

function holdState(state: StackChanAttentionState): StackChanAttentionState {
  return {
    mode: "hold",
    centered: state.centered,
    yawStepResidualDeg: 0,
    pitchStepResidualDeg: 0,
    yawStepDirection: 0,
    pitchStepDirection: 0,
    ...(state.lastTargetAtMs === undefined ? {} : { lastTargetAtMs: state.lastTargetAtMs }),
    ...(state.lastTrackedPose === undefined
      ? {}
      : { lastTrackedPose: { ...state.lastTrackedPose } }),
    ...(state.scanArrivedAtMs === undefined ? {} : { scanArrivedAtMs: state.scanArrivedAtMs }),
    scanIndex: state.scanIndex
  };
}

function minimumTrackingPitch(config: StackChanAttentionControllerConfig): number {
  return config.trackingPitchMin;
}

function advanceScan(
  state: StackChanAttentionState,
  input: StackChanAttentionInput,
  config: StackChanAttentionControllerConfig
): StackChanAttentionTransition {
  const poseCount = config.scanYaw.length * config.scanPitch.length;
  const currentIndex =
    state.mode !== "scan" && state.lastTrackedPose !== undefined
      ? nearestScanIndex(state.lastTrackedPose, config)
      : state.scanIndex % poseCount;
  const pose = scanPose(currentIndex, config);

  if (pose === undefined) {
    return {
      state,
      effect: { kind: "hold" }
    };
  }

  if (!samePose(pose, input.currentPose)) {
    return {
      state: scanState(state, currentIndex),
      effect: {
        kind: "move",
        pose
      }
    };
  }

  return advanceArrivedScan(state, input, config, currentIndex, poseCount);
}

function advanceArrivedScan(
  state: StackChanAttentionState,
  input: StackChanAttentionInput,
  config: StackChanAttentionControllerConfig,
  currentIndex: number,
  poseCount: number
): StackChanAttentionTransition {
  const arrivedAtMs =
    state.mode === "scan" && state.scanArrivedAtMs !== undefined
      ? state.scanArrivedAtMs
      : input.nowMs;
  if (input.nowMs - arrivedAtMs < config.scanDwellMs) {
    return {
      state: scanState(state, currentIndex, arrivedAtMs),
      effect: { kind: "hold" }
    };
  }

  const nextIndex = (currentIndex + 1) % poseCount;
  const nextPose = scanPose(nextIndex, config);
  if (nextPose === undefined) {
    return {
      state: scanState(state, currentIndex, arrivedAtMs),
      effect: { kind: "hold" }
    };
  }
  if (samePose(nextPose, input.currentPose)) {
    return {
      state: scanState(state, nextIndex, input.nowMs),
      effect: { kind: "hold" }
    };
  }

  return {
    state: scanState(state, nextIndex),
    effect: {
      kind: "move",
      pose: nextPose
    }
  };
}

function scanState(
  state: StackChanAttentionState,
  scanIndex: number,
  scanArrivedAtMs?: number
): StackChanAttentionState {
  return {
    mode: "scan",
    centered: false,
    yawStepResidualDeg: 0,
    pitchStepResidualDeg: 0,
    yawStepDirection: 0,
    pitchStepDirection: 0,
    ...(state.lastTargetAtMs === undefined ? {} : { lastTargetAtMs: state.lastTargetAtMs }),
    ...(state.lastTrackedPose === undefined
      ? {}
      : { lastTrackedPose: { ...state.lastTrackedPose } }),
    ...(scanArrivedAtMs === undefined ? {} : { scanArrivedAtMs }),
    scanIndex
  };
}

function scanPose(
  index: number,
  config: StackChanAttentionControllerConfig
): StackChanHeadPose | undefined {
  const yawIndex = index % config.scanYaw.length;
  const pitchIndex = Math.floor(index / config.scanYaw.length);
  const yaw = config.scanYaw[yawIndex];
  const pitch = config.scanPitch[pitchIndex];
  return yaw === undefined || pitch === undefined ? undefined : { yaw, pitch };
}

function nearestScanIndex(
  pose: StackChanHeadPose,
  config: StackChanAttentionControllerConfig
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let pitchIndex = 0; pitchIndex < config.scanPitch.length; pitchIndex += 1) {
    for (let yawIndex = 0; yawIndex < config.scanYaw.length; yawIndex += 1) {
      const yaw = config.scanYaw[yawIndex];
      const pitch = config.scanPitch[pitchIndex];
      if (yaw === undefined || pitch === undefined) {
        continue;
      }
      const yawDistance = yaw - pose.yaw;
      const pitchDistance = pitch - pose.pitch;
      const distance = yawDistance * yawDistance + pitchDistance * pitchDistance;
      if (distance < nearestDistance) {
        nearestIndex = pitchIndex * config.scanYaw.length + yawIndex;
        nearestDistance = distance;
      }
    }
  }

  return nearestIndex;
}

function boundedStep(value: number, maximumMagnitude: number): number {
  return Math.round(clampStep(value, maximumMagnitude));
}

type QuantizedAxisStep = {
  readonly stepDeg: number;
  readonly residualDeg: number;
  readonly direction: -1 | 0 | 1;
  readonly clampedCorrectionDeg: number;
  readonly legacyRoundedStepDeg: number;
  readonly residualBeforeDeg: number;
  readonly residualAction: StackChanAttentionResidualAction;
};

function quantizeAxisStep(
  continuousStepDeg: number,
  maximumMagnitude: number,
  mode: StackChanAttentionControllerConfig["stepQuantization"],
  previousResidualDeg: number,
  previousDirection: -1 | 0 | 1
): QuantizedAxisStep {
  const direction = Math.sign(continuousStepDeg) as -1 | 0 | 1;
  const clampedCorrectionDeg = clampStep(continuousStepDeg, maximumMagnitude);
  const legacyRoundedStepDeg = boundedStep(continuousStepDeg, maximumMagnitude);
  if (mode === "round") {
    return {
      stepDeg: legacyRoundedStepDeg,
      residualDeg: 0,
      direction: 0,
      clampedCorrectionDeg,
      legacyRoundedStepDeg,
      residualBeforeDeg: previousResidualDeg,
      residualAction: "round-disabled"
    };
  }
  if (direction === 0) {
    return {
      stepDeg: 0,
      residualDeg: 0,
      direction: 0,
      clampedCorrectionDeg,
      legacyRoundedStepDeg,
      residualBeforeDeg: previousResidualDeg,
      residualAction: "reset-zero-correction"
    };
  }
  if (legacyRoundedStepDeg !== 0) {
    return {
      stepDeg: legacyRoundedStepDeg,
      residualDeg: 0,
      direction: 0,
      clampedCorrectionDeg,
      legacyRoundedStepDeg,
      residualBeforeDeg: previousResidualDeg,
      residualAction: "reset-direct-step"
    };
  }

  const directionReversed = previousDirection !== 0 && previousDirection !== direction;
  const carriedResidual = directionReversed ? 0 : previousResidualDeg;
  const accumulated = clampStep(continuousStepDeg + carriedResidual, maximumMagnitude);
  const stepDeg = Math.round(accumulated);
  return {
    stepDeg,
    residualDeg: accumulated - stepDeg,
    direction,
    clampedCorrectionDeg,
    legacyRoundedStepDeg,
    residualBeforeDeg: previousResidualDeg,
    residualAction: directionReversed
      ? "reset-direction-reversal"
      : stepDeg === 0
        ? "residual-accumulate"
        : "residual-release"
  };
}

function axisCorrection(
  normalizedError: number,
  deadZone: number,
  gainDeg: number,
  flip: -1 | 1
): number {
  return errorBeyondDeadZone(normalizedError, deadZone) * gainDeg * flip;
}

function clampStep(value: number, maximumMagnitude: number): number {
  return Math.min(maximumMagnitude, Math.max(-maximumMagnitude, value));
}

function axisDiagnostic(
  normalizedError: number,
  rawCorrectionDeg: number,
  step: QuantizedAxisStep
): StackChanAttentionAxisQuantizationDiagnostic {
  return {
    normalizedError: normalizeNegativeZero(normalizedError),
    rawCorrectionDeg: normalizeNegativeZero(rawCorrectionDeg),
    clampedCorrectionDeg: normalizeNegativeZero(step.clampedCorrectionDeg),
    legacyRoundedStepDeg: normalizeNegativeZero(step.legacyRoundedStepDeg),
    quantizedStepDeg: normalizeNegativeZero(step.stepDeg),
    residualBeforeDeg: normalizeNegativeZero(step.residualBeforeDeg),
    residualAfterDeg: normalizeNegativeZero(step.residualDeg),
    residualAction: step.residualAction
  };
}

function centeredAxisDiagnostic(
  normalizedError: number,
  rawCorrectionDeg: number,
  maximumMagnitude: number,
  residualBeforeDeg: number
): StackChanAttentionAxisQuantizationDiagnostic {
  return {
    normalizedError: normalizeNegativeZero(normalizedError),
    rawCorrectionDeg: normalizeNegativeZero(rawCorrectionDeg),
    clampedCorrectionDeg: normalizeNegativeZero(clampStep(rawCorrectionDeg, maximumMagnitude)),
    legacyRoundedStepDeg: normalizeNegativeZero(boundedStep(rawCorrectionDeg, maximumMagnitude)),
    quantizedStepDeg: 0,
    residualBeforeDeg: normalizeNegativeZero(residualBeforeDeg),
    residualAfterDeg: 0,
    residualAction: "reset-centered"
  };
}

function createAttentionDecisionDiagnostic(input: {
  readonly input: StackChanAttentionInput;
  readonly config: StackChanAttentionControllerConfig;
  readonly centered: boolean;
  readonly requestedPose?: StackChanHeadPose;
  readonly yaw: StackChanAttentionAxisQuantizationDiagnostic;
  readonly pitch: StackChanAttentionAxisQuantizationDiagnostic;
}): StackChanAttentionDecisionDiagnostic {
  return {
    decisionAtMs: input.input.nowMs,
    observedAtMs: input.input.observedAtMs ?? input.input.nowMs,
    quantizationMode: input.config.stepQuantization,
    centered: input.centered,
    baseConfirmedPose: { ...input.input.currentPose },
    ...(input.requestedPose === undefined ? {} : { requestedPose: { ...input.requestedPose } }),
    yaw: input.yaw,
    pitch: input.pitch
  };
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function errorBeyondDeadZone(value: number, deadZone: number): number {
  return Math.sign(value) * Math.max(0, Math.abs(value) - deadZone);
}

function boundedServoAngle(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function samePose(left: StackChanHeadPose, right: StackChanHeadPose): boolean {
  return left.yaw === right.yaw && left.pitch === right.pitch;
}
