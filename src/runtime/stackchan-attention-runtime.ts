import type { PicoStackChanFollowConfig } from "../config/index.js";
import {
  advanceAttentionState,
  initialAttentionState,
  type StackChanAttentionControllerConfig,
  type StackChanAttentionDecisionDiagnostic,
  type StackChanAttentionEffect,
  type StackChanAttentionState,
  type StackChanAttentionTargetObservation
} from "../modules/stackchan/attention-controller.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../modules/stackchan/head-target-lane.js";
import type { StackChanAdapter, StackChanHeadPose } from "../modules/stackchan/index.js";
import type { AttentionDetectionModel } from "../modules/vision/attention-detection.js";

export type StackChanAttentionPhase = "idle" | "starting" | "running" | "stopping" | "stopped";

const ATTENTION_ERROR_MESSAGES = {
  start_failed: "StackChan attention startup failed",
  tick_failed: "StackChan attention tick failed",
  scheduler_cancel_failed: "StackChan attention scheduler cancellation failed",
  lane_stop_failed: "StackChan attention head target lane stop failed",
  lane_close_failed: "StackChan attention head target lane close failed",
  home_failed: "StackChan attention home move failed",
  close_failed: "StackChan attention adapter close failed"
} as const;

const STOPPED_RUNTIME_ERROR = "StackChan attention runtime is stopped";
const HOME_APPROACH_DELTA_DEG = 4;
const HOME_APPROACH_WAIT_MS = 250;

export const STACKCHAN_ATTENTION_ERROR_HISTORY_LIMIT = 8;

export type StackChanAttentionErrorCode = keyof typeof ATTENTION_ERROR_MESSAGES;

export type StackChanAttentionStatusError = {
  readonly code: StackChanAttentionErrorCode;
  readonly message: (typeof ATTENTION_ERROR_MESSAGES)[StackChanAttentionErrorCode];
};

export type StackChanAttentionTargetStatus = StackChanAttentionTargetObservation & {
  readonly observedAtMs: number;
  readonly ageMs: number;
};

export type StackChanAttentionLiveStatus = {
  readonly mode: StackChanAttentionState["mode"];
  readonly targetVisible: boolean;
  readonly targetFrames: number;
  readonly centeredFrames: number;
  readonly lastTarget?: StackChanAttentionTargetStatus;
};

export type StackChanAttentionFlowStatus = {
  readonly observationTicksStarted: number;
  readonly observationTicksCompleted: number;
  readonly observationsWhileMoveInFlight: number;
  readonly lastAcceptedFrameSequence?: number;
  readonly staleFramesDiscarded: number;
  readonly staleFrameDispatches: number;
  readonly pendingMoveDepth: 0 | 1;
  readonly maximumPendingMoveDepth: 0 | 1;
  readonly pendingMoveReplacements: number;
  readonly pendingMoveDispatches: number;
  readonly activeObservationTicks: number;
  readonly activeMoves: number;
  readonly maximumConcurrentObservationTicks: number;
  readonly maximumConcurrentMoves: number;
  readonly observationOverlapAttempts: number;
  readonly moveOverlapAttempts: number;
};

export type StackChanAttentionStatus = {
  readonly phase: StackChanAttentionPhase;
  readonly framesProcessed: number;
  readonly moveCount: number;
  readonly attention: StackChanAttentionLiveStatus;
  readonly flow: StackChanAttentionFlowStatus;
  readonly headTargetLane?: StackChanAttentionHeadTargetLaneStatus;
  readonly lastError?: string;
  readonly errors?: readonly StackChanAttentionStatusError[];
};

export type StackChanAttentionHeadTargetLaneStatus = {
  readonly phase: StackChanHeadTargetStatus["phase"];
  readonly accepted: number;
  readonly replaced: number;
  readonly dispatched: number;
  readonly confirmed: number;
  readonly confirmedApplyReplies: number;
  readonly failed: number;
  readonly staleDiscarded: number;
  readonly noOpDiscarded: number;
  readonly activeCalls: number;
  readonly pendingDepth: number;
  readonly maximumActiveCalls: number;
  readonly maximumPendingDepth: number;
  readonly postStopDispatches: number;
  readonly updateAcknowledgmentMs: StackChanHeadTargetStatus["updateAcknowledgmentMs"];
  readonly pendingAgeMs: StackChanHeadTargetStatus["pendingAgeMs"];
  readonly deviceDispatchLatencyMs: StackChanHeadTargetStatus["deviceDispatchLatencyMs"];
};

export type StackChanAttentionScheduledLoop = {
  readonly cancel: () => void;
};

export type StackChanAttentionScheduler = (
  task: () => Promise<void>,
  intervalMs: number
) => StackChanAttentionScheduledLoop;

export type CreateStackChanAttentionRuntimeOptions = {
  readonly adapter: StackChanAdapter;
  readonly headTargetLane: StackChanHeadTargetLane;
  readonly model: AttentionDetectionModel;
  readonly config: Extract<PicoStackChanFollowConfig, { readonly enabled: true }>;
  readonly scheduler?: StackChanAttentionScheduler;
  readonly nowMs?: () => number;
  readonly waitMs?: (durationMs: number) => Promise<void>;
  readonly onDecision?: (diagnostic: StackChanAttentionDecisionDiagnostic) => void;
};

export type StackChanAttentionRuntime = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly status: () => StackChanAttentionStatus;
};

type StackChanScanSubmission = {
  readonly confirmedPose: StackChanHeadPose;
  readonly targetPose: StackChanHeadPose;
};

export function createStackChanAttentionRuntime(
  options: CreateStackChanAttentionRuntimeOptions
): StackChanAttentionRuntime {
  const scheduler = options.scheduler ?? scheduleAttentionInterval;
  const nowMs = options.nowMs ?? Date.now;
  const waitMs = options.waitMs ?? wait;
  const controllerConfig = attentionControllerConfig(options.config);
  let state = initialAttentionState();
  let phase: StackChanAttentionPhase = "idle";
  let framesProcessed = 0;
  let moveCount = 0;
  let targetVisible = false;
  let targetFrames = 0;
  let centeredFrames = 0;
  let lastTarget:
    | (StackChanAttentionTargetObservation & {
        readonly observedAtMs: number;
      })
    | undefined;
  let commandedPose: StackChanHeadPose | undefined;
  let errors: readonly StackChanAttentionStatusError[] = [];
  let runToken = 0;
  let nextSequence = 0;
  let terminated = false;
  let ownsAdapter = false;
  let adapterConnected = false;
  let laneCloseRequired = false;
  let laneLeaseId: string | undefined;
  let laneStatus: StackChanHeadTargetStatus | undefined;
  let pendingLaneTarget = false;
  let lastScanSubmission: StackChanScanSubmission | undefined;
  let scheduledLoop: StackChanAttentionScheduledLoop | undefined;
  let activeTick: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let observationTicksStarted = 0;
  let observationTicksCompleted = 0;
  const observationsWhileMoveInFlight = 0;
  let lastAcceptedFrameSequence: number | undefined;
  let staleFramesDiscarded = 0;
  const staleFrameDispatches = 0;
  let activeObservationTicks = 0;
  let maximumConcurrentObservationTicks = 0;
  let observationOverlapAttempts = 0;

  const recordError = (code: StackChanAttentionErrorCode): void => {
    errors = appendAttentionError(errors, code);
  };

  const adoptLaneStatus = (status: StackChanHeadTargetStatus): void => {
    laneStatus = status;
    moveCount = status.accepted;
  };

  const clearPendingLaneTarget = async (token: number): Promise<void> => {
    if (!pendingLaneTarget) {
      return;
    }
    const leaseId = requireLaneLease(laneLeaseId);
    const status = await options.headTargetLane.clear(leaseId);
    pendingLaneTarget = false;
    if (phase === "running" && token === runToken) {
      adoptLaneStatus(status);
    }
  };

  const refreshConfirmedPose = async (token: number): Promise<StackChanHeadPose> => {
    const leaseId = requireLaneLease(laneLeaseId);
    const status = await options.headTargetLane.status(leaseId);
    if (phase === "running" && token === runToken) {
      adoptLaneStatus(status);
      if (status.confirmedPose !== undefined) {
        commandedPose = { ...status.confirmedPose };
      }
    }
    return requireCommandedPose(commandedPose);
  };

  const submitLaneTarget = async (
    effect: Extract<StackChanAttentionEffect, { readonly kind: "move" }>,
    token: number
  ): Promise<void> => {
    const leaseId = requireLaneLease(laneLeaseId);
    nextSequence += 1;
    requireSafeSequence(nextSequence);
    const acknowledgment = await options.headTargetLane.update({
      leaseId,
      sequence: nextSequence,
      pose: { ...effect.pose }
    });
    if (phase !== "running" || token !== runToken) {
      return;
    }
    pendingLaneTarget = acknowledgment.pendingDepth === 1;
    moveCount = acknowledgment.acceptedCount;
    if (laneStatus !== undefined) {
      laneStatus = {
        ...laneStatus,
        accepted: acknowledgment.acceptedCount,
        replaced: acknowledgment.replacedCount,
        pendingDepth: acknowledgment.pendingDepth,
        maximumPendingDepth: Math.max(laneStatus.maximumPendingDepth, acknowledgment.pendingDepth),
        lastAcceptedSequence: acknowledgment.lastAcceptedSequence
      };
    }
  };

  const applyAttentionEffect = async (
    effect: StackChanAttentionEffect,
    mode: StackChanAttentionState["mode"],
    currentPose: StackChanHeadPose,
    token: number
  ): Promise<void> => {
    if (effect.kind === "hold") {
      lastScanSubmission = undefined;
      await clearPendingLaneTarget(token);
      return;
    }
    if (mode !== "scan") {
      lastScanSubmission = undefined;
      await submitLaneTarget(effect, token);
      return;
    }
    if (shouldSuppressScanSubmission(lastScanSubmission, currentPose, effect.pose, laneStatus)) {
      return;
    }
    await submitLaneTarget(effect, token);
    if (phase === "running" && token === runToken) {
      lastScanSubmission = {
        confirmedPose: { ...currentPose },
        targetPose: { ...effect.pose }
      };
    }
  };

  const runTick = async (): Promise<void> => {
    if (phase !== "running") {
      return;
    }
    if (activeTick !== undefined) {
      observationOverlapAttempts += 1;
      return;
    }

    const token = runToken;
    observationTicksStarted += 1;
    activeObservationTicks = 1;
    maximumConcurrentObservationTicks = Math.max(
      maximumConcurrentObservationTicks,
      activeObservationTicks
    );
    const tick = executeAttentionTick({
      options,
      controllerConfig,
      token,
      isCurrent: () => phase === "running" && token === runToken,
      refreshConfirmedPose: () => refreshConfirmedPose(token),
      state: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      nowMs,
      recordFrame: () => {
        framesProcessed += 1;
      },
      lastAcceptedFrameSequence: () => lastAcceptedFrameSequence,
      acceptFrameSequence: (sequence) => {
        lastAcceptedFrameSequence = sequence;
      },
      recordStaleFrame: () => {
        staleFramesDiscarded += 1;
      },
      applyEffect: (effect, mode, currentPose) =>
        applyAttentionEffect(effect, mode, currentPose, token),
      recordAttention: (target, observedAtMs) => {
        targetVisible = target !== undefined;
        if (target === undefined) {
          return;
        }
        targetFrames += 1;
        if (target.centered) {
          centeredFrames += 1;
        }
        lastTarget = {
          ...target,
          observedAtMs
        };
      },
      recordError: () => {
        recordError("tick_failed");
      }
    }).finally(() => {
      observationTicksCompleted += 1;
      activeObservationTicks = 0;
      if (activeTick === tick) {
        activeTick = undefined;
      }
    });
    activeTick = tick;
    await tick;
  };

  const start = (): Promise<void> => {
    if (stopPromise !== undefined || phase === "stopping") {
      return Promise.reject(new Error("StackChan attention runtime is stopping"));
    }
    if (terminated) {
      return Promise.reject(new Error(STOPPED_RUNTIME_ERROR));
    }
    if (phase === "running") {
      return Promise.resolve();
    }
    if (startPromise !== undefined) {
      return startPromise;
    }
    if (ownsAdapter) {
      return Promise.reject(new Error("StackChan attention runtime requires cleanup"));
    }

    phase = "starting";
    ownsAdapter = true;
    laneCloseRequired = true;
    const isStarting = (): boolean => phase === "starting";
    const task = (async () => {
      await options.adapter.connect();
      adapterConnected = true;
      if (!isStarting()) {
        return;
      }

      const homePose = {
        yaw: options.config.homeYaw,
        pitch: options.config.homePitch
      };
      await options.adapter.moveHead(homePose, {
        speedDps: options.config.moveSpeedDps
      });
      commandedPose = homePose;
      if (!isStarting()) {
        return;
      }

      await options.headTargetLane.connect();
      if (!isStarting()) {
        return;
      }
      const lease = await options.headTargetLane.start({
        rateHz: options.config.commandRateHz,
        maxStepDeg: options.config.maxStepDeg,
        maxPendingAgeMs: options.config.maxPendingCommandAgeMs,
        speedDps: options.config.moveSpeedDps
      });
      laneLeaseId = lease.leaseId;
      adoptLaneStatus(lease.status);
      commandedPose = { ...lease.confirmedPose };
      if (!isStarting()) {
        return;
      }

      scheduledLoop = scheduler(runTick, options.config.frameIntervalMs);
    })()
      .then(() => {
        if (phase !== "starting") {
          return;
        }

        state = initialAttentionState();
        runToken += 1;
        nextSequence = 0;
        lastScanSubmission = undefined;
        phase = "running";
      })
      .catch((error: unknown) => {
        recordError("start_failed");
        terminated = true;
        if (phase === "starting") {
          phase = "stopped";
        }
        throw error;
      })
      .finally(() => {
        startPromise = undefined;
      });
    startPromise = task;
    return task;
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    if ((phase === "idle" || phase === "stopped") && !ownsAdapter) {
      terminated = true;
      phase = "stopped";
      return Promise.resolve();
    }

    const task = stopAttentionRuntime({
      options,
      waitMs,
      getStartPromise: () => startPromise,
      getActiveTick: () => activeTick,
      ownsAdapter: () => ownsAdapter,
      adapterConnected: () => adapterConnected,
      laneCloseRequired: () => laneCloseRequired,
      laneLeaseId: () => laneLeaseId,
      adoptLaneStatus,
      clearLaneLease: () => {
        laneLeaseId = undefined;
        pendingLaneTarget = false;
        lastScanSubmission = undefined;
      },
      cancelLoop: () => {
        const loop = scheduledLoop;
        scheduledLoop = undefined;
        loop?.cancel();
      },
      invalidateRun: () => {
        terminated = true;
        phase = "stopping";
        runToken += 1;
        pendingLaneTarget = false;
        lastScanSubmission = undefined;
      },
      markStopped: () => {
        phase = "stopped";
      },
      releaseAdapter: () => {
        ownsAdapter = false;
        adapterConnected = false;
        laneCloseRequired = false;
      },
      recordError
    });
    const trackedTask = task.finally(() => {
      if (stopPromise === trackedTask) {
        stopPromise = undefined;
      }
    });
    stopPromise = trackedTask;
    return trackedTask;
  };

  return {
    start,
    stop,
    status: () => {
      const flow = createAttentionFlowStatus({
        observationTicksStarted,
        observationTicksCompleted,
        observationsWhileMoveInFlight,
        lastAcceptedFrameSequence,
        staleFramesDiscarded,
        staleFrameDispatches,
        activeObservationTicks,
        maximumConcurrentObservationTicks,
        observationOverlapAttempts,
        laneStatus
      });
      return attentionStatus(
        phase,
        framesProcessed,
        moveCount,
        errors,
        state,
        targetVisible,
        targetFrames,
        centeredFrames,
        lastTarget,
        flow,
        nowMs(),
        laneStatus
      );
    }
  };
}

type ExecuteAttentionTickOptions = {
  readonly options: CreateStackChanAttentionRuntimeOptions;
  readonly controllerConfig: StackChanAttentionControllerConfig;
  readonly token: number;
  readonly isCurrent: () => boolean;
  readonly refreshConfirmedPose: () => Promise<StackChanHeadPose>;
  readonly state: () => StackChanAttentionState;
  readonly setState: (state: StackChanAttentionState) => void;
  readonly nowMs: () => number;
  readonly recordFrame: () => void;
  readonly lastAcceptedFrameSequence: () => number | undefined;
  readonly acceptFrameSequence: (sequence: number) => void;
  readonly recordStaleFrame: () => void;
  readonly applyEffect: (
    effect: StackChanAttentionEffect,
    mode: StackChanAttentionState["mode"],
    currentPose: StackChanHeadPose
  ) => Promise<void>;
  readonly recordAttention: (
    target: StackChanAttentionTargetObservation | undefined,
    observedAtMs: number
  ) => void;
  readonly recordError: () => void;
};

async function executeAttentionTick(input: ExecuteAttentionTickOptions): Promise<void> {
  try {
    const frame = await input.options.adapter.captureJpeg();
    if (
      !isFreshAttentionFrame(
        frame,
        input.nowMs(),
        input.lastAcceptedFrameSequence(),
        input.options.config.maxFrameAgeMs
      )
    ) {
      input.recordStaleFrame();
      return;
    }
    const detections = await input.options.model.detect(frame.bytes);

    if (!input.isCurrent()) {
      return;
    }

    const observedAtMs = input.nowMs();
    if (
      !isFreshAttentionFrame(
        frame,
        observedAtMs,
        input.lastAcceptedFrameSequence(),
        input.options.config.maxFrameAgeMs
      )
    ) {
      input.recordStaleFrame();
      return;
    }
    await applyConfirmedAttentionTransition(input, frame, detections, observedAtMs);
  } catch {
    if (input.isCurrent()) {
      input.recordError();
    }
  }
}

async function applyConfirmedAttentionTransition(
  input: ExecuteAttentionTickOptions,
  frame: Awaited<ReturnType<StackChanAdapter["captureJpeg"]>>,
  detections: Awaited<ReturnType<AttentionDetectionModel["detect"]>>,
  observedAtMs: number
): Promise<void> {
  const currentPose = await input.refreshConfirmedPose();
  if (!input.isCurrent()) {
    return;
  }
  const decisionAtMs = input.nowMs();
  if (
    !isFreshAttentionFrame(
      frame,
      decisionAtMs,
      input.lastAcceptedFrameSequence(),
      input.options.config.maxFrameAgeMs
    )
  ) {
    input.recordStaleFrame();
    return;
  }
  if (frame.sequence !== undefined) {
    input.acceptFrameSequence(frame.sequence);
  }
  const transition = advanceAttentionState(
    input.state(),
    {
      nowMs: decisionAtMs,
      observedAtMs,
      currentPose,
      detections
    },
    input.controllerConfig
  );
  if (transition.diagnostic !== undefined) {
    input.options.onDecision?.(transition.diagnostic);
  }
  input.recordAttention(transition.target, observedAtMs);
  input.recordFrame();
  input.setState(transition.state);
  if (input.isCurrent()) {
    await input.applyEffect(transition.effect, transition.state.mode, currentPose);
  }
}

function isFreshAttentionFrame(
  frame: Awaited<ReturnType<StackChanAdapter["captureJpeg"]>>,
  observedAtMs: number,
  lastAcceptedSequence: number | undefined,
  maximumAgeMs: number
): boolean {
  if (frame.sequence === undefined && frame.receivedAtMs === undefined) {
    return true;
  }
  if (frame.sequence === undefined || frame.receivedAtMs === undefined) {
    return false;
  }
  const ageMs = observedAtMs - frame.receivedAtMs;
  return frame.sequence > (lastAcceptedSequence ?? -1) && ageMs >= 0 && ageMs <= maximumAgeMs;
}

function requireCommandedPose(pose: StackChanHeadPose | undefined): StackChanHeadPose {
  if (pose === undefined) {
    throw new Error("StackChan attention commanded pose is unavailable");
  }
  return { ...pose };
}

type StopAttentionRuntimeOptions = {
  readonly options: CreateStackChanAttentionRuntimeOptions;
  readonly waitMs: (durationMs: number) => Promise<void>;
  readonly getStartPromise: () => Promise<void> | undefined;
  readonly getActiveTick: () => Promise<void> | undefined;
  readonly ownsAdapter: () => boolean;
  readonly adapterConnected: () => boolean;
  readonly laneCloseRequired: () => boolean;
  readonly laneLeaseId: () => string | undefined;
  readonly adoptLaneStatus: (status: StackChanHeadTargetStatus) => void;
  readonly clearLaneLease: () => void;
  readonly cancelLoop: () => void;
  readonly invalidateRun: () => void;
  readonly markStopped: () => void;
  readonly releaseAdapter: () => void;
  readonly recordError: (code: StackChanAttentionErrorCode) => void;
};

async function stopAttentionRuntime(input: StopAttentionRuntimeOptions): Promise<void> {
  input.invalidateRun();
  const pendingStart = input.getStartPromise();
  if (pendingStart !== undefined) {
    await pendingStart.catch(() => undefined);
  }
  cancelAttentionLoop(input);
  await drainAttentionTick(input);

  if (input.ownsAdapter()) {
    const laneStopped = await stopHeadTargetLane(input);
    if (input.adapterConnected() && laneStopped) {
      await returnAttentionHome(input);
    }
    if (input.laneCloseRequired()) {
      await closeHeadTargetLane(input);
    }
    await closeAttentionAdapter(input);
    input.releaseAdapter();
  }

  input.markStopped();
}

function cancelAttentionLoop(input: StopAttentionRuntimeOptions): void {
  try {
    input.cancelLoop();
  } catch {
    input.recordError("scheduler_cancel_failed");
  }
}

async function drainAttentionTick(input: StopAttentionRuntimeOptions): Promise<void> {
  await input.getActiveTick()?.catch(() => {
    input.recordError("tick_failed");
  });
}

async function stopHeadTargetLane(input: StopAttentionRuntimeOptions): Promise<boolean> {
  const leaseId = input.laneLeaseId();
  if (leaseId === undefined) {
    return true;
  }
  try {
    input.adoptLaneStatus(await input.options.headTargetLane.stop(leaseId));
    return true;
  } catch {
    input.recordError("lane_stop_failed");
    return false;
  } finally {
    input.clearLaneLease();
  }
}

async function returnAttentionHome(input: StopAttentionRuntimeOptions): Promise<void> {
  try {
    await input.options.adapter.moveHead(
      {
        yaw: input.options.config.homeYaw,
        pitch: Math.min(85, input.options.config.homePitch + HOME_APPROACH_DELTA_DEG)
      },
      {
        speedDps: input.options.config.moveSpeedDps
      }
    );
    await input.waitMs(HOME_APPROACH_WAIT_MS);
    await input.options.adapter.moveHead(
      {
        yaw: input.options.config.homeYaw,
        pitch: input.options.config.homePitch
      },
      {
        speedDps: input.options.config.moveSpeedDps
      }
    );
  } catch {
    input.recordError("home_failed");
  }
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function closeHeadTargetLane(input: StopAttentionRuntimeOptions): Promise<void> {
  try {
    await input.options.headTargetLane.close();
  } catch {
    input.recordError("lane_close_failed");
  }
}

async function closeAttentionAdapter(input: StopAttentionRuntimeOptions): Promise<void> {
  try {
    await input.options.adapter.close();
  } catch {
    input.recordError("close_failed");
  }
}

type CreateAttentionFlowStatusInput = {
  readonly observationTicksStarted: number;
  readonly observationTicksCompleted: number;
  readonly observationsWhileMoveInFlight: number;
  readonly lastAcceptedFrameSequence: number | undefined;
  readonly staleFramesDiscarded: number;
  readonly staleFrameDispatches: number;
  readonly activeObservationTicks: number;
  readonly maximumConcurrentObservationTicks: number;
  readonly observationOverlapAttempts: number;
  readonly laneStatus: StackChanHeadTargetStatus | undefined;
};

function createAttentionFlowStatus(
  input: CreateAttentionFlowStatusInput
): StackChanAttentionFlowStatus {
  const lane = projectLaneFlow(input.laneStatus);
  return {
    observationTicksStarted: input.observationTicksStarted,
    observationTicksCompleted: input.observationTicksCompleted,
    observationsWhileMoveInFlight: input.observationsWhileMoveInFlight,
    ...(input.lastAcceptedFrameSequence === undefined
      ? {}
      : { lastAcceptedFrameSequence: input.lastAcceptedFrameSequence }),
    staleFramesDiscarded: input.staleFramesDiscarded,
    staleFrameDispatches: input.staleFrameDispatches,
    pendingMoveDepth: lane.pendingMoveDepth,
    maximumPendingMoveDepth: lane.maximumPendingMoveDepth,
    pendingMoveReplacements: lane.pendingMoveReplacements,
    pendingMoveDispatches: lane.pendingMoveDispatches,
    activeObservationTicks: input.activeObservationTicks,
    activeMoves: lane.activeMoves,
    maximumConcurrentObservationTicks: input.maximumConcurrentObservationTicks,
    maximumConcurrentMoves: lane.maximumConcurrentMoves,
    observationOverlapAttempts: input.observationOverlapAttempts,
    moveOverlapAttempts: 0
  };
}

function projectLaneFlow(
  status: StackChanHeadTargetStatus | undefined
): Pick<
  StackChanAttentionFlowStatus,
  | "pendingMoveDepth"
  | "maximumPendingMoveDepth"
  | "pendingMoveReplacements"
  | "pendingMoveDispatches"
  | "activeMoves"
  | "maximumConcurrentMoves"
> {
  if (status === undefined) {
    return {
      pendingMoveDepth: 0,
      maximumPendingMoveDepth: 0,
      pendingMoveReplacements: 0,
      pendingMoveDispatches: 0,
      activeMoves: 0,
      maximumConcurrentMoves: 0
    };
  }
  return {
    pendingMoveDepth: boundedLaneDepth(status.pendingDepth),
    maximumPendingMoveDepth: boundedLaneDepth(status.maximumPendingDepth),
    pendingMoveReplacements: status.replaced,
    pendingMoveDispatches: status.dispatched,
    activeMoves: status.activeCalls,
    maximumConcurrentMoves: status.maximumActiveCalls
  };
}

function attentionStatus(
  phase: StackChanAttentionPhase,
  framesProcessed: number,
  moveCount: number,
  errors: readonly StackChanAttentionStatusError[],
  state: StackChanAttentionState,
  targetVisible: boolean,
  targetFrames: number,
  centeredFrames: number,
  lastTarget:
    | (StackChanAttentionTargetObservation & {
        readonly observedAtMs: number;
      })
    | undefined,
  flow: StackChanAttentionFlowStatus,
  currentTimeMs: number,
  laneStatus: StackChanHeadTargetStatus | undefined
): StackChanAttentionStatus {
  const latestError = errors[errors.length - 1];

  return {
    phase,
    framesProcessed,
    moveCount,
    flow: { ...flow },
    ...(laneStatus === undefined ? {} : { headTargetLane: projectLaneStatus(laneStatus) }),
    attention: {
      mode: state.mode,
      targetVisible,
      targetFrames,
      centeredFrames,
      ...(lastTarget === undefined
        ? {}
        : {
            lastTarget: {
              ...lastTarget,
              ageMs: Math.max(0, currentTimeMs - lastTarget.observedAtMs)
            }
          })
    },
    ...(latestError === undefined
      ? {}
      : {
          lastError: latestError.message,
          errors: [...errors]
        })
  };
}

function projectLaneStatus(
  status: StackChanHeadTargetStatus
): StackChanAttentionHeadTargetLaneStatus {
  return {
    phase: status.phase,
    accepted: status.accepted,
    replaced: status.replaced,
    dispatched: status.dispatched,
    confirmed: status.confirmed,
    confirmedApplyReplies: status.confirmedApplyReplies,
    failed: status.failed,
    staleDiscarded: status.staleDiscarded,
    noOpDiscarded: status.noOpDiscarded,
    activeCalls: status.activeCalls,
    pendingDepth: status.pendingDepth,
    maximumActiveCalls: status.maximumActiveCalls,
    maximumPendingDepth: status.maximumPendingDepth,
    postStopDispatches: status.postStopDispatches,
    updateAcknowledgmentMs: { ...status.updateAcknowledgmentMs },
    pendingAgeMs: { ...status.pendingAgeMs },
    deviceDispatchLatencyMs: { ...status.deviceDispatchLatencyMs }
  };
}

function requireLaneLease(leaseId: string | undefined): string {
  if (leaseId === undefined) {
    throw new Error("StackChan attention head target lane is unavailable");
  }
  return leaseId;
}

function requireSafeSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("StackChan attention sequence exhausted");
  }
}

function laneHasOutstandingWork(status: StackChanHeadTargetStatus | undefined): boolean {
  return status !== undefined && (status.activeCalls > 0 || status.pendingDepth > 0);
}

function shouldSuppressScanSubmission(
  submission: StackChanScanSubmission | undefined,
  confirmedPose: StackChanHeadPose,
  targetPose: StackChanHeadPose,
  status: StackChanHeadTargetStatus | undefined
): boolean {
  return (
    submission !== undefined &&
    sameHeadPose(submission.confirmedPose, confirmedPose) &&
    sameHeadPose(submission.targetPose, targetPose) &&
    laneHasOutstandingWork(status)
  );
}

function sameHeadPose(left: StackChanHeadPose, right: StackChanHeadPose): boolean {
  return left.yaw === right.yaw && left.pitch === right.pitch;
}

function boundedLaneDepth(value: number | undefined): 0 | 1 {
  return value === 1 ? 1 : 0;
}

function appendAttentionError(
  errors: readonly StackChanAttentionStatusError[],
  code: StackChanAttentionErrorCode
): readonly StackChanAttentionStatusError[] {
  return [
    ...errors,
    {
      code,
      message: ATTENTION_ERROR_MESSAGES[code]
    }
  ].slice(-STACKCHAN_ATTENTION_ERROR_HISTORY_LIMIT);
}

function attentionControllerConfig(
  config: Extract<PicoStackChanFollowConfig, { readonly enabled: true }>
): StackChanAttentionControllerConfig {
  return {
    deadZone: config.deadZone,
    deadZoneRelease: config.deadZoneRelease,
    stepQuantization: config.stepQuantization,
    targetFilter: config.targetFilter,
    yawGainDeg: config.yawGainDeg,
    pitchGainDeg: config.pitchGainDeg,
    flipYaw: config.flipYaw,
    flipPitch: config.flipPitch,
    maxStepDeg: config.maxStepDeg,
    trackingPitchMin: config.trackingPitchMin,
    lostHoldMs: config.lostHoldMs,
    scanDwellMs: config.scanDwellMs,
    scanYaw: config.scanYaw,
    scanPitch: config.scanPitch
  };
}

function scheduleAttentionInterval(
  task: () => Promise<void>,
  intervalMs: number
): StackChanAttentionScheduledLoop {
  const timer = setInterval(() => {
    task().catch(() => undefined);
  }, intervalMs);
  timer.unref();

  return {
    cancel() {
      clearInterval(timer);
    }
  };
}
