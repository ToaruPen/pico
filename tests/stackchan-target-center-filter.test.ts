import { describe, expect, it } from "vitest";

import {
  filterStackChanTargetCenter,
  type StackChanTargetFilterState
} from "../src/modules/stackchan/target-center-filter.js";

const enabledConfig = {
  enabled: true as const,
  minimumCutoffHz: 1,
  speedCoefficient: 2,
  derivativeCutoffHz: 1
};

describe("StackChan target-center filter", () => {
  it("returns the raw center without allocating state when disabled", () => {
    expect(
      filterStackChanTargetCenter(
        undefined,
        { observedAtMs: 125, label: "face", centerX: 0.61, centerY: 0.49 },
        { enabled: false }
      )
    ).toEqual({ centerX: 0.61, centerY: 0.49 });
  });

  it("initializes both axes from the first enabled observation", () => {
    const result = filterStackChanTargetCenter(
      undefined,
      { observedAtMs: 125, label: "face", centerX: 0.61, centerY: 0.49 },
      enabledConfig
    );

    expect(result).toEqual({
      centerX: 0.61,
      centerY: 0.49,
      state: {
        observedAtMs: 125,
        label: "face",
        horizontal: { rawValue: 0.61, filteredValue: 0.61, filteredDerivative: 0 },
        vertical: { rawValue: 0.49, filteredValue: 0.49, filteredDerivative: 0 }
      }
    });
  });

  it("low-pass filters repeated noise independently on both axes", () => {
    const first = filterStackChanTargetCenter(
      undefined,
      { observedAtMs: 0, label: "face", centerX: 0.5, centerY: 0.5 },
      enabledConfig
    );
    const second = filterStackChanTargetCenter(
      first.state,
      { observedAtMs: 125, label: "face", centerX: 0.52, centerY: 0.47 },
      enabledConfig
    );

    expect(second.centerX).toBeGreaterThan(0.5);
    expect(second.centerX).toBeLessThan(0.52);
    expect(second.centerY).toBeGreaterThan(0.47);
    expect(second.centerY).toBeLessThan(0.5);
    expect(second.state?.horizontal.rawValue).toBe(0.52);
    expect(second.state?.vertical.rawValue).toBe(0.47);
  });

  it("raises cutoff at higher estimated speed", () => {
    const initial = filterStackChanTargetCenter(
      undefined,
      { observedAtMs: 0, label: "face", centerX: 0.5, centerY: 0.5 },
      enabledConfig
    );
    const adaptive = filterStackChanTargetCenter(
      initial.state,
      { observedAtMs: 125, label: "face", centerX: 0.8, centerY: 0.5 },
      enabledConfig
    );
    const fixed = filterStackChanTargetCenter(
      initial.state,
      { observedAtMs: 125, label: "face", centerX: 0.8, centerY: 0.5 },
      { ...enabledConfig, speedCoefficient: 0 }
    );

    expect(adaptive.centerX).toBeGreaterThan(fixed.centerX);
    expect(0.8 - adaptive.centerX).toBeLessThan(0.8 - fixed.centerX);
  });

  it.each([
    ["label change", { observedAtMs: 250, label: "head" as const, centerX: 0.7, centerY: 0.4 }],
    [
      "non-increasing timestamp",
      { observedAtMs: 125, label: "face" as const, centerX: 0.7, centerY: 0.4 }
    ]
  ])("reinitializes on %s", (_name, observation) => {
    const previous = stateAt(125);
    const result = filterStackChanTargetCenter(previous, observation, enabledConfig);

    expect(result.centerX).toBe(0.7);
    expect(result.centerY).toBe(0.4);
    expect(result.state?.horizontal.filteredDerivative).toBe(0);
    expect(result.state?.vertical.filteredDerivative).toBe(0);
  });

  it("reinitializes when carried state is non-finite", () => {
    const previous: StackChanTargetFilterState = {
      ...stateAt(125),
      horizontal: {
        ...stateAt(125).horizontal,
        filteredDerivative: Number.NaN
      }
    };
    const result = filterStackChanTargetCenter(
      previous,
      { observedAtMs: 250, label: "face", centerX: 0.7, centerY: 0.4 },
      enabledConfig
    );

    expect(result.centerX).toBe(0.7);
    expect(result.state?.horizontal.filteredDerivative).toBe(0);
  });

  it("clamps only the exposed output and does not mutate its inputs", () => {
    const previous = stateAt(125);
    const previousSnapshot = structuredClone(previous);
    const observation = { observedAtMs: 250, label: "face" as const, centerX: 2, centerY: -1 };
    const observationSnapshot = { ...observation };
    const result = filterStackChanTargetCenter(previous, observation, enabledConfig);

    expect(result.centerX).toBe(1);
    expect(result.centerY).toBe(0);
    expect(previous).toEqual(previousSnapshot);
    expect(observation).toEqual(observationSnapshot);
    expect(result.state).not.toBe(previous);
  });
});

function stateAt(observedAtMs: number): StackChanTargetFilterState {
  return {
    observedAtMs,
    label: "face",
    horizontal: { rawValue: 0.5, filteredValue: 0.5, filteredDerivative: 0 },
    vertical: { rawValue: 0.5, filteredValue: 0.5, filteredDerivative: 0 }
  };
}
