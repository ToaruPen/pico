import { describe, expect, it } from "vitest";

import {
  evaluateStackChanTargetFilterCandidates,
  type StackChanTargetFilterCandidateResult
} from "../scripts/field/stackchan-target-filter-evaluation.js";

describe("StackChan target-filter deterministic evaluation", () => {
  it("returns identical ordered output for the fixed seed", () => {
    const first = evaluateStackChanTargetFilterCandidates();
    const second = evaluateStackChanTargetFilterCandidates();

    expect(second).toEqual(first);
    expect(first.candidates).toHaveLength(16);
    expect(
      first.candidates.map(({ config }) => {
        if (!config.enabled) {
          throw new Error("expected enabled candidate config");
        }
        return [config.minimumCutoffHz, config.speedCoefficient];
      })
    ).toEqual([
      [0.5, 0.5],
      [0.5, 1],
      [0.5, 2],
      [0.5, 4],
      [1, 0.5],
      [1, 1],
      [1, 2],
      [1, 4],
      [1.5, 0.5],
      [1.5, 1],
      [1.5, 2],
      [1.5, 4],
      [2, 0.5],
      [2, 1],
      [2, 2],
      [2, 4]
    ]);
  });

  it("emits finite metrics and safe integer counts", () => {
    const result = evaluateStackChanTargetFilterCandidates();

    for (const run of [result.raw, ...result.candidates]) {
      expectFiniteMetrics(run);
      for (const count of [
        run.stationary.moveRequestCount,
        run.stationary.maximumIntegerStep,
        run.stationary.safety.errorCount,
        run.stationary.safety.staleCount,
        run.stationary.safety.postStopCount,
        run.stationary.safety.overlapCount,
        run.stationary.safety.servoLimitFrames,
        run.reversal.moveRequestCount,
        run.reversal.maximumIntegerStep,
        run.reversal.extraDirectionReversals,
        run.reversal.safety.errorCount,
        run.reversal.safety.staleCount,
        run.reversal.safety.postStopCount,
        run.reversal.safety.overlapCount,
        run.reversal.safety.servoLimitFrames
      ]) {
        expect(Number.isSafeInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("selects only accepted candidates with stable lexicographic ranking", () => {
    const result = evaluateStackChanTargetFilterCandidates();
    const accepted = result.candidates.filter(({ acceptance }) => acceptance.passed);
    const ranked = [...accepted].sort((left, right) =>
      compareTuple(rankTuple(result.raw, left), rankTuple(result.raw, right))
    );

    expect(result.candidates.every(({ acceptance }) => acceptance.checks.length === 5)).toBe(true);
    expect(result.selected?.acceptance.passed).toBe(true);
    expect(result.selected).toEqual(ranked[0]);
  });

  it("returns no selection when the thresholds are deliberately impossible", () => {
    const result = evaluateStackChanTargetFilterCandidates({
      stationaryCommandPathTotalVariationRatioMaximum: -1
    });

    expect(result.selected).toBeUndefined();
    expect(result.candidates.every(({ acceptance }) => !acceptance.passed)).toBe(true);
  });

  it("selects a candidate that suppresses jitter without delaying reversal over 250 ms", () => {
    const result = evaluateStackChanTargetFilterCandidates();
    const selected = result.selected;

    expect(selected).toBeDefined();
    if (selected === undefined) {
      throw new Error("expected one selected target-filter candidate");
    }
    expect(selected.stationary.commandPathTotalVariation).toBeLessThanOrEqual(
      result.raw.stationary.commandPathTotalVariation * 0.7
    );
    expect(
      selected.reversal.firstCorrectReversalLatencyMs -
        result.raw.reversal.firstCorrectReversalLatencyMs
    ).toBeLessThanOrEqual(250);
    expect(selected.stationary.maximumIntegerStep).toBeLessThanOrEqual(
      result.raw.stationary.maximumIntegerStep
    );
    expect(selected.reversal.extraDirectionReversals).toBeLessThanOrEqual(
      result.raw.reversal.extraDirectionReversals
    );
  });
});

function expectFiniteMetrics(run: StackChanTargetFilterCandidateResult): void {
  for (const metrics of [run.stationary, run.reversal]) {
    for (const value of [
      metrics.filteredCenterTotalVariation,
      metrics.targetAbsoluteErrorP50,
      metrics.targetAbsoluteErrorP95,
      metrics.commandPathTotalVariation,
      metrics.commandNormalizedRoughness,
      metrics.commandVelocityTotalVariation,
      metrics.safety.homeError
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  }
  expect(Number.isFinite(run.reversal.firstCorrectReversalLatencyMs)).toBe(true);
}

function rankTuple(
  raw: StackChanTargetFilterCandidateResult,
  candidate: StackChanTargetFilterCandidateResult
): readonly number[] {
  if (!candidate.config.enabled) {
    throw new Error("expected enabled candidate config");
  }
  return [
    candidate.stationary.commandPathTotalVariation,
    candidate.reversal.firstCorrectReversalLatencyMs - raw.reversal.firstCorrectReversalLatencyMs,
    candidate.reversal.targetAbsoluteErrorP95,
    candidate.config.minimumCutoffHz,
    candidate.config.speedCoefficient
  ];
}

function compareTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
