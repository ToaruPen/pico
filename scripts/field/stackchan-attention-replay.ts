#!/usr/bin/env jiti
/* eslint-disable unicorn/no-null */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PicoStackChanFollowConfig } from "../../src/config/index.js";
import type {
  StackChanAttentionAxisQuantizationDiagnostic,
  StackChanAttentionDecisionDiagnostic
} from "../../src/modules/stackchan/attention-controller.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus,
  StackChanLatencyDistribution
} from "../../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter, StackChanHeadPose } from "../../src/modules/stackchan/index.js";
import type {
  AttentionDetection,
  AttentionDetectionModel
} from "../../src/modules/vision/attention-detection.js";
import {
  type CreateStackChanAttentionRuntimeOptions,
  createStackChanAttentionRuntime,
  STACKCHAN_ATTENTION_ERROR_HISTORY_LIMIT,
  type StackChanAttentionErrorCode,
  type StackChanAttentionRuntime,
  type StackChanAttentionScheduler,
  type StackChanAttentionStatus
} from "../../src/runtime/stackchan-attention-runtime.js";
import {
  type AttentionQuantizationAxisSample,
  type AttentionQuantizationAxisSummary,
  summarizeAttentionQuantizationAxis
} from "./stackchan-attention-metrics.js";
import { decideStackChanReplayHeadTargetDispatch } from "./stackchan-attention-replay-lane-policy.js";
import {
  loadStackChanAttentionReplaySchema,
  stackChanAttentionReplayEventSchemaHash,
  stackChanAttentionReplaySchemaHash,
  validateStackChanAttentionReplaySchemaValue
} from "./stackchan-attention-replay-schema.js";

export type StackChanAttentionReplayOptions = {
  readonly reportOutput: string;
  readonly repeat: number;
  readonly producerSourceHash: string;
  readonly stepQuantization?: StackChanAttentionReplayStepQuantization;
};

type EnabledFollowConfig = Extract<PicoStackChanFollowConfig, { readonly enabled: true }>;
export type StackChanAttentionReplayStepQuantization = EnabledFollowConfig["stepQuantization"];

export const STACKCHAN_ATTENTION_REPLAY_FIXTURE = {
  seed: 20_260_730,
  syntheticFovDeg: {
    yaw: 64,
    pitch: 48
  },
  staticProbeDurationMs: 375,
  virtualDeviceCommandDurationMs: 200,
  pendingStopVirtualDeviceCommandDurationMs: 300,
  follow: {
    enabled: true,
    commandTransport: "async-latest",
    stepQuantization: "error-feedback",
    targetFilter: { enabled: false },
    commandRateHz: 10,
    maxPendingCommandAgeMs: 180,
    frameIntervalMs: 125,
    maxFrameAgeMs: 180,
    homeYaw: 0,
    homePitch: 33,
    trackingPitchMin: 23,
    deadZone: 0.1,
    deadZoneRelease: 0.14,
    yawGainDeg: 44,
    pitchGainDeg: 30,
    flipYaw: 1,
    flipPitch: -1,
    maxStepDeg: 4,
    moveSpeedDps: 90,
    lostHoldMs: 1_000,
    scanDwellMs: 900,
    scanYaw: [-35, 0, 35],
    scanPitch: [33, 23]
  } satisfies EnabledFollowConfig
} as const;

const STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS = 1 as const;

const STACKCHAN_ATTENTION_REPLAY_METRIC_DEFINITIONS = {
  version: 5,
  source: "raw-replay-events",
  percentile: "nearest-rank sorted[ceil(q*n)-1]",
  trackingRequiredReversalDispatches:
    "tracking dispatch reverses direction from an unresolved planned frontier toward or through confirmed-before",
  trackingRequiredReversalOccupancyMs:
    "trackingRequiredReversalDispatches multiplied by virtual device command duration",
  trackingProvablyRedundantDispatches:
    "tracking device dispatch whose dispatched pose equals planned-before-dispatch",
  trackingProvablyRedundantOccupancyMs:
    "trackingProvablyRedundantDispatches multiplied by virtual device command duration",
  trackingProvablyRedundantDiscarded:
    "lane targets discarded immediately before device RPC because reclamping equals the idle planned pose",
  trackingOrdinaryDispatches:
    "tracking device dispatches that are neither required reversals nor provably redundant planned-frontier repeats",
  reversalResponseLatencyMs:
    "elapsed milliseconds from a visible target-segment direction reversal to the first dispatch progressing from planned-before toward that new direction",
  sameAbsoluteTargetWhileActive:
    "tracking request repeats the prior absolute target while one device call is active",
  pendingSameTargetReplacements: "latest-wins replacement repeats the preceding absolute target",
  effectiveConfirmedProgressIntervalMs:
    "elapsed milliseconds between pose-changing confirmations within one active non-centered tracking episode",
  initialEffectiveConfirmedProgressLatencyMs:
    "elapsed milliseconds from the first non-centered track event in an episode to its first pose-changing confirmation whose dispatch occurred at or after that event",
  activeNonCenteredTrackingEpisodesWithoutConfirmedProgress:
    "active non-centered tracking episodes ending without a pose-changing confirmation whose dispatch occurred within that episode",
  activeNonCenteredTrackingEpisodeBoundary:
    "starts at the first non-centered track event; ends after the first controller-mode exit or centered idle event with no request, active call, or pending target; variant and probe changes also end the episode",
  settling:
    "first visible centered-or-release-band no-op window spanning two complete frame intervals per target segment",
  visibility:
    "visible frames divided by visible plus outside-FOV frames; occluded and lifecycle events excluded"
} as const;

export const STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE = {
  version: 6,
  checks: [
    {
      id: "slow-tracking-provably-redundant-dispatches",
      kind: "objective",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.trackingProvablyRedundantDispatches",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "slow-tracking-provably-redundant-occupancy",
      kind: "objective",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.trackingProvablyRedundantOccupancyMs",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "fast-tracking-provably-redundant-dispatches",
      kind: "objective",
      scenarioId: "fast-reversals",
      metric: "aggregates.trackingProvablyRedundantDispatches",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "fast-tracking-provably-redundant-occupancy",
      kind: "objective",
      scenarioId: "fast-reversals",
      metric: "aggregates.trackingProvablyRedundantOccupancyMs",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "slow-tracking-provably-redundant-discards",
      kind: "objective",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.trackingProvablyRedundantDiscarded",
      rule: { type: "absolute-minimum", minimum: 1 }
    },
    {
      id: "fast-tracking-provably-redundant-discards",
      kind: "objective",
      scenarioId: "fast-reversals",
      metric: "aggregates.trackingProvablyRedundantDiscarded",
      rule: { type: "absolute-minimum", minimum: 1 }
    },
    {
      id: "fast-confirmed-jerk-p95",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.confirmedKinematics.jerk.combined.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "slow-target-error-p95",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.targetAbsoluteError.combined.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "fast-target-error-p95",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.targetAbsoluteError.combined.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "slow-centered-ratio",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.centeredRatio",
      rule: { type: "maximum-absolute-drop", maximumDrop: 0.02 }
    },
    {
      id: "slow-settling-p95",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.settlingMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "fast-settling-p95",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.settlingMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "slow-effective-progress-p95",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.effectiveConfirmedProgressIntervalMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "fast-effective-progress-p95",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.effectiveConfirmedProgressIntervalMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "slow-initial-effective-progress-p95",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.initialEffectiveConfirmedProgressLatencyMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "fast-initial-effective-progress-p95",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.initialEffectiveConfirmedProgressLatencyMs.p95",
      rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
    },
    {
      id: "slow-tracking-episodes-without-progress",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "fast-tracking-episodes-without-progress",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "target-loss-waypoint-reach",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.waypointReachRatio",
      rule: { type: "absolute-minimum", minimum: 1 }
    },
    {
      id: "target-loss-premature-waypoint-advances",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.prematureWaypointAdvances",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "target-loss-insufficient-post-arrival-dwells",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.insufficientPostArrivalDwells",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "target-loss-same-pose-scan-dispatches",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.samePoseScanDispatches",
      rule: { type: "absolute-maximum", maximum: 0 }
    },
    {
      id: "target-loss-post-arrival-dwell",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.minimumPostArrivalDwellMs",
      rule: {
        type: "absolute-minimum",
        minimum: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      }
    },
    {
      id: "target-loss-reacquisition-latency",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "aggregates.reacquisitionLatencyMs",
      rule: { type: "absolute-maximum", maximum: 2_125 }
    },
    {
      id: "static-hold-absolute-safety",
      kind: "guardrail",
      scenarioId: "static-hold",
      metric: "invariants.absoluteSafety",
      rule: { type: "absolute-boolean", expected: true }
    },
    {
      id: "slow-continuous-tracking-absolute-safety",
      kind: "guardrail",
      scenarioId: "slow-continuous-tracking",
      metric: "invariants.absoluteSafety",
      rule: { type: "absolute-boolean", expected: true }
    },
    {
      id: "fast-reversals-absolute-safety",
      kind: "guardrail",
      scenarioId: "fast-reversals",
      metric: "invariants.absoluteSafety",
      rule: { type: "absolute-boolean", expected: true }
    },
    {
      id: "target-loss-reacquisition-absolute-safety",
      kind: "guardrail",
      scenarioId: "target-loss-reacquisition",
      metric: "invariants.absoluteSafety",
      rule: { type: "absolute-boolean", expected: true }
    },
    {
      id: "stop-home-absolute-safety",
      kind: "guardrail",
      scenarioId: "stop-home",
      metric: "invariants.absoluteSafety",
      rule: { type: "absolute-boolean", expected: true }
    },
    {
      id: "stop-home-variants-qualified",
      kind: "guardrail",
      scenarioId: "stop-home",
      metric: "invariants.stopVariantsQualified",
      rule: { type: "absolute-boolean", expected: true }
    }
  ],
  syntheticEvidence: true,
  physicalSmoothnessQualified: false
} as const;

type Distribution = {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
};

type DerivativeSummary = {
  readonly yaw: Distribution;
  readonly pitch: Distribution;
  readonly combined: Distribution;
};

export type ReplayKinematicsSummary = {
  readonly velocity: DerivativeSummary;
  readonly acceleration: DerivativeSummary;
  readonly jerk: DerivativeSummary;
  readonly normalizedRoughness: {
    readonly yaw: number;
    readonly pitch: number;
    readonly combined: number;
  };
};

type ReplayPoseSample = {
  readonly timestampMs: number;
  readonly pose: StackChanHeadPose;
};

type ScenarioId =
  | "static-hold"
  | "slow-continuous-tracking"
  | "fast-reversals"
  | "target-loss-reacquisition"
  | "stop-home";
type StopVariant = "track-moving" | "pending-present" | "scan-active";
type DetectorState = "visible" | "occluded" | "outside-fov";
type StaticBoundaryAxis = "yaw" | "pitch";
type StaticBoundaryNormalizedError = 0.09 | 0.11 | 0.13 | 0.15;

type WorldKeyframe = {
  readonly atMs: number;
  readonly pose: StackChanHeadPose;
  readonly occluded: boolean;
  readonly interpolation?: "linear";
  readonly normalizedError?: StackChanHeadPose;
};

type RuntimeScenarioInput = {
  readonly id: Exclude<ScenarioId, "static-hold" | "stop-home">;
  readonly durationMs: number;
  readonly world: readonly WorldKeyframe[];
};

type StaticBoundaryProbeInput = {
  readonly probeId: string;
  readonly axis: StaticBoundaryAxis;
  readonly initialSign: -1 | 1;
  readonly normalizedError: StaticBoundaryNormalizedError;
};

type StaticBoundaryScenarioInput = {
  readonly id: "static-hold";
  readonly probes: readonly StaticBoundaryProbeInput[];
};

type LegacyStaticScenarioInput = {
  readonly id: "static-hold";
  readonly durationMs: number;
  readonly world: readonly WorldKeyframe[];
};

type StopVariantInput = {
  readonly variant: StopVariant;
  readonly durationMs: number;
  readonly world: readonly WorldKeyframe[];
};

type StopHomeScenarioInput = {
  readonly id: "stop-home";
  readonly variants: readonly StopVariantInput[];
};

type CanonicalScenarioInput =
  | RuntimeScenarioInput
  | StaticBoundaryScenarioInput
  | LegacyStaticScenarioInput
  | StopHomeScenarioInput;

type LaneCounters = {
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly noOpDiscarded: number;
  readonly pendingDepth: number;
  readonly activeCalls: number;
  readonly maximumPendingDepth: number;
  readonly maximumActiveCalls: number;
  readonly postStopDispatches: number;
  readonly postStopDispatchAttempts: number;
};

export type ReplayPostStopProbe = {
  readonly schedulerTickRejected: boolean;
  readonly lanePhase: StackChanHeadTargetStatus["phase"];
  readonly dispatchAttempts: number;
  readonly dispatchedBefore: number;
  readonly dispatchedAfter: number;
  readonly confirmedBefore: number;
  readonly confirmedAfter: number;
};

export type StackChanAttentionReplayEvent = {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly observationId: string;
  readonly variant: StopVariant | null;
  readonly frameSequence: number | null;
  readonly runtimeAcceptedFrameSequence: number | null;
  readonly targetWorldPose: StackChanHeadPose | null;
  readonly targetSegmentIndex: number | null;
  readonly detectorState: DetectorState | null;
  readonly targetErrorDeg: StackChanHeadPose | null;
  readonly targetNormalizedError: StackChanHeadPose | null;
  readonly probeId: string | null;
  readonly isProbeObservation: boolean;
  readonly centered: boolean;
  readonly controllerMode: "acquire" | "track" | "hold" | "scan";
  readonly decision: StackChanAttentionReplayDecision | null;
  readonly requestSequence: number | null;
  readonly requestedPose: StackChanHeadPose | null;
  readonly dispatchSequence: number | null;
  readonly dispatchedRequestPose: StackChanHeadPose | null;
  readonly dispatchedPose: StackChanHeadPose | null;
  readonly confirmedSequence: number | null;
  readonly noOpDiscardedSequence: number | null;
  readonly confirmedBeforeDispatch: StackChanHeadPose;
  readonly plannedBeforeDispatch: StackChanHeadPose;
  readonly rpcConfirmedPose: StackChanHeadPose;
  readonly pendingAgeMs: number | null;
  readonly generation: number;
  readonly counters: LaneCounters;
  readonly clear: boolean;
  readonly stop: boolean;
  readonly stopRequestedAtMs: number | null;
  readonly home: boolean;
  readonly homeAcknowledgedAtMs: number | null;
  readonly homeAcknowledgedPose: StackChanHeadPose | null;
  readonly postStopProbe: ReplayPostStopProbe | null;
  readonly finalRuntimeEvidence: FinalRuntimeEvidence | null;
};

export type StackChanAttentionReplayEffectOutcome =
  | "dispatched"
  | "replaced"
  | "noop"
  | "stale"
  | "none";

export type StackChanAttentionReplayDecision = {
  readonly id: number;
  readonly decisionAtMs: number;
  readonly observedAtMs: number;
  readonly quantizationMode: StackChanAttentionReplayStepQuantization;
  readonly centered: boolean;
  readonly baseConfirmedPose: StackChanHeadPose;
  readonly requestedPose: StackChanHeadPose | null;
  readonly requestSequence: number | null;
  readonly effectOutcome: StackChanAttentionReplayEffectOutcome;
  readonly ticksWithoutConfirmedUpdate: number;
  readonly yaw: StackChanAttentionAxisQuantizationDiagnostic;
  readonly pitch: StackChanAttentionAxisQuantizationDiagnostic;
};

export type ReplayInitialConfirmedProgressEvent = Pick<
  StackChanAttentionReplayEvent,
  | "timestampMs"
  | "variant"
  | "probeId"
  | "controllerMode"
  | "centered"
  | "requestedPose"
  | "dispatchSequence"
  | "dispatchedPose"
  | "confirmedSequence"
  | "confirmedBeforeDispatch"
  | "plannedBeforeDispatch"
  | "rpcConfirmedPose"
> & {
  readonly counters: Pick<LaneCounters, "activeCalls" | "pendingDepth">;
};

type ScenarioAggregates = {
  readonly requestKinematics: ReplayKinematicsSummary;
  readonly dispatchKinematics: ReplayKinematicsSummary;
  readonly commandKinematics: ReplayKinematicsSummary;
  readonly confirmedKinematics: ReplayKinematicsSummary;
  readonly targetAbsoluteError: {
    readonly yaw: Distribution;
    readonly pitch: Distribution;
    readonly combined: Distribution;
  };
  readonly angularPathDeg: {
    readonly request: number;
    readonly dispatch: number;
    readonly command: number;
    readonly confirmed: number;
  };
  readonly velocityTotalVariation: {
    readonly yaw: number;
    readonly pitch: number;
    readonly combined: number;
  };
  readonly directionReversals: {
    readonly yaw: number;
    readonly pitch: number;
    readonly combined: number;
  };
  readonly centeredRatio: number | null;
  readonly settlingMs: Distribution;
  readonly settlingIntervalCount: number;
  readonly settlingCensoredCount: number;
  readonly quantization: {
    readonly yaw: AttentionQuantizationAxisSummary;
    readonly pitch: AttentionQuantizationAxisSummary;
  };
  readonly dispatchIntervalMs: Distribution;
  readonly replyToNextDispatchMs: Distribution;
  readonly samePoseRequests: number;
  readonly samePoseDispatches: number;
  readonly samePoseScanDispatches: number;
  readonly redundantSamePoseRequests: number;
  readonly nonzeroStaticCommands: number;
  readonly dispatchCount: number;
  readonly staleDispatchCount: number;
  readonly postStopNormalDispatchCount: number;
  readonly postStopDispatchAttemptCount: number;
  readonly pendingMaximum: number;
  readonly activeMaximum: number;
  readonly activeOverlapCount: number;
  readonly reacquisitionLatencyMs: number | null;
  readonly homeErrorDeg: StackChanHeadPose;
  readonly homeCompletionMs: number | null;
  readonly waypointReachRatio: number;
  readonly prematureWaypointAdvances: number;
  readonly insufficientPostArrivalDwells: number;
  readonly actualPostArrivalDwellMs: Distribution;
  readonly minimumPostArrivalDwellMs: number | null;
  readonly dwellBeforeArrivalMs: Distribution;
  readonly progressReversals: number;
  readonly observationCount: number;
  readonly visibilityEligibleFrames: number;
  readonly visibleFrames: number;
  readonly outsideFovFrames: number;
  readonly visibilityRatio: number;
  readonly scanDispatchCount: number;
  readonly effectiveConfirmedMovements: number;
  readonly settlingUncensoredRatio: number;
  readonly plannedTargetReversals: number;
  readonly staticBoundaryObservationCount: number;
  readonly staticBoundaryPrematureReleaseCount: number;
  readonly staticBoundaryRequestOverflowCount: number;
  readonly trackingRequiredReversalDispatches: number;
  readonly trackingRequiredReversalOccupancyMs: number;
  readonly trackingProvablyRedundantDispatches: number;
  readonly trackingProvablyRedundantOccupancyMs: number;
  readonly trackingProvablyRedundantDiscarded: number;
  readonly trackingOrdinaryDispatches: number;
  readonly reversalResponseLatencyMs: Distribution;
  readonly sameAbsoluteTargetWhileActive: number;
  readonly pendingSameTargetReplacements: number;
  readonly effectiveConfirmedProgressIntervalMs: Distribution;
  readonly initialEffectiveConfirmedProgressLatencyMs: Distribution;
  readonly activeNonCenteredTrackingEpisodesWithoutConfirmedProgress: number;
  readonly maximumConfirmedStepDeg: number;
  readonly trackingDecisionCount: number;
  readonly trackingCenteredHoldCount: number;
  readonly trackingQuantizedNoOpCount: number;
  readonly trackingMoveRequestCount: number;
};

type ScenarioInvariants = {
  readonly angleBounds: boolean;
  readonly pendingDepth: boolean;
  readonly activeCalls: boolean;
  readonly noOverlap: boolean;
  readonly noStale: boolean;
  readonly noPostStopNormalDispatch: boolean;
  readonly homeReturned: boolean;
  readonly errorFree: boolean;
  readonly runtimeStopped: boolean;
  readonly framesAndTicksComplete: boolean;
  readonly sufficientPostArrivalDwell: boolean;
  readonly targetLossAcceptance: boolean;
  readonly noSamePoseScanDispatches: boolean;
  readonly postStopQuiescent: boolean;
  readonly staticBoundaryQualified: boolean;
  readonly slowTrackingQualified: boolean;
  readonly fastReversalQualified: boolean;
  readonly stopVariantsQualified: boolean;
  readonly absoluteSafety: boolean;
  readonly qualityDataPresent: boolean;
  readonly trackingDecisionPartition: boolean;
};

type ScenarioRuntimeStatus = {
  readonly phase: StackChanAttentionStatus["phase"];
  readonly framesProcessed: number;
  readonly lastAcceptedFrameSequence: number | null;
  readonly staleFramesDiscarded: number;
  readonly observationTicksStarted: number;
  readonly observationTicksCompleted: number;
  readonly observationOverlapAttempts: number;
  readonly maximumConcurrentObservationTicks: number;
  readonly expectedFramesProcessed: number;
  readonly expectedObservationTicks: number;
  readonly errorCount: number;
  readonly errorCodes: readonly StackChanAttentionErrorCode[];
};

type FinalRuntimeEvidence = Omit<
  ScenarioRuntimeStatus,
  "expectedFramesProcessed" | "expectedObservationTicks" | "errorCount"
>;

type LossWindow = {
  readonly phase: "before-search" | "during-search" | "before-reacquisition";
  readonly startMs: number;
  readonly endMs: number | null;
};

export type StackChanAttentionReplayScenario = {
  readonly id: ScenarioId;
  readonly status: "passed" | "failed";
  readonly canonicalInput: CanonicalScenarioInput;
  readonly canonicalInputHash: string;
  readonly canonicalHash: string;
  readonly lossWindows: readonly LossWindow[];
  readonly events: readonly StackChanAttentionReplayEvent[];
  readonly aggregates: ScenarioAggregates;
  readonly invariants: ScenarioInvariants;
  readonly runtimeStatus: ScenarioRuntimeStatus;
  readonly stopVariants: StopVariantResults | null;
};

type StopVariantResult = {
  readonly variant: StopVariant;
  readonly status: "passed" | "failed";
  readonly canonicalHash: string;
  readonly preconditionReached: boolean;
  readonly runtimeStopped: boolean;
  readonly laneStopped: boolean;
  readonly schedulerTickRejected: boolean;
  readonly stoppedLaneUpdateRejected: boolean;
  readonly pendingDrained: boolean;
  readonly activeDrained: boolean;
  readonly noPostStopDispatch: boolean;
  readonly homeAcknowledged: boolean;
  readonly homeErrorDeg: StackChanHeadPose;
  readonly homeAcknowledgementCount: number;
};

type StopVariantResults = {
  readonly "track-moving": StopVariantResult;
  readonly "pending-present": StopVariantResult;
  readonly "scan-active": StopVariantResult;
};

type ScenarioHashRecord = Record<ScenarioId, string>;

type ReplayRawScenarioEvidence = {
  readonly canonicalInput: CanonicalScenarioInput;
  readonly events: readonly StackChanAttentionReplayEvent[];
  readonly legacyRuntimeStatus?: ScenarioRuntimeStatus;
};

export type StackChanAttentionReplayValidationMode = "qualified" | "historical-normalized";

type ReplayReductionOptions = {
  readonly evidenceKind: StackChanAttentionReplayValidationMode;
  readonly runtimeEvidenceSource: "recorded-final-events" | "legacy-scenario-status";
  readonly producerSourceHash: string | null;
  readonly quantizationMode?: StackChanAttentionReplayStepQuantization;
  readonly contractSourceHashes?: StackChanAttentionReplayContractSourceHashes;
};

export type StackChanAttentionReplayContractSourceHashes = {
  readonly metricImplementationHash: string;
  readonly producerSourceHash: string;
};

type ReplayContractHashes = Pick<
  StackChanAttentionReplayReport,
  | "reportSchemaHash"
  | "eventSchemaHash"
  | "metricDefinitionHash"
  | "metricImplementationHash"
  | "acceptanceProfileHash"
  | "fixtureHash"
  | "scenarioInputHash"
  | "producerSourceHash"
  | "comparisonSetHash"
>;

export type StackChanAttentionReplayReport = {
  readonly schemaVersion: 7;
  readonly evidenceKind: "qualified" | "historical-normalized";
  readonly runtimeEvidenceSource: "recorded-final-events" | "legacy-scenario-status";
  readonly status: "passed" | "failed";
  readonly reportSchemaHash: string;
  readonly eventSchemaHash: string;
  readonly metricDefinitionHash: string;
  readonly metricImplementationHash: string;
  readonly acceptanceProfileHash: string;
  readonly fixtureHash: string;
  readonly scenarioInputHash: string;
  readonly producerSourceHash: string | null;
  readonly comparisonSetHash: string;
  readonly metadata: {
    readonly runtimeFactory: "createStackChanAttentionRuntime";
    readonly clock: "virtual-monotonic";
    readonly quantizationMode: StackChanAttentionReplayStepQuantization;
    readonly motionEvidence: "virtual-confirmed-not-physical";
    readonly fixture: ReturnType<typeof createReplayFixture>;
    readonly percentile: {
      readonly method: "nearest-rank";
      readonly definition: "sorted[ceil(q*n)-1]";
      readonly quantiles: readonly [0.5, 0.9, 0.95, 0.99];
    };
    readonly roughnessDefinition: "sum(abs(delta[k]-delta[k-1]))/max(sum(abs(delta[k])),1deg)";
    readonly derivativeRule: "dt<=0 fails the run";
    readonly gateway: {
      readonly absoluteRequests: true;
      readonly reclampFromPlannedPose: true;
      readonly maximumActiveCalls: typeof STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS;
      readonly quantizationDeg: 1;
      readonly pendingPolicy: "latest-wins";
      readonly homeDispatch: "adapter-only-after-lane-stop";
    };
  };
  readonly scenarios: readonly StackChanAttentionReplayScenario[];
  readonly repeatDeterminism: {
    readonly requested: number;
    readonly deterministic: boolean;
    readonly evidenceRuns: readonly (readonly Omit<
      ReplayRawScenarioEvidence,
      "legacyRuntimeStatus"
    >[])[];
    readonly canonicalHashes: readonly string[];
    readonly scenarioHashes: readonly ScenarioHashRecord[];
    readonly comparisonSetHashes: readonly string[];
  };
};

type ReplayAcceptanceCheckSpec =
  (typeof STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.checks)[number];
type ReplayAcceptanceValue = number | boolean | null;
type ReplayAcceptanceFailureReason =
  | "invalid-value"
  | "negative-value"
  | "non-finite-value"
  | "null-value"
  | "threshold-not-met"
  | "zero-baseline";

export type StackChanAttentionReplayAcceptanceCheckVerdict = {
  readonly id: ReplayAcceptanceCheckSpec["id"];
  readonly kind: ReplayAcceptanceCheckSpec["kind"];
  readonly scenarioId: ReplayAcceptanceCheckSpec["scenarioId"];
  readonly metric: ReplayAcceptanceCheckSpec["metric"];
  readonly rule: ReplayAcceptanceCheckSpec["rule"];
  readonly status: "passed" | "failed";
  readonly baselineValue: ReplayAcceptanceValue;
  readonly candidateValue: ReplayAcceptanceValue;
  readonly observedRegressionRatio: number | null;
  readonly failureReason: ReplayAcceptanceFailureReason | null;
};

export type StackChanAttentionReplayAcceptanceVerdict = {
  readonly verdictVersion: 1;
  readonly status: "accepted" | "rejected";
  readonly acceptanceProfileVersion: 6;
  readonly acceptanceProfileHash: string;
  readonly comparisonSetHash: string;
  readonly baselineCanonicalReportHash: string;
  readonly candidateCanonicalReportHash: string;
  readonly checks: readonly StackChanAttentionReplayAcceptanceCheckVerdict[];
};

export type StackChanAttentionReplayCliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type StackChanAttentionReplayDependencies = {
  readonly createRuntime?: (
    options: CreateStackChanAttentionRuntimeOptions
  ) => StackChanAttentionRuntime;
  readonly postStopProbe?: (
    probe: ReplayPostStopProbe,
    context: {
      readonly id: ScenarioId;
      readonly variant: StopVariant | null;
    }
  ) => ReplayPostStopProbe | null;
};

type MutableCounters = {
  accepted: number;
  replaced: number;
  dispatched: number;
  confirmed: number;
  failed: number;
  staleDiscarded: number;
  noOpDiscarded: number;
  maximumPendingDepth: number;
  maximumActiveCalls: number;
  postStopDispatches: number;
  postStopDispatchAttempts: number;
};

type PendingTarget = {
  readonly sequence: number;
  readonly pose: StackChanHeadPose;
  readonly acceptedAtMs: number;
};

type ActiveCommand = {
  readonly sequence: number;
  readonly requestPose: StackChanHeadPose;
  readonly dispatchedPose: StackChanHeadPose;
  readonly completesAtMs: number;
};

type MutableTickRecord = {
  frameSequence: number | null;
  targetWorldPose: StackChanHeadPose | null;
  targetSegmentIndex: number | null;
  detectorState: DetectorState | null;
  targetErrorDeg: StackChanHeadPose | null;
  requestSequence: number | null;
  requestedPose: StackChanHeadPose | null;
  dispatchSequence: number | null;
  dispatchedRequestPose: StackChanHeadPose | null;
  dispatchedPose: StackChanHeadPose | null;
  confirmedSequence: number | null;
  noOpDiscardedSequence: number | null;
  confirmedBeforeDispatch: StackChanHeadPose;
  plannedBeforeDispatch: StackChanHeadPose;
  decision: StackChanAttentionDecisionDiagnostic | null;
  clear: boolean;
};

type VirtualClock = {
  nowMs: number;
};

type VirtualDevice = {
  pose: StackChanHeadPose;
  stopHomeAcknowledgement: {
    readonly acknowledgedAtMs: number;
    readonly pose: StackChanHeadPose;
  } | null;
};

type VirtualLane = {
  readonly client: StackChanHeadTargetLane;
  readonly counters: MutableCounters;
  readonly status: () => StackChanHeadTargetStatus;
  readonly pendingAgeMs: () => number | null;
  readonly generation: () => number;
};

type EventRecorder = {
  readonly beginTick: () => void;
  readonly activeTick: () => MutableTickRecord;
  readonly recordDecision: (diagnostic: StackChanAttentionDecisionDiagnostic) => void;
  readonly finishTick: (
    runtimeStatus: StackChanAttentionStatus,
    lane: VirtualLane,
    variant: StopVariant | null
  ) => void;
  readonly finishStop: (
    runtimeStatus: StackChanAttentionStatus,
    lane: VirtualLane,
    variant: StopVariant | null,
    home: boolean,
    homeAcknowledgement: VirtualDevice["stopHomeAcknowledgement"],
    stopRequestedAtMs: number,
    postStopProbe: ReplayPostStopProbe | null
  ) => void;
  readonly events: StackChanAttentionReplayEvent[];
};

type RuntimeRunResult = {
  readonly events: readonly StackChanAttentionReplayEvent[];
  readonly runtimeStatus: ScenarioRuntimeStatus;
};

type ReplayRuntimeTiming = {
  readonly frameIntervalMs: number;
  readonly deviceCommandDurationMs: number;
};

const defaultReplayRuntimeTiming: ReplayRuntimeTiming = {
  frameIntervalMs: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs,
  deviceCommandDurationMs: STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs
};

const emptyLatencyDistribution: StackChanLatencyDistribution = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0
};
const frameBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const leaseId = "attention-replay";

const staticBoundaryProbes: readonly StaticBoundaryProbeInput[] = (
  ["yaw", "pitch"] as const
).flatMap((axis) =>
  ([-1, 1] as const).flatMap((initialSign) =>
    ([0.09, 0.11, 0.13, 0.15] as const).map((normalizedError) => ({
      probeId: `${axis}-${initialSign === -1 ? "negative" : "positive"}-${normalizedError}`,
      axis,
      initialSign,
      normalizedError
    }))
  )
);

const canonicalScenarioInputs: readonly CanonicalScenarioInput[] = [
  {
    id: "static-hold",
    probes: staticBoundaryProbes
  },
  {
    id: "slow-continuous-tracking",
    durationMs: 6_000,
    world: [
      {
        atMs: 0,
        pose: { yaw: 0, pitch: 33 },
        occluded: false,
        interpolation: "linear"
      },
      {
        atMs: 2_000,
        pose: { yaw: 16, pitch: 37 },
        occluded: false,
        interpolation: "linear"
      },
      {
        atMs: 4_000,
        pose: { yaw: -12, pitch: 29 },
        occluded: false,
        interpolation: "linear"
      },
      { atMs: 6_000, pose: { yaw: 0, pitch: 33 }, occluded: false }
    ]
  },
  {
    id: "fast-reversals",
    durationMs: 24_000,
    world: [
      { atMs: 0, pose: { yaw: -8, pitch: 33 }, occluded: false },
      { atMs: 125, pose: { yaw: 8, pitch: 33 }, occluded: false },
      { atMs: 250, pose: { yaw: -8, pitch: 33 }, occluded: false },
      ...Array.from({ length: 15 }, (_, index) => ({
        atMs: (index + 1) * 1_500,
        pose: {
          yaw: index % 2 === 0 ? 8 : -8,
          pitch: 33
        },
        occluded: false
      }))
    ]
  },
  {
    id: "target-loss-reacquisition",
    durationMs: 22_000,
    world: [
      { atMs: 0, pose: { yaw: -20, pitch: 33 }, occluded: false },
      { atMs: 1_500, pose: { yaw: -20, pitch: 33 }, occluded: true },
      { atMs: 2_500, pose: { yaw: 35, pitch: 33 }, occluded: false }
    ]
  },
  {
    id: "stop-home",
    variants: [
      {
        variant: "track-moving",
        durationMs: 375,
        world: [{ atMs: 0, pose: { yaw: 30, pitch: 43 }, occluded: false }]
      },
      {
        variant: "pending-present",
        durationMs: 250,
        world: [
          { atMs: 0, pose: { yaw: -30, pitch: 23 }, occluded: false },
          { atMs: 125, pose: { yaw: 30, pitch: 43 }, occluded: false },
          { atMs: 250, pose: { yaw: -30, pitch: 23 }, occluded: false }
        ]
      },
      {
        variant: "scan-active",
        durationMs: 250,
        world: [{ atMs: 0, pose: { yaw: 0, pitch: 33 }, occluded: true }]
      }
    ]
  }
];

function parseReplayStepQuantization(
  value: unknown,
  path: string
): StackChanAttentionReplayStepQuantization {
  if (value === "round" || value === "error-feedback") {
    return value;
  }
  throw new Error(`${path} must be round or error-feedback`);
}

export function parseStackChanAttentionReplayArguments(
  arguments_: readonly string[]
): StackChanAttentionReplayOptions {
  const values = parseNamedArguments(arguments_);
  const unknownArgument = [...values.keys()].find(
    (name) =>
      name !== "--report-output" &&
      name !== "--repeat" &&
      name !== "--producer-source-hash" &&
      name !== "--step-quantization"
  );
  if (unknownArgument !== undefined) {
    throw new Error(`${unknownArgument} is not supported`);
  }
  if (values.size !== 3 && values.size !== 4) {
    throw new Error("attention replay arguments are invalid");
  }
  const reportOutput = requireArgument(values, "--report-output");
  if (!isAbsolute(reportOutput)) {
    throw new Error("--report-output must be an absolute path");
  }
  const repeat = Number(requireArgument(values, "--repeat"));
  if (repeat !== 3) {
    throw new Error("--repeat must be exactly 3 for qualified evidence");
  }
  const producerSourceHash = requireArgument(values, "--producer-source-hash");
  if (!/^[a-f0-9]{64}$/u.test(producerSourceHash)) {
    throw new Error("--producer-source-hash must be a lowercase SHA-256 digest");
  }
  const stepQuantization = parseReplayStepQuantization(
    values.get("--step-quantization") ?? STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.stepQuantization,
    "--step-quantization"
  );
  return { reportOutput, repeat, producerSourceHash, stepQuantization };
}

export async function runStackChanAttentionReplay(
  options: StackChanAttentionReplayOptions,
  dependencies: StackChanAttentionReplayDependencies = {}
): Promise<StackChanAttentionReplayReport> {
  requireHash(options.producerSourceHash, "options.producerSourceHash");
  const contractSourceHashes = {
    metricImplementationHash: hashFile(fileURLToPath(import.meta.url)),
    producerSourceHash: options.producerSourceHash
  };
  const report = await produceStackChanAttentionReplay(
    options.repeat,
    dependencies,
    contractSourceHashes,
    parseReplayStepQuantization(
      options.stepQuantization ?? STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.stepQuantization,
      "options.stepQuantization"
    )
  );
  validateStackChanAttentionReplayReport(report, "qualified", contractSourceHashes);
  await writeAtomicJsonReport(options.reportOutput, report);
  return report;
}

async function produceStackChanAttentionReplay(
  repeat: number,
  dependencies: StackChanAttentionReplayDependencies,
  contractSourceHashes: StackChanAttentionReplayContractSourceHashes,
  stepQuantization: StackChanAttentionReplayStepQuantization
): Promise<StackChanAttentionReplayReport> {
  const createRuntime = dependencies.createRuntime ?? createStackChanAttentionRuntime;
  const repeatedScenarios: StackChanAttentionReplayScenario[][] = [];
  for (let index = 0; index < repeat; index += 1) {
    repeatedScenarios.push(
      await runAllScenarios(createRuntime, dependencies.postStopProbe, stepQuantization)
    );
  }
  return reduceStackChanAttentionReplayEvidence(
    repeatedScenarios.map((scenarios) => scenarios.map(extractRawScenarioEvidence)),
    repeat,
    {
      evidenceKind: "qualified",
      runtimeEvidenceSource: "recorded-final-events",
      producerSourceHash: contractSourceHashes.producerSourceHash,
      quantizationMode: stepQuantization,
      contractSourceHashes
    }
  );
}

export async function verifyQualifiedReplayAgainstFreshCurrentProducer(
  value: unknown,
  contractSourceHashes?: StackChanAttentionReplayContractSourceHashes
): Promise<{
  readonly freshReport: StackChanAttentionReplayReport;
  readonly candidateCanonicalSha256: string;
  readonly freshCanonicalSha256: string;
}> {
  validateStackChanAttentionReplayReport(value, "qualified", contractSourceHashes);
  const report = value as StackChanAttentionReplayReport;
  if (report.status !== "passed") {
    throw new Error("attention replay qualified report did not pass");
  }
  if (report.producerSourceHash === null) {
    throw new Error("attention replay qualified report producer source hash is missing");
  }
  const freshContractSourceHashes = contractSourceHashes ?? {
    metricImplementationHash: hashFile(fileURLToPath(import.meta.url)),
    producerSourceHash: report.producerSourceHash
  };
  const fresh = await produceStackChanAttentionReplay(
    3,
    {},
    freshContractSourceHashes,
    report.metadata.quantizationMode
  );
  validateStackChanAttentionReplayReport(fresh, "qualified", freshContractSourceHashes);
  if (fresh.status !== "passed") {
    throw new Error("attention replay fresh current producer did not pass");
  }
  const candidateCanonicalJson = canonicalJson(report);
  const freshCanonicalJson = canonicalJson(fresh);
  if (candidateCanonicalJson !== freshCanonicalJson) {
    throw new Error("attention replay qualified report does not match fresh current producer");
  }
  return {
    freshReport: fresh,
    candidateCanonicalSha256: createHash("sha256").update(candidateCanonicalJson).digest("hex"),
    freshCanonicalSha256: createHash("sha256").update(freshCanonicalJson).digest("hex")
  };
}

// Contract hashing and repeat agreement are intentionally evaluated at one boundary.
// eslint-disable-next-line complexity
export function reduceStackChanAttentionReplayEvidence(
  repeatedEvidence: readonly (readonly ReplayRawScenarioEvidence[])[],
  requestedRepeat: number,
  options: ReplayReductionOptions
): StackChanAttentionReplayReport {
  if (repeatedEvidence.length === 0) {
    throw new Error("attention replay evidence is empty");
  }
  if (requestedRepeat !== repeatedEvidence.length) {
    throw new Error("attention replay requested repeat mismatch");
  }
  if (
    (options.evidenceKind === "qualified" && requestedRepeat !== 3) ||
    (options.evidenceKind === "historical-normalized" && requestedRepeat !== 1)
  ) {
    throw new Error("attention replay evidence repeat contract mismatch");
  }
  if (options.evidenceKind === "qualified") {
    requireHash(options.producerSourceHash, "options.producerSourceHash");
  } else if (options.producerSourceHash !== null) {
    throw new Error("historical replay producer source hash must be null");
  }
  for (const run of repeatedEvidence) {
    assertReplayEvidenceRoster(run, options.evidenceKind);
  }
  const reducedRuns = repeatedEvidence.map((run) =>
    run.map((evidence) => reduceRawScenarioEvidence(evidence, options.runtimeEvidenceSource))
  );
  const canonicalHashes = reducedRuns.map(canonicalHash);
  const scenarioHashes = reducedRuns.map(createScenarioHashRecord);
  const firstEvidence = repeatedEvidence[0] ?? [];
  const scenarioInputs = firstEvidence.map((evidence) => evidence.canonicalInput);
  if (
    repeatedEvidence.some(
      (run) =>
        canonicalHash(run.map((evidence) => evidence.canonicalInput)) !==
        canonicalHash(scenarioInputs)
    )
  ) {
    throw new Error("attention replay scenario input mismatch");
  }
  const hashes = createReplayContractHashes(
    scenarioInputs,
    options.producerSourceHash,
    options.contractSourceHashes
  );
  const comparisonSetHashes = reducedRuns.map(() => hashes.comparisonSetHash);
  const evidenceRuns = repeatedEvidence.map((run) =>
    run.map((evidence) => ({
      canonicalInput: evidence.canonicalInput,
      events: evidence.events
    }))
  );
  const deterministic =
    canonicalHashes.every((hash) => hash === canonicalHashes[0]) &&
    scenarioHashes.every(
      (hashes_) => canonicalHash(hashes_) === canonicalHash(scenarioHashes[0])
    ) &&
    comparisonSetHashes.every((hash) => hash === comparisonSetHashes[0]);
  const scenarios = reducedRuns[0] ?? [];
  const quantizationMode =
    options.quantizationMode ?? STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.stepQuantization;
  return {
    schemaVersion: 7,
    evidenceKind: options.evidenceKind,
    runtimeEvidenceSource: options.runtimeEvidenceSource,
    status:
      deterministic && scenarios.every((scenario) => scenario.status === "passed")
        ? "passed"
        : "failed",
    ...hashes,
    producerSourceHash: options.producerSourceHash,
    metadata: createMetadata(quantizationMode),
    scenarios,
    repeatDeterminism: {
      requested: requestedRepeat,
      deterministic,
      evidenceRuns,
      canonicalHashes,
      scenarioHashes,
      comparisonSetHashes
    }
  };
}

function assertReplayEvidenceRoster(
  evidence: readonly ReplayRawScenarioEvidence[],
  evidenceKind: StackChanAttentionReplayValidationMode
): void {
  if (evidence.length !== canonicalScenarioInputs.length) {
    throw new Error("attention replay canonical scenario count mismatch");
  }
  for (const [index, scenario] of evidence.entries()) {
    const expected = canonicalScenarioInputs[index];
    if (expected === undefined) {
      throw new Error("attention replay canonical scenario order mismatch");
    }
    assertReplayScenarioInput(scenario.canonicalInput, expected, evidenceKind);
  }
}

function assertReplayScenarioInput(
  actual: CanonicalScenarioInput,
  expected: CanonicalScenarioInput,
  evidenceKind: StackChanAttentionReplayValidationMode
): void {
  if (actual.id !== expected.id) {
    throw new Error("attention replay canonical scenario order mismatch");
  }
  if (evidenceKind === "qualified" && canonicalHash(actual) !== canonicalHash(expected)) {
    throw new Error(`attention replay ${expected.id} canonical input mismatch`);
  }
  if (actual.id === "stop-home") {
    assertReplayStopVariantRoster(actual);
  }
}

function assertReplayStopVariantRoster(input: StopHomeScenarioInput): void {
  const variants = input.variants.map((variant) => variant.variant);
  const expectedVariants = ["track-moving", "pending-present", "scan-active"] as const;
  if (canonicalHash(variants) !== canonicalHash(expectedVariants)) {
    throw new Error("attention replay stop variant order mismatch");
  }
}

function extractRawScenarioEvidence(
  scenario: StackChanAttentionReplayScenario
): ReplayRawScenarioEvidence {
  return {
    canonicalInput: scenario.canonicalInput,
    events: scenario.events
  };
}

function reduceRawScenarioEvidence(
  evidence: ReplayRawScenarioEvidence,
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"]
): StackChanAttentionReplayScenario {
  const input = evidence.canonicalInput;
  const events = evidence.events;
  const runtimeStatus =
    runtimeEvidenceSource === "recorded-final-events"
      ? reduceRecordedRuntimeStatus(input, events)
      : requireLegacyRuntimeStatus(evidence);
  return reduceStackChanAttentionReplayScenarioEvidence(
    input,
    events,
    runtimeStatus,
    {
      lossWindows:
        input.id === "target-loss-reacquisition" ? createLossWindows(events, input.world) : [],
      stopVariants:
        input.id === "stop-home"
          ? reduceStopVariantResults(events, input, runtimeEvidenceSource, runtimeStatus)
          : null
    },
    runtimeEvidenceSource
  );
}

function reduceStopVariantResults(
  events: readonly StackChanAttentionReplayEvent[],
  input: StopHomeScenarioInput,
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"],
  legacyRuntimeStatus: ScenarioRuntimeStatus
): StopVariantResults {
  const byVariant = (variant: StopVariant): StackChanAttentionReplayEvent[] =>
    events.filter((event) => event.variant === variant);
  const runtimeStatusFor = (variant: StopVariant): ScenarioRuntimeStatus => {
    if (runtimeEvidenceSource === "legacy-scenario-status") {
      return legacyRuntimeStatus;
    }
    const variantInput = input.variants.find((candidate) => candidate.variant === variant);
    if (variantInput === undefined) {
      throw new Error(`attention replay missing stop input ${variant}`);
    }
    return reduceRecordedRuntimeStatus(variantInput, byVariant(variant));
  };
  return {
    "track-moving": evaluateStopVariant(
      "track-moving",
      byVariant("track-moving"),
      runtimeStatusFor("track-moving")
    ),
    "pending-present": evaluateStopVariant(
      "pending-present",
      byVariant("pending-present"),
      runtimeStatusFor("pending-present")
    ),
    "scan-active": evaluateStopVariant(
      "scan-active",
      byVariant("scan-active"),
      runtimeStatusFor("scan-active")
    )
  };
}

function createReplayContractHashes(
  scenarioInputs: readonly CanonicalScenarioInput[],
  producerSourceHash: string | null,
  contractSourceHashes?: StackChanAttentionReplayContractSourceHashes
): ReplayContractHashes {
  const schema = loadStackChanAttentionReplaySchema();
  const reportSchemaHash = stackChanAttentionReplaySchemaHash(schema);
  const eventSchemaHash = stackChanAttentionReplayEventSchemaHash(schema);
  const metricDefinitionHash = canonicalHash(STACKCHAN_ATTENTION_REPLAY_METRIC_DEFINITIONS);
  const metricImplementationHash =
    contractSourceHashes?.metricImplementationHash ?? hashFile(fileURLToPath(import.meta.url));
  const acceptanceProfileHash = canonicalHash(STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE);
  const fixtureHash = canonicalHash(createComparisonFixture());
  const scenarioInputHash = canonicalHash(scenarioInputs);
  const comparisonSetHash = canonicalHash({
    reportSchemaHash,
    eventSchemaHash,
    metricDefinitionHash,
    metricImplementationHash,
    acceptanceProfileHash,
    fixtureHash,
    scenarioInputHash
  });
  return {
    reportSchemaHash,
    eventSchemaHash,
    metricDefinitionHash,
    metricImplementationHash,
    acceptanceProfileHash,
    fixtureHash,
    scenarioInputHash,
    producerSourceHash,
    comparisonSetHash
  };
}

function createComparisonFixture(): unknown {
  return {
    ...STACKCHAN_ATTENTION_REPLAY_FIXTURE,
    follow: Object.fromEntries(
      Object.entries(STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow).filter(
        ([key]) => key !== "stepQuantization"
      )
    )
  };
}

export function normalizeStackChanAttentionReplayReport(
  value: unknown
): StackChanAttentionReplayReport {
  const report = requireRecord(value, "report");
  const scenarios = requireArray(report.scenarios, "report.scenarios").map(
    (candidate, index): ReplayRawScenarioEvidence => {
      const scenario = requireRecord(candidate, `report.scenarios[${index}]`);
      return {
        canonicalInput: normalizeCanonicalInput(
          scenario.canonicalInput,
          `report.scenarios[${index}].canonicalInput`
        ),
        events: requireArray(scenario.events, `report.scenarios[${index}].events`).map(
          (event, eventIndex) =>
            normalizeReplayEvent(event, `report.scenarios[${index}].events[${eventIndex}]`)
        ),
        legacyRuntimeStatus: normalizeRuntimeStatus(
          scenario.runtimeStatus,
          `report.scenarios[${index}].runtimeStatus`
        )
      };
    }
  );
  return reduceStackChanAttentionReplayEvidence([scenarios], 1, {
    evidenceKind: "historical-normalized",
    runtimeEvidenceSource: "legacy-scenario-status",
    producerSourceHash: null,
    quantizationMode: inferReplayQuantizationMode(report)
  });
}

export function assertStackChanAttentionReplayReportsComparable(
  baseline: StackChanAttentionReplayReport,
  candidate: StackChanAttentionReplayReport,
  validationMode: StackChanAttentionReplayValidationMode = "qualified",
  contractSourceHashes?: StackChanAttentionReplayContractSourceHashes
): void {
  validateStackChanAttentionReplayReport(baseline, validationMode, contractSourceHashes);
  validateStackChanAttentionReplayReport(candidate, validationMode, contractSourceHashes);
  for (const field of [
    "reportSchemaHash",
    "eventSchemaHash",
    "metricDefinitionHash",
    "metricImplementationHash",
    "acceptanceProfileHash",
    "fixtureHash",
    "scenarioInputHash",
    "comparisonSetHash"
  ] as const) {
    if (baseline[field] !== candidate[field]) {
      throw new Error(`attention replay comparison ${field} mismatch`);
    }
  }
}

export function evaluateStackChanAttentionReplayAcceptance(
  baseline: StackChanAttentionReplayReport,
  candidate: StackChanAttentionReplayReport,
  contractSourceHashes?: StackChanAttentionReplayContractSourceHashes
): StackChanAttentionReplayAcceptanceVerdict {
  assertStackChanAttentionReplayReportsComparable(
    baseline,
    candidate,
    "qualified",
    contractSourceHashes
  );
  const checks = STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.checks.map((spec) =>
    evaluateReplayAcceptanceCheck(
      spec,
      readReplayAcceptanceMetric(baseline, spec),
      readReplayAcceptanceMetric(candidate, spec)
    )
  );
  return {
    verdictVersion: 1,
    status: checks.every((check) => check.status === "passed") ? "accepted" : "rejected",
    acceptanceProfileVersion: STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.version,
    acceptanceProfileHash: candidate.acceptanceProfileHash,
    comparisonSetHash: candidate.comparisonSetHash,
    baselineCanonicalReportHash: canonicalHash(baseline),
    candidateCanonicalReportHash: canonicalHash(candidate),
    checks
  };
}

function readReplayAcceptanceMetric(
  report: StackChanAttentionReplayReport,
  spec: ReplayAcceptanceCheckSpec
): unknown {
  const scenario = report.scenarios.find((candidate) => candidate.id === spec.scenarioId);
  if (scenario === undefined) {
    return undefined;
  }
  let value: unknown = scenario;
  for (const segment of spec.metric.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function evaluateReplayAcceptanceCheck(
  spec: ReplayAcceptanceCheckSpec,
  baselineRaw: unknown,
  candidateRaw: unknown
): StackChanAttentionReplayAcceptanceCheckVerdict {
  const baseline = normalizeReplayAcceptanceValue(baselineRaw);
  const candidate = normalizeReplayAcceptanceValue(candidateRaw);
  const inputFailure = baseline.failureReason ?? candidate.failureReason;
  if (inputFailure !== null) {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baseline.value,
      candidate.value,
      null,
      inputFailure
    );
  }
  if (spec.rule.type === "absolute-boolean") {
    return evaluateReplayAcceptanceBooleanCheck(
      spec,
      baseline.value,
      candidate.value,
      spec.rule.expected
    );
  }
  if (typeof baseline.value !== "number" || typeof candidate.value !== "number") {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baseline.value,
      candidate.value,
      null,
      "invalid-value"
    );
  }
  return evaluateReplayAcceptanceNumericCheck(spec, baseline.value, candidate.value);
}

function evaluateReplayAcceptanceBooleanCheck(
  spec: ReplayAcceptanceCheckSpec,
  baselineValue: ReplayAcceptanceValue,
  candidateValue: ReplayAcceptanceValue,
  expected: boolean
): StackChanAttentionReplayAcceptanceCheckVerdict {
  const passed =
    typeof baselineValue === "boolean" &&
    typeof candidateValue === "boolean" &&
    candidateValue === expected;
  return createReplayAcceptanceCheckVerdict(
    spec,
    baselineValue,
    candidateValue,
    null,
    passed ? null : "threshold-not-met"
  );
}

function evaluateReplayAcceptanceNumericCheck(
  spec: ReplayAcceptanceCheckSpec,
  baselineValue: number,
  candidateValue: number
): StackChanAttentionReplayAcceptanceCheckVerdict {
  if (spec.rule.type === "absolute-maximum") {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      acceptanceThresholdFailure(candidateValue <= spec.rule.maximum)
    );
  }
  if (spec.rule.type === "absolute-minimum") {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      acceptanceThresholdFailure(candidateValue >= spec.rule.minimum)
    );
  }
  if (spec.rule.type === "maximum-absolute-drop") {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      acceptanceThresholdFailure(candidateValue >= baselineValue - spec.rule.maximumDrop)
    );
  }
  if (spec.rule.type === "absolute-boolean") {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      "invalid-value"
    );
  }
  if (baselineValue === 0) {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      "zero-baseline"
    );
  }
  const observedRegressionRatio = (candidateValue - baselineValue) / baselineValue;
  if (!Number.isFinite(observedRegressionRatio)) {
    return createReplayAcceptanceCheckVerdict(
      spec,
      baselineValue,
      candidateValue,
      null,
      "non-finite-value"
    );
  }
  return createReplayAcceptanceCheckVerdict(
    spec,
    baselineValue,
    candidateValue,
    observedRegressionRatio,
    acceptanceThresholdFailure(observedRegressionRatio <= spec.rule.maximumRatio)
  );
}

function acceptanceThresholdFailure(passed: boolean): "threshold-not-met" | null {
  return passed ? null : "threshold-not-met";
}

function normalizeReplayAcceptanceValue(value: unknown): {
  readonly value: ReplayAcceptanceValue;
  readonly failureReason: ReplayAcceptanceFailureReason | null;
} {
  if (value === null) {
    return { value, failureReason: "null-value" };
  }
  if (typeof value === "boolean") {
    return { value, failureReason: null };
  }
  if (typeof value !== "number") {
    return { value: null, failureReason: "invalid-value" };
  }
  if (!Number.isFinite(value)) {
    return { value: null, failureReason: "non-finite-value" };
  }
  if (value < 0) {
    return { value, failureReason: "negative-value" };
  }
  return { value, failureReason: null };
}

function createReplayAcceptanceCheckVerdict(
  spec: ReplayAcceptanceCheckSpec,
  baselineValue: ReplayAcceptanceValue,
  candidateValue: ReplayAcceptanceValue,
  observedRegressionRatio: number | null,
  failureReason: ReplayAcceptanceFailureReason | null
): StackChanAttentionReplayAcceptanceCheckVerdict {
  return {
    id: spec.id,
    kind: spec.kind,
    scenarioId: spec.scenarioId,
    metric: spec.metric,
    rule: spec.rule,
    status: failureReason === null ? "passed" : "failed",
    baselineValue,
    candidateValue,
    observedRegressionRatio,
    failureReason
  };
}

function normalizeCanonicalInput(value: unknown, path: string): CanonicalScenarioInput {
  const input = structuredClone(requireRecord(value, path));
  if (input.id === "stop-home") {
    const variants = requireArray(input.variants, `${path}.variants`);
    input.variants = variants.map((candidate, index) => {
      const variant = requireRecord(candidate, `${path}.variants[${index}]`);
      return {
        ...variant,
        variant: normalizeStopVariant(variant.variant, `${path}.variants[${index}].variant`)
      };
    });
  }
  if (!isScenarioId(input.id)) {
    throw new Error(`${path}.id is invalid`);
  }
  return input as CanonicalScenarioInput;
}

function normalizeReplayEvent(value: unknown, path: string): StackChanAttentionReplayEvent {
  const source = requireRecord(value, path);
  const targetErrorDeg = normalizeNullablePose(source.targetErrorDeg, `${path}.targetErrorDeg`);
  const counters = requireRecord(source.counters, `${path}.counters`);
  return {
    ...(source as StackChanAttentionReplayEvent),
    variant:
      source.variant === null ? null : normalizeStopVariant(source.variant, `${path}.variant`),
    targetErrorDeg,
    targetNormalizedError:
      source.targetNormalizedError === undefined
        ? targetErrorDeg === null
          ? null
          : {
              yaw: roundSixDecimals(
                targetErrorDeg.yaw / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw
              ),
              pitch: roundSixDecimals(
                targetErrorDeg.pitch / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch
              )
            }
        : normalizeNullablePose(source.targetNormalizedError, `${path}.targetNormalizedError`),
    probeId:
      source.probeId === undefined
        ? null
        : source.probeId === null || typeof source.probeId === "string"
          ? source.probeId
          : (() => {
              throw new Error(`${path}.probeId is invalid`);
            })(),
    isProbeObservation:
      source.isProbeObservation === undefined
        ? false
        : requireBoolean(source.isProbeObservation, `${path}.isProbeObservation`),
    decision: null,
    noOpDiscardedSequence: normalizeOptionalNonnegativeInteger(
      source.noOpDiscardedSequence,
      `${path}.noOpDiscardedSequence`
    ),
    counters: {
      ...(counters as LaneCounters),
      noOpDiscarded: normalizeOptionalCounter(
        counters.noOpDiscarded,
        `${path}.counters.noOpDiscarded`
      )
    },
    finalRuntimeEvidence: null
  };
}

function normalizeOptionalNonnegativeInteger(value: unknown, path: string): number | null {
  return value === undefined || value === null ? null : requireNonnegativeInteger(value, path);
}

function normalizeOptionalCounter(value: unknown, path: string): number {
  return value === undefined ? 0 : requireNonnegativeInteger(value, path);
}

function normalizeRuntimeStatus(value: unknown, path: string): ScenarioRuntimeStatus {
  return structuredClone(requireRecord(value, path)) as ScenarioRuntimeStatus;
}

function normalizeStopVariant(value: unknown, path: string): StopVariant {
  if (value === "track-moving") {
    return value;
  }
  if (value === "pending" || value === "pending-present") {
    return "pending-present";
  }
  if (value === "scan" || value === "scan-active") {
    return "scan-active";
  }
  throw new Error(`${path} is invalid`);
}

function inferReplayQuantizationMode(
  report: Readonly<Record<string, unknown>>
): StackChanAttentionReplayStepQuantization {
  const metadata = optionalReplayRecord(report.metadata);
  const fixture = optionalReplayRecord(metadata?.fixture);
  const follow = optionalReplayRecord(fixture?.follow);
  return parseReplayStepQuantization(
    metadata?.quantizationMode ??
      follow?.stepQuantization ??
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.stepQuantization,
    "report.metadata.quantizationMode"
  );
}

function optionalReplayRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? undefined
    : (value as Readonly<Record<string, unknown>>);
}

function isScenarioId(value: unknown): value is ScenarioId {
  return [
    "static-hold",
    "slow-continuous-tracking",
    "fast-reversals",
    "target-loss-reacquisition",
    "stop-home"
  ].includes(String(value));
}

export async function executeStackChanAttentionReplayCli(
  arguments_: readonly string[],
  io: StackChanAttentionReplayCliIo = {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line)
  },
  dependencies: StackChanAttentionReplayDependencies = {}
): Promise<number> {
  let options: StackChanAttentionReplayOptions;
  try {
    options = parseStackChanAttentionReplayArguments(arguments_);
  } catch {
    io.stderr('{"status":"failed","code":"invalid_arguments"}\n');
    return 1;
  }
  try {
    const report = await runStackChanAttentionReplay(options, dependencies);
    io.stdout(`${JSON.stringify(report)}\n`);
    return report.status === "passed" ? 0 : 1;
  } catch {
    io.stderr('{"status":"failed","code":"execution_failed"}\n');
    return 1;
  }
}

export function summarizeReplayKinematics(
  samples: readonly ReplayPoseSample[]
): ReplayKinematicsSummary {
  requireStrictlyIncreasingTimestamps(samples);
  const positions = samples.map((sample) => ({
    timestampMs: sample.timestampMs,
    yaw: sample.pose.yaw,
    pitch: sample.pose.pitch
  }));
  const velocity = deriveSamples(positions);
  const acceleration = deriveSamples(velocity);
  const jerk = deriveSamples(acceleration);
  return {
    velocity: summarizeDerivative(velocity),
    acceleration: summarizeDerivative(acceleration),
    jerk: summarizeDerivative(jerk),
    normalizedRoughness: {
      yaw: normalizedRoughness(samples.map((sample) => sample.pose.yaw)),
      pitch: normalizedRoughness(samples.map((sample) => sample.pose.pitch)),
      combined: normalizedCombinedRoughness(samples)
    }
  };
}

async function runAllScenarios(
  createRuntime: NonNullable<StackChanAttentionReplayDependencies["createRuntime"]>,
  postStopProbe: StackChanAttentionReplayDependencies["postStopProbe"],
  stepQuantization: StackChanAttentionReplayStepQuantization
): Promise<StackChanAttentionReplayScenario[]> {
  const scenarios: StackChanAttentionReplayScenario[] = [];
  for (const input of canonicalScenarioInputs) {
    scenarios.push(
      input.id === "static-hold" && "probes" in input
        ? await runStaticBoundaryScenario(input, createRuntime, postStopProbe, stepQuantization)
        : input.id === "stop-home"
          ? await runStopHomeScenario(input, createRuntime, postStopProbe, stepQuantization)
          : await runRuntimeScenario(
              input as RuntimeScenarioInput,
              createRuntime,
              postStopProbe,
              stepQuantization
            )
    );
  }
  return scenarios;
}

async function runStaticBoundaryScenario(
  input: StaticBoundaryScenarioInput,
  createRuntime: NonNullable<StackChanAttentionReplayDependencies["createRuntime"]>,
  postStopProbe: StackChanAttentionReplayDependencies["postStopProbe"],
  stepQuantization: StackChanAttentionReplayStepQuantization
): Promise<StackChanAttentionReplayScenario> {
  const events: StackChanAttentionReplayEvent[] = [];
  const statuses: ScenarioRuntimeStatus[] = [];
  let timestampOffsetMs = 0;
  for (const probe of input.probes) {
    const normalizedError = (sign: -1 | 0 | 1): StackChanHeadPose => ({
      yaw: probe.axis === "yaw" ? sign * probe.normalizedError : 0,
      pitch: probe.axis === "pitch" ? sign * probe.normalizedError : 0
    });
    const run = await executeRuntime(
      input.id,
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.staticProbeDurationMs,
      [
        {
          atMs: 0,
          pose: homePose(),
          normalizedError: normalizedError(0),
          occluded: false
        },
        {
          atMs: 125,
          pose: homePose(),
          normalizedError: normalizedError(probe.initialSign),
          occluded: false
        },
        {
          atMs: 250,
          pose: homePose(),
          normalizedError: normalizedError(probe.initialSign === -1 ? 1 : -1),
          occluded: false
        },
        {
          atMs: 375,
          pose: homePose(),
          normalizedError: normalizedError(0),
          occluded: false
        }
      ],
      null,
      createRuntime,
      postStopProbe,
      stepQuantization
    );
    events.push(
      ...offsetReplayEvents(run.events, events.length, timestampOffsetMs).map((event) => ({
        ...event,
        probeId: probe.probeId,
        isProbeObservation: event.frameSequence !== null
      }))
    );
    statuses.push(run.runtimeStatus);
    timestampOffsetMs =
      (events.at(-1)?.timestampMs ?? timestampOffsetMs) +
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs;
  }
  return buildScenario(input, events, combineRuntimeStatuses(statuses), {
    lossWindows: [],
    stopVariants: null
  });
}

async function runRuntimeScenario(
  input: RuntimeScenarioInput,
  createRuntime: NonNullable<StackChanAttentionReplayDependencies["createRuntime"]>,
  postStopProbe: StackChanAttentionReplayDependencies["postStopProbe"],
  stepQuantization: StackChanAttentionReplayStepQuantization
): Promise<StackChanAttentionReplayScenario> {
  const run = await executeRuntime(
    input.id,
    input.durationMs,
    input.world,
    null,
    createRuntime,
    postStopProbe,
    stepQuantization
  );
  const lossWindows =
    input.id === "target-loss-reacquisition"
      ? createLossWindows(run.events, input.world)
      : undefined;
  return buildScenario(input, run.events, run.runtimeStatus, {
    lossWindows: lossWindows ?? [],
    stopVariants: null
  });
}

async function runStopHomeScenario(
  input: StopHomeScenarioInput,
  createRuntime: NonNullable<StackChanAttentionReplayDependencies["createRuntime"]>,
  postStopProbe: StackChanAttentionReplayDependencies["postStopProbe"],
  stepQuantization: StackChanAttentionReplayStepQuantization
): Promise<StackChanAttentionReplayScenario> {
  const events: StackChanAttentionReplayEvent[] = [];
  const statuses: ScenarioRuntimeStatus[] = [];
  const variantResults = {} as Record<StopVariant, StopVariantResult>;
  let timestampOffsetMs = 0;
  for (const variant of input.variants) {
    const run = await executeRuntime(
      input.id,
      variant.durationMs,
      variant.world,
      variant.variant,
      createRuntime,
      postStopProbe,
      stepQuantization
    );
    events.push(...offsetReplayEvents(run.events, events.length, timestampOffsetMs));
    statuses.push(run.runtimeStatus);
    variantResults[variant.variant] = evaluateStopVariant(
      variant.variant,
      run.events,
      run.runtimeStatus
    );
    timestampOffsetMs +=
      (run.events.at(-1)?.timestampMs ?? variant.durationMs) +
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs;
  }
  return buildScenario(input, events, combineRuntimeStatuses(statuses), {
    lossWindows: [],
    stopVariants: {
      "track-moving": requireStopVariantResult(variantResults, "track-moving"),
      "pending-present": requireStopVariantResult(variantResults, "pending-present"),
      "scan-active": requireStopVariantResult(variantResults, "scan-active")
    }
  });
}

function offsetReplayEvents(
  events: readonly StackChanAttentionReplayEvent[],
  sequenceOffset: number,
  timestampOffsetMs: number
): StackChanAttentionReplayEvent[] {
  return events.map((event) => ({
    ...event,
    sequence: sequenceOffset + event.sequence,
    timestampMs: timestampOffsetMs + event.timestampMs,
    decision:
      event.decision === null
        ? null
        : {
            ...event.decision,
            id: sequenceOffset + event.decision.id,
            decisionAtMs: timestampOffsetMs + event.decision.decisionAtMs,
            observedAtMs: timestampOffsetMs + event.decision.observedAtMs
          },
    stopRequestedAtMs:
      event.stopRequestedAtMs === null ? null : timestampOffsetMs + event.stopRequestedAtMs,
    homeAcknowledgedAtMs:
      event.homeAcknowledgedAtMs === null ? null : timestampOffsetMs + event.homeAcknowledgedAtMs
  }));
}

function requireStopVariantResult(
  results: Readonly<Partial<Record<StopVariant, StopVariantResult>>>,
  variant: StopVariant
): StopVariantResult {
  const result = results[variant];
  if (result === undefined) {
    throw new Error(`attention replay missing stop variant ${variant}`);
  }
  return result;
}

// Every stop lifecycle signal remains explicit in the emitted evidence.
// eslint-disable-next-line complexity
function evaluateStopVariant(
  variant: StopVariant,
  events: readonly StackChanAttentionReplayEvent[],
  runtimeStatus: ScenarioRuntimeStatus
): StopVariantResult {
  const stopEvents = events.filter((event) => event.stop);
  const stopEvent = stopEvents[0];
  const probe = stopEvent?.postStopProbe;
  // eslint-disable-next-line complexity
  const preconditionReached = events.some((event) => {
    if (event.stop) {
      return false;
    }
    if (variant === "track-moving") {
      return (
        event.controllerMode === "track" &&
        event.counters.activeCalls === 1 &&
        event.counters.pendingDepth === 0 &&
        event.dispatchedPose !== null
      );
    }
    if (variant === "pending-present") {
      return (
        event.controllerMode === "track" &&
        event.counters.activeCalls === STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS &&
        event.counters.pendingDepth === 1
      );
    }
    return (
      event.controllerMode === "scan" &&
      event.counters.activeCalls === 1 &&
      event.counters.pendingDepth === 0
    );
  });
  const homeAcknowledgements = stopEvents.filter(
    (event) =>
      event.home && event.homeAcknowledgedAtMs !== null && event.homeAcknowledgedPose !== null
  );
  const homeErrorDeg = finalHomeError(events);
  const core = {
    variant,
    preconditionReached,
    runtimeStopped: runtimeStatus.phase === "stopped",
    laneStopped: probe?.lanePhase === "stopped",
    schedulerTickRejected: probe?.schedulerTickRejected === true,
    stoppedLaneUpdateRejected:
      probe?.dispatchAttempts === 1 &&
      probe.dispatchedBefore === probe.dispatchedAfter &&
      probe.confirmedBefore === probe.confirmedAfter,
    pendingDrained: stopEvent?.counters.pendingDepth === 0,
    activeDrained: stopEvent?.counters.activeCalls === 0,
    noPostStopDispatch:
      stopEvent?.counters.postStopDispatches === 0 &&
      probe?.dispatchedBefore === probe?.dispatchedAfter &&
      probe?.confirmedBefore === probe?.confirmedAfter,
    homeAcknowledged:
      homeAcknowledgements.length === 1 && homeErrorDeg.yaw <= 1 && homeErrorDeg.pitch <= 1,
    homeErrorDeg,
    homeAcknowledgementCount: homeAcknowledgements.length
  };
  const passed = Object.values(core)
    .filter((value) => typeof value === "boolean")
    .every(Boolean);
  return {
    ...core,
    status: passed ? "passed" : "failed",
    canonicalHash: canonicalHash(core)
  };
}

async function executeRuntime(
  id: ScenarioId,
  durationMs: number,
  world: readonly WorldKeyframe[],
  variant: StopVariant | null,
  createRuntime: NonNullable<StackChanAttentionReplayDependencies["createRuntime"]>,
  projectPostStopProbe: StackChanAttentionReplayDependencies["postStopProbe"],
  stepQuantization: StackChanAttentionReplayStepQuantization,
  timing: ReplayRuntimeTiming = defaultReplayRuntimeTiming
): Promise<RuntimeRunResult> {
  const clock: VirtualClock = { nowMs: 0 };
  const device: VirtualDevice = {
    pose: homePose(),
    stopHomeAcknowledgement: null
  };
  const recorder = createEventRecorder(clock, id);
  const lane = createVirtualLane(
    clock,
    device,
    recorder,
    variant === "pending-present"
      ? STACKCHAN_ATTENTION_REPLAY_FIXTURE.pendingStopVirtualDeviceCommandDurationMs
      : timing.deviceCommandDurationMs
  );
  const scheduler = createManualScheduler(
    clock,
    async () => {
      await lane.client.status(leaseId);
    },
    timing.frameIntervalMs
  );
  const adapter = createVirtualAdapter(clock, device, recorder, lane);
  const model = createWorldDetector(clock, device, recorder, world);
  const runtime = createRuntime({
    adapter,
    headTargetLane: lane.client,
    model,
    config: {
      ...STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow,
      frameIntervalMs: timing.frameIntervalMs,
      stepQuantization
    },
    scheduler: scheduler.scheduler,
    nowMs: () => clock.nowMs,
    waitMs: () => Promise.resolve(),
    onDecision: recorder.recordDecision
  });
  await runtime.start();

  for (let timestampMs = 0; timestampMs <= durationMs; timestampMs += timing.frameIntervalMs) {
    recorder.beginTick();
    await scheduler.tick(timestampMs);
    recorder.finishTick(runtime.status(), lane, variant);
  }

  clock.nowMs = durationMs + timing.frameIntervalMs;
  const stopRequestedAtMs = clock.nowMs;
  recorder.beginTick();
  await runtime.stop();
  const finalStatus = runtime.status();
  const beforeProbe = lane.status();
  const dispatchAttemptsBeforeProbe = lane.counters.postStopDispatchAttempts;
  const commandRateIntervalMs = 1_000 / STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.commandRateHz;
  clock.nowMs =
    Math.max(clock.nowMs, stopRequestedAtMs + timing.deviceCommandDurationMs) +
    commandRateIntervalMs +
    1;
  let schedulerTickRejected = false;
  try {
    await scheduler.tick(clock.nowMs);
  } catch {
    schedulerTickRejected = true;
  }
  try {
    await lane.client.update({
      leaseId,
      sequence: beforeProbe.accepted + 1,
      pose: homePose()
    });
  } catch {
    // A stopped lane must reject a valid normal update without mutating dispatch state.
  }
  const afterProbe = await lane.client.status(leaseId);
  const actualPostStopProbe: ReplayPostStopProbe = {
    schedulerTickRejected,
    lanePhase: afterProbe.phase,
    dispatchAttempts: lane.counters.postStopDispatchAttempts - dispatchAttemptsBeforeProbe,
    dispatchedBefore: beforeProbe.dispatched,
    dispatchedAfter: afterProbe.dispatched,
    confirmedBefore: beforeProbe.confirmed,
    confirmedAfter: afterProbe.confirmed
  };
  recorder.finishStop(
    finalStatus,
    lane,
    variant,
    device.stopHomeAcknowledgement !== null,
    device.stopHomeAcknowledgement,
    stopRequestedAtMs,
    projectPostStopProbe === undefined
      ? actualPostStopProbe
      : projectPostStopProbe(actualPostStopProbe, { id, variant })
  );
  const expectedObservationTicks = Math.floor(durationMs / timing.frameIntervalMs) + 1;
  return {
    events: finalizeReplayDecisions(recorder.events),
    runtimeStatus: projectRuntimeStatus(finalStatus, expectedObservationTicks)
  };
}

export type StackChanAttentionQuantizationCouplingProbeRun = {
  readonly frameIntervalMs: number;
  readonly replyDurationMs: number;
  readonly residualReleaseCount: number;
  readonly residualReleaseAtMs: readonly number[];
  readonly firstResidualReleaseAtMs: number | null;
  readonly releasesBeforeFirstConfirmation: number;
  readonly unDispatchedResidualReleaseCount: number;
  readonly dispatchCount: number;
  readonly replacedReleaseCount: number;
};

export type StackChanAttentionQuantizationCouplingProbe = {
  readonly fixedDelayedReply: StackChanAttentionQuantizationCouplingProbeRun;
  readonly visualCadence: {
    readonly fast: StackChanAttentionQuantizationCouplingProbeRun;
    readonly slow: StackChanAttentionQuantizationCouplingProbeRun;
  };
  readonly replyCadence: {
    readonly fast: StackChanAttentionQuantizationCouplingProbeRun;
    readonly delayed: StackChanAttentionQuantizationCouplingProbeRun;
  };
  readonly findings: {
    readonly releasesFromUnconfirmedVisualObservations: boolean;
    readonly residualReleaseIsVisualCadenceDependent: boolean;
    readonly laneOutcomeIsReplyCadenceDependent: boolean;
  };
};

export async function probeStackChanAttentionQuantizationCoupling(): Promise<StackChanAttentionQuantizationCouplingProbe> {
  const delayedFastVisual = await runQuantizationCouplingProbeCase(125, 500);
  const delayedSlowVisual = await runQuantizationCouplingProbeCase(250, 500);
  const fastReply = await runQuantizationCouplingProbeCase(125, 200);
  return {
    fixedDelayedReply: delayedFastVisual,
    visualCadence: {
      fast: delayedFastVisual,
      slow: delayedSlowVisual
    },
    replyCadence: {
      fast: fastReply,
      delayed: delayedFastVisual
    },
    findings: {
      releasesFromUnconfirmedVisualObservations:
        delayedFastVisual.releasesBeforeFirstConfirmation > 0,
      residualReleaseIsVisualCadenceDependent:
        canonicalHash(delayedFastVisual.residualReleaseAtMs) !==
        canonicalHash(delayedSlowVisual.residualReleaseAtMs),
      laneOutcomeIsReplyCadenceDependent:
        fastReply.dispatchCount !== delayedFastVisual.dispatchCount ||
        fastReply.unDispatchedResidualReleaseCount !==
          delayedFastVisual.unDispatchedResidualReleaseCount
    }
  };
}

async function runQuantizationCouplingProbeCase(
  frameIntervalMs: number,
  replyDurationMs: number
): Promise<StackChanAttentionQuantizationCouplingProbeRun> {
  const run = await executeRuntime(
    "slow-continuous-tracking",
    1_000,
    [
      {
        atMs: 0,
        pose: homePose(),
        normalizedError: { yaw: 0.11, pitch: 0 },
        occluded: false
      }
    ],
    null,
    createStackChanAttentionRuntime,
    undefined,
    "error-feedback",
    { frameIntervalMs, deviceCommandDurationMs: replyDurationMs }
  );
  const releases = run.events.filter(
    (event) => event.decision?.yaw.residualAction === "residual-release"
  );
  const firstConfirmationAtMs = run.events.find(
    (event) => event.confirmedSequence !== null
  )?.timestampMs;
  const stopEvent = run.events.find((event) => event.stop);
  return {
    frameIntervalMs,
    replyDurationMs,
    residualReleaseCount: releases.length,
    residualReleaseAtMs: releases.map((event) => event.timestampMs),
    firstResidualReleaseAtMs: releases[0]?.timestampMs ?? null,
    releasesBeforeFirstConfirmation:
      firstConfirmationAtMs === undefined
        ? releases.length
        : releases.filter((event) => event.timestampMs < firstConfirmationAtMs).length,
    unDispatchedResidualReleaseCount: releases.filter(
      (event) => event.decision?.effectOutcome !== "dispatched"
    ).length,
    dispatchCount: stopEvent?.counters.dispatched ?? 0,
    replacedReleaseCount: releases.filter((event) => event.decision?.effectOutcome === "replaced")
      .length
  };
}

function createManualScheduler(
  clock: VirtualClock,
  beforeTick: () => Promise<void>,
  expectedIntervalMs: number
): {
  readonly scheduler: StackChanAttentionScheduler;
  readonly tick: (timestampMs: number) => Promise<void>;
} {
  let task: (() => Promise<void>) | undefined;
  let cancelled = false;
  return {
    scheduler(nextTask, intervalMs) {
      if (intervalMs !== expectedIntervalMs) {
        throw new Error("attention replay scheduler interval mismatch");
      }
      task = nextTask;
      return {
        cancel() {
          cancelled = true;
        }
      };
    },
    async tick(timestampMs) {
      if (task === undefined || cancelled) {
        throw new Error("attention replay scheduler is unavailable");
      }
      clock.nowMs = timestampMs;
      await beforeTick();
      await task();
    }
  };
}

function createVirtualAdapter(
  clock: VirtualClock,
  device: VirtualDevice,
  recorder: EventRecorder,
  lane: VirtualLane
): StackChanAdapter {
  let frameSequence = 0;
  let connected = false;
  return {
    connect() {
      connected = true;
      return Promise.resolve();
    },
    captureJpeg() {
      if (!connected) {
        return Promise.reject(new Error("attention replay adapter is disconnected"));
      }
      frameSequence += 1;
      recorder.activeTick().frameSequence = frameSequence;
      return Promise.resolve({
        bytes: frameBytes,
        mimeType: "image/jpeg",
        sequence: frameSequence,
        receivedAtMs: clock.nowMs
      });
    },
    getHeadAngles() {
      return Promise.resolve({ ...device.pose });
    },
    moveHead(pose) {
      device.pose = { ...pose };
      if (lane.status().phase === "stopped") {
        device.stopHomeAcknowledgement = {
          acknowledgedAtMs: clock.nowMs,
          pose: { ...pose }
        };
      }
      return Promise.resolve();
    },
    close() {
      connected = false;
      return Promise.resolve();
    }
  };
}

function createWorldDetector(
  clock: VirtualClock,
  device: VirtualDevice,
  recorder: EventRecorder,
  world: readonly WorldKeyframe[]
): AttentionDetectionModel {
  return {
    detect() {
      const target = worldTargetAt(world, clock.nowMs);
      const tick = recorder.activeTick();
      const targetPose =
        target.normalizedError === undefined
          ? target.pose
          : {
              yaw:
                device.pose.yaw +
                target.normalizedError.yaw * STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw,
              pitch:
                device.pose.pitch +
                target.normalizedError.pitch *
                  STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch
            };
      tick.targetWorldPose = {
        yaw: roundSixDecimals(targetPose.yaw),
        pitch: roundSixDecimals(targetPose.pitch)
      };
      tick.targetSegmentIndex = target.segmentIndex;
      tick.targetErrorDeg = {
        yaw: roundSixDecimals(targetPose.yaw - device.pose.yaw),
        pitch: roundSixDecimals(targetPose.pitch - device.pose.pitch)
      };
      if (target.occluded) {
        tick.detectorState = "occluded";
        return Promise.resolve([]);
      }
      if (!insideSyntheticFov(tick.targetErrorDeg)) {
        tick.detectorState = "outside-fov";
        return Promise.resolve([]);
      }
      tick.detectorState = "visible";
      return Promise.resolve([detectionFromWorldError(tick.targetErrorDeg)]);
    }
  };
}

function worldTargetAt(
  world: readonly WorldKeyframe[],
  timestampMs: number
): WorldKeyframe & { readonly segmentIndex: number } {
  let selected = world[0];
  let selectedIndex = 0;
  if (selected === undefined) {
    throw new Error("attention replay world is empty");
  }
  for (const [index, keyframe] of world.entries()) {
    if (keyframe.atMs > timestampMs) {
      break;
    }
    selected = keyframe;
    selectedIndex = index;
  }
  const next = world[selectedIndex + 1];
  if (selected.interpolation !== "linear" || next === undefined || timestampMs >= next.atMs) {
    return { ...selected, segmentIndex: selectedIndex };
  }
  const progress = (timestampMs - selected.atMs) / (next.atMs - selected.atMs);
  return {
    atMs: timestampMs,
    pose: {
      yaw: roundSixDecimals(selected.pose.yaw + (next.pose.yaw - selected.pose.yaw) * progress),
      pitch: roundSixDecimals(
        selected.pose.pitch + (next.pose.pitch - selected.pose.pitch) * progress
      )
    },
    occluded: selected.occluded,
    interpolation: "linear",
    segmentIndex: selectedIndex
  };
}

function insideSyntheticFov(error: StackChanHeadPose): boolean {
  return (
    Math.abs(error.yaw) <= STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw / 2 &&
    Math.abs(error.pitch) <= STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch / 2
  );
}

function detectionFromWorldError(error: StackChanHeadPose): AttentionDetection {
  const centerX = clamp(
    0.5 + error.yaw / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw,
    0.02,
    0.98
  );
  const centerY = clamp(
    0.5 - error.pitch / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch,
    0.02,
    0.98
  );
  return {
    label: "face",
    confidence: 1,
    boundingBox: {
      xMin: centerX - 0.02,
      yMin: centerY - 0.02,
      xMax: centerX + 0.02,
      yMax: centerY + 0.02
    }
  };
}

export type ReplayLaneUpdateValidationInput = {
  readonly sequence: number;
  readonly pose: StackChanHeadPose;
};

export type ReplayLaneValidationSnapshot = {
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly pendingDepth: number;
  readonly activeCalls: number;
  readonly lastAcceptedSequence: number | null;
  readonly confirmedPose: StackChanHeadPose | null;
};

export type ReplayLaneValidationResult = {
  readonly accepted: boolean;
  readonly before: ReplayLaneValidationSnapshot;
  readonly after: ReplayLaneValidationSnapshot;
};

export type ReplayLaneTimedUpdateInput = ReplayLaneUpdateValidationInput & {
  readonly atMs: number;
};

export type ReplayLaneTimedUpdateResult = {
  readonly dispatchedPose: StackChanHeadPose | null;
  readonly confirmedBeforeDispatch: StackChanHeadPose;
  readonly plannedBeforeDispatch: StackChanHeadPose;
  readonly noOpDiscardedSequence: number | null;
  readonly after: ReplayLaneValidationSnapshot;
};

export async function probeReplayLaneUpdateValidation(
  updates: readonly ReplayLaneUpdateValidationInput[]
): Promise<readonly ReplayLaneValidationResult[]> {
  const clock: VirtualClock = { nowMs: 0 };
  const device: VirtualDevice = {
    pose: homePose(),
    stopHomeAcknowledgement: null
  };
  const recorder = createEventRecorder(clock, "static-hold");
  const lane = createVirtualLane(clock, device, recorder);
  await lane.client.connect();
  await lane.client.start({
    rateHz: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.commandRateHz,
    maxStepDeg: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxStepDeg,
    maxPendingAgeMs: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxPendingCommandAgeMs,
    speedDps: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.moveSpeedDps
  });
  const results: ReplayLaneValidationResult[] = [];
  for (const update of updates) {
    recorder.beginTick();
    const before = laneValidationSnapshot(lane);
    let accepted = true;
    try {
      await lane.client.update({ leaseId, ...update });
    } catch {
      accepted = false;
    }
    results.push({
      accepted,
      before,
      after: laneValidationSnapshot(lane)
    });
  }
  await lane.client.close();
  return results;
}

export async function probeReplayLaneTimedUpdates(
  updates: readonly ReplayLaneTimedUpdateInput[]
): Promise<readonly ReplayLaneTimedUpdateResult[]> {
  const clock: VirtualClock = { nowMs: 0 };
  const device: VirtualDevice = {
    pose: homePose(),
    stopHomeAcknowledgement: null
  };
  const recorder = createEventRecorder(clock, "static-hold");
  const lane = createVirtualLane(clock, device, recorder);
  await lane.client.connect();
  await lane.client.start({
    rateHz: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.commandRateHz,
    maxStepDeg: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxStepDeg,
    maxPendingAgeMs: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxPendingCommandAgeMs,
    speedDps: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.moveSpeedDps
  });
  const results: ReplayLaneTimedUpdateResult[] = [];
  for (const update of updates) {
    if (!Number.isFinite(update.atMs) || update.atMs < clock.nowMs) {
      throw new Error("attention replay timed update timestamp is invalid");
    }
    clock.nowMs = update.atMs;
    recorder.beginTick();
    await lane.client.update({ leaseId, sequence: update.sequence, pose: update.pose });
    const tick = recorder.activeTick();
    results.push({
      dispatchedPose: tick.dispatchedPose === null ? null : { ...tick.dispatchedPose },
      confirmedBeforeDispatch: { ...tick.confirmedBeforeDispatch },
      plannedBeforeDispatch: { ...tick.plannedBeforeDispatch },
      noOpDiscardedSequence: tick.noOpDiscardedSequence,
      after: laneValidationSnapshot(lane)
    });
  }
  await lane.client.close();
  return results;
}

function createVirtualLane(
  clock: VirtualClock,
  device: VirtualDevice,
  recorder: EventRecorder,
  deviceCommandDurationMs: number = STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs
): VirtualLane {
  const counters: MutableCounters = {
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmed: 0,
    failed: 0,
    staleDiscarded: 0,
    noOpDiscarded: 0,
    maximumPendingDepth: 0,
    maximumActiveCalls: 0,
    postStopDispatches: 0,
    postStopDispatchAttempts: 0
  };
  let phase: StackChanHeadTargetStatus["phase"] = "starting";
  let pending: PendingTarget | undefined;
  const active: ActiveCommand[] = [];
  let lastAcceptedSequence: number | undefined;
  let lastConfirmedSequence: number | undefined;
  let generation = 0;
  let connected = false;
  let confirmedPose = { ...device.pose };
  let plannedPose = { ...device.pose };

  const dispatchPending = (): boolean => {
    const target = pending;
    if (target === undefined || active.length >= STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS) {
      return target !== undefined;
    }
    const confirmedBeforeDispatch = { ...confirmedPose };
    const plannedBeforeDispatch = { ...plannedPose };
    const dispatchedPose = reclampPose(target.pose, plannedBeforeDispatch);
    const tick = recorder.activeTick();
    tick.confirmedBeforeDispatch = confirmedBeforeDispatch;
    tick.plannedBeforeDispatch = plannedBeforeDispatch;
    const decision = decideStackChanReplayHeadTargetDispatch({
      confirmedPose: confirmedBeforeDispatch,
      plannedPose: plannedBeforeDispatch,
      dispatchedPose,
      activeCalls: active.length
    });
    if (decision === "defer-planned-no-op") {
      return true;
    }
    pending = undefined;
    if (decision === "discard-planned-no-op") {
      counters.noOpDiscarded += 1;
      tick.noOpDiscardedSequence = target.sequence;
      return false;
    }
    active.push({
      sequence: target.sequence,
      requestPose: { ...target.pose },
      dispatchedPose,
      completesAtMs: clock.nowMs + deviceCommandDurationMs
    });
    plannedPose = { ...dispatchedPose };
    counters.dispatched += 1;
    counters.maximumActiveCalls = Math.max(counters.maximumActiveCalls, active.length);
    tick.dispatchSequence = target.sequence;
    tick.dispatchedRequestPose = { ...target.pose };
    tick.dispatchedPose = { ...dispatchedPose };
    tick.confirmedBeforeDispatch = confirmedBeforeDispatch;
    tick.plannedBeforeDispatch = plannedBeforeDispatch;
    return false;
  };

  const completeActiveIfDue = (): void => {
    while (active[0] !== undefined && active[0].completesAtMs <= clock.nowMs) {
      const completed = active.shift();
      if (completed === undefined) {
        throw new Error("attention replay active command disappeared");
      }
      device.pose = { ...completed.dispatchedPose };
      confirmedPose = { ...completed.dispatchedPose };
      counters.confirmed += 1;
      lastConfirmedSequence = completed.sequence;
      recorder.activeTick().confirmedSequence = completed.sequence;
    }
  };

  const settle = (): void => {
    completeActiveIfDue();
    if (
      pending === undefined ||
      phase !== "running" ||
      active.length >= STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS
    ) {
      return;
    }
    const ageMs = clock.nowMs - pending.acceptedAtMs;
    if (ageMs > STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxPendingCommandAgeMs) {
      counters.staleDiscarded += 1;
      pending = undefined;
      return;
    }
    dispatchPending();
  };

  const status = (): StackChanHeadTargetStatus => ({
    phase,
    ...(phase === "running" || phase === "stopping" ? { leaseId, leaseIdMatch: true } : {}),
    accepted: counters.accepted,
    replaced: counters.replaced,
    dispatched: counters.dispatched,
    confirmed: counters.confirmed,
    confirmedApplyReplies: counters.confirmed,
    failed: counters.failed,
    staleDiscarded: counters.staleDiscarded,
    noOpDiscarded: counters.noOpDiscarded,
    activeCalls: active.length,
    pendingDepth: pending === undefined ? 0 : 1,
    maximumActiveCalls: counters.maximumActiveCalls,
    maximumPendingDepth: counters.maximumPendingDepth,
    postStopDispatches: counters.postStopDispatches,
    ...(lastAcceptedSequence === undefined ? {} : { lastAcceptedSequence }),
    ...(lastConfirmedSequence === undefined ? {} : { lastConfirmedSequence }),
    confirmedPose: { ...confirmedPose },
    updateAcknowledgmentMs: emptyLatencyDistribution,
    pendingAgeMs:
      pending === undefined
        ? emptyLatencyDistribution
        : fixedLatencyDistribution(clock.nowMs - pending.acceptedAtMs),
    deviceDispatchLatencyMs: emptyLatencyDistribution,
    successfulReplyLatencyMs: emptyLatencyDistribution,
    firmwareMcpStageUs: {
      count: 0,
      receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
      toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
      applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
      schedulerHops: {}
    }
  });

  const client: StackChanHeadTargetLane = {
    connect() {
      connected = true;
      return Promise.resolve();
    },
    start(config) {
      if (!connected || config.rateHz !== STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.commandRateHz) {
        return Promise.reject(new Error("attention replay lane start mismatch"));
      }
      if (
        config.maxStepDeg !== STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxStepDeg ||
        config.maxPendingAgeMs !==
          STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxPendingCommandAgeMs ||
        config.speedDps !== STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.moveSpeedDps
      ) {
        return Promise.reject(new Error("attention replay lane fixture mismatch"));
      }
      phase = "running";
      const currentStatus = status();
      return Promise.resolve({
        leaseId,
        confirmedPose: { ...confirmedPose },
        status: currentStatus
      });
    },
    update(target) {
      try {
        requireValidReplayLaneUpdate(target, lastAcceptedSequence);
      } catch {
        return Promise.reject(new Error("attention replay lane update rejected"));
      }
      settle();
      if (phase !== "running" || target.leaseId !== leaseId) {
        if (phase === "stopping" || phase === "stopped") {
          counters.postStopDispatchAttempts += 1;
        }
        return Promise.reject(new Error("attention replay lane update rejected"));
      }
      const replaced = pending !== undefined;
      counters.accepted += 1;
      counters.replaced += Number(replaced);
      lastAcceptedSequence = target.sequence;
      const accepted: PendingTarget = {
        sequence: target.sequence,
        pose: { ...target.pose },
        acceptedAtMs: clock.nowMs
      };
      const tick = recorder.activeTick();
      tick.requestSequence = target.sequence;
      tick.requestedPose = { ...target.pose };
      pending = accepted;
      const hasPending = dispatchPending();
      if (hasPending) {
        counters.maximumPendingDepth = Math.max(counters.maximumPendingDepth, 1);
      }
      return Promise.resolve({
        accepted: true,
        replaced,
        pendingDepth: Number(hasPending),
        acceptedCount: counters.accepted,
        replacedCount: counters.replaced,
        lastAcceptedSequence: target.sequence
      });
    },
    clear(currentLeaseId) {
      settle();
      if (currentLeaseId !== leaseId) {
        return Promise.reject(new Error("attention replay lane clear rejected"));
      }
      pending = undefined;
      recorder.activeTick().clear = true;
      return Promise.resolve(status());
    },
    status(currentLeaseId) {
      settle();
      if (currentLeaseId !== leaseId) {
        return Promise.reject(new Error("attention replay lane status rejected"));
      }
      return Promise.resolve(status());
    },
    stop(currentLeaseId) {
      if (currentLeaseId !== leaseId) {
        return Promise.reject(new Error("attention replay lane stop rejected"));
      }
      phase = "stopping";
      completeActiveIfDue();
      pending = undefined;
      while (active[0] !== undefined) {
        clock.nowMs = active[0].completesAtMs;
        completeActiveIfDue();
      }
      generation += 1;
      phase = "stopped";
      return Promise.resolve(status());
    },
    close() {
      connected = false;
      return Promise.resolve();
    }
  };

  return {
    client,
    counters,
    status,
    pendingAgeMs: () =>
      pending === undefined ? null : roundSixDecimals(clock.nowMs - pending.acceptedAtMs),
    generation: () => generation
  };
}

function requireValidReplayLaneUpdate(
  target: ReplayLaneUpdateValidationInput,
  lastAcceptedSequence: number | undefined
): void {
  if (!isValidReplayLaneSequence(target.sequence, lastAcceptedSequence)) {
    throw new Error("attention replay lane sequence is invalid");
  }
  if (!isIntegerInRange(target.pose.yaw, -90, 90) || !isIntegerInRange(target.pose.pitch, 5, 85)) {
    throw new Error("attention replay lane pose is invalid");
  }
}

function isValidReplayLaneSequence(
  sequence: number,
  lastAcceptedSequence: number | undefined
): boolean {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    return false;
  }
  return lastAcceptedSequence === undefined || sequence > lastAcceptedSequence;
}

function isIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function laneValidationSnapshot(lane: VirtualLane): ReplayLaneValidationSnapshot {
  const status = lane.status();
  return {
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    failed: status.failed,
    pendingDepth: status.pendingDepth,
    activeCalls: status.activeCalls,
    lastAcceptedSequence: status.lastAcceptedSequence ?? null,
    confirmedPose: status.confirmedPose === undefined ? null : { ...status.confirmedPose }
  };
}

function createEventRecorder(clock: VirtualClock, id: ScenarioId): EventRecorder {
  const events: StackChanAttentionReplayEvent[] = [];
  let tick: MutableTickRecord | undefined;
  const beginTick = (): void => {
    tick = emptyTickRecord(homePose());
  };
  const activeTick = (): MutableTickRecord => {
    if (tick === undefined) {
      throw new Error("attention replay event tick is unavailable");
    }
    return tick;
  };
  const recordDecision = (diagnostic: StackChanAttentionDecisionDiagnostic): void => {
    const current = activeTick();
    if (current.decision !== null) {
      throw new Error("attention replay event captured multiple controller decisions");
    }
    current.decision = diagnostic;
  };
  const push = (
    runtimeStatus: StackChanAttentionStatus,
    lane: VirtualLane,
    variant: StopVariant | null,
    lifecycle: {
      readonly stop: boolean;
      readonly home: boolean;
      readonly stopRequestedAtMs: number | null;
    }
  ): void => {
    const current = activeTick();
    const laneStatus = lane.status();
    events.push({
      sequence: events.length + 1,
      timestampMs: clock.nowMs,
      observationId: `${id}:${variant ?? "base"}:${events.length + 1}`,
      variant,
      frameSequence: current.frameSequence,
      runtimeAcceptedFrameSequence: runtimeStatus.flow.lastAcceptedFrameSequence ?? null,
      targetWorldPose: current.targetWorldPose,
      targetSegmentIndex: current.targetSegmentIndex,
      detectorState: current.detectorState,
      targetErrorDeg: current.targetErrorDeg,
      targetNormalizedError: normalizeReplayTargetError(current.targetErrorDeg),
      probeId: null,
      isProbeObservation: false,
      centered: isReplayTargetCentered(runtimeStatus),
      controllerMode: runtimeStatus.attention.mode,
      decision: createOptionalReplayDecision(
        current.decision,
        events.length + 1,
        current.requestSequence
      ),
      requestSequence: current.requestSequence,
      requestedPose: current.requestedPose,
      dispatchSequence: current.dispatchSequence,
      dispatchedRequestPose: current.dispatchedRequestPose,
      dispatchedPose: current.dispatchedPose,
      confirmedSequence: current.confirmedSequence,
      noOpDiscardedSequence: current.noOpDiscardedSequence,
      confirmedBeforeDispatch: current.confirmedBeforeDispatch,
      plannedBeforeDispatch: current.plannedBeforeDispatch,
      rpcConfirmedPose: { ...(laneStatus.confirmedPose ?? homePose()) },
      pendingAgeMs: lane.pendingAgeMs(),
      generation: lane.generation(),
      counters: projectCounters(laneStatus, lane.counters.postStopDispatchAttempts),
      clear: current.clear,
      stop: lifecycle.stop,
      stopRequestedAtMs: lifecycle.stopRequestedAtMs,
      home: lifecycle.home,
      homeAcknowledgedAtMs: null,
      homeAcknowledgedPose: null,
      postStopProbe: null,
      finalRuntimeEvidence: optionalFinalRuntimeEvidence(lifecycle.stop, runtimeStatus)
    });
    tick = undefined;
  };
  return {
    beginTick,
    activeTick,
    recordDecision,
    finishTick(runtimeStatus, lane, variant) {
      push(runtimeStatus, lane, variant, {
        stop: false,
        home: false,
        stopRequestedAtMs: null
      });
    },
    finishStop(
      runtimeStatus,
      lane,
      variant,
      home,
      homeAcknowledgement,
      stopRequestedAtMs,
      postStopProbe
    ) {
      push(runtimeStatus, lane, variant, { stop: true, home, stopRequestedAtMs });
      const event = events.at(-1);
      if (event === undefined) {
        throw new Error("attention replay stop event is unavailable");
      }
      events[events.length - 1] = {
        ...event,
        homeAcknowledgedAtMs: homeAcknowledgement?.acknowledgedAtMs ?? null,
        homeAcknowledgedPose: homeAcknowledgement === null ? null : { ...homeAcknowledgement.pose },
        postStopProbe
      };
    },
    events
  };
}

function emptyTickRecord(confirmedPose: StackChanHeadPose): MutableTickRecord {
  return {
    frameSequence: null,
    targetWorldPose: null,
    targetSegmentIndex: null,
    detectorState: null,
    targetErrorDeg: null,
    requestSequence: null,
    requestedPose: null,
    dispatchSequence: null,
    dispatchedRequestPose: null,
    dispatchedPose: null,
    confirmedSequence: null,
    noOpDiscardedSequence: null,
    confirmedBeforeDispatch: { ...confirmedPose },
    plannedBeforeDispatch: { ...confirmedPose },
    decision: null,
    clear: false
  };
}

function createReplayDecision(
  diagnostic: StackChanAttentionDecisionDiagnostic,
  id: number,
  requestSequence: number | null
): StackChanAttentionReplayDecision {
  return {
    id,
    decisionAtMs: diagnostic.decisionAtMs,
    observedAtMs: diagnostic.observedAtMs,
    quantizationMode: diagnostic.quantizationMode,
    centered: diagnostic.centered,
    baseConfirmedPose: { ...diagnostic.baseConfirmedPose },
    requestedPose: diagnostic.requestedPose === undefined ? null : { ...diagnostic.requestedPose },
    requestSequence,
    effectOutcome: "none",
    ticksWithoutConfirmedUpdate: 0,
    yaw: { ...diagnostic.yaw },
    pitch: { ...diagnostic.pitch }
  };
}

function normalizeReplayTargetError(error: StackChanHeadPose | null): StackChanHeadPose | null {
  if (error === null) {
    return null;
  }
  return {
    yaw: roundSixDecimals(error.yaw / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw),
    pitch: roundSixDecimals(error.pitch / STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch)
  };
}

function isReplayTargetCentered(runtimeStatus: StackChanAttentionStatus): boolean {
  return (
    runtimeStatus.attention.targetVisible && runtimeStatus.attention.lastTarget?.centered === true
  );
}

function createOptionalReplayDecision(
  diagnostic: StackChanAttentionDecisionDiagnostic | null,
  id: number,
  requestSequence: number | null
): StackChanAttentionReplayDecision | null {
  return diagnostic === null ? null : createReplayDecision(diagnostic, id, requestSequence);
}

function optionalFinalRuntimeEvidence(
  stop: boolean,
  runtimeStatus: StackChanAttentionStatus
): FinalRuntimeEvidence | null {
  return stop ? projectFinalRuntimeEvidence(runtimeStatus) : null;
}

function finalizeReplayDecisions(
  events: readonly StackChanAttentionReplayEvent[]
): StackChanAttentionReplayEvent[] {
  const outcomes = deriveReplayRequestOutcomes(events);
  let ticksWithoutConfirmedUpdate = 0;
  return events.map((event) => {
    if (event.confirmedSequence !== null) {
      ticksWithoutConfirmedUpdate = 0;
    } else if (event.frameSequence !== null) {
      ticksWithoutConfirmedUpdate += 1;
    }
    if (event.decision === null) {
      return event;
    }
    return {
      ...event,
      decision: {
        ...event.decision,
        effectOutcome:
          event.decision.requestSequence === null
            ? "none"
            : (outcomes.get(event.decision.requestSequence) ?? "none"),
        ticksWithoutConfirmedUpdate
      }
    };
  });
}

function deriveReplayRequestOutcomes(
  events: readonly StackChanAttentionReplayEvent[]
): ReadonlyMap<number, StackChanAttentionReplayEffectOutcome> {
  const outcomes = new Map<number, StackChanAttentionReplayEffectOutcome>();
  const state: ReplayRequestOutcomeState = { pendingSequence: null, staleDiscarded: 0 };
  for (const event of events) {
    recordStaleReplayOutcome(outcomes, state, event);
    recordTerminalReplayOutcome(outcomes, state, event.noOpDiscardedSequence, "noop");
    recordTerminalReplayOutcome(outcomes, state, event.dispatchSequence, "dispatched");
    recordAcceptedReplayOutcome(outcomes, state, event);
    if (event.clear || event.stop) {
      state.pendingSequence = null;
    }
  }
  return outcomes;
}

type ReplayRequestOutcomeState = {
  pendingSequence: number | null;
  staleDiscarded: number;
};

function recordStaleReplayOutcome(
  outcomes: Map<number, StackChanAttentionReplayEffectOutcome>,
  state: ReplayRequestOutcomeState,
  event: StackChanAttentionReplayEvent
): void {
  if (event.counters.staleDiscarded > state.staleDiscarded && state.pendingSequence !== null) {
    outcomes.set(state.pendingSequence, "stale");
    state.pendingSequence = null;
  }
  state.staleDiscarded = event.counters.staleDiscarded;
}

function recordTerminalReplayOutcome(
  outcomes: Map<number, StackChanAttentionReplayEffectOutcome>,
  state: ReplayRequestOutcomeState,
  sequence: number | null,
  outcome: "noop" | "dispatched"
): void {
  if (sequence === null) {
    return;
  }
  outcomes.set(sequence, outcome);
  if (state.pendingSequence === sequence) {
    state.pendingSequence = null;
  }
}

function recordAcceptedReplayOutcome(
  outcomes: Map<number, StackChanAttentionReplayEffectOutcome>,
  state: ReplayRequestOutcomeState,
  event: StackChanAttentionReplayEvent
): void {
  const sequence = event.requestSequence;
  if (sequence === null) {
    return;
  }
  if (state.pendingSequence !== null) {
    outcomes.set(state.pendingSequence, "replaced");
  }
  outcomes.set(sequence, outcomes.get(sequence) ?? "none");
  state.pendingSequence = isTerminalReplayRequest(event, sequence) ? null : sequence;
}

function isTerminalReplayRequest(event: StackChanAttentionReplayEvent, sequence: number): boolean {
  return sequence === event.dispatchSequence || sequence === event.noOpDiscardedSequence;
}

function projectCounters(
  status: StackChanHeadTargetStatus,
  postStopDispatchAttempts: number
): LaneCounters {
  return {
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    noOpDiscarded: status.noOpDiscarded,
    pendingDepth: status.pendingDepth,
    activeCalls: status.activeCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    maximumActiveCalls: status.maximumActiveCalls,
    postStopDispatches: status.postStopDispatches,
    postStopDispatchAttempts
  };
}

function fixedLatencyDistribution(value: number): StackChanLatencyDistribution {
  const rounded = roundSixDecimals(value);
  return {
    count: 1,
    p50: rounded,
    p95: rounded,
    p99: rounded,
    max: rounded
  };
}

function reclampPose(
  requestedPose: StackChanHeadPose,
  confirmedPose: StackChanHeadPose
): StackChanHeadPose {
  const maximumStep = STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxStepDeg;
  return {
    yaw: clamp(
      Math.round(requestedPose.yaw),
      confirmedPose.yaw - maximumStep,
      confirmedPose.yaw + maximumStep,
      -90,
      90
    ),
    pitch: clamp(
      Math.round(requestedPose.pitch),
      confirmedPose.pitch - maximumStep,
      confirmedPose.pitch + maximumStep,
      5,
      85
    )
  };
}

function reduceStackChanAttentionReplayScenarioEvidence(
  input: CanonicalScenarioInput,
  events: readonly StackChanAttentionReplayEvent[],
  runtimeStatus: ScenarioRuntimeStatus,
  details: {
    readonly lossWindows: readonly LossWindow[];
    readonly stopVariants: StopVariantResults | null;
  },
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"] = "recorded-final-events"
): StackChanAttentionReplayScenario {
  validateRawScenarioEvidence(input, events, runtimeEvidenceSource);
  const aggregates = aggregateScenario(input.id, events);
  const invariants = evaluateInvariants(
    input.id,
    events,
    aggregates,
    runtimeStatus,
    details.stopVariants
  );
  const core = {
    id: input.id,
    canonicalInput: input,
    canonicalInputHash: canonicalHash(input),
    lossWindows: details.lossWindows,
    events,
    aggregates,
    invariants,
    runtimeStatus,
    stopVariants: details.stopVariants
  };
  const stopVariantsPassed =
    details.stopVariants === null ||
    Object.values(details.stopVariants).every((variant) => variant.status === "passed");
  return {
    ...core,
    status: Object.values(invariants).every(Boolean) && stopVariantsPassed ? "passed" : "failed",
    canonicalHash: canonicalHash(core)
  };
}

const buildScenario = reduceStackChanAttentionReplayScenarioEvidence;

function aggregateScenario(
  id: ScenarioId,
  events: readonly StackChanAttentionReplayEvent[]
): ScenarioAggregates {
  const requestSamples = poseSamples(events, (event) => event.requestedPose);
  const dispatchSamples = poseSamples(events, (event) => event.dispatchedPose);
  const confirmedSamples = uniquePoseSamples(events, (event) => event.rpcConfirmedPose);
  const targetErrors = events.flatMap((event) =>
    event.targetErrorDeg === null ? [] : [event.targetErrorDeg]
  );
  const waypointMetrics = summarizeReplayWaypoints(
    events,
    STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
  );
  const targetEvents = events.filter((event) => event.detectorState === "visible");
  const centeredEvents = targetEvents.filter((event) => event.centered);
  const homeCompletionDurations = events.flatMap((event) =>
    event.home && event.stopRequestedAtMs !== null && event.homeAcknowledgedAtMs !== null
      ? [event.homeAcknowledgedAtMs - event.stopRequestedAtMs]
      : []
  );
  const finalCounters = events.filter((event) => event.stop).map((event) => event.counters);
  const requestKinematics = summarizeReplayKinematics(requestSamples);
  const dispatchKinematics = summarizeReplayKinematics(dispatchSamples);
  const settling = summarizeSettling(events);
  const quantization = {
    yaw: summarizeAttentionQuantizationAxis(quantizationAxisSamples(events, "yaw")),
    pitch: summarizeAttentionQuantizationAxis(quantizationAxisSamples(events, "pitch"))
  };
  const observations = events.filter((event) => event.frameSequence !== null);
  const visibilityEligible = observations.filter(
    (event) => event.detectorState === "visible" || event.detectorState === "outside-fov"
  );
  const visible = visibilityEligible.filter((event) => event.detectorState === "visible");
  const outsideFov = visibilityEligible.filter((event) => event.detectorState === "outside-fov");
  const trackingDecisions = observations.filter(
    (event) => event.detectorState === "visible" && event.controllerMode === "track"
  );
  const effectiveConfirmedSamples = effectiveConfirmedPoseSamples(events);
  const initialConfirmedProgress = summarizeReplayInitialConfirmedProgress(events);
  const staticBoundary = summarizeStaticBoundary(events);
  const plannedTargetSamples = uniqueTargetSegmentSamples(observations);
  const requiredReversalDispatches = events.filter(isTrackingRequiredReversalDispatch);
  const provablyRedundantDispatches = events.filter(isTrackingProvablyRedundantDispatch);
  const ordinaryDispatches = events.filter(
    (event) =>
      event.controllerMode === "track" &&
      event.dispatchedPose !== null &&
      !isTrackingRequiredReversalDispatch(event) &&
      !isTrackingProvablyRedundantDispatch(event)
  );
  return {
    requestKinematics,
    dispatchKinematics,
    commandKinematics: dispatchKinematics,
    confirmedKinematics: summarizeReplayKinematics(confirmedSamples),
    targetAbsoluteError: summarizePoseMagnitudes(targetErrors),
    angularPathDeg: {
      request: angularPath(requestSamples),
      dispatch: angularPath(dispatchSamples),
      command: angularPath(dispatchSamples),
      confirmed: angularPath(confirmedSamples)
    },
    velocityTotalVariation: velocityTotalVariation(confirmedSamples),
    directionReversals: directionReversals(confirmedSamples),
    centeredRatio:
      targetEvents.length === 0
        ? null
        : roundSixDecimals(centeredEvents.length / targetEvents.length),
    ...settling,
    quantization,
    dispatchIntervalMs: distribution(replayDispatchIntervals(events)),
    replyToNextDispatchMs: distribution(replayReplyToNextDispatchIntervals(events)),
    samePoseRequests: countSamePoses(events.map((event) => event.requestedPose)),
    samePoseDispatches: countSamePoses(events.map((event) => event.dispatchedPose)),
    samePoseScanDispatches: events.filter(
      (event) =>
        event.controllerMode === "scan" &&
        event.dispatchedPose !== null &&
        samePose(event.dispatchedPose, event.plannedBeforeDispatch)
    ).length,
    redundantSamePoseRequests: events.filter(
      (event) =>
        event.requestedPose !== null && samePose(event.requestedPose, event.rpcConfirmedPose)
    ).length,
    nonzeroStaticCommands:
      id === "static-hold"
        ? events.filter(
            (event) => event.dispatchedPose !== null && !samePose(event.dispatchedPose, homePose())
          ).length
        : 0,
    dispatchCount: finalCounters.reduce((sum, counters) => sum + counters.dispatched, 0),
    staleDispatchCount: finalCounters.reduce((sum, counters) => sum + counters.staleDiscarded, 0),
    postStopNormalDispatchCount: finalCounters.reduce(
      (sum, counters) => sum + counters.postStopDispatches,
      0
    ),
    postStopDispatchAttemptCount: finalCounters.reduce(
      (sum, counters) => sum + counters.postStopDispatchAttempts,
      0
    ),
    pendingMaximum: Math.max(0, ...events.map((event) => event.counters.maximumPendingDepth)),
    activeMaximum: Math.max(0, ...events.map((event) => event.counters.maximumActiveCalls)),
    activeOverlapCount: events.filter((event) => event.counters.activeCalls > 1).length,
    reacquisitionLatencyMs:
      id === "target-loss-reacquisition" ? calculateReacquisitionLatency(events) : null,
    homeErrorDeg: finalHomeError(events),
    homeCompletionMs:
      homeCompletionDurations.length === 0 ? null : Math.max(...homeCompletionDurations),
    ...waypointMetrics,
    observationCount: observations.length,
    visibilityEligibleFrames: visibilityEligible.length,
    visibleFrames: visible.length,
    outsideFovFrames: outsideFov.length,
    visibilityRatio:
      visibilityEligible.length === 0
        ? 0
        : roundSixDecimals(visible.length / visibilityEligible.length),
    scanDispatchCount: events.filter(
      (event) => event.controllerMode === "scan" && event.dispatchedPose !== null
    ).length,
    effectiveConfirmedMovements: effectiveConfirmedSamples.length,
    settlingUncensoredRatio:
      settling.settlingIntervalCount === 0
        ? 0
        : roundSixDecimals(settling.settlingMs.count / settling.settlingIntervalCount),
    plannedTargetReversals: directionReversals(plannedTargetSamples).yaw,
    ...staticBoundary,
    trackingRequiredReversalDispatches: requiredReversalDispatches.length,
    trackingRequiredReversalOccupancyMs:
      requiredReversalDispatches.length *
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs,
    trackingProvablyRedundantDispatches: provablyRedundantDispatches.length,
    trackingProvablyRedundantOccupancyMs:
      provablyRedundantDispatches.length *
      STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs,
    trackingProvablyRedundantDiscarded: events.filter(
      (event) => event.noOpDiscardedSequence !== null
    ).length,
    trackingOrdinaryDispatches: ordinaryDispatches.length,
    reversalResponseLatencyMs: distribution(reversalResponseLatencies(events)),
    sameAbsoluteTargetWhileActive: countSameAbsoluteTargetWhileActive(events),
    pendingSameTargetReplacements: countPendingSameTargetReplacements(events),
    effectiveConfirmedProgressIntervalMs: distribution(effectiveConfirmedProgressIntervals(events)),
    ...initialConfirmedProgress,
    maximumConfirmedStepDeg: maximumConfirmedStep(events),
    trackingDecisionCount: trackingDecisions.length,
    trackingCenteredHoldCount: trackingDecisions.filter(
      (event) => event.centered && event.requestedPose === null
    ).length,
    trackingQuantizedNoOpCount: trackingDecisions.filter(
      (event) => !event.centered && event.requestedPose === null
    ).length,
    trackingMoveRequestCount: trackingDecisions.filter((event) => event.requestedPose !== null)
      .length
  };
}

function isTrackingRequiredReversalDispatch(event: StackChanAttentionReplayEvent): boolean {
  if (event.controllerMode !== "track" || event.dispatchedPose === null) {
    return false;
  }
  const unresolvedYaw = event.plannedBeforeDispatch.yaw - event.confirmedBeforeDispatch.yaw;
  const unresolvedPitch = event.plannedBeforeDispatch.pitch - event.confirmedBeforeDispatch.pitch;
  const nextYaw = event.dispatchedPose.yaw - event.plannedBeforeDispatch.yaw;
  const nextPitch = event.dispatchedPose.pitch - event.plannedBeforeDispatch.pitch;
  return unresolvedYaw * nextYaw + unresolvedPitch * nextPitch < 0;
}

function quantizationAxisSamples(
  events: readonly StackChanAttentionReplayEvent[],
  axis: "yaw" | "pitch"
): AttentionQuantizationAxisSample[] {
  return events.map((event) => {
    const decision = event.decision;
    const boundary = replayEventBoundary(event);
    if (decision === null) {
      return {
        timestampMs: event.timestampMs,
        boundary,
        active: false,
        centered: event.centered,
        rawCorrectionDeg: 0,
        clampedCorrectionDeg: 0,
        legacyRoundedStepDeg: 0,
        quantizedStepDeg: 0,
        residualAction: "reset-zero-correction",
        effectOutcome: "none",
        ticksWithoutConfirmedUpdate: 0
      };
    }
    const diagnostic = decision[axis];
    return {
      timestampMs: event.timestampMs,
      boundary,
      active: true,
      centered: decision.centered,
      rawCorrectionDeg: diagnostic.rawCorrectionDeg,
      clampedCorrectionDeg: diagnostic.clampedCorrectionDeg,
      legacyRoundedStepDeg: diagnostic.legacyRoundedStepDeg,
      quantizedStepDeg: diagnostic.quantizedStepDeg,
      residualAction: diagnostic.residualAction,
      effectOutcome: decision.effectOutcome,
      ticksWithoutConfirmedUpdate: decision.ticksWithoutConfirmedUpdate
    };
  });
}

function replayDispatchIntervals(events: readonly StackChanAttentionReplayEvent[]): number[] {
  return splitReplaySubruns(events).flatMap((subrun) => {
    const timestamps = subrun.flatMap((event) =>
      event.dispatchSequence === null ? [] : [event.timestampMs]
    );
    return timestamps.slice(1).map((timestampMs, index) => {
      const previous = timestamps[index];
      if (previous === undefined) {
        throw new Error("attention replay dispatch interval predecessor is missing");
      }
      return timestampMs - previous;
    });
  });
}

function replayReplyToNextDispatchIntervals(
  events: readonly StackChanAttentionReplayEvent[]
): number[] {
  return splitReplaySubruns(events).flatMap((subrun) => {
    const intervals: number[] = [];
    let latestReplyAtMs: number | undefined;
    for (const event of subrun) {
      if (event.confirmedSequence !== null) {
        latestReplyAtMs = event.timestampMs;
      }
      if (event.dispatchSequence !== null && latestReplyAtMs !== undefined) {
        intervals.push(event.timestampMs - latestReplyAtMs);
        latestReplyAtMs = undefined;
      }
    }
    return intervals;
  });
}

function isTrackingProvablyRedundantDispatch(event: StackChanAttentionReplayEvent): boolean {
  return (
    event.controllerMode === "track" &&
    event.dispatchedPose !== null &&
    samePose(event.dispatchedPose, event.plannedBeforeDispatch)
  );
}

type ReversalResponseState = {
  readonly boundary: string | null;
  readonly segmentIndex: number | null;
  readonly admittedDirection: number;
  readonly pending: { readonly direction: number; readonly startedAtMs: number } | null;
};

function reversalResponseLatencies(events: readonly StackChanAttentionReplayEvent[]): number[] {
  const latencies: number[] = [];
  let state: ReversalResponseState = {
    boundary: null,
    segmentIndex: null,
    admittedDirection: 0,
    pending: null
  };
  for (const event of events) {
    state = resetReversalResponseBoundary(event, state);
    state = observeReversalTarget(event, state);
    const dispatch = observeReversalDispatch(event, state);
    if (dispatch.latencyMs !== null) {
      latencies.push(dispatch.latencyMs);
    }
    state = dispatch.state;
  }
  return latencies;
}

function resetReversalResponseBoundary(
  event: StackChanAttentionReplayEvent,
  state: ReversalResponseState
): ReversalResponseState {
  const boundary = replayEventBoundary(event);
  return boundary === state.boundary
    ? state
    : { boundary, segmentIndex: null, admittedDirection: 0, pending: null };
}

function observeReversalTarget(
  event: StackChanAttentionReplayEvent,
  state: ReversalResponseState
): ReversalResponseState {
  if (!isNewVisibleTrackingSegment(event, state.segmentIndex)) {
    return state;
  }
  const desiredDirection = Math.sign(
    (event.targetWorldPose?.yaw ?? event.rpcConfirmedPose.yaw) - event.rpcConfirmedPose.yaw
  );
  const reversesAdmittedDirection =
    desiredDirection !== 0 &&
    state.admittedDirection !== 0 &&
    desiredDirection !== state.admittedDirection;
  return {
    ...state,
    segmentIndex: event.targetSegmentIndex,
    pending: reversesAdmittedDirection
      ? { direction: desiredDirection, startedAtMs: event.timestampMs }
      : state.pending
  };
}

function isNewVisibleTrackingSegment(
  event: StackChanAttentionReplayEvent,
  segmentIndex: number | null
): boolean {
  return (
    event.controllerMode === "track" &&
    event.detectorState === "visible" &&
    event.targetSegmentIndex !== null &&
    event.targetSegmentIndex !== segmentIndex &&
    event.targetWorldPose !== null
  );
}

function observeReversalDispatch(
  event: StackChanAttentionReplayEvent,
  state: ReversalResponseState
): { readonly state: ReversalResponseState; readonly latencyMs: number | null } {
  if (event.dispatchedPose === null) {
    return { state, latencyMs: null };
  }
  const direction = Math.sign(event.dispatchedPose.yaw - event.plannedBeforeDispatch.yaw);
  const respondsToReversal = state.pending !== null && direction === state.pending.direction;
  return {
    state: {
      ...state,
      admittedDirection: direction === 0 ? state.admittedDirection : direction,
      pending: respondsToReversal ? null : state.pending
    },
    latencyMs: respondsToReversal ? event.timestampMs - state.pending.startedAtMs : null
  };
}

function effectiveConfirmedPoseSamples(
  events: readonly StackChanAttentionReplayEvent[]
): ReplayPoseSample[] {
  const samples: ReplayPoseSample[] = [];
  let previousPose: StackChanHeadPose | null = null;
  let previousBoundary: string | null = null;
  for (const event of events) {
    const boundary = `${event.variant ?? "base"}:${event.probeId ?? "scenario"}`;
    if (boundary !== previousBoundary) {
      previousPose = null;
      previousBoundary = boundary;
    }
    if (previousPose !== null && !samePose(previousPose, event.rpcConfirmedPose)) {
      samples.push({ timestampMs: event.timestampMs, pose: event.rpcConfirmedPose });
    }
    previousPose = event.rpcConfirmedPose;
  }
  return samples;
}

// Episode boundary resets and pose-change filtering are intentionally co-located.
// eslint-disable-next-line complexity
function effectiveConfirmedProgressIntervals(
  events: readonly StackChanAttentionReplayEvent[]
): number[] {
  const intervals: number[] = [];
  let previousPose: StackChanHeadPose | null = null;
  let previousProgressAtMs: number | null = null;
  let previousBoundary: string | null = null;
  for (const event of events) {
    const boundary = `${event.variant ?? "base"}:${event.probeId ?? "scenario"}`;
    if (boundary !== previousBoundary) {
      previousPose = null;
      previousProgressAtMs = null;
      previousBoundary = boundary;
    }
    if (previousPose !== null && !samePose(previousPose, event.rpcConfirmedPose)) {
      if (previousProgressAtMs !== null) {
        intervals.push(event.timestampMs - previousProgressAtMs);
      }
      previousProgressAtMs = event.timestampMs;
    }
    previousPose = event.rpcConfirmedPose;
    if (endsActiveTrackingEpisode(event)) {
      previousProgressAtMs = null;
    }
  }
  return intervals;
}

function endsActiveTrackingEpisode(event: StackChanAttentionReplayEvent): boolean {
  return (
    event.controllerMode !== "track" ||
    (event.centered &&
      event.requestedPose === null &&
      event.counters.activeCalls === 0 &&
      event.counters.pendingDepth === 0)
  );
}

// Episode lifecycle, causal dispatch binding, and censoring are one deterministic reduction.
// eslint-disable-next-line complexity
export function summarizeReplayInitialConfirmedProgress(
  events: readonly ReplayInitialConfirmedProgressEvent[]
): {
  readonly initialEffectiveConfirmedProgressLatencyMs: Distribution;
  readonly activeNonCenteredTrackingEpisodesWithoutConfirmedProgress: number;
} {
  const dispatches = new Map<
    string,
    { readonly eventIndex: number; readonly changesPose: boolean }
  >();
  for (const [eventIndex, event] of events.entries()) {
    if (event.dispatchSequence === null || event.dispatchedPose === null) {
      continue;
    }
    dispatches.set(replaySequenceKey(event, event.dispatchSequence), {
      eventIndex,
      changesPose: !samePose(event.dispatchedPose, event.plannedBeforeDispatch)
    });
  }

  const latencies: number[] = [];
  let episodeStartIndex: number | null = null;
  let episodeStartMs: number | null = null;
  let episodeHasProgress = false;
  let episodesWithoutProgress = 0;
  let previousBoundary: string | null = null;
  const finishEpisode = (): void => {
    if (episodeStartIndex !== null && !episodeHasProgress) {
      episodesWithoutProgress += 1;
    }
    episodeStartIndex = null;
    episodeStartMs = null;
    episodeHasProgress = false;
  };

  for (const [eventIndex, event] of events.entries()) {
    const boundary = replayEventBoundary(event);
    if (previousBoundary !== null && boundary !== previousBoundary) {
      finishEpisode();
    }
    previousBoundary = boundary;

    if (episodeStartIndex === null && startsActiveNonCenteredTrackingEpisode(event)) {
      episodeStartIndex = eventIndex;
      episodeStartMs = event.timestampMs;
    }

    if (
      episodeStartIndex !== null &&
      episodeStartMs !== null &&
      !episodeHasProgress &&
      event.confirmedSequence !== null
    ) {
      const dispatch = dispatches.get(replaySequenceKey(event, event.confirmedSequence));
      if (
        dispatch !== undefined &&
        dispatch.eventIndex >= episodeStartIndex &&
        dispatch.changesPose
      ) {
        latencies.push(event.timestampMs - episodeStartMs);
        episodeHasProgress = true;
      }
    }

    if (episodeStartIndex !== null && endsInitialProgressTrackingEpisode(event)) {
      finishEpisode();
    }
  }
  finishEpisode();

  return {
    initialEffectiveConfirmedProgressLatencyMs: distribution(latencies),
    activeNonCenteredTrackingEpisodesWithoutConfirmedProgress: episodesWithoutProgress
  };
}

function startsActiveNonCenteredTrackingEpisode(
  event: ReplayInitialConfirmedProgressEvent
): boolean {
  return event.controllerMode === "track" && !event.centered;
}

function endsInitialProgressTrackingEpisode(event: ReplayInitialConfirmedProgressEvent): boolean {
  return (
    event.controllerMode !== "track" ||
    (event.centered &&
      event.requestedPose === null &&
      event.counters.activeCalls === 0 &&
      event.counters.pendingDepth === 0)
  );
}

function replayEventBoundary(
  event: Pick<ReplayInitialConfirmedProgressEvent, "variant" | "probeId">
): string {
  return `${event.variant ?? "base"}:${event.probeId ?? "scenario"}`;
}

function replaySequenceKey(
  event: Pick<ReplayInitialConfirmedProgressEvent, "variant" | "probeId">,
  sequence: number
): string {
  return `${replayEventBoundary(event)}:${sequence}`;
}

function uniqueTargetSegmentSamples(
  events: readonly StackChanAttentionReplayEvent[]
): ReplayPoseSample[] {
  const samples: ReplayPoseSample[] = [];
  let previousSegment: number | null | undefined;
  let previousProbe: string | null | undefined;
  for (const event of events) {
    if (event.targetWorldPose === null || event.targetSegmentIndex === null) {
      continue;
    }
    if (event.targetSegmentIndex !== previousSegment || event.probeId !== previousProbe) {
      samples.push({ timestampMs: event.timestampMs, pose: event.targetWorldPose });
      previousSegment = event.targetSegmentIndex;
      previousProbe = event.probeId;
    }
  }
  return samples;
}

function summarizeStaticBoundary(events: readonly StackChanAttentionReplayEvent[]): {
  readonly staticBoundaryObservationCount: number;
  readonly staticBoundaryPrematureReleaseCount: number;
  readonly staticBoundaryRequestOverflowCount: number;
} {
  const probeEvents = events.filter((event) => event.isProbeObservation && event.probeId !== null);
  let prematureReleaseCount = 0;
  for (const probeId of new Set(probeEvents.map((event) => event.probeId))) {
    const observations = probeEvents.filter((event) => event.probeId === probeId);
    let centered = false;
    for (const event of observations) {
      const normalizedError = event.targetNormalizedError;
      const magnitude =
        normalizedError === null
          ? Number.POSITIVE_INFINITY
          : Math.max(Math.abs(normalizedError.yaw), Math.abs(normalizedError.pitch));
      if (centered && magnitude <= STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.deadZoneRelease) {
        prematureReleaseCount += Number(!event.centered || event.dispatchedPose !== null);
      }
      centered = event.centered;
    }
  }
  return {
    staticBoundaryObservationCount: probeEvents.length,
    staticBoundaryPrematureReleaseCount: prematureReleaseCount,
    staticBoundaryRequestOverflowCount: probeEvents.filter(
      (event) => (event.requestSequence === null) !== (event.requestedPose === null)
    ).length
  };
}

// eslint-disable-next-line complexity
function countSameAbsoluteTargetWhileActive(
  events: readonly StackChanAttentionReplayEvent[]
): number {
  let previousTarget: StackChanHeadPose | null = null;
  let count = 0;
  for (const event of events) {
    if (
      event.requestedPose !== null &&
      event.counters.activeCalls > 0 &&
      previousTarget !== null &&
      samePose(event.requestedPose, previousTarget)
    ) {
      count += 1;
    }
    if (event.requestedPose !== null) {
      previousTarget = event.requestedPose;
    }
    if (event.stop || event.clear) {
      previousTarget = null;
    }
  }
  return count;
}

function countPendingSameTargetReplacements(
  events: readonly StackChanAttentionReplayEvent[]
): number {
  let previousTarget: StackChanHeadPose | null = null;
  let previousReplaced = 0;
  let count = 0;
  for (const event of events) {
    const replaced = event.counters.replaced > previousReplaced;
    if (
      replaced &&
      event.requestedPose !== null &&
      previousTarget !== null &&
      samePose(event.requestedPose, previousTarget)
    ) {
      count += 1;
    }
    previousReplaced = event.counters.replaced;
    if (event.requestedPose !== null) {
      previousTarget = event.requestedPose;
    }
    if (event.stop) {
      previousTarget = null;
      previousReplaced = 0;
    }
  }
  return count;
}

function maximumConfirmedStep(events: readonly StackChanAttentionReplayEvent[]): number {
  let maximum = 0;
  let previousPose: StackChanHeadPose | null = null;
  let previousBoundary: string | null = null;
  for (const event of events) {
    const boundary = `${event.variant ?? "base"}:${event.probeId ?? "scenario"}`;
    if (boundary !== previousBoundary) {
      previousPose = null;
      previousBoundary = boundary;
    }
    if (previousPose !== null) {
      maximum = Math.max(
        maximum,
        Math.abs(event.rpcConfirmedPose.yaw - previousPose.yaw),
        Math.abs(event.rpcConfirmedPose.pitch - previousPose.pitch)
      );
    }
    previousPose = event.rpcConfirmedPose;
  }
  return roundSixDecimals(maximum);
}

// Scenario-specific qualification remains co-located with common safety invariants.
// eslint-disable-next-line complexity
function evaluateInvariants(
  id: ScenarioId,
  events: readonly StackChanAttentionReplayEvent[],
  aggregates: ScenarioAggregates,
  runtimeStatus: ScenarioRuntimeStatus,
  stopVariants: StopVariantResults | null
): ScenarioInvariants {
  const commonSafety = {
    angleBounds: events.every(
      (event) =>
        inBounds(event.rpcConfirmedPose) &&
        (event.dispatchedPose === null || inBounds(event.dispatchedPose))
    ),
    pendingDepth: aggregates.pendingMaximum <= 1,
    activeCalls: aggregates.activeMaximum <= STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS,
    noOverlap: runtimeStatus.observationOverlapAttempts === 0,
    noStale: aggregates.staleDispatchCount === 0 && runtimeStatus.staleFramesDiscarded === 0,
    noPostStopNormalDispatch: aggregates.postStopNormalDispatchCount === 0,
    homeReturned:
      aggregates.homeErrorDeg.yaw === 0 &&
      aggregates.homeErrorDeg.pitch === 0 &&
      events.some(
        (event) =>
          event.stop &&
          event.home &&
          event.homeAcknowledgedAtMs !== null &&
          event.homeAcknowledgedPose !== null &&
          samePose(event.homeAcknowledgedPose, homePose())
      ),
    errorFree: runtimeStatus.errorCount === 0,
    runtimeStopped: runtimeStatus.phase === "stopped",
    framesAndTicksComplete:
      runtimeStatus.framesProcessed === runtimeStatus.expectedFramesProcessed &&
      runtimeStatus.observationTicksStarted === runtimeStatus.expectedObservationTicks &&
      runtimeStatus.observationTicksCompleted === runtimeStatus.expectedObservationTicks,
    sufficientPostArrivalDwell:
      aggregates.prematureWaypointAdvances === 0 && aggregates.insufficientPostArrivalDwells === 0,
    targetLossAcceptance: evaluateTargetLossScenarioAcceptance(id, aggregates),
    noSamePoseScanDispatches: aggregates.samePoseScanDispatches === 0,
    postStopQuiescent: evaluatePostStopQuiescence(events, aggregates)
  };
  const trackingDecisionPartition =
    aggregates.trackingDecisionCount > 0 &&
    aggregates.trackingDecisionCount ===
      aggregates.trackingCenteredHoldCount +
        aggregates.trackingQuantizedNoOpCount +
        aggregates.trackingMoveRequestCount;
  const staticBoundaryQualified =
    id !== "static-hold" ||
    (staticBoundaryFixtureComplete(events) &&
      aggregates.nonzeroStaticCommands > 0 &&
      aggregates.staticBoundaryPrematureReleaseCount === 0 &&
      aggregates.staticBoundaryRequestOverflowCount === 0);
  const slowTrackingQualified =
    id !== "slow-continuous-tracking" ||
    (aggregates.visibilityEligibleFrames > 0 &&
      aggregates.visibleFrames * 100 >= aggregates.visibilityEligibleFrames * 95 &&
      aggregates.scanDispatchCount === 0 &&
      aggregates.targetAbsoluteError.combined.count > 0 &&
      aggregates.confirmedKinematics.velocity.combined.count > 0 &&
      aggregates.settlingCensoredCount <= 1);
  const fastReversalQualified =
    id !== "fast-reversals" ||
    (aggregates.visibilityEligibleFrames > 0 &&
      aggregates.visibleFrames * 100 >= aggregates.visibilityEligibleFrames * 95 &&
      aggregates.plannedTargetReversals >= 6 &&
      aggregates.scanDispatchCount === 0 &&
      aggregates.effectiveConfirmedMovements >= 16 &&
      aggregates.settlingIntervalCount > 0 &&
      aggregates.settlingMs.count * 100 >= aggregates.settlingIntervalCount * 80);
  const stopVariantsQualified =
    id !== "stop-home" ||
    (stopVariants !== null &&
      Object.values(stopVariants).every((variant) => variant.status === "passed"));
  const absoluteSafety =
    commonSafety.angleBounds &&
    commonSafety.pendingDepth &&
    commonSafety.activeCalls &&
    commonSafety.noOverlap &&
    commonSafety.noStale &&
    commonSafety.noPostStopNormalDispatch &&
    commonSafety.homeReturned &&
    aggregates.maximumConfirmedStepDeg <= STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.maxStepDeg;
  const qualityDataPresent =
    id === "target-loss-reacquisition" ||
    id === "stop-home" ||
    (aggregates.targetAbsoluteError.combined.count > 0 &&
      (id === "static-hold" || aggregates.confirmedKinematics.velocity.combined.count > 0));
  return {
    ...commonSafety,
    staticBoundaryQualified,
    slowTrackingQualified,
    fastReversalQualified,
    stopVariantsQualified,
    absoluteSafety,
    qualityDataPresent,
    trackingDecisionPartition
  };
}

// eslint-disable-next-line complexity
function staticBoundaryFixtureComplete(events: readonly StackChanAttentionReplayEvent[]): boolean {
  const probeEvents = events.filter((event) => event.isProbeObservation && event.probeId !== null);
  if (probeEvents.length !== staticBoundaryProbes.length * 4) {
    return false;
  }
  for (const probe of staticBoundaryProbes) {
    const observations = probeEvents.filter((event) => event.probeId === probe.probeId);
    const expected = [
      { yaw: 0, pitch: 0 },
      {
        yaw: probe.axis === "yaw" ? probe.initialSign * probe.normalizedError : 0,
        pitch: probe.axis === "pitch" ? probe.initialSign * probe.normalizedError : 0
      },
      {
        yaw: probe.axis === "yaw" ? -probe.initialSign * probe.normalizedError : 0,
        pitch: probe.axis === "pitch" ? -probe.initialSign * probe.normalizedError : 0
      },
      { yaw: 0, pitch: 0 }
    ];
    if (
      observations.length !== expected.length ||
      observations.some((event, index) => {
        const normalized = event.targetNormalizedError;
        const expectedError = expected[index];
        return (
          normalized === null || expectedError === undefined || !samePose(normalized, expectedError)
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

function evaluateTargetLossScenarioAcceptance(
  id: ScenarioId,
  aggregates: ScenarioAggregates
): boolean {
  return id !== "target-loss-reacquisition" || evaluateTargetLossAcceptance(aggregates);
}

function evaluateTargetLossAcceptance(aggregates: ScenarioAggregates): boolean {
  return [
    aggregates.waypointReachRatio === 1 &&
      aggregates.prematureWaypointAdvances === 0 &&
      aggregates.insufficientPostArrivalDwells === 0 &&
      aggregates.samePoseScanDispatches === 0,
    aggregates.actualPostArrivalDwellMs.count >= 1 &&
      isAtLeast(
        aggregates.minimumPostArrivalDwellMs,
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      ),
    isBetweenExclusive(aggregates.reacquisitionLatencyMs, 0, 7_125)
  ].every(Boolean);
}

function isAtLeast(value: number | null, minimum: number): boolean {
  return value !== null && value >= minimum;
}

function isBetweenExclusive(value: number | null, minimum: number, maximum: number): boolean {
  return value !== null && value > minimum && value < maximum;
}

function evaluatePostStopQuiescence(
  events: readonly StackChanAttentionReplayEvent[],
  aggregates: ScenarioAggregates
): boolean {
  const stopEvents = events.filter((event) => event.stop);
  return (
    stopEvents.length > 0 &&
    aggregates.postStopDispatchAttemptCount === stopEvents.length &&
    stopEvents.every((event) => {
      const probe = event.postStopProbe;
      return (
        probe?.schedulerTickRejected === true &&
        probe.lanePhase === "stopped" &&
        probe.dispatchAttempts === 1 &&
        probe.dispatchedBefore === probe.dispatchedAfter &&
        probe.confirmedBefore === probe.confirmedAfter &&
        event.counters.postStopDispatchAttempts === 1
      );
    })
  );
}

export type ReplayWaypointSample = Omit<
  Pick<
    StackChanAttentionReplayEvent,
    | "timestampMs"
    | "controllerMode"
    | "requestedPose"
    | "rpcConfirmedPose"
    | "detectorState"
    | "stop"
    | "variant"
  >,
  "variant"
> & {
  readonly variant: StopVariant | "pending" | "scan" | null;
};

export function summarizeReplayWaypoints(
  events: readonly ReplayWaypointSample[],
  minimumPostArrivalDwellMs = STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
): {
  readonly waypointReachRatio: number;
  readonly prematureWaypointAdvances: number;
  readonly insufficientPostArrivalDwells: number;
  readonly actualPostArrivalDwellMs: Distribution;
  readonly minimumPostArrivalDwellMs: number | null;
  readonly dwellBeforeArrivalMs: Distribution;
  readonly progressReversals: number;
} {
  const waypoints = collapseWaypointVisits(events);
  const visits = waypoints.map((waypoint, index) => {
    const next = waypoints[index + 1];
    return summarizeWaypointVisit(events, waypoint, next, next?.group === waypoint.group);
  });
  const reachEvaluatedVisits = visits.filter((visit) => visit.includedInReachRatio);
  const reached = reachEvaluatedVisits.filter((visit) => visit.arrived).length;
  const prematureDwells = visits.flatMap((visit) =>
    visit.prematureDwellMs === null ? [] : [visit.prematureDwellMs]
  );
  const postArrivalDwells = visits.flatMap((visit) =>
    visit.actualPostArrivalDwellMs === null ? [] : [visit.actualPostArrivalDwellMs]
  );
  return {
    waypointReachRatio:
      reachEvaluatedVisits.length === 0
        ? 0
        : roundSixDecimals(reached / reachEvaluatedVisits.length),
    prematureWaypointAdvances: prematureDwells.length,
    insufficientPostArrivalDwells: postArrivalDwells.filter(
      (dwellMs) => dwellMs < minimumPostArrivalDwellMs
    ).length,
    actualPostArrivalDwellMs: distribution(postArrivalDwells),
    minimumPostArrivalDwellMs:
      postArrivalDwells.length === 0 ? null : Math.min(...postArrivalDwells),
    dwellBeforeArrivalMs: distribution(prematureDwells),
    progressReversals: visits.reduce((sum, visit) => sum + visit.progressReversals, 0)
  };
}

type ReplayWaypointVisitStart = {
  readonly sample: ReplayWaypointSample;
  readonly group: number;
};

// Scan continuity, lifecycle interruption, and variant boundaries are evaluated together.
function collapseWaypointVisits(
  events: readonly ReplayWaypointSample[]
): ReplayWaypointVisitStart[] {
  const waypoints: ReplayWaypointVisitStart[] = [];
  let activePose: StackChanHeadPose | null = null;
  let activeVariant: ReplayWaypointSample["variant"] | undefined;
  let group = 0;
  for (const event of events) {
    const interrupted =
      isWaypointInterruption(event) ||
      (activeVariant !== undefined && event.variant !== activeVariant);
    if (interrupted) {
      activePose = null;
      activeVariant = event.variant;
      group += 1;
      continue;
    }
    if (event.requestedPose === null) {
      continue;
    }
    if (activePose === null || !samePose(activePose, event.requestedPose)) {
      waypoints.push({ sample: event, group });
      activePose = event.requestedPose;
      activeVariant = event.variant;
    }
  }
  return waypoints;
}

// Arrival, pre-arrival advance, post-arrival dwell, and path reversal are independent outputs.
// eslint-disable-next-line complexity
function summarizeWaypointVisit(
  events: readonly ReplayWaypointSample[],
  waypoint: ReplayWaypointVisitStart,
  next: ReplayWaypointVisitStart | undefined,
  isAdvance: boolean
): {
  readonly arrived: boolean;
  readonly arrivedAtMs: number | null;
  readonly includedInReachRatio: boolean;
  readonly prematureDwellMs: number | null;
  readonly actualPostArrivalDwellMs: number | null;
  readonly progressReversals: number;
} {
  const waypointSample = waypoint.sample;
  const nextSample = next?.sample;
  const interval = events.filter(
    (event) =>
      event.timestampMs >= waypointSample.timestampMs &&
      (nextSample === undefined || event.timestampMs < nextSample.timestampMs) &&
      event.variant === waypointSample.variant
  );
  const arrival = interval.find(
    (event) =>
      waypointSample.requestedPose !== null &&
      samePose(event.rpcConfirmedPose, waypointSample.requestedPose)
  );
  const arrivedAtMs = arrival?.timestampMs ?? null;
  return {
    arrived: arrival !== undefined,
    arrivedAtMs,
    includedInReachRatio: isAdvance || !interval.some(isWaypointInterruption),
    prematureDwellMs:
      !isAdvance || nextSample === undefined || arrival !== undefined
        ? null
        : nextSample.timestampMs - waypointSample.timestampMs,
    actualPostArrivalDwellMs:
      !isAdvance || nextSample === undefined || arrivedAtMs === null
        ? null
        : nextSample.timestampMs - arrivedAtMs,
    progressReversals: countWaypointProgressReversals(interval, waypointSample.requestedPose)
  };
}

function isWaypointInterruption(event: ReplayWaypointSample): boolean {
  return event.stop || (event.controllerMode === "track" && event.detectorState === "visible");
}

function countWaypointProgressReversals(
  events: readonly ReplayWaypointSample[],
  waypoint: StackChanHeadPose | null
): number {
  if (waypoint === null) {
    return 0;
  }
  const distances = events.map((event) => angularDistance(event.rpcConfirmedPose, waypoint));
  let reversals = 0;
  for (let index = 1; index < distances.length; index += 1) {
    const previous = distances[index - 1];
    const current = distances[index];
    if (previous !== undefined && current !== undefined && current > previous) {
      reversals += 1;
    }
  }
  return reversals;
}

// Segments must remain explicit so an unsettled interval is censored instead of disappearing.
// eslint-disable-next-line complexity
function summarizeSettling(events: readonly StackChanAttentionReplayEvent[]): {
  readonly settlingMs: Distribution;
  readonly settlingIntervalCount: number;
  readonly settlingCensoredCount: number;
} {
  const intervals: StackChanAttentionReplayEvent[][] = [];
  for (const event of events) {
    if (event.frameSequence === null || event.targetSegmentIndex === null) {
      continue;
    }
    const current = intervals.at(-1);
    const previous = current?.at(-1);
    if (
      current === undefined ||
      previous?.variant !== event.variant ||
      previous.targetSegmentIndex !== event.targetSegmentIndex
    ) {
      intervals.push([event]);
    } else {
      current.push(event);
    }
  }
  const latencies: number[] = [];
  let censoredCount = 0;
  const stableWindowMs = 2 * STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs;
  for (const interval of intervals) {
    const startedAtMs = interval[0]?.timestampMs;
    if (startedAtMs === undefined) {
      continue;
    }
    const settledAtMs = interval.find((candidate, candidateIndex) =>
      isStableCenteredWindow(interval.slice(candidateIndex), candidate.timestampMs, stableWindowMs)
    )?.timestampMs;
    if (settledAtMs === undefined) {
      censoredCount += 1;
    } else {
      latencies.push(settledAtMs - startedAtMs);
    }
  }
  return {
    settlingMs: distribution(latencies),
    settlingIntervalCount: intervals.length,
    settlingCensoredCount: censoredCount
  };
}

function isStableCenteredWindow(
  events: readonly StackChanAttentionReplayEvent[],
  startMs: number,
  stableWindowMs: number
): boolean {
  const endMs = startMs + stableWindowMs;
  const window = events.filter(
    (event) => event.timestampMs >= startMs && event.timestampMs <= endMs
  );
  return (
    window.at(-1)?.timestampMs === endMs &&
    window.every(
      (event) =>
        event.detectorState === "visible" &&
        event.controllerMode === "track" &&
        (event.centered ||
          (event.targetNormalizedError !== null &&
            Math.max(
              Math.abs(event.targetNormalizedError.yaw),
              Math.abs(event.targetNormalizedError.pitch)
            ) <= STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.deadZoneRelease &&
            event.requestedPose === null &&
            event.dispatchedPose === null))
    ) &&
    window.every((event) =>
      samePose(event.rpcConfirmedPose, window[0]?.rpcConfirmedPose ?? homePose())
    )
  );
}

function calculateReacquisitionLatency(
  events: readonly StackChanAttentionReplayEvent[]
): number | null {
  const reappearance = events.find(
    (event) =>
      event.targetWorldPose?.yaw === 35 &&
      event.targetWorldPose.pitch === 33 &&
      event.detectorState === "outside-fov"
  );
  const reacquired = events.find(
    (event) =>
      reappearance !== undefined &&
      event.timestampMs > reappearance.timestampMs &&
      event.detectorState === "visible"
  );
  return reappearance === undefined || reacquired === undefined
    ? null
    : reacquired.timestampMs - reappearance.timestampMs;
}

// The three windows deliberately combine fixture and observed runtime boundaries.
// eslint-disable-next-line complexity
function createLossWindows(
  events: readonly StackChanAttentionReplayEvent[],
  world: readonly WorldKeyframe[]
): readonly LossWindow[] {
  const occlusion = world.find((keyframe) => keyframe.occluded);
  const reappearance = world.find(
    (keyframe) => !keyframe.occluded && keyframe.atMs > (occlusion?.atMs ?? 0)
  );
  const firstScan = events.find((event) => event.controllerMode === "scan");
  const reacquired = events.find(
    (event) =>
      reappearance !== undefined &&
      event.timestampMs >= reappearance.atMs &&
      event.detectorState === "visible"
  );
  return [
    {
      phase: "before-search",
      startMs: occlusion?.atMs ?? 0,
      endMs: firstScan?.timestampMs ?? null
    },
    {
      phase: "during-search",
      startMs: firstScan?.timestampMs ?? 0,
      endMs: reappearance?.atMs ?? null
    },
    {
      phase: "before-reacquisition",
      startMs: reappearance?.atMs ?? 0,
      endMs: reacquired?.timestampMs ?? null
    }
  ];
}

function poseSamples(
  events: readonly StackChanAttentionReplayEvent[],
  select: (event: StackChanAttentionReplayEvent) => StackChanHeadPose | null
): ReplayPoseSample[] {
  return events.flatMap((event) => {
    const pose = select(event);
    return pose === null ? [] : [{ timestampMs: event.timestampMs, pose }];
  });
}

function uniquePoseSamples(
  events: readonly StackChanAttentionReplayEvent[],
  select: (event: StackChanAttentionReplayEvent) => StackChanHeadPose
): ReplayPoseSample[] {
  const samples: ReplayPoseSample[] = [];
  for (const event of events) {
    const pose = select(event);
    if (samples.at(-1)?.timestampMs === event.timestampMs) {
      continue;
    }
    samples.push({ timestampMs: event.timestampMs, pose });
  }
  return samples;
}

function summarizePoseMagnitudes(poses: readonly StackChanHeadPose[]): {
  readonly yaw: Distribution;
  readonly pitch: Distribution;
  readonly combined: Distribution;
} {
  return {
    yaw: distribution(poses.map((pose) => Math.abs(pose.yaw))),
    pitch: distribution(poses.map((pose) => Math.abs(pose.pitch))),
    combined: distribution(poses.map((pose) => Math.hypot(pose.yaw, pose.pitch)))
  };
}

type DerivedSample = {
  readonly timestampMs: number;
  readonly yaw: number;
  readonly pitch: number;
};

function requireStrictlyIncreasingTimestamps(samples: readonly ReplayPoseSample[]): void {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.timestampMs - previous.timestampMs <= 0
    ) {
      throw new Error("attention replay derivative dt<=0");
    }
  }
}

function deriveSamples(samples: readonly DerivedSample[]): DerivedSample[] {
  const derived: DerivedSample[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const deltaSeconds = (current.timestampMs - previous.timestampMs) / 1_000;
    if (deltaSeconds <= 0) {
      throw new Error("attention replay derivative dt<=0");
    }
    derived.push({
      timestampMs: current.timestampMs,
      yaw: (current.yaw - previous.yaw) / deltaSeconds,
      pitch: (current.pitch - previous.pitch) / deltaSeconds
    });
  }
  return derived;
}

function summarizeDerivative(samples: readonly DerivedSample[]): DerivativeSummary {
  return {
    yaw: distribution(samples.map((sample) => Math.abs(sample.yaw))),
    pitch: distribution(samples.map((sample) => Math.abs(sample.pitch))),
    combined: distribution(samples.map((sample) => Math.hypot(sample.yaw, sample.pitch)))
  };
}

function velocityTotalVariation(samples: readonly ReplayPoseSample[]): {
  readonly yaw: number;
  readonly pitch: number;
  readonly combined: number;
} {
  if (samples.length < 2) {
    return { yaw: 0, pitch: 0, combined: 0 };
  }
  requireStrictlyIncreasingTimestamps(samples);
  const velocity = deriveSamples(
    samples.map((sample) => ({
      timestampMs: sample.timestampMs,
      yaw: sample.pose.yaw,
      pitch: sample.pose.pitch
    }))
  );
  const yaw = totalVariation(velocity.map((sample) => sample.yaw));
  const pitch = totalVariation(velocity.map((sample) => sample.pitch));
  return {
    yaw,
    pitch,
    combined: roundSixDecimals(yaw + pitch)
  };
}

function totalVariation(values: readonly number[]): number {
  return roundSixDecimals(
    values
      .slice(1)
      .reduce((sum, value, index) => sum + Math.abs(value - (values[index] ?? value)), 0)
  );
}

function directionReversals(samples: readonly ReplayPoseSample[]): {
  readonly yaw: number;
  readonly pitch: number;
  readonly combined: number;
} {
  const yaw = countDirectionReversals(samples.map((sample) => sample.pose.yaw));
  const pitch = countDirectionReversals(samples.map((sample) => sample.pose.pitch));
  return { yaw, pitch, combined: yaw + pitch };
}

function countDirectionReversals(values: readonly number[]): number {
  let previousSign = 0;
  let count = 0;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const sign = Math.sign(current - previous);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) {
      count += 1;
    }
    if (sign !== 0) {
      previousSign = sign;
    }
  }
  return count;
}

function angularPath(samples: readonly ReplayPoseSample[]): number {
  return roundSixDecimals(
    samples.slice(1).reduce((sum, sample, index) => {
      const previous = samples[index];
      return previous === undefined ? sum : sum + angularDistance(sample.pose, previous.pose);
    }, 0)
  );
}

function countSamePoses(poses: readonly (StackChanHeadPose | null)[]): number {
  let previous: StackChanHeadPose | undefined;
  let count = 0;
  for (const pose of poses) {
    if (pose === null) {
      continue;
    }
    count += Number(previous !== undefined && samePose(previous, pose));
    previous = pose;
  }
  return count;
}

function normalizedRoughness(values: readonly number[]): number {
  const deltas = values.slice(1).map((value, index) => value - (values[index] ?? value));
  const numerator = deltas
    .slice(1)
    .reduce((sum, delta, index) => sum + Math.abs(delta - (deltas[index] ?? delta)), 0);
  const denominator = Math.max(
    deltas.reduce((sum, delta) => sum + Math.abs(delta), 0),
    1
  );
  return roundSixDecimals(numerator / denominator);
}

function normalizedCombinedRoughness(samples: readonly ReplayPoseSample[]): number {
  const deltas = samples.slice(1).map((sample, index) => {
    const previous = samples[index]?.pose ?? sample.pose;
    return {
      yaw: sample.pose.yaw - previous.yaw,
      pitch: sample.pose.pitch - previous.pitch
    };
  });
  const numerator = deltas.slice(1).reduce((sum, delta, index) => {
    const previous = deltas[index] ?? delta;
    return sum + Math.hypot(delta.yaw - previous.yaw, delta.pitch - previous.pitch);
  }, 0);
  const denominator = Math.max(
    deltas.reduce((sum, delta) => sum + Math.hypot(delta.yaw, delta.pitch), 0),
    1
  );
  return roundSixDecimals(numerator / denominator);
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, p50: null, p90: null, p95: null, p99: null, max: null };
  }
  const sorted = values.map(roundSixDecimals).sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted.at(-1) ?? null
  };
}

function nearestRank(sorted: readonly number[], quantile: number): number | null {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function projectRuntimeStatus(
  status: StackChanAttentionStatus,
  expectedObservationTicks: number
): ScenarioRuntimeStatus {
  const evidence = projectFinalRuntimeEvidence(status);
  return {
    ...evidence,
    expectedFramesProcessed: expectedObservationTicks,
    expectedObservationTicks,
    errorCount: evidence.errorCodes.length
  };
}

function projectFinalRuntimeEvidence(status: StackChanAttentionStatus): FinalRuntimeEvidence {
  return {
    phase: status.phase,
    framesProcessed: status.framesProcessed,
    lastAcceptedFrameSequence: status.flow.lastAcceptedFrameSequence ?? null,
    staleFramesDiscarded: status.flow.staleFramesDiscarded,
    observationTicksStarted: status.flow.observationTicksStarted,
    observationTicksCompleted: status.flow.observationTicksCompleted,
    observationOverlapAttempts: status.flow.observationOverlapAttempts,
    maximumConcurrentObservationTicks: status.flow.maximumConcurrentObservationTicks,
    errorCodes: (status.errors ?? [])
      .slice(-STACKCHAN_ATTENTION_ERROR_HISTORY_LIMIT)
      .map((error) => error.code)
  };
}

function reduceRecordedRuntimeStatus(
  input: CanonicalScenarioInput | StopVariantInput,
  events: readonly StackChanAttentionReplayEvent[]
): ScenarioRuntimeStatus {
  if (events.some((event) => !event.stop && event.finalRuntimeEvidence !== null)) {
    throw new Error("attention replay non-stop event has final runtime evidence");
  }
  const subruns = splitReplaySubruns(events);
  const expectedTicks = expectedSubrunObservationTicks(input);
  if (subruns.length !== expectedTicks.length) {
    throw new Error("attention replay final runtime evidence count mismatch");
  }
  validateRecordedSubrunRoster(input, subruns);
  const statuses = subruns.map((subrun, index) => {
    const expectedObservationTicks = expectedTicks[index];
    if (expectedObservationTicks === undefined) {
      throw new Error("attention replay expected runtime evidence is missing");
    }
    return reduceRecordedSubrunStatus(subrun, expectedObservationTicks);
  });
  const single = statuses[0];
  if (single !== undefined && statuses.length === 1) {
    return single;
  }
  return combineRuntimeStatuses(statuses);
}

function validateRecordedSubrunRoster(
  input: CanonicalScenarioInput | StopVariantInput,
  subruns: readonly (readonly StackChanAttentionReplayEvent[])[]
): void {
  for (const [index, subrun] of subruns.entries()) {
    const expected = expectedReplaySubrunIdentity(input, index);
    if (
      subrun.some(
        (event) =>
          event.variant !== expected.variant ||
          event.probeId !== expected.probeId ||
          event.isProbeObservation !== (expected.probeObservation && !event.stop)
      )
    ) {
      throw new Error("attention replay scenario event subrun roster mismatch");
    }
  }
}

function expectedReplaySubrunIdentity(
  input: CanonicalScenarioInput | StopVariantInput,
  index: number
): {
  readonly variant: StopVariant | null;
  readonly probeId: string | null;
  readonly probeObservation: boolean;
} {
  if ("variant" in input) {
    return { variant: input.variant, probeId: null, probeObservation: false };
  }
  if ("probes" in input) {
    const probe = input.probes[index];
    if (probe === undefined) {
      throw new Error("attention replay static subrun input is missing");
    }
    return { variant: null, probeId: probe.probeId, probeObservation: true };
  }
  if ("variants" in input) {
    const variant = input.variants[index];
    if (variant === undefined) {
      throw new Error("attention replay stop subrun input is missing");
    }
    return { variant: variant.variant, probeId: null, probeObservation: false };
  }
  return { variant: null, probeId: null, probeObservation: false };
}

function splitReplaySubruns(
  events: readonly StackChanAttentionReplayEvent[]
): StackChanAttentionReplayEvent[][] {
  const subruns: StackChanAttentionReplayEvent[][] = [];
  let current: StackChanAttentionReplayEvent[] = [];
  for (const event of events) {
    current.push(event);
    if (event.stop) {
      subruns.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    throw new Error("attention replay subrun has no stop event");
  }
  return subruns;
}

function reduceRecordedSubrunStatus(
  subrun: readonly StackChanAttentionReplayEvent[],
  expectedObservationTicks: number
): ScenarioRuntimeStatus {
  const stopEvent = requireRecordedStopEvent(subrun);
  const observations = subrun.slice(0, -1);
  requireRecordedObservations(observations, expectedObservationTicks);
  const derived = deriveRecordedObservationEvidence(observations);
  const evidence = stopEvent.finalRuntimeEvidence;
  if (evidence === null) {
    throw new Error("attention replay stop event final runtime evidence is missing");
  }
  if (!recordedFinalEvidenceMatches(evidence, stopEvent, derived, observations.length)) {
    throw new Error("attention replay final runtime evidence mismatch");
  }
  return {
    ...evidence,
    lastAcceptedFrameSequence: derived.lastAcceptedFrameSequence,
    observationTicksStarted: observations.length,
    observationTicksCompleted: observations.length,
    expectedFramesProcessed: expectedObservationTicks,
    expectedObservationTicks,
    errorCount: evidence.errorCodes.length
  };
}

function requireRecordedStopEvent(
  subrun: readonly StackChanAttentionReplayEvent[]
): StackChanAttentionReplayEvent {
  const stopEvent = subrun.at(-1);
  if (stopEvent === undefined || !stopEvent.stop || stopEvent.finalRuntimeEvidence === null) {
    throw new Error("attention replay stop event final runtime evidence is missing");
  }
  return stopEvent;
}

function requireRecordedObservations(
  observations: readonly StackChanAttentionReplayEvent[],
  expectedObservationTicks: number
): void {
  if (
    observations.length !== expectedObservationTicks ||
    observations.some((event) => event.stop || event.frameSequence === null)
  ) {
    throw new Error("attention replay captured frame evidence mismatch");
  }
}

function recordedFinalEvidenceMatches(
  evidence: FinalRuntimeEvidence,
  stopEvent: StackChanAttentionReplayEvent,
  derived: ReturnType<typeof deriveRecordedObservationEvidence>,
  observationCount: number
): boolean {
  return (
    evidence.framesProcessed === derived.framesProcessed &&
    evidence.lastAcceptedFrameSequence === derived.lastAcceptedFrameSequence &&
    stopEvent.runtimeAcceptedFrameSequence === derived.lastAcceptedFrameSequence &&
    evidence.observationTicksStarted === observationCount &&
    evidence.observationTicksCompleted === observationCount
  );
}

function deriveRecordedObservationEvidence(
  observations: readonly StackChanAttentionReplayEvent[]
): {
  readonly framesProcessed: number;
  readonly lastAcceptedFrameSequence: number | null;
} {
  let framesProcessed = 0;
  let lastAcceptedFrameSequence: number | null = null;
  for (const [index, event] of observations.entries()) {
    if (event.frameSequence !== index + 1) {
      throw new Error("attention replay captured frame sequence mismatch");
    }
    if (
      event.runtimeAcceptedFrameSequence !== lastAcceptedFrameSequence &&
      event.runtimeAcceptedFrameSequence !== event.frameSequence
    ) {
      throw new Error("attention replay accepted frame sequence mismatch");
    }
    if (event.runtimeAcceptedFrameSequence !== lastAcceptedFrameSequence) {
      framesProcessed += 1;
      lastAcceptedFrameSequence = event.runtimeAcceptedFrameSequence;
    }
  }
  return { framesProcessed, lastAcceptedFrameSequence };
}

function expectedSubrunObservationTicks(
  input: CanonicalScenarioInput | StopVariantInput
): number[] {
  const ticks = (durationMs: number): number =>
    Math.floor(durationMs / STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs) + 1;
  if ("probes" in input) {
    return input.probes.map(() => ticks(STACKCHAN_ATTENTION_REPLAY_FIXTURE.staticProbeDurationMs));
  }
  if ("variants" in input) {
    return input.variants.map((variant) => ticks(variant.durationMs));
  }
  return [ticks(input.durationMs)];
}

function requireLegacyRuntimeStatus(evidence: ReplayRawScenarioEvidence): ScenarioRuntimeStatus {
  if (evidence.legacyRuntimeStatus === undefined) {
    throw new Error("attention replay legacy runtime status is missing");
  }
  return evidence.legacyRuntimeStatus;
}

function combineRuntimeStatuses(statuses: readonly ScenarioRuntimeStatus[]): ScenarioRuntimeStatus {
  const errorCodes = statuses
    .flatMap((status) => status.errorCodes)
    .slice(-STACKCHAN_ATTENTION_ERROR_HISTORY_LIMIT);
  return {
    phase: statuses.every((status) => status.phase === "stopped") ? "stopped" : "stopping",
    framesProcessed: statuses.reduce((sum, status) => sum + status.framesProcessed, 0),
    lastAcceptedFrameSequence: statuses.at(-1)?.lastAcceptedFrameSequence ?? null,
    staleFramesDiscarded: statuses.reduce((sum, status) => sum + status.staleFramesDiscarded, 0),
    observationTicksStarted: statuses.reduce(
      (sum, status) => sum + status.observationTicksStarted,
      0
    ),
    observationTicksCompleted: statuses.reduce(
      (sum, status) => sum + status.observationTicksCompleted,
      0
    ),
    observationOverlapAttempts: statuses.reduce(
      (sum, status) => sum + status.observationOverlapAttempts,
      0
    ),
    maximumConcurrentObservationTicks: Math.max(
      0,
      ...statuses.map((status) => status.maximumConcurrentObservationTicks)
    ),
    expectedFramesProcessed: statuses.reduce(
      (sum, status) => sum + status.expectedFramesProcessed,
      0
    ),
    expectedObservationTicks: statuses.reduce(
      (sum, status) => sum + status.expectedObservationTicks,
      0
    ),
    errorCount: errorCodes.length,
    errorCodes
  };
}

function createScenarioHashRecord(
  scenarios: readonly StackChanAttentionReplayScenario[]
): ScenarioHashRecord {
  return Object.fromEntries(
    scenarios.map((scenario) => [scenario.id, scenario.canonicalHash])
  ) as ScenarioHashRecord;
}

function createReplayFixture(quantizationMode: StackChanAttentionReplayStepQuantization): Omit<
  typeof STACKCHAN_ATTENTION_REPLAY_FIXTURE,
  "follow"
> & {
  readonly follow: EnabledFollowConfig;
} {
  return {
    ...STACKCHAN_ATTENTION_REPLAY_FIXTURE,
    follow: {
      ...STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow,
      stepQuantization: quantizationMode
    }
  };
}

function createMetadata(
  quantizationMode: StackChanAttentionReplayStepQuantization
): StackChanAttentionReplayReport["metadata"] {
  return {
    runtimeFactory: "createStackChanAttentionRuntime",
    clock: "virtual-monotonic",
    quantizationMode,
    motionEvidence: "virtual-confirmed-not-physical",
    fixture: createReplayFixture(quantizationMode),
    percentile: {
      method: "nearest-rank",
      definition: "sorted[ceil(q*n)-1]",
      quantiles: [0.5, 0.9, 0.95, 0.99]
    },
    roughnessDefinition: "sum(abs(delta[k]-delta[k-1]))/max(sum(abs(delta[k])),1deg)",
    derivativeRule: "dt<=0 fails the run",
    gateway: {
      absoluteRequests: true,
      reclampFromPlannedPose: true,
      maximumActiveCalls: STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS,
      quantizationDeg: 1,
      pendingPolicy: "latest-wins",
      homeDispatch: "adapter-only-after-lane-stop"
    }
  };
}

function finalHomeError(events: readonly StackChanAttentionReplayEvent[]): StackChanHeadPose {
  let finalPose = homePose();
  for (const event of events) {
    if (event.homeAcknowledgedPose !== null) {
      finalPose = event.homeAcknowledgedPose;
    }
  }
  return {
    yaw: Math.abs(finalPose.yaw - STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.homeYaw),
    pitch: Math.abs(finalPose.pitch - STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.homePitch)
  };
}

function homePose(): StackChanHeadPose {
  return {
    yaw: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.homeYaw,
    pitch: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.homePitch
  };
}

function inBounds(pose: StackChanHeadPose): boolean {
  return pose.yaw >= -90 && pose.yaw <= 90 && pose.pitch >= 5 && pose.pitch <= 85;
}

function samePose(left: StackChanHeadPose, right: StackChanHeadPose): boolean {
  return left.yaw === right.yaw && left.pitch === right.pitch;
}

function angularDistance(left: StackChanHeadPose, right: StackChanHeadPose): number {
  return Math.hypot(left.yaw - right.yaw, left.pitch - right.pitch);
}

function clamp(value: number, ...bounds: readonly number[]): number {
  let result = value;
  for (let index = 0; index < bounds.length; index += 2) {
    const minimum = bounds[index];
    const maximum = bounds[index + 1];
    if (minimum !== undefined && maximum !== undefined) {
      result = Math.min(maximum, Math.max(minimum, result));
    }
  }
  return result;
}

function roundSixDecimals(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  assertFiniteJsonValue(value, "canonical");
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export const STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES = [
  "pico-attention-controller",
  "pico-target-center-filter",
  "pico-attention-runtime",
  "pico-attention-detection",
  "replay-sut-lane-policy",
  "gateway-head-target-lane"
] as const;

export type StackChanAttentionReplayProducerSourceRole =
  (typeof STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES)[number];

export function hashStackChanAttentionReplayProducerSources(
  sources: readonly {
    readonly role: StackChanAttentionReplayProducerSourceRole;
    readonly bytes: Uint8Array;
  }[]
): string {
  if (
    sources.length !== STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES.length ||
    sources.some(
      (source, index) => source.role !== STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[index]
    )
  ) {
    throw new Error("attention replay producer source roles mismatch");
  }
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(source.role);
    hash.update("\0");
    hash.update(source.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const replayEventKeys = [
  "sequence",
  "timestampMs",
  "observationId",
  "variant",
  "frameSequence",
  "runtimeAcceptedFrameSequence",
  "targetWorldPose",
  "targetSegmentIndex",
  "detectorState",
  "targetErrorDeg",
  "targetNormalizedError",
  "probeId",
  "isProbeObservation",
  "centered",
  "controllerMode",
  "decision",
  "requestSequence",
  "requestedPose",
  "dispatchSequence",
  "dispatchedRequestPose",
  "dispatchedPose",
  "confirmedSequence",
  "noOpDiscardedSequence",
  "confirmedBeforeDispatch",
  "plannedBeforeDispatch",
  "rpcConfirmedPose",
  "pendingAgeMs",
  "generation",
  "counters",
  "clear",
  "stop",
  "stopRequestedAtMs",
  "home",
  "homeAcknowledgedAtMs",
  "homeAcknowledgedPose",
  "postStopProbe",
  "finalRuntimeEvidence"
] as const;

const replayReportKeys = [
  "schemaVersion",
  "evidenceKind",
  "runtimeEvidenceSource",
  "status",
  "reportSchemaHash",
  "eventSchemaHash",
  "metricDefinitionHash",
  "metricImplementationHash",
  "acceptanceProfileHash",
  "fixtureHash",
  "scenarioInputHash",
  "producerSourceHash",
  "comparisonSetHash",
  "metadata",
  "scenarios",
  "repeatDeterminism"
] as const;

const replayScenarioKeys = [
  "id",
  "status",
  "canonicalInput",
  "canonicalInputHash",
  "canonicalHash",
  "lossWindows",
  "events",
  "aggregates",
  "invariants",
  "runtimeStatus",
  "stopVariants"
] as const;

const replayCounterKeys = [
  "accepted",
  "replaced",
  "dispatched",
  "confirmed",
  "failed",
  "staleDiscarded",
  "noOpDiscarded",
  "pendingDepth",
  "activeCalls",
  "maximumPendingDepth",
  "maximumActiveCalls",
  "postStopDispatches",
  "postStopDispatchAttempts"
] as const;

// Schema, semantic evidence, contract hashes, and reducer parity fail at one public boundary.
// eslint-disable-next-line complexity
export function validateStackChanAttentionReplayReport(
  value: unknown,
  validationMode: StackChanAttentionReplayValidationMode = "qualified",
  contractSourceHashes?: StackChanAttentionReplayContractSourceHashes
): void {
  validateStackChanAttentionReplaySchemaValue(value);
  const report = requireRecord(value, "report");
  assertExactKeys(report, replayReportKeys, "report");
  if (report.schemaVersion !== 7) {
    throw new Error("report.schemaVersion is invalid");
  }
  if (report.evidenceKind !== validationMode) {
    throw new Error("report.evidenceKind mismatch");
  }
  const expectedRuntimeEvidenceSource =
    validationMode === "qualified" ? "recorded-final-events" : "legacy-scenario-status";
  if (report.runtimeEvidenceSource !== expectedRuntimeEvidenceSource) {
    throw new Error("report.runtimeEvidenceSource mismatch");
  }
  if (report.status !== "passed" && report.status !== "failed") {
    throw new Error("report.status is invalid");
  }
  assertFiniteJsonValue(report, "report");
  const metadata = requireRecord(report.metadata, "report.metadata");
  const quantizationMode = parseReplayStepQuantization(
    metadata.quantizationMode,
    "report.metadata.quantizationMode"
  );
  if (canonicalHash(report.metadata) !== canonicalHash(createMetadata(quantizationMode))) {
    throw new Error("report.metadata mismatch");
  }
  const scenarios = requireArray(report.scenarios, "report.scenarios");
  if (scenarios.length !== canonicalScenarioInputs.length) {
    throw new Error("report.scenarios length is invalid");
  }
  for (const [index, candidate] of scenarios.entries()) {
    const path = `report.scenarios[${index}]`;
    const scenario = requireRecord(candidate, `report.scenarios[${index}]`);
    assertExactKeys(scenario, replayScenarioKeys, path);
    const id = scenario.id;
    if (!isScenarioId(id)) {
      throw new Error(`${path}.id is invalid`);
    }
    const canonicalInput = normalizeCanonicalInput(
      scenario.canonicalInput,
      `${path}.canonicalInput`
    );
    if (id !== canonicalInput.id) {
      throw new Error(`${path}.id does not match canonicalInput.id`);
    }
    const expectedInput = canonicalScenarioInputs[index];
    if (expectedInput === undefined || id !== expectedInput.id) {
      throw new Error(`${path}.id is not in canonical scenario order`);
    }
    if (
      validationMode === "qualified" &&
      canonicalHash(canonicalInput) !== canonicalHash(expectedInput)
    ) {
      throw new Error(`${path}.canonicalInput mismatch`);
    }
    validateRawScenarioEvidence(
      canonicalInput,
      requireArray(
        scenario.events,
        `${path}.events`
      ) as unknown as readonly StackChanAttentionReplayEvent[],
      expectedRuntimeEvidenceSource
    );
    validateRuntimeStatus(scenario.runtimeStatus, `${path}.runtimeStatus`);
  }
  const typedReport = report as StackChanAttentionReplayReport;
  if (
    typedReport.scenarios.some((scenario) =>
      scenario.events.some(
        (event) => event.decision !== null && event.decision.quantizationMode !== quantizationMode
      )
    )
  ) {
    throw new Error("report controller decision quantization mode mismatch");
  }
  if (validationMode === "qualified") {
    requireHash(report.producerSourceHash, "report.producerSourceHash");
    if (
      contractSourceHashes !== undefined &&
      report.producerSourceHash !== contractSourceHashes.producerSourceHash
    ) {
      throw new Error("report.producerSourceHash mismatch");
    }
  } else if (report.producerSourceHash !== null) {
    throw new Error("report.producerSourceHash must be unknown for historical evidence");
  }
  const expectedHashes = createReplayContractHashes(
    typedReport.scenarios.map((scenario) => scenario.canonicalInput),
    typedReport.producerSourceHash,
    contractSourceHashes
  );
  for (const field of [
    "reportSchemaHash",
    "eventSchemaHash",
    "metricDefinitionHash",
    "metricImplementationHash",
    "acceptanceProfileHash",
    "fixtureHash",
    "scenarioInputHash",
    "comparisonSetHash"
  ] as const) {
    requireHash(report[field], `report.${field}`);
    if (report[field] !== expectedHashes[field]) {
      throw new Error(`report.${field} mismatch`);
    }
  }
  const determinism = requireRecord(report.repeatDeterminism, "report.repeatDeterminism");
  assertExactKeys(
    determinism,
    [
      "requested",
      "deterministic",
      "evidenceRuns",
      "canonicalHashes",
      "scenarioHashes",
      "comparisonSetHashes"
    ],
    "report.repeatDeterminism"
  );
  const requested = requireNonnegativeInteger(
    determinism.requested,
    "report.repeatDeterminism.requested"
  );
  if (
    (validationMode === "qualified" && requested !== 3) ||
    (validationMode === "historical-normalized" && requested !== 1)
  ) {
    throw new Error("report.repeatDeterminism.requested is invalid");
  }
  const evidenceRuns = parseRepeatEvidenceRuns(
    determinism.evidenceRuns,
    typedReport,
    validationMode,
    expectedRuntimeEvidenceSource
  );
  if (evidenceRuns.length !== requested) {
    throw new Error("report.repeatDeterminism.evidenceRuns length mismatch");
  }
  const reducedRuns = evidenceRuns.map((run) =>
    run.map((evidence) => reduceRawScenarioEvidence(evidence, expectedRuntimeEvidenceSource))
  );
  const expectedScenarios = reducedRuns[0];
  if (expectedScenarios === undefined) {
    throw new Error("report.repeatDeterminism.evidenceRuns is empty");
  }
  for (const [index, scenario] of typedReport.scenarios.entries()) {
    const expected = expectedScenarios[index];
    if (expected === undefined) {
      throw new Error(`report.scenarios[${index}] reduced evidence is missing`);
    }
    assertRuntimeStatusMatches(
      scenario.runtimeStatus,
      expected.runtimeStatus,
      `report.scenarios[${index}].runtimeStatus`
    );
  }
  if (canonicalHash(expectedScenarios) !== canonicalHash(typedReport.scenarios)) {
    throw new Error("report derived scenario mismatch");
  }
  const canonicalHashes = requireArray(
    determinism.canonicalHashes,
    "report.repeatDeterminism.canonicalHashes"
  );
  const scenarioHashes = requireArray(
    determinism.scenarioHashes,
    "report.repeatDeterminism.scenarioHashes"
  );
  const comparisonSetHashes = requireArray(
    determinism.comparisonSetHashes,
    "report.repeatDeterminism.comparisonSetHashes"
  );
  for (const [field, values] of [
    ["canonicalHashes", canonicalHashes],
    ["scenarioHashes", scenarioHashes],
    ["comparisonSetHashes", comparisonSetHashes]
  ] as const) {
    if (values.length !== requested) {
      throw new Error(`report.repeatDeterminism.${field} length mismatch`);
    }
  }
  const expectedCanonicalHashes = reducedRuns.map(canonicalHash);
  const expectedScenarioHashes = reducedRuns.map(createScenarioHashRecord);
  for (const [index, hash] of canonicalHashes.entries()) {
    requireHash(hash, `report.repeatDeterminism.canonicalHashes[${index}]`);
    if (hash !== expectedCanonicalHashes[index]) {
      throw new Error(`report.repeatDeterminism.canonicalHashes[${index}] mismatch`);
    }
  }
  for (const [index, candidate] of scenarioHashes.entries()) {
    const record = requireRecord(candidate, `report.repeatDeterminism.scenarioHashes[${index}]`);
    assertExactKeys(
      record,
      canonicalScenarioInputs.map((input) => input.id),
      `report.repeatDeterminism.scenarioHashes[${index}]`
    );
    const expectedRecord = expectedScenarioHashes[index];
    if (expectedRecord === undefined) {
      throw new Error(`report.repeatDeterminism.scenarioHashes[${index}] evidence is missing`);
    }
    for (const id of canonicalScenarioInputs.map((input) => input.id)) {
      requireHash(record[id], `report.repeatDeterminism.scenarioHashes[${index}].${id}`);
      if (record[id] !== expectedRecord[id]) {
        throw new Error(`report.repeatDeterminism.scenarioHashes[${index}].${id} mismatch`);
      }
    }
  }
  for (const [index, hash] of comparisonSetHashes.entries()) {
    requireHash(hash, `report.repeatDeterminism.comparisonSetHashes[${index}]`);
    if (hash !== report.comparisonSetHash) {
      throw new Error(`report.repeatDeterminism.comparisonSetHashes[${index}] mismatch`);
    }
  }
  const computedDeterministic =
    canonicalHashes.every((hash) => hash === canonicalHashes[0]) &&
    scenarioHashes.every((hashes) => canonicalHash(hashes) === canonicalHash(scenarioHashes[0])) &&
    comparisonSetHashes.every((hash) => hash === comparisonSetHashes[0]);
  if (determinism.deterministic !== computedDeterministic || !computedDeterministic) {
    throw new Error("report.repeatDeterminism.deterministic mismatch");
  }
  const expectedStatus = expectedScenarios.every((scenario) => scenario.status === "passed")
    ? "passed"
    : "failed";
  if (report.status !== expectedStatus) {
    throw new Error("report.status mismatch");
  }
}

function parseRepeatEvidenceRuns(
  value: unknown,
  report: StackChanAttentionReplayReport,
  validationMode: StackChanAttentionReplayValidationMode,
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"]
): ReplayRawScenarioEvidence[][] {
  return requireArray(value, "report.repeatDeterminism.evidenceRuns").map((runValue, runIndex) => {
    const runPath = `report.repeatDeterminism.evidenceRuns[${runIndex}]`;
    const run = requireArray(runValue, runPath).map(
      (candidate, scenarioIndex): ReplayRawScenarioEvidence => {
        const path = `${runPath}[${scenarioIndex}]`;
        const evidence = requireRecord(candidate, path);
        assertExactKeys(evidence, ["canonicalInput", "events"], path);
        const canonicalInput = normalizeCanonicalInput(
          evidence.canonicalInput,
          `${path}.canonicalInput`
        );
        const events = requireArray(
          evidence.events,
          `${path}.events`
        ) as unknown as StackChanAttentionReplayEvent[];
        validateRawScenarioEvidence(canonicalInput, events, runtimeEvidenceSource);
        const legacyRuntimeStatus =
          validationMode === "historical-normalized"
            ? report.scenarios[scenarioIndex]?.runtimeStatus
            : undefined;
        return {
          canonicalInput,
          events,
          ...(legacyRuntimeStatus === undefined ? {} : { legacyRuntimeStatus })
        };
      }
    );
    assertReplayEvidenceRoster(run, validationMode);
    return run;
  });
}

function validateRawScenarioEvidence(
  input: CanonicalScenarioInput,
  events: readonly StackChanAttentionReplayEvent[],
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"]
): void {
  if (events.length === 0) {
    throw new Error(`attention replay ${input.id} events are empty`);
  }
  let previousTimestamp = -1;
  for (const [index, candidate] of events.entries()) {
    previousTimestamp = validateRawReplayEvent(
      input.id,
      candidate,
      index,
      previousTimestamp,
      runtimeEvidenceSource
    );
  }
  if (runtimeEvidenceSource === "recorded-final-events") {
    validateQualifiedReplaySubrunCounters(events);
  }
}

const cumulativeReplayCounterKeys = [
  "accepted",
  "replaced",
  "dispatched",
  "confirmed",
  "failed",
  "staleDiscarded",
  "noOpDiscarded",
  "maximumPendingDepth",
  "maximumActiveCalls",
  "postStopDispatches",
  "postStopDispatchAttempts"
] as const;

function validateQualifiedReplaySubrunCounters(
  events: readonly StackChanAttentionReplayEvent[]
): void {
  for (const subrun of splitReplaySubruns(events)) {
    validateReplayStopEventSemantics(subrun);
    validateReplayCumulativeCounters(subrun);
    validateReplayCounterGauges(subrun);
    validateReplayCounterEventBindings(subrun);
    validateReplayPoseStateMachine(subrun);
    validateReplayLaneStateMachine(subrun);
    validateReplayDecisions(subrun);
  }
}

function validateReplayStopEventSemantics(subrun: readonly StackChanAttentionReplayEvent[]): void {
  const stopEvent = subrun.at(-1);
  const nullableObservationFields = [
    "frameSequence",
    "targetWorldPose",
    "targetSegmentIndex",
    "detectorState",
    "targetErrorDeg",
    "targetNormalizedError"
  ] as const;
  if (
    stopEvent === undefined ||
    nullableObservationFields.some((field) => stopEvent[field] !== null) ||
    stopEvent.isProbeObservation
  ) {
    throw new Error("attention replay stop event contains observation evidence");
  }
}

function validateReplayCumulativeCounters(subrun: readonly StackChanAttentionReplayEvent[]): void {
  for (const key of cumulativeReplayCounterKeys) {
    if (
      subrun.slice(1).some((event, index) => {
        const previous = subrun[index];
        return previous === undefined || event.counters[key] < previous.counters[key];
      })
    ) {
      throw new Error(`attention replay cumulative counter decreased: ${key}`);
    }
  }
}

function validateReplayCounterGauges(subrun: readonly StackChanAttentionReplayEvent[]): void {
  if (
    subrun.some(
      (event) =>
        event.counters.pendingDepth > event.counters.maximumPendingDepth ||
        event.counters.activeCalls > event.counters.maximumActiveCalls
    )
  ) {
    throw new Error("attention replay lane gauge exceeds recorded maximum");
  }
}

function validateReplayCounterEventBindings(
  subrun: readonly StackChanAttentionReplayEvent[]
): void {
  let previous: Pick<
    LaneCounters,
    "accepted" | "replaced" | "dispatched" | "confirmed" | "noOpDiscarded"
  > = {
    accepted: 0,
    replaced: 0,
    dispatched: 0,
    confirmed: 0,
    noOpDiscarded: 0
  };
  let maximumPendingDepth = 0;
  let maximumActiveCalls = 0;
  for (const event of subrun) {
    assertReplayCounterDelta("accepted", event.requestSequence, event.counters, previous);
    assertReplayCounterDelta("dispatched", event.dispatchSequence, event.counters, previous);
    assertReplayConfirmationCounterDelta(event, previous);
    assertReplayCounterDelta(
      "noOpDiscarded",
      event.noOpDiscardedSequence,
      event.counters,
      previous
    );
    const replacedDelta = event.counters.replaced - previous.replaced;
    const acceptedDelta = event.counters.accepted - previous.accepted;
    if (replacedDelta < 0 || replacedDelta > acceptedDelta) {
      throw new Error("attention replay event counter delta mismatch: replaced");
    }
    maximumPendingDepth = Math.max(maximumPendingDepth, event.counters.pendingDepth);
    maximumActiveCalls = Math.max(maximumActiveCalls, event.counters.activeCalls);
    if (
      event.counters.maximumPendingDepth !== maximumPendingDepth ||
      event.counters.maximumActiveCalls !== maximumActiveCalls
    ) {
      throw new Error("attention replay event counter maximum mismatch");
    }
    previous = event.counters;
  }
}

function validateReplayDecisions(subrun: readonly StackChanAttentionReplayEvent[]): void {
  const outcomes = deriveReplayRequestOutcomes(subrun);
  let ticksWithoutConfirmedUpdate = 0;
  for (const event of subrun) {
    if (event.confirmedSequence !== null) {
      ticksWithoutConfirmedUpdate = 0;
    } else if (event.frameSequence !== null) {
      ticksWithoutConfirmedUpdate += 1;
    }
    const decision = event.decision;
    if (eventExpectsReplayDecision(event) !== (decision !== null)) {
      throw new Error("attention replay controller decision presence mismatch");
    }
    if (decision === null) {
      continue;
    }
    validateReplayDecisionBinding(event, decision, outcomes, ticksWithoutConfirmedUpdate);
    validateReplayDecisionZeroSign(decision);
  }
}

function eventExpectsReplayDecision(event: StackChanAttentionReplayEvent): boolean {
  return event.frameSequence !== null && event.controllerMode === "track" && !event.stop;
}

function validateReplayDecisionBinding(
  event: StackChanAttentionReplayEvent,
  decision: StackChanAttentionReplayDecision,
  outcomes: ReadonlyMap<number, StackChanAttentionReplayEffectOutcome>,
  ticksWithoutConfirmedUpdate: number
): void {
  requireReplayDecisionBinding(decision.id === event.sequence);
  requireReplayDecisionBinding(decision.decisionAtMs === event.timestampMs);
  requireReplayDecisionBinding(decision.observedAtMs <= decision.decisionAtMs);
  requireReplayDecisionBinding(decision.centered === event.centered);
  requireReplayDecisionBinding(decision.requestSequence === event.requestSequence);
  requireReplayDecisionBinding(sameNullablePose(decision.requestedPose, event.requestedPose));
  requireReplayDecisionBinding(samePose(decision.baseConfirmedPose, event.rpcConfirmedPose));
  requireReplayDecisionBinding(
    decision.effectOutcome === replayDecisionOutcome(decision.requestSequence, outcomes)
  );
  requireReplayDecisionBinding(
    decision.ticksWithoutConfirmedUpdate === ticksWithoutConfirmedUpdate
  );
}

function replayDecisionOutcome(
  requestSequence: number | null,
  outcomes: ReadonlyMap<number, StackChanAttentionReplayEffectOutcome>
): StackChanAttentionReplayEffectOutcome {
  return requestSequence === null ? "none" : (outcomes.get(requestSequence) ?? "none");
}

function requireReplayDecisionBinding(condition: boolean): void {
  if (!condition) {
    throw new Error("attention replay controller decision binding mismatch");
  }
}

function validateReplayDecisionZeroSign(decision: StackChanAttentionReplayDecision): void {
  const steps = [
    decision.yaw.legacyRoundedStepDeg,
    decision.yaw.quantizedStepDeg,
    decision.pitch.legacyRoundedStepDeg,
    decision.pitch.quantizedStepDeg
  ];
  if (steps.some((step) => Object.is(step, -0))) {
    throw new Error("attention replay controller decision contains negative zero");
  }
}

function sameNullablePose(
  left: StackChanHeadPose | null,
  right: StackChanHeadPose | null
): boolean {
  return left === null || right === null ? left === right : samePose(left, right);
}

function assertReplayConfirmationCounterDelta(
  event: StackChanAttentionReplayEvent,
  previous: Pick<LaneCounters, "confirmed">
): void {
  const delta = event.counters.confirmed - previous.confirmed;
  if (
    delta < 0 ||
    delta > STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS ||
    (delta === 0) !== (event.confirmedSequence === null)
  ) {
    throw new Error("attention replay event counter delta mismatch: confirmed");
  }
}

function assertReplayCounterDelta(
  key: "accepted" | "dispatched" | "confirmed" | "noOpDiscarded",
  eventSequence: number | null,
  current: LaneCounters,
  previous: Pick<
    LaneCounters,
    "accepted" | "replaced" | "dispatched" | "confirmed" | "noOpDiscarded"
  >
): void {
  const expectedDelta = eventSequence === null ? 0 : 1;
  if (current[key] - previous[key] !== expectedDelta) {
    throw new Error(`attention replay event counter delta mismatch: ${key}`);
  }
}

type ReplayLaneSequenceState = {
  pending: number | null;
  active: number[];
  plannedPose: StackChanHeadPose;
};

type ReplayLanePreviousCounters = Pick<LaneCounters, "replaced" | "staleDiscarded" | "confirmed">;

function validateReplayLaneStateMachine(subrun: readonly StackChanAttentionReplayEvent[]): void {
  const requestedPoses = new Map<number, StackChanHeadPose>();
  for (const event of subrun) {
    if (event.requestSequence !== null && event.requestedPose !== null) {
      requestedPoses.set(event.requestSequence, event.requestedPose);
    }
  }
  let state: ReplayLaneSequenceState = {
    pending: null,
    active: [],
    plannedPose: homePose()
  };
  let previous: ReplayLanePreviousCounters = {
    replaced: 0,
    staleDiscarded: 0,
    confirmed: 0
  };
  for (const event of subrun) {
    assertNoReplayLaneFailure(event);
    state = resolveReplayLaneActive(event, previous, state);
    state = discardReplayStalePending(event, previous, state);
    state = discardReplayPlannedNoOp(event, requestedPoses, state);
    state = dispatchReplayPending(event, state);
    state = acceptReplayRequest(event, previous, state);
    if (event.clear || event.stop) {
      state.pending = null;
    }
    assertReplayLaneGaugeState(event, state);
    previous = event.counters;
  }
}

function discardReplayPlannedNoOp(
  event: StackChanAttentionReplayEvent,
  requestedPoses: ReadonlyMap<number, StackChanHeadPose>,
  state: ReplayLaneSequenceState
): ReplayLaneSequenceState {
  const sequence = event.noOpDiscardedSequence;
  if (sequence === null) {
    return state;
  }
  if (!isCurrentReplayNoOpDiscardRequest(event, state, sequence)) {
    throw new Error("attention replay no-op discard is not current pending request");
  }
  if (!matchesReplayPlannedNoOpPose(requestedPoses.get(sequence), state.plannedPose)) {
    throw new Error("attention replay no-op discard does not match idle planned pose");
  }
  return {
    ...state,
    pending: null
  };
}

function isCurrentReplayNoOpDiscardRequest(
  event: StackChanAttentionReplayEvent,
  state: ReplayLaneSequenceState,
  sequence: number
): boolean {
  const discardsPending = state.pending === sequence;
  const discardsImmediateRequest = state.pending === null && event.requestSequence === sequence;
  return (
    state.active.length === 0 &&
    (discardsPending || discardsImmediateRequest) &&
    event.dispatchSequence !== sequence
  );
}

function matchesReplayPlannedNoOpPose(
  requestedPose: StackChanHeadPose | undefined,
  plannedPose: StackChanHeadPose
): boolean {
  return (
    requestedPose !== undefined && samePose(reclampPose(requestedPose, plannedPose), plannedPose)
  );
}

function assertNoReplayLaneFailure(event: StackChanAttentionReplayEvent): void {
  if (event.counters.failed !== 0) {
    throw new Error("attention replay qualified lane contains a device failure");
  }
}

function resolveReplayLaneActive(
  event: StackChanAttentionReplayEvent,
  previous: ReplayLanePreviousCounters,
  state: ReplayLaneSequenceState
): ReplayLaneSequenceState {
  const confirmedDelta = event.counters.confirmed - previous.confirmed;
  if (
    confirmedDelta < 0 ||
    confirmedDelta > state.active.length ||
    (confirmedDelta === 0) !== (event.confirmedSequence === null)
  ) {
    throw new Error("attention replay confirmation count does not match active dispatches");
  }
  if (confirmedDelta > 0 && state.active[confirmedDelta - 1] !== event.confirmedSequence) {
    throw new Error("attention replay confirmation is not the ordered active dispatch");
  }
  return {
    ...state,
    active: state.active.slice(confirmedDelta)
  };
}

function discardReplayStalePending(
  event: StackChanAttentionReplayEvent,
  previous: ReplayLanePreviousCounters,
  state: ReplayLaneSequenceState
): ReplayLaneSequenceState {
  const staleDelta = event.counters.staleDiscarded - previous.staleDiscarded;
  if (staleDelta < 0 || staleDelta > 1 || (staleDelta === 1 && state.pending === null)) {
    throw new Error("attention replay stale counter has no pending request");
  }
  return staleDelta === 0
    ? state
    : {
        ...state,
        pending: null
      };
}

function dispatchReplayPending(
  event: StackChanAttentionReplayEvent,
  state: ReplayLaneSequenceState
): ReplayLaneSequenceState {
  if (event.dispatchSequence === null) {
    return state;
  }
  if (event.dispatchedPose === null) {
    throw new Error("attention replay event pose binding mismatch: dispatch");
  }
  if (state.active.length >= STACKCHAN_ATTENTION_REPLAY_MAXIMUM_ACTIVE_CALLS) {
    throw new Error("attention replay dispatch exceeds the bounded device pipeline");
  }
  const dispatchesPending = state.pending === event.dispatchSequence;
  const dispatchesImmediateRequest =
    state.pending === null && event.requestSequence === event.dispatchSequence;
  if (!dispatchesPending && !dispatchesImmediateRequest) {
    throw new Error("attention replay dispatch is not current pending request");
  }
  return {
    pending: null,
    active: [...state.active, event.dispatchSequence],
    plannedPose: { ...event.dispatchedPose }
  };
}

function acceptReplayRequest(
  event: StackChanAttentionReplayEvent,
  previous: ReplayLanePreviousCounters,
  state: ReplayLaneSequenceState
): ReplayLaneSequenceState {
  const replacedDelta = event.counters.replaced - previous.replaced;
  if (event.requestSequence === null) {
    if (replacedDelta !== 0) {
      throw new Error("attention replay replaced counter disagrees with pending request");
    }
    return state;
  }
  if (event.requestSequence !== event.counters.accepted) {
    throw new Error("attention replay request sequence does not match accepted counter");
  }
  if (requestTerminatesImmediately(event)) {
    if (replacedDelta !== 0) {
      throw new Error("attention replay replaced counter disagrees with pending request");
    }
    return state;
  }
  const expectedReplacedDelta = state.pending === null ? 0 : 1;
  if (replacedDelta !== expectedReplacedDelta) {
    throw new Error("attention replay replaced counter disagrees with pending request");
  }
  return {
    ...state,
    pending: event.requestSequence
  };
}

function requestTerminatesImmediately(event: StackChanAttentionReplayEvent): boolean {
  return (
    event.requestSequence === event.dispatchSequence ||
    event.requestSequence === event.noOpDiscardedSequence
  );
}

function assertReplayLaneGaugeState(
  event: StackChanAttentionReplayEvent,
  state: ReplayLaneSequenceState
): void {
  const outstanding = event.counters.dispatched - event.counters.confirmed - event.counters.failed;
  if (
    event.counters.pendingDepth !== Number(state.pending !== null) ||
    event.counters.activeCalls !== state.active.length ||
    event.counters.activeCalls !== outstanding
  ) {
    throw new Error("attention replay lane gauge does not match request lifecycle");
  }
  if (
    event.stop &&
    (state.pending !== null ||
      state.active.length !== 0 ||
      event.counters.dispatched !== event.counters.confirmed + event.counters.failed)
  ) {
    throw new Error("attention replay stopped lane did not drain");
  }
}

function validateRawReplayEvent(
  id: ScenarioId,
  candidate: StackChanAttentionReplayEvent,
  index: number,
  previousTimestamp: number,
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"]
): number {
  const path = `${id}.events[${index}]`;
  const event = requireRecord(candidate, path);
  assertExactKeys(event, replayEventKeys, path);
  const sequence = requireNonnegativeInteger(event.sequence, `${path}.sequence`);
  if (sequence !== index + 1) {
    throw new Error(`attention replay ${id} event sequence mismatch`);
  }
  const timestampMs = requireNonnegativeInteger(event.timestampMs, `${path}.timestampMs`);
  if (timestampMs <= previousTimestamp) {
    throw new Error("attention replay derivative dt<=0");
  }
  validateReplayEventCounters(event, path);
  validateReplayEventRuntimeEvidence(id, event, path, runtimeEvidenceSource);
  assertFiniteJsonValue(event, path);
  return timestampMs;
}

function validateReplayEventCounters(event: Record<string, unknown>, path: string): void {
  const counters = requireRecord(event.counters, `${path}.counters`);
  assertExactKeys(counters, replayCounterKeys, `${path}.counters`);
  for (const key of replayCounterKeys) {
    requireNonnegativeInteger(counters[key], `${path}.counters.${key}`);
  }
}

function validateReplayEventRuntimeEvidence(
  id: ScenarioId,
  event: Record<string, unknown>,
  path: string,
  runtimeEvidenceSource: ReplayReductionOptions["runtimeEvidenceSource"]
): void {
  const finalRuntimeEvidence = event.finalRuntimeEvidence;
  if (runtimeEvidenceSource === "recorded-final-events") {
    if (event.stop !== (finalRuntimeEvidence !== null)) {
      throw new Error(`attention replay ${id} final runtime evidence boundary mismatch`);
    }
    if (finalRuntimeEvidence !== null) {
      validateFinalRuntimeEvidence(finalRuntimeEvidence, `${path}.finalRuntimeEvidence`);
    }
  } else if (finalRuntimeEvidence !== null) {
    throw new Error(`attention replay ${id} historical final runtime evidence is invalid`);
  }
}

function validateReplayPoseStateMachine(subrun: readonly StackChanAttentionReplayEvent[]): void {
  const requests = new Map<number, StackChanHeadPose>();
  const dispatches = new Map<number, StackChanHeadPose>();
  const confirmations = new Set<number>();
  let confirmedPose = homePose();
  let plannedPose = homePose();
  for (const event of subrun) {
    recordReplayRequest(event, requests);
    confirmedPose = applyReplayConfirmation(event, dispatches, confirmations, confirmedPose);
    if (!samePose(event.rpcConfirmedPose, confirmedPose)) {
      throw new Error("attention replay confirmed pose changed without confirmation");
    }
    plannedPose = recordReplayDispatch(event, requests, dispatches, confirmedPose, plannedPose);
  }
}

function recordReplayRequest(
  event: StackChanAttentionReplayEvent,
  requests: Map<number, StackChanHeadPose>
): void {
  if ((event.requestSequence === null) !== (event.requestedPose === null)) {
    throw new Error("attention replay event pose binding mismatch: request");
  }
  if (event.requestSequence === null || event.requestedPose === null) {
    return;
  }
  if (requests.has(event.requestSequence)) {
    throw new Error("attention replay request sequence is duplicated");
  }
  requests.set(event.requestSequence, event.requestedPose);
}

function applyReplayConfirmation(
  event: StackChanAttentionReplayEvent,
  dispatches: ReadonlyMap<number, StackChanHeadPose>,
  confirmations: Set<number>,
  confirmedPose: StackChanHeadPose
): StackChanHeadPose {
  if (event.confirmedSequence === null) {
    return confirmedPose;
  }
  const dispatchedPose = dispatches.get(event.confirmedSequence);
  if (dispatchedPose === undefined || confirmations.has(event.confirmedSequence)) {
    throw new Error("attention replay confirmation has no unique dispatch");
  }
  confirmations.add(event.confirmedSequence);
  return dispatchedPose;
}

function recordReplayDispatch(
  event: StackChanAttentionReplayEvent,
  requests: ReadonlyMap<number, StackChanHeadPose>,
  dispatches: Map<number, StackChanHeadPose>,
  confirmedPose: StackChanHeadPose,
  plannedPose: StackChanHeadPose
): StackChanHeadPose {
  const evidence = requireReplayDispatchEvidence(event);
  if (evidence === null) {
    return plannedPose;
  }
  const requestedPose = requests.get(evidence.sequence);
  if (requestedPose === undefined || dispatches.has(evidence.sequence)) {
    throw new Error("attention replay dispatch pose binding mismatch");
  }
  const posesMatch = [
    samePose(evidence.requestedPose, requestedPose),
    samePose(event.confirmedBeforeDispatch, confirmedPose),
    samePose(event.plannedBeforeDispatch, plannedPose),
    samePose(evidence.dispatchedPose, reclampPose(requestedPose, plannedPose))
  ].every(Boolean);
  if (!posesMatch) {
    throw new Error("attention replay dispatch pose binding mismatch");
  }
  dispatches.set(evidence.sequence, evidence.dispatchedPose);
  return evidence.dispatchedPose;
}

function requireReplayDispatchEvidence(event: StackChanAttentionReplayEvent): {
  readonly sequence: number;
  readonly requestedPose: StackChanHeadPose;
  readonly dispatchedPose: StackChanHeadPose;
} | null {
  const values = [event.dispatchSequence, event.dispatchedRequestPose, event.dispatchedPose];
  if (values.every((value) => value === null)) {
    return null;
  }
  if (
    event.dispatchSequence === null ||
    event.dispatchedRequestPose === null ||
    event.dispatchedPose === null
  ) {
    throw new Error("attention replay event pose binding mismatch: dispatch");
  }
  return {
    sequence: event.dispatchSequence,
    requestedPose: event.dispatchedRequestPose,
    dispatchedPose: event.dispatchedPose
  };
}

const runtimeStatusKeys = [
  "phase",
  "framesProcessed",
  "lastAcceptedFrameSequence",
  "staleFramesDiscarded",
  "observationTicksStarted",
  "observationTicksCompleted",
  "observationOverlapAttempts",
  "maximumConcurrentObservationTicks",
  "expectedFramesProcessed",
  "expectedObservationTicks",
  "errorCount",
  "errorCodes"
] as const;

const finalRuntimeEvidenceKeys = [
  "phase",
  "framesProcessed",
  "lastAcceptedFrameSequence",
  "staleFramesDiscarded",
  "observationTicksStarted",
  "observationTicksCompleted",
  "observationOverlapAttempts",
  "maximumConcurrentObservationTicks",
  "errorCodes"
] as const;

function validateRuntimeStatus(value: unknown, path: string): void {
  const status = requireRecord(value, path);
  assertExactKeys(status, runtimeStatusKeys, path);
  assertFiniteJsonValue(status, path);
}

function validateFinalRuntimeEvidence(value: unknown, path: string): void {
  const evidence = requireRecord(value, path);
  assertExactKeys(evidence, finalRuntimeEvidenceKeys, path);
  assertFiniteJsonValue(evidence, path);
}

function assertRuntimeStatusMatches(
  actual: ScenarioRuntimeStatus,
  expected: ScenarioRuntimeStatus,
  path: string
): void {
  for (const key of runtimeStatusKeys) {
    if (canonicalHash(actual[key]) !== canonicalHash(expected[key])) {
      throw new Error(`${path}.${key} mismatch`);
    }
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${path} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a sha256 hash`);
  }
  return value;
}

function normalizeNullablePose(value: unknown, path: string): StackChanHeadPose | null {
  if (value === null) {
    return null;
  }
  const pose = requireRecord(value, path);
  if (
    typeof pose.yaw !== "number" ||
    !Number.isFinite(pose.yaw) ||
    typeof pose.pitch !== "number" ||
    !Number.isFinite(pose.pitch)
  ) {
    throw new Error(`${path} is invalid`);
  }
  return { yaw: pose.yaw, pitch: pose.pitch };
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${path} keys are invalid`);
  }
}

function assertFiniteJsonValue(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertFiniteJsonValue(item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteJsonValue(item, `${path}.${key}`);
    }
  }
}

function parseNamedArguments(arguments_: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error("attention replay arguments are invalid");
    }
    values.set(name, value);
  }
  return values;
}

function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function writeAtomicJsonReport(
  path: string,
  report: StackChanAttentionReplayReport
): Promise<void> {
  const outputPath = resolve(path);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(report, undefined, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    replaced = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!replaced) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function isDirectExecution(): boolean {
  const moduleName = basename(fileURLToPath(import.meta.url));
  return (
    (moduleName === "stackchan-attention-replay.ts" ||
      moduleName === "stackchan-attention-replay.js") &&
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isDirectExecution()) {
  process.exitCode = await executeStackChanAttentionReplayCli(process.argv.slice(2));
}
