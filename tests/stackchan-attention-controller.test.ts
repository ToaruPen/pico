import { describe, expect, it } from "vitest";

import {
  advanceAttentionState,
  initialAttentionState,
  type StackChanAttentionControllerConfig,
  type StackChanAttentionDecisionDiagnostic
} from "../src/modules/stackchan/attention-controller.js";
import type { AttentionDetection } from "../src/modules/vision/attention-detection.js";

const config: StackChanAttentionControllerConfig = {
  deadZone: 0.08,
  deadZoneRelease: 0.14,
  stepQuantization: "round",
  targetFilter: { enabled: false },
  yawGainDeg: 40,
  pitchGainDeg: 30,
  flipYaw: 1,
  flipPitch: -1,
  maxStepDeg: 8,
  trackingPitchMin: 25,
  lostHoldMs: 1000,
  scanDwellMs: 900,
  scanYaw: [-35, 0, 35],
  scanPitch: [35, 25]
};

const filteredConfig: StackChanAttentionControllerConfig = {
  ...config,
  targetFilter: {
    enabled: true,
    minimumCutoffHz: 1,
    speedCoefficient: 0,
    derivativeCutoffHz: 1
  }
};

function detection(
  label: "head" | "face",
  centerX: number,
  centerY: number,
  confidence = 0.8,
  size = 0.2
): AttentionDetection {
  return {
    label,
    confidence,
    boundingBox: {
      xMin: centerX - size / 2,
      yMin: centerY - size / 2,
      xMax: centerX + size / 2,
      yMax: centerY + size / 2
    }
  };
}

function requireTarget(
  transition: ReturnType<typeof advanceAttentionState>
): NonNullable<ReturnType<typeof advanceAttentionState>["target"]> {
  if (transition.target === undefined) {
    throw new Error("expected attention target observation");
  }
  return transition.target;
}

function requireMovePose(effect: ReturnType<typeof advanceAttentionState>["effect"]): {
  readonly yaw: number;
  readonly pitch: number;
} {
  if (effect.kind !== "move") {
    throw new Error("expected move effect");
  }
  return effect.pose;
}

function requireDecisionDiagnostic(
  transition: ReturnType<typeof advanceAttentionState>
): StackChanAttentionDecisionDiagnostic {
  if (transition.diagnostic === undefined) {
    throw new Error("expected attention decision diagnostic");
  }
  return transition.diagnostic;
}

describe("StackChan attention controller", () => {
  it("acquires the face target, emits a configured-step setpoint, and enters track", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 100,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("head", 0.1, 0.1, 0.99, 0.8), detection("face", 0.8, 0.8)]
      },
      config
    );

    expect(result.state).toEqual({
      mode: "track",
      centered: false,
      lastTargetAtMs: 100,
      scanIndex: 0,
      lastTrackedPose: { yaw: 0, pitch: 35 },
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    });
    expect(result.effect).toEqual({
      kind: "move",
      pose: {
        yaw: 8,
        pitch: 28
      }
    });
    expect(result.target).toMatchObject({
      label: "face",
      confidence: 0.8,
      centered: false
    });
    expect(result.target?.centerX).toBeCloseTo(0.8);
    expect(result.target?.centerY).toBeCloseTo(0.8);
    expect(result.target?.horizontalError).toBeCloseTo(0.3);
    expect(result.target?.verticalError).toBeCloseTo(0.3);
  });

  it("holds when the selected target center is inside the dead zone", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 200,
        currentPose: { yaw: 10, pitch: 40 },
        detections: [detection("face", 0.55, 0.45)]
      },
      config
    );

    expect(result.state.mode).toBe("track");
    expect(result.effect).toEqual({ kind: "hold" });
    expect(result.target).toMatchObject({
      label: "face",
      confidence: 0.8,
      centered: true
    });
    expect(result.target?.centerX).toBeCloseTo(0.55);
    expect(result.target?.centerY).toBeCloseTo(0.45);
    expect(result.target?.horizontalError).toBeCloseTo(0.05);
    expect(result.target?.verticalError).toBeCloseTo(-0.05);
  });

  it("keeps the tracking pitch floor independent from a home-only scan", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 200,
        currentPose: { yaw: 0, pitch: 33 },
        detections: [detection("face", 0.5, 0.8)]
      },
      {
        ...config,
        maxStepDeg: 4,
        scanPitch: [33],
        trackingPitchMin: 23
      }
    );

    expect(result.effect).toEqual({ kind: "move", pose: { yaw: 0, pitch: 29 } });
  });

  it("records target loss timing from observation time while using the later decision time", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 1_100,
        observedAtMs: 100,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      config
    );

    expect(result.state).toMatchObject({
      mode: "track",
      lastTargetAtMs: 100
    });
  });

  it("uses the filtered center for hysteresis and generated movement", () => {
    const centered = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      filteredConfig
    );
    const moved = advanceAttentionState(
      centered.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.8, 0.5)]
      },
      filteredConfig
    );
    const released = advanceAttentionState(
      moved.state,
      {
        nowMs: 250,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.9, 0.5)]
      },
      filteredConfig
    );

    const movedTarget = requireTarget(moved);
    const releasedTarget = requireTarget(released);
    const releasedPose = requireMovePose(released.effect);
    expect(movedTarget.centerX).toBeGreaterThan(0.5);
    expect(movedTarget.centerX).toBeLessThan(0.8);
    expect(movedTarget.horizontalError).toBeCloseTo(movedTarget.centerX - 0.5);
    expect(movedTarget.centered).toBe(true);
    expect(moved.effect).toEqual({ kind: "hold" });
    expect(releasedTarget.centerX).toBeLessThan(0.9);
    expect(releasedTarget.centered).toBe(false);
    expect(releasedPose.yaw).toBeGreaterThan(0);
    expect(releasedPose.yaw).toBeLessThan(8);
  });

  it("updates filter state while centered and clears only step feedback", () => {
    const first = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      filteredConfig
    );
    const second = advanceAttentionState(
      {
        ...first.state,
        yawStepResidualDeg: 0.4,
        pitchStepResidualDeg: -0.3,
        yawStepDirection: 1,
        pitchStepDirection: -1
      },
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.51, 0.49)]
      },
      filteredConfig
    );

    expect(second.state).toMatchObject({
      targetFilterState: { observedAtMs: 125, label: "face" },
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    });
  });

  it("clears filter state on first loss hold and scan, then reinitializes on reacquisition", () => {
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.2, 0.5)]
      },
      filteredConfig
    );
    const held = advanceAttentionState(
      tracked.state,
      { nowMs: 125, currentPose: { yaw: 0, pitch: 35 }, detections: [] },
      filteredConfig
    );
    const scanning = advanceAttentionState(
      tracked.state,
      { nowMs: 1000, currentPose: { yaw: 0, pitch: 35 }, detections: [] },
      filteredConfig
    );
    const reacquired = advanceAttentionState(
      held.state,
      {
        nowMs: 250,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.8, 0.5)]
      },
      filteredConfig
    );

    expect(tracked.state).toHaveProperty("targetFilterState");
    expect(held.state).not.toHaveProperty("targetFilterState");
    expect(scanning.state).not.toHaveProperty("targetFilterState");
    expect(reacquired.target?.centerX).toBeCloseTo(0.8);
    expect(reacquired.state).toHaveProperty("targetFilterState.observedAtMs", 250);
  });

  it("reinitializes filtering when the selected label changes", () => {
    const face = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.2, 0.5)]
      },
      filteredConfig
    );
    const head = advanceAttentionState(
      face.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("head", 0.8, 0.5)]
      },
      filteredConfig
    );

    expect(head.target?.centerX).toBeCloseTo(0.8);
    expect(head.state).toHaveProperty("targetFilterState.label", "head");
  });

  it("holds inside the release zone after entering center", () => {
    const entered = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 200,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.58, 0.5)]
      },
      config
    );
    const retained = advanceAttentionState(
      entered.state,
      {
        nowMs: 300,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.63, 0.5)]
      },
      config
    );

    expect(entered.target?.centered).toBe(true);
    expect(retained.target?.centered).toBe(true);
    expect(retained.effect).toEqual({ kind: "hold" });
  });

  it("leaves center beyond the release zone", () => {
    const entered = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 200,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.58, 0.5)]
      },
      config
    );
    const released = advanceAttentionState(
      entered.state,
      {
        nowMs: 300,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.65, 0.5)]
      },
      config
    );

    expect(released.target?.centered).toBe(false);
    expect(released.effect.kind).toBe("move");
  });

  it("scales corrections from the dead-zone edge instead of jumping at full gain", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 250,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.62, 0.62)]
      },
      config
    );

    expect(result.effect).toEqual({
      kind: "move",
      pose: {
        yaw: 2,
        pitch: 34
      }
    });
  });

  it("accumulates a sub-degree correction until it produces an integer servo step", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "error-feedback" as const
    };
    const first = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );
    const second = advanceAttentionState(
      first.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );

    expect(first.effect).toEqual({ kind: "hold" });
    expect(first.state.yawStepResidualDeg).toBeCloseTo(0.4);
    expect(first.state.yawStepDirection).toBe(1);
    expect(second.effect).toEqual({ kind: "move", pose: { yaw: 1, pitch: 35 } });
    expect(second.state.yawStepResidualDeg).toBeCloseTo(-0.2);
    expect(second.state.yawStepDirection).toBe(1);
  });

  it("clears both residual axes when the target is centered", () => {
    const candidate = { ...config, stepQuantization: "error-feedback" as const };
    const result = advanceAttentionState(
      {
        ...initialAttentionState(),
        yawStepResidualDeg: 0.4,
        pitchStepResidualDeg: -0.3,
        yawStepDirection: 1,
        pitchStepDirection: -1
      },
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      candidate
    );

    expect(result.effect).toEqual({ kind: "hold" });
    expect(result.state).toMatchObject({
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    });
  });

  it("clears both residual axes on the first target-loss hold", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "error-feedback" as const
    };
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );
    const held = advanceAttentionState(
      tracked.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      candidate
    );

    expect(held).toMatchObject({
      state: {
        mode: "hold",
        yawStepResidualDeg: 0,
        pitchStepResidualDeg: 0,
        yawStepDirection: 0,
        pitchStepDirection: 0
      },
      effect: { kind: "hold" }
    });
  });

  it("drops a carried residual when the correction direction reverses", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "error-feedback" as const
    };
    const positive = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );
    const reversed = advanceAttentionState(
      positive.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.39, 0.5)]
      },
      candidate
    );

    expect(reversed.effect).toEqual({ kind: "hold" });
    expect(reversed.state.yawStepResidualDeg).toBeCloseTo(-0.4);
    expect(reversed.state.yawStepDirection).toBe(-1);
  });

  it("reports the controller's actual residual release intermediates", () => {
    const result = advanceAttentionState(
      {
        ...initialAttentionState(),
        yawStepResidualDeg: 0.3,
        yawStepDirection: 1
      },
      {
        nowMs: 250,
        observedAtMs: 225,
        currentPose: { yaw: 10, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      {
        ...config,
        deadZone: 0.1,
        yawGainDeg: 40,
        stepQuantization: "error-feedback"
      }
    );
    const diagnostic = requireDecisionDiagnostic(result);

    expect(diagnostic).toMatchObject({
      decisionAtMs: 250,
      observedAtMs: 225,
      quantizationMode: "error-feedback",
      centered: false,
      baseConfirmedPose: { yaw: 10, pitch: 35 },
      requestedPose: { yaw: 11, pitch: 35 },
      yaw: {
        legacyRoundedStepDeg: 0,
        quantizedStepDeg: 1,
        residualBeforeDeg: 0.3,
        residualAction: "residual-release"
      },
      pitch: {
        normalizedError: 0,
        rawCorrectionDeg: 0,
        clampedCorrectionDeg: 0,
        legacyRoundedStepDeg: 0,
        quantizedStepDeg: 0,
        residualBeforeDeg: 0,
        residualAfterDeg: 0,
        residualAction: "reset-zero-correction"
      }
    });
    expect(diagnostic.yaw.rawCorrectionDeg).toBeCloseTo(0.4);
    expect(diagnostic.yaw.normalizedError).toBeCloseTo(0.11);
    expect(diagnostic.yaw.clampedCorrectionDeg).toBeCloseTo(0.4);
    expect(diagnostic.yaw.residualAfterDeg).toBeCloseTo(-0.3);
  });

  it("reports centered and direction-reversal residual resets", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "error-feedback" as const
    };
    const reversed = advanceAttentionState(
      {
        ...initialAttentionState(),
        yawStepResidualDeg: 0.4,
        yawStepDirection: 1
      },
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.39, 0.5)]
      },
      candidate
    );
    const centered = advanceAttentionState(
      reversed.state,
      {
        nowMs: 250,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      candidate
    );

    expect(requireDecisionDiagnostic(reversed).yaw).toMatchObject({
      quantizedStepDeg: 0,
      residualBeforeDeg: 0.4,
      residualAction: "reset-direction-reversal"
    });
    expect(requireDecisionDiagnostic(reversed).yaw.residualAfterDeg).toBeCloseTo(-0.4);
    expect(requireDecisionDiagnostic(centered).yaw).toMatchObject({
      quantizedStepDeg: 0,
      residualAfterDeg: 0,
      residualAction: "reset-centered"
    });
    expect(requireDecisionDiagnostic(centered).yaw.residualBeforeDeg).toBeCloseTo(-0.4);
  });

  it("normalizes negative zero in round-mode diagnostics", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.39, 0.5)]
      },
      {
        ...config,
        deadZone: 0.1,
        yawGainDeg: 40,
        stepQuantization: "round"
      }
    );
    const yaw = requireDecisionDiagnostic(result).yaw;

    expect(yaw.residualAction).toBe("round-disabled");
    expect(Object.is(yaw.legacyRoundedStepDeg, -0)).toBe(false);
    expect(Object.is(yaw.quantizedStepDeg, -0)).toBe(false);
  });

  it("resets a zero-correction axis without clearing the other axis", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      pitchGainDeg: 40,
      flipPitch: 1 as const,
      stepQuantization: "error-feedback" as const
    };
    const bothAxes = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.61)]
      },
      candidate
    );
    const yawOnly = advanceAttentionState(
      bothAxes.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );

    expect(yawOnly.effect).toEqual({ kind: "move", pose: { yaw: 1, pitch: 35 } });
    expect(yawOnly.state).toMatchObject({
      pitchStepResidualDeg: 0,
      pitchStepDirection: 0,
      yawStepDirection: 1
    });
    expect(yawOnly.state.yawStepResidualDeg).toBeCloseTo(-0.2);
  });

  it("caps a saturated visual correction at the configured maximum step", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 1, 0.5)]
      },
      { ...config, maxStepDeg: 4, stepQuantization: "error-feedback" }
    );

    expect(result.effect).toEqual({ kind: "move", pose: { yaw: 4, pitch: 35 } });
    expect(result.state.yawStepResidualDeg).toBe(0);
    expect(result.state.yawStepDirection).toBe(0);
  });

  it("repeats the same configured-step target without accumulating unconfirmed poses", () => {
    const first = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 1, 0.5)]
      },
      { ...config, maxStepDeg: 4 }
    );
    const repeated = advanceAttentionState(
      first.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 1, 0.5)]
      },
      { ...config, maxStepDeg: 4 }
    );

    expect(requireMovePose(first.effect)).toEqual({ yaw: 4, pitch: 35 });
    expect(repeated.effect).toEqual(first.effect);
  });

  it("holds without refreshing a target through a short detection gap", () => {
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 1, 0.5)]
      },
      config
    );
    const missing = advanceAttentionState(
      tracked.state,
      {
        nowMs: 999,
        currentPose: { yaw: 4, pitch: 35 },
        detections: []
      },
      config
    );

    expect(missing).toMatchObject({ state: { mode: "hold" }, effect: { kind: "hold" } });
  });

  it("returns to the configured scan when a target times out", () => {
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 1, 0.5)]
      },
      config
    );
    const timedOut = advanceAttentionState(
      tracked.state,
      {
        nowMs: 1_000,
        currentPose: { yaw: 4, pitch: 35 },
        detections: []
      },
      config
    );

    expect(timedOut).toMatchObject({
      state: { mode: "scan", scanIndex: 1 },
      effect: { kind: "move", pose: { yaw: 0, pitch: 35 } }
    });
  });

  it("does not mix a fractional residual into a multi-degree correction", () => {
    const result = advanceAttentionState(
      {
        ...initialAttentionState(),
        yawStepResidualDeg: 0.4,
        yawStepDirection: 1
      },
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.655, 0.5)]
      },
      {
        ...config,
        deadZone: 0.1,
        yawGainDeg: 40,
        stepQuantization: "error-feedback"
      }
    );

    expect(result.effect).toEqual({ kind: "move", pose: { yaw: 2, pitch: 35 } });
    expect(result.state.yawStepResidualDeg).toBe(0);
    expect(result.state.yawStepDirection).toBe(0);
  });

  it("does not mix a residual into a correction that already rounds to one degree", () => {
    const result = advanceAttentionState(
      {
        ...initialAttentionState(),
        yawStepResidualDeg: -0.4,
        yawStepDirection: 1
      },
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.615, 0.5)]
      },
      {
        ...config,
        deadZone: 0.1,
        yawGainDeg: 40,
        stepQuantization: "error-feedback"
      }
    );

    expect(result.effect).toEqual({ kind: "move", pose: { yaw: 1, pitch: 35 } });
    expect(result.state.yawStepResidualDeg).toBe(0);
    expect(result.state.yawStepDirection).toBe(0);
  });

  it("keeps legacy frame-by-frame rounding when configured for round", () => {
    const baseline = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "round" as const
    };
    const first = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      baseline
    );
    const second = advanceAttentionState(
      first.state,
      {
        nowMs: 125,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      baseline
    );

    expect(first.effect).toEqual({ kind: "hold" });
    expect(second.effect).toEqual({ kind: "hold" });
    expect(second.state).toMatchObject({
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    });
  });

  it("never carries tracking residuals into timed-out scan", () => {
    const candidate = {
      ...config,
      deadZone: 0.1,
      yawGainDeg: 40,
      stepQuantization: "error-feedback" as const
    };
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("face", 0.61, 0.5)]
      },
      candidate
    );
    const scanning = advanceAttentionState(
      tracked.state,
      {
        nowMs: 1_000,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      candidate
    );

    expect(scanning.state).toMatchObject({
      mode: "scan",
      yawStepResidualDeg: 0,
      pitchStepResidualDeg: 0,
      yawStepDirection: 0,
      pitchStepDirection: 0
    });
  });

  it("clamps generated poses to yaw safety and the configured scan-pitch floor", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 300,
        currentPose: { yaw: 88, pitch: 7 },
        detections: [detection("face", 0.9, 0.9)]
      },
      {
        ...config,
        maxStepDeg: 20
      }
    );

    expect(result.effect).toEqual({
      kind: "move",
      pose: {
        yaw: 90,
        pitch: 25
      }
    });
  });

  it("holds until loss timeout and then resumes the configured scan", () => {
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 100,
        currentPose: { yaw: 0, pitch: 35 },
        detections: [detection("head", 0.9, 0.5)]
      },
      config
    );
    const held = advanceAttentionState(
      tracked.state,
      {
        nowMs: 1099,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );
    const timedOut = advanceAttentionState(
      held.state,
      {
        nowMs: 1100,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );
    const laterHold = advanceAttentionState(
      timedOut.state,
      {
        nowMs: 1999,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );
    expect(held).toMatchObject({
      state: { mode: "hold" },
      effect: { kind: "hold" }
    });
    expect(timedOut).toMatchObject({
      state: { mode: "scan", scanIndex: 1 },
      effect: { kind: "hold" }
    });
    expect(laterHold).toMatchObject({
      state: { mode: "scan", scanIndex: 1 },
      effect: { kind: "hold" }
    });
  });

  it("starts scanning from acquire when no target is visible", () => {
    const result = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );

    expect(result).toMatchObject({
      state: { mode: "scan", scanIndex: 0 },
      effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
    });
    expect(result.target).toBeUndefined();
  });

  it("observes every tick but advances scan only after scanDwellMs", () => {
    const first = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 100,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );
    const waiting = advanceAttentionState(
      first.state,
      {
        nowMs: 999,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );
    const next = advanceAttentionState(
      waiting.state,
      {
        nowMs: 1898,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );
    const advanced = advanceAttentionState(
      next.state,
      {
        nowMs: 1899,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );

    expect(first).toMatchObject({
      state: { mode: "scan", scanIndex: 0 },
      effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
    });
    expect(waiting).toMatchObject({
      state: { mode: "scan", scanIndex: 0, scanArrivedAtMs: 999 },
      effect: { kind: "hold" }
    });
    expect(next.effect).toEqual({ kind: "hold" });
    expect(advanced).toMatchObject({
      state: { mode: "scan", scanIndex: 1 },
      effect: { kind: "move", pose: { yaw: 0, pitch: 35 } }
    });
  });

  it("repeats the active scan waypoint until confirmed arrival and dwells from arrival", () => {
    const requested = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 0,
        currentPose: { yaw: 0, pitch: 35 },
        detections: []
      },
      config
    );
    const partiallyConfirmed = advanceAttentionState(
      requested.state,
      {
        nowMs: 500,
        currentPose: { yaw: -20, pitch: 35 },
        detections: []
      },
      config
    );
    const arrived = advanceAttentionState(
      partiallyConfirmed.state,
      {
        nowMs: 1_000,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );
    const dwelling = advanceAttentionState(
      arrived.state,
      {
        nowMs: 1_899,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );
    const advanced = advanceAttentionState(
      dwelling.state,
      {
        nowMs: 1_900,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );

    expect(requested).toMatchObject({
      state: { mode: "scan", scanIndex: 0 },
      effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
    });
    expect(partiallyConfirmed).toMatchObject({
      state: { mode: "scan", scanIndex: 0 },
      effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
    });
    expect(partiallyConfirmed.state).not.toHaveProperty("scanArrivedAtMs");
    expect(arrived).toMatchObject({
      state: { mode: "scan", scanIndex: 0, scanArrivedAtMs: 1_000 },
      effect: { kind: "hold" }
    });
    expect(dwelling).toEqual({
      state: arrived.state,
      effect: { kind: "hold" }
    });
    expect(advanced).toMatchObject({
      state: { mode: "scan", scanIndex: 1 },
      effect: { kind: "move", pose: { yaw: 0, pitch: 35 } }
    });
    expect(advanced.state).not.toHaveProperty("scanArrivedAtMs");
  });

  it("holds without a same-pose move and clears scan arrival when a target reappears", () => {
    const arrived = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 100,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      config
    );
    const reacquired = advanceAttentionState(
      arrived.state,
      {
        nowMs: 200,
        currentPose: { yaw: -35, pitch: 35 },
        detections: [detection("face", 0.5, 0.5)]
      },
      config
    );

    expect(arrived).toMatchObject({
      state: { mode: "scan", scanIndex: 0, scanArrivedAtMs: 100 },
      effect: { kind: "hold" }
    });
    expect(reacquired).toMatchObject({
      state: { mode: "track", scanIndex: 0 },
      effect: { kind: "hold" }
    });
    expect(reacquired.state).not.toHaveProperty("scanArrivedAtMs");
  });

  it("starts a fresh dwell when consecutive scan entries resolve to the same pose", () => {
    const result = advanceAttentionState(
      {
        mode: "scan",
        centered: false,
        scanIndex: 0,
        scanArrivedAtMs: 100,
        yawStepResidualDeg: 0,
        pitchStepResidualDeg: 0,
        yawStepDirection: 0,
        pitchStepDirection: 0
      },
      {
        nowMs: 1_000,
        currentPose: { yaw: -35, pitch: 35 },
        detections: []
      },
      {
        ...config,
        scanYaw: [-35, -35],
        scanPitch: [35]
      }
    );

    expect(result).toEqual({
      state: {
        mode: "scan",
        centered: false,
        scanIndex: 1,
        scanArrivedAtMs: 1_000,
        yawStepResidualDeg: 0,
        pitchStepResidualDeg: 0,
        yawStepDirection: 0,
        pitchStepDirection: 0
      },
      effect: { kind: "hold" }
    });
  });

  it("continues the initial-acquisition scan sequence with wraparound", () => {
    const wrappedScan = advanceAttentionState(
      {
        mode: "scan",
        centered: false,
        scanIndex: 5,
        scanArrivedAtMs: 100,
        yawStepResidualDeg: 0,
        pitchStepResidualDeg: 0,
        yawStepDirection: 0,
        pitchStepDirection: 0
      },
      {
        nowMs: 1_000,
        currentPose: { yaw: 35, pitch: 25 },
        detections: []
      },
      config
    );

    expect(wrappedScan).toMatchObject({
      state: { mode: "scan", scanIndex: 0 },
      effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
    });
  });

  it("stores only control progress, normalized continuity, and bounded poses", () => {
    const tracked = advanceAttentionState(
      initialAttentionState(),
      {
        nowMs: 100,
        currentPose: { yaw: 12, pitch: 38 },
        detections: [detection("face", 0.6, 0.4)]
      },
      config
    );

    expect(Object.keys(tracked.state).sort()).toEqual([
      "centered",
      "lastTargetAtMs",
      "lastTrackedPose",
      "mode",
      "pitchStepDirection",
      "pitchStepResidualDeg",
      "scanIndex",
      "yawStepDirection",
      "yawStepResidualDeg"
    ]);
    expect(tracked.state).not.toHaveProperty("target");
    expect(tracked.state).not.toHaveProperty("identity");
    expect(tracked.state).not.toHaveProperty("label");
  });
});
