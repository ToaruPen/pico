import { describe, expect, it } from "vitest";

import { decideStackChanReplayHeadTargetDispatch } from "../scripts/field/stackchan-attention-replay-lane-policy.js";

describe("StackChan attention replay lane dispatch policy", () => {
  it("dispatches an in-flight reversal back to the confirmed pose", () => {
    expect(
      decideStackChanReplayHeadTargetDispatch({
        confirmedPose: { yaw: 0, pitch: 33 },
        plannedPose: { yaw: 4, pitch: 33 },
        dispatchedPose: { yaw: 0, pitch: 33 },
        activeCalls: 1
      })
    ).toBe("dispatch");
  });

  it("defers a target matching the planned pose while a command is active", () => {
    expect(
      decideStackChanReplayHeadTargetDispatch({
        confirmedPose: { yaw: 4, pitch: 33 },
        plannedPose: { yaw: 8, pitch: 33 },
        dispatchedPose: { yaw: 8, pitch: 33 },
        activeCalls: 1
      })
    ).toBe("defer-planned-no-op");
  });

  it("discards a target matching the planned pose only when the lane is idle", () => {
    expect(
      decideStackChanReplayHeadTargetDispatch({
        confirmedPose: { yaw: 8, pitch: 33 },
        plannedPose: { yaw: 8, pitch: 33 },
        dispatchedPose: { yaw: 8, pitch: 33 },
        activeCalls: 0
      })
    ).toBe("discard-planned-no-op");
  });

  it.each([
    {
      confirmedPose: { yaw: 4, pitch: 33 },
      plannedPose: { yaw: 4, pitch: 33 },
      dispatchedPose: { yaw: 8, pitch: 33 }
    },
    {
      confirmedPose: { yaw: 4, pitch: 33 },
      plannedPose: { yaw: 4, pitch: 33 },
      dispatchedPose: { yaw: 4, pitch: 35 }
    }
  ])("dispatches when at least one reclamped pose axis advances", (input) => {
    expect(
      decideStackChanReplayHeadTargetDispatch({
        ...input,
        activeCalls: 0
      })
    ).toBe("dispatch");
  });
});
