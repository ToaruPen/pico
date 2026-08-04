import type { PicoStackChanTargetFilterConfig } from "../../config/index.js";
import type { AttentionDetection } from "../vision/attention-detection.js";

export type StackChanTargetFilterAxisState = {
  readonly rawValue: number;
  readonly filteredValue: number;
  readonly filteredDerivative: number;
};

export type StackChanTargetFilterState = {
  readonly observedAtMs: number;
  readonly label: AttentionDetection["label"];
  readonly horizontal: StackChanTargetFilterAxisState;
  readonly vertical: StackChanTargetFilterAxisState;
};

export type StackChanTargetCenterObservation = {
  readonly observedAtMs: number;
  readonly label: AttentionDetection["label"];
  readonly centerX: number;
  readonly centerY: number;
};

export type StackChanFilteredTargetCenter = {
  readonly centerX: number;
  readonly centerY: number;
  readonly state?: StackChanTargetFilterState;
};

export function filterStackChanTargetCenter(
  previousState: StackChanTargetFilterState | undefined,
  observation: StackChanTargetCenterObservation,
  config: PicoStackChanTargetFilterConfig
): StackChanFilteredTargetCenter {
  if (!config.enabled) {
    return {
      centerX: observation.centerX,
      centerY: observation.centerY
    };
  }

  const shouldInitialize =
    previousState === undefined ||
    previousState.label !== observation.label ||
    observation.observedAtMs <= previousState.observedAtMs ||
    !isFiniteFilterState(previousState);
  const horizontal = shouldInitialize
    ? initializeAxis(observation.centerX)
    : filterAxis(
        previousState.horizontal,
        observation.centerX,
        (observation.observedAtMs - previousState.observedAtMs) / 1000,
        config
      );
  const vertical = shouldInitialize
    ? initializeAxis(observation.centerY)
    : filterAxis(
        previousState.vertical,
        observation.centerY,
        (observation.observedAtMs - previousState.observedAtMs) / 1000,
        config
      );
  const state: StackChanTargetFilterState = {
    observedAtMs: observation.observedAtMs,
    label: observation.label,
    horizontal,
    vertical
  };

  return {
    centerX: clampUnit(horizontal.filteredValue),
    centerY: clampUnit(vertical.filteredValue),
    state
  };
}

function initializeAxis(value: number): StackChanTargetFilterAxisState {
  return {
    rawValue: value,
    filteredValue: value,
    filteredDerivative: 0
  };
}

function filterAxis(
  previous: StackChanTargetFilterAxisState,
  value: number,
  elapsedSeconds: number,
  config: Extract<PicoStackChanTargetFilterConfig, { readonly enabled: true }>
): StackChanTargetFilterAxisState {
  const rawDerivative = (value - previous.rawValue) / elapsedSeconds;
  const filteredDerivative = lowPass(
    rawDerivative,
    previous.filteredDerivative,
    smoothingFactor(config.derivativeCutoffHz, elapsedSeconds)
  );
  const adaptiveCutoffHz =
    config.minimumCutoffHz + config.speedCoefficient * Math.abs(filteredDerivative);
  const filteredValue = lowPass(
    value,
    previous.filteredValue,
    smoothingFactor(adaptiveCutoffHz, elapsedSeconds)
  );

  return {
    rawValue: value,
    filteredValue,
    filteredDerivative
  };
}

function smoothingFactor(cutoffHz: number, elapsedSeconds: number): number {
  const timeConstant = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + timeConstant / elapsedSeconds);
}

function lowPass(value: number, previousValue: number, factor: number): number {
  return factor * value + (1 - factor) * previousValue;
}

function isFiniteFilterState(state: StackChanTargetFilterState): boolean {
  return (
    Number.isFinite(state.observedAtMs) &&
    isFiniteAxisState(state.horizontal) &&
    isFiniteAxisState(state.vertical)
  );
}

function isFiniteAxisState(state: StackChanTargetFilterAxisState): boolean {
  return (
    Number.isFinite(state.rawValue) &&
    Number.isFinite(state.filteredValue) &&
    Number.isFinite(state.filteredDerivative)
  );
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
