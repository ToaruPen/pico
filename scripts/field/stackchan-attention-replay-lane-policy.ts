import type { StackChanHeadPose } from "../../src/modules/stackchan/index.js";

export type StackChanReplayHeadTargetDispatchInput = {
  readonly confirmedPose: StackChanHeadPose;
  readonly plannedPose: StackChanHeadPose;
  readonly dispatchedPose: StackChanHeadPose;
  readonly activeCalls: number;
};

export type StackChanReplayHeadTargetDispatchDecision =
  | "dispatch"
  | "defer-planned-no-op"
  | "discard-planned-no-op";

export function decideStackChanReplayHeadTargetDispatch(
  input: StackChanReplayHeadTargetDispatchInput
): StackChanReplayHeadTargetDispatchDecision {
  if (
    input.dispatchedPose.yaw !== input.plannedPose.yaw ||
    input.dispatchedPose.pitch !== input.plannedPose.pitch
  ) {
    return "dispatch";
  }
  return input.activeCalls > 0 ? "defer-planned-no-op" : "discard-planned-no-op";
}
