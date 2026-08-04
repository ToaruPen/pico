import type {
  PicoAttentionDetectionConfig,
  PicoConfig,
  PicoStackChanConfig,
  PicoStackChanFollowConfig
} from "../config/index.js";
import {
  createStackChanHeadTargetLaneFromConfig,
  type StackChanHeadTargetLane
} from "../modules/stackchan/head-target-lane.js";
import {
  createStackChanAdapterFromConfig,
  type StackChanAdapter
} from "../modules/stackchan/index.js";
import {
  type AttentionDetectionModel,
  createPintoAttentionDetectionModel
} from "../modules/vision/attention-detection.js";
import {
  createStackChanAttentionRuntime,
  type StackChanAttentionRuntime,
  type StackChanAttentionStatus
} from "./stackchan-attention-runtime.js";
import type { AttentionInteractionOwner } from "./voice-resident.js";

type EnabledAttentionConfig = Extract<PicoAttentionDetectionConfig, { readonly enabled: true }>;
type EnabledFollowConfig = Extract<PicoStackChanFollowConfig, { readonly enabled: true }>;

const OWNER_ERROR_MESSAGES = {
  model_initialization_failed: "StackChan attention model initialization failed",
  runtime_start_failed: "StackChan attention runtime startup failed",
  runtime_cleanup_failed: "StackChan attention runtime cleanup failed",
  operation_failed: "StackChan attention owner operation failed"
} as const;

const STACKCHAN_ATTENTION_OWNER_ERROR_HISTORY_LIMIT = 8;

export type StackChanAttentionOwnerErrorCode = keyof typeof OWNER_ERROR_MESSAGES;

export type StackChanAttentionOwnerStatusError = {
  readonly code: StackChanAttentionOwnerErrorCode;
  readonly message: (typeof OWNER_ERROR_MESSAGES)[StackChanAttentionOwnerErrorCode];
};

export type StackChanAttentionOwnerStatus = {
  readonly active: boolean;
  readonly runtime?: StackChanAttentionStatus;
  readonly lastError?: string;
  readonly errors?: readonly StackChanAttentionOwnerStatusError[];
};

export type StackChanAttentionOwner = AttentionInteractionOwner & {
  readonly status: () => StackChanAttentionOwnerStatus;
};

export type StackChanAttentionOwnerDependencies = {
  readonly createModel: (config: EnabledAttentionConfig) => Promise<AttentionDetectionModel>;
  readonly createAdapter: (config: PicoStackChanConfig) => StackChanAdapter;
  readonly createHeadTargetLane: (config: PicoStackChanConfig) => StackChanHeadTargetLane;
  readonly createRuntime: (options: {
    readonly adapter: StackChanAdapter;
    readonly headTargetLane: StackChanHeadTargetLane;
    readonly model: AttentionDetectionModel;
    readonly config: EnabledFollowConfig;
  }) => StackChanAttentionRuntime;
};

const defaultDependencies: StackChanAttentionOwnerDependencies = {
  createModel: (config) =>
    createPintoAttentionDetectionModel({
      modelPath: config.modelPath,
      inputWidth: config.inputWidth,
      inputHeight: config.inputHeight,
      headConfidenceThreshold: config.headConfidenceThreshold,
      faceConfidenceThreshold: config.faceConfidenceThreshold
    }),
  createAdapter: (config) => createStackChanAdapterFromConfig(config),
  createHeadTargetLane: (config) => createStackChanHeadTargetLaneFromConfig(config),
  createRuntime: createStackChanAttentionRuntime
};

export async function createConfiguredStackChanAttentionOwner(
  config: PicoConfig,
  dependencies: StackChanAttentionOwnerDependencies = defaultDependencies
): Promise<StackChanAttentionOwner | undefined> {
  const stackchan = config.camera.stackchan;
  const follow = stackchan?.follow;
  const attention = config.vision.attentionDetection;

  if (stackchan === undefined || follow?.enabled !== true) {
    return undefined;
  }
  if (attention?.enabled !== true) {
    throw new Error("enabled StackChan follow requires enabled attention detection");
  }

  return createOwnerWithInitializedModel(stackchan, follow, attention, dependencies);
}

async function createOwnerWithInitializedModel(
  stackchan: PicoStackChanConfig,
  follow: EnabledFollowConfig,
  attention: EnabledAttentionConfig,
  dependencies: StackChanAttentionOwnerDependencies
): Promise<StackChanAttentionOwner> {
  const model = await initializeAttentionModel(attention, dependencies);
  if (model === undefined) {
    return createInactiveAttentionOwner("model_initialization_failed");
  }

  return createAttentionOwner(stackchan, follow, model, dependencies);
}

async function initializeAttentionModel(
  config: EnabledAttentionConfig,
  dependencies: StackChanAttentionOwnerDependencies
): Promise<AttentionDetectionModel | undefined> {
  try {
    return await dependencies.createModel(config);
  } catch {
    return undefined;
  }
}

function createInactiveAttentionOwner(
  errorCode: StackChanAttentionOwnerErrorCode
): StackChanAttentionOwner {
  const errors = appendOwnerError([], errorCode);

  return {
    startInteraction: () => Promise.resolve(),
    stopInteraction: () => Promise.resolve(),
    status: () => ownerStatus(undefined, errors)
  };
}

function createAttentionOwner(
  stackchan: PicoStackChanConfig,
  follow: EnabledFollowConfig,
  model: AttentionDetectionModel,
  dependencies: StackChanAttentionOwnerDependencies
): StackChanAttentionOwner {
  let runtime: StackChanAttentionRuntime | undefined;
  let operation = Promise.resolve();
  let errors: readonly StackChanAttentionOwnerStatusError[] = [];

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    operation = operation.then(task).catch(() => {
      errors = appendOwnerError(errors, "operation_failed");
    });
    return operation;
  };

  const recordError = (code: StackChanAttentionOwnerErrorCode): void => {
    errors = appendOwnerError(errors, code);
  };

  return {
    startInteraction: () =>
      enqueue(async () => {
        if (runtime !== undefined) {
          return;
        }

        const nextRuntime = dependencies.createRuntime({
          adapter: dependencies.createAdapter(stackchan),
          headTargetLane: dependencies.createHeadTargetLane(stackchan),
          model,
          config: follow
        });
        runtime = nextRuntime;
        try {
          await nextRuntime.start();
        } catch {
          recordError("runtime_start_failed");
          if (await runtimeCleanupFailed(nextRuntime)) {
            recordError("runtime_cleanup_failed");
          }
          runtime = undefined;
        }
      }),
    stopInteraction: () =>
      enqueue(async () => {
        const activeRuntime = runtime;
        if (activeRuntime === undefined) {
          return;
        }

        try {
          if (await runtimeCleanupFailed(activeRuntime)) {
            recordError("runtime_cleanup_failed");
          }
        } finally {
          runtime = undefined;
        }
      }),
    status: () => ownerStatus(runtime?.status(), errors)
  };
}

async function runtimeCleanupFailed(runtime: StackChanAttentionRuntime): Promise<boolean> {
  try {
    await runtime.stop();
  } catch {
    return true;
  }

  return hasRuntimeCleanupError(runtime.status());
}

function hasRuntimeCleanupError(status: StackChanAttentionStatus): boolean {
  return (
    status.errors?.some(
      (error) =>
        error.code === "scheduler_cancel_failed" ||
        error.code === "lane_stop_failed" ||
        error.code === "lane_close_failed" ||
        error.code === "home_failed" ||
        error.code === "close_failed"
    ) === true
  );
}

function ownerStatus(
  runtime: StackChanAttentionStatus | undefined,
  errors: readonly StackChanAttentionOwnerStatusError[]
): StackChanAttentionOwnerStatus {
  const latestError = errors[errors.length - 1];

  return {
    active: runtime !== undefined,
    ...(runtime === undefined ? {} : { runtime }),
    ...(latestError === undefined
      ? {}
      : {
          lastError: latestError.message,
          errors: [...errors]
        })
  };
}

function appendOwnerError(
  errors: readonly StackChanAttentionOwnerStatusError[],
  code: StackChanAttentionOwnerErrorCode
): readonly StackChanAttentionOwnerStatusError[] {
  return [
    ...errors,
    {
      code,
      message: OWNER_ERROR_MESSAGES[code]
    }
  ].slice(-STACKCHAN_ATTENTION_OWNER_ERROR_HISTORY_LIMIT);
}
