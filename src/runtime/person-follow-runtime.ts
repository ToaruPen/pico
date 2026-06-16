import { existsSync } from "node:fs";

import type { PicoConfig } from "../config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createOnvifPersonFollowPtzDriver,
  createPersonFollowController,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type OnvifPersonFollowPtzDriverInput,
  type PersonFollowAuditEvent,
  type PersonFollowController,
  type PersonFollowControllerInput,
  type PersonFollowPtzDriver,
  type RtspSnapshotResult,
  type RtspSnapshotSource
} from "../modules/camera/index.js";
import {
  createCoremlPersonDetectionModel,
  createOnnxPersonDetectionModel,
  createPersonDetectionStream,
  createSharpRgbTensorPreprocessor,
  type PersonDetectionFrame,
  type PersonDetectionModel,
  type PersonDetectionStream,
  type PersonDetectionStreamOptions
} from "../modules/vision/person-detection.js";

const defaultTapoDetectionStream = "stream2";
const defaultTapoPort = 554;
const defaultOnvifPort = 2020;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;
const defaultDurationMs = 5_000;
const defaultMaxFrames = 10;
const defaultFinishDrainTimeoutMs = 2_000;

export type PersonFollowRuntimeProvider =
  | "tapo-rtsp+onnxruntime+onvif"
  | "tapo-rtsp+coreml+onvif"
  | "unsupported";

export type PersonFollowRuntimeReport =
  | {
      readonly status: "passed";
      readonly provider: PersonFollowRuntimeProvider;
      readonly details: {
        readonly sourceId: string;
        readonly framesProcessed: number;
        readonly personDetectionsTotal: number;
        readonly framesWithPersonDetections: number;
        readonly maxPersonDetectionsInFrame: number;
        readonly movesIssued: number;
        readonly stopsIssued: number;
        readonly errors: number;
      };
    }
  | {
      readonly status: "failed";
      readonly provider: PersonFollowRuntimeProvider;
      readonly reason: string;
    };

export type PersonFollowRuntimeOptions = {
  readonly enableLiveRun?: boolean;
  readonly durationMs?: number;
  readonly finishDrainTimeoutMs?: number;
  readonly maxFrames?: number;
};

export type PersonFollowRuntimeDependencies = {
  readonly pathExists?: (path: string) => boolean;
  readonly captureFrame?: (
    config: PicoConfig,
    source: RtspSnapshotSource
  ) => Promise<Uint8Array | undefined>;
  readonly createModel?: (config: PicoConfig) => Promise<PersonDetectionModel>;
  readonly createDriver?: (connection: OnvifPersonFollowPtzDriverInput) => PersonFollowPtzDriver;
  readonly createDetectionStream?: (options: PersonDetectionStreamOptions) => PersonDetectionStream;
  readonly createController?: (input: PersonFollowControllerInput) => PersonFollowController;
  readonly audit?: (event: PersonFollowAuditEvent) => void;
  readonly now?: () => string;
  readonly nowMs?: () => number;
};

type EnabledPersonDetectionConfig = {
  readonly enabled: true;
  readonly sourceCameraId: string;
  readonly modelFamily: "pinto0309";
  readonly provider: "onnxruntime" | "coreml";
  readonly modelPath: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly outputLayout?: "xyxy_score_class" | "cxcywh_score_class" | "yolox_coco_raw";
  readonly coordinateScale?: "pixel" | "normalized";
  readonly frameIntervalMs: number;
  readonly confidenceThreshold: number;
  readonly coremlFlags?: number;
  readonly nmsIouThreshold?: number;
};

type EnabledPersonFollowConfig = {
  readonly enabled: true;
  readonly sourceCameraId: string;
  readonly deadZone: number;
  readonly maxStep: number;
  readonly speed: number;
  readonly cooldownMs: number;
  readonly lostTargetTimeoutMs: number;
};

type ResolvedPersonFollowRuntimeConfig = {
  readonly detector: EnabledPersonDetectionConfig;
  readonly follow: EnabledPersonFollowConfig;
  readonly tapo: NonNullable<PicoConfig["camera"]["tapo"]>;
  readonly source: RtspSnapshotSource;
  readonly provider: PersonFollowRuntimeProvider;
};

type RuntimeCounters = {
  framesProcessed: number;
  personDetectionsTotal: number;
  framesWithPersonDetections: number;
  maxPersonDetectionsInFrame: number;
  movesIssued: number;
  stopsIssued: number;
  errors: number;
};

export async function runPersonFollowRuntime(
  config: PicoConfig,
  options: PersonFollowRuntimeOptions = {},
  dependencies: PersonFollowRuntimeDependencies = {}
): Promise<PersonFollowRuntimeReport> {
  const provider = personFollowRuntimeProvider(config);

  try {
    return await runConfiguredPersonFollowRuntime(config, options, dependencies);
  } catch (error: unknown) {
    return {
      status: "failed",
      provider,
      reason: errorMessage(error)
    };
  }
}

async function runConfiguredPersonFollowRuntime(
  config: PicoConfig,
  options: PersonFollowRuntimeOptions,
  dependencies: PersonFollowRuntimeDependencies
): Promise<PersonFollowRuntimeReport> {
  if (options.enableLiveRun !== true) {
    throw new Error("person-follow runtime requires enableLiveRun=true");
  }

  const resolved = resolvePersonFollowRuntimeConfig(config, dependencies);
  const model =
    dependencies.createModel === undefined
      ? await createConfiguredPersonDetectionModel(resolved.detector)
      : await dependencies.createModel(config);
  const counters = {
    framesProcessed: 0,
    personDetectionsTotal: 0,
    framesWithPersonDetections: 0,
    maxPersonDetectionsInFrame: 0,
    movesIssued: 0,
    stopsIssued: 0,
    errors: 0
  };
  const driver = createRuntimeDriver(resolved.tapo, dependencies);
  const controller = createRuntimeController(resolved.follow, driver, counters, dependencies);
  const maxFrames = requirePositiveInteger(options.maxFrames ?? defaultMaxFrames, "maxFrames");
  const durationMs = requirePositiveInteger(options.durationMs ?? defaultDurationMs, "durationMs");
  const finishDrainTimeoutMs = requirePositiveInteger(
    options.finishDrainTimeoutMs ?? defaultFinishDrainTimeoutMs,
    "finishDrainTimeoutMs"
  );
  const pendingFrames = new Set<Promise<void>>();
  let stream: PersonDetectionStream | undefined;

  return await new Promise<PersonFollowRuntimeReport>((resolve) => {
    let settled = false;
    const resolveUnexpectedFinishError = (): void => {
      counters.errors += 1;
      resolve(buildPersonFollowRuntimeReport(resolved, counters));
    };
    const timeout = setTimeout(() => {
      finish().catch(resolveUnexpectedFinishError);
    }, durationMs);

    const finish = async (
      input: { readonly streamAlreadyStopped?: boolean } = {}
    ): Promise<void> => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      if (input.streamAlreadyStopped !== true) {
        stream?.stop();
      }
      const streamDrainResult = await waitForStreamDrain(stream, finishDrainTimeoutMs);
      const drainResult = await waitForPendingFrames(pendingFrames, finishDrainTimeoutMs);
      if (streamDrainResult !== "drained" || drainResult !== "drained") {
        counters.errors += 1;
      }

      const stopResult = await waitForControllerStop(controller, finishDrainTimeoutMs);
      if (stopResult !== "drained") {
        counters.errors += 1;
      }

      resolve(buildPersonFollowRuntimeReport(resolved, counters));
    };

    const publish = (frame: PersonDetectionFrame): void => {
      counters.framesProcessed += 1;
      countPersonDetections(frame, counters);
      const reachedFrameBudget = counters.framesProcessed >= maxFrames;
      if (reachedFrameBudget) {
        stream?.stop();
      }

      const frameProcessing = controller
        .processFrame(frame)
        .catch(() => {
          counters.errors += 1;
        })
        .then(() => {
          pendingFrames.delete(frameProcessing);
          finishAfterMaxFrames(
            reachedFrameBudget,
            () => finish({ streamAlreadyStopped: true }),
            resolveUnexpectedFinishError
          );
        });
      pendingFrames.add(frameProcessing);
    };

    const captureFrame = async (): Promise<Uint8Array | undefined> =>
      await (dependencies.captureFrame ?? captureTapoDetectionFrame)(config, resolved.source);

    stream = createRuntimeDetectionStream(resolved.detector, model, captureFrame, publish, {
      dependencies,
      counters
    });
    stream.start();
  });
}

function buildPersonFollowRuntimeReport(
  resolved: ResolvedPersonFollowRuntimeConfig,
  counters: RuntimeCounters
): PersonFollowRuntimeReport {
  if (counters.errors > 0) {
    return {
      status: "failed",
      provider: resolved.provider,
      reason: `person-follow runtime finished with ${counters.errors} ${pluralizeError(
        counters.errors
      )}`
    };
  }

  if (counters.framesProcessed === 0) {
    return {
      status: "failed",
      provider: resolved.provider,
      reason: "person-follow runtime processed no frames"
    };
  }

  return {
    status: "passed",
    provider: resolved.provider,
    details: {
      sourceId: resolved.follow.sourceCameraId,
      framesProcessed: counters.framesProcessed,
      personDetectionsTotal: counters.personDetectionsTotal,
      framesWithPersonDetections: counters.framesWithPersonDetections,
      maxPersonDetectionsInFrame: counters.maxPersonDetectionsInFrame,
      movesIssued: counters.movesIssued,
      stopsIssued: counters.stopsIssued,
      errors: counters.errors
    }
  };
}

function pluralizeError(count: number): "error" | "errors" {
  return count === 1 ? "error" : "errors";
}

async function waitForStreamDrain(
  stream: PersonDetectionStream | undefined,
  timeoutMs: number
): Promise<"drained" | "failed" | "timed_out"> {
  if (stream === undefined) {
    return "drained";
  }

  return await raceDrainTimeout(stream.drain(), timeoutMs);
}

async function waitForPendingFrames(
  pendingFrames: ReadonlySet<Promise<void>>,
  timeoutMs: number
): Promise<"drained" | "failed" | "timed_out"> {
  if (pendingFrames.size === 0) {
    return "drained";
  }

  return await raceDrainTimeout(
    Promise.all([...pendingFrames]).then(() => undefined),
    timeoutMs
  );
}

async function waitForControllerStop(
  controller: PersonFollowController,
  timeoutMs: number
): Promise<"drained" | "failed" | "timed_out"> {
  return await raceDrainTimeout(controller.stop(), timeoutMs);
}

async function raceDrainTimeout(
  drain: Promise<void>,
  timeoutMs: number
): Promise<"drained" | "failed" | "timed_out"> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timed_out">((resolve) => {
    timeout = setTimeout(() => {
      resolve("timed_out");
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      drain.then(
        () => "drained" as const,
        () => "failed" as const
      ),
      timeoutPromise
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function resolvePersonFollowRuntimeConfig(
  config: PicoConfig,
  dependencies: PersonFollowRuntimeDependencies
): ResolvedPersonFollowRuntimeConfig {
  const detector = requireEnabledPersonDetectionConfig(config);
  const follow = requireEnabledPersonFollowConfig(config);
  const pathExists = dependencies.pathExists ?? existsSync;

  if (detector.sourceCameraId !== follow.sourceCameraId) {
    throw new Error(
      "vision.personDetection.sourceCameraId must match camera.personFollow.sourceCameraId"
    );
  }

  if (!pathExists(detector.modelPath)) {
    throw new Error("vision.personDetection model file is required to run person-follow runtime");
  }

  return {
    detector,
    follow,
    tapo: requireTapoConfig(config),
    source: buildPersonFollowDetectionSource(config, detector),
    provider: personFollowRuntimeProvider(config)
  };
}

function createRuntimeDriver(
  tapo: NonNullable<PicoConfig["camera"]["tapo"]>,
  dependencies: PersonFollowRuntimeDependencies
): PersonFollowPtzDriver {
  const connection = {
    host: tapo.host,
    port: tapo.onvifPort ?? defaultOnvifPort,
    username: tapo.user,
    password: tapo.password
  };

  return dependencies.createDriver === undefined
    ? createOnvifPersonFollowPtzDriver(connection)
    : dependencies.createDriver(connection);
}

function createRuntimeController(
  follow: EnabledPersonFollowConfig,
  driver: PersonFollowPtzDriver,
  counters: RuntimeCounters,
  dependencies: PersonFollowRuntimeDependencies
): PersonFollowController {
  const createController = dependencies.createController ?? createPersonFollowController;

  return createController({
    ...follow,
    driver,
    audit: (event) => {
      countPersonFollowAuditEvent(event, counters);
      dependencies.audit?.(event);
    },
    ...(dependencies.nowMs === undefined ? {} : { nowMs: dependencies.nowMs }),
    ...(dependencies.now === undefined ? {} : { nowIso: dependencies.now })
  });
}

function createRuntimeDetectionStream(
  detector: EnabledPersonDetectionConfig,
  model: PersonDetectionModel,
  captureFrame: () => Promise<Uint8Array | undefined>,
  publish: (frame: PersonDetectionFrame) => void,
  input: {
    readonly dependencies: PersonFollowRuntimeDependencies;
    readonly counters: RuntimeCounters;
  }
): PersonDetectionStream {
  const createStream = input.dependencies.createDetectionStream ?? createPersonDetectionStream;

  return createStream({
    sourceId: detector.sourceCameraId,
    frameIntervalMs: detector.frameIntervalMs,
    confidenceThreshold: detector.confidenceThreshold,
    frameSize: {
      width: detector.inputWidth,
      height: detector.inputHeight
    },
    captureFrame,
    model,
    publish,
    reportError: () => {
      input.counters.errors += 1;
    },
    ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now })
  });
}

function countPersonDetections(frame: PersonDetectionFrame, counters: RuntimeCounters): void {
  const count = frame.detections.length;

  counters.personDetectionsTotal += count;
  counters.maxPersonDetectionsInFrame = Math.max(counters.maxPersonDetectionsInFrame, count);
  if (count > 0) {
    counters.framesWithPersonDetections += 1;
  }
}

function countPersonFollowAuditEvent(
  event: PersonFollowAuditEvent,
  counters: RuntimeCounters
): void {
  if (event.name === "camera.person_follow.move") {
    counters.movesIssued += 1;
    return;
  }

  counters.stopsIssued += 1;
}

function finishAfterMaxFrames(
  reachedFrameBudget: boolean,
  finish: () => Promise<void>,
  onError: () => void
): void {
  if (!reachedFrameBudget) {
    return;
  }

  finish().catch(onError);
}

function buildPersonFollowDetectionSource(
  config: PicoConfig,
  detector: EnabledPersonDetectionConfig
): RtspSnapshotSource {
  const tapo = requireTapoConfig(config);

  return defineRtspSnapshotSource({
    id: detector.sourceCameraId,
    host: tapo.host,
    username: tapo.user,
    password: tapo.password,
    stream: tapo.streams?.detection ?? defaultTapoDetectionStream,
    port: tapo.port ?? defaultTapoPort
  });
}

async function captureTapoDetectionFrame(
  config: PicoConfig,
  source: RtspSnapshotSource
): Promise<Uint8Array | undefined> {
  const snapshot = await captureTapoDetectionSnapshot(config, source);

  if (!snapshot.ok) {
    throw new Error(`person-follow detection frame capture failed: ${snapshot.message}`);
  }

  if (snapshot.frame.byteLength === 0) {
    return undefined;
  }

  return snapshot.frame;
}

async function captureTapoDetectionSnapshot(
  config: PicoConfig,
  source: RtspSnapshotSource
): Promise<RtspSnapshotResult> {
  const tapo = requireTapoConfig(config);
  const client = createRtspSnapshotClient(
    source,
    createFfmpegRtspSnapshotTransport({
      timeoutMs: tapo.timeoutMs ?? defaultTimeoutMs,
      maxFrameBytes: tapo.maxFrameBytes ?? defaultMaxFrameBytes
    })
  );

  return await client.captureSnapshot();
}

function createConfiguredPersonDetectionModel(
  detector: EnabledPersonDetectionConfig
): Promise<PersonDetectionModel> {
  const commonOptions = {
    modelPath: detector.modelPath,
    frameSize: {
      width: detector.inputWidth,
      height: detector.inputHeight
    },
    confidenceThreshold: detector.confidenceThreshold,
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    ...(detector.nmsIouThreshold === undefined
      ? {}
      : { nmsIouThreshold: detector.nmsIouThreshold }),
    preprocessFrame: createSharpRgbTensorPreprocessor({
      inputWidth: detector.inputWidth,
      inputHeight: detector.inputHeight
    })
  };

  if (detector.provider === "coreml") {
    return createCoremlPersonDetectionModel({
      ...commonOptions,
      ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags })
    });
  }

  return createOnnxPersonDetectionModel({
    ...commonOptions,
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout })
  });
}

function requireEnabledPersonDetectionConfig(config: PicoConfig): EnabledPersonDetectionConfig {
  const detector = config.vision.personDetection;

  if (!detector.enabled || detector.modelFamily !== "pinto0309") {
    throw new Error("vision.personDetection.enabled=true is required for person-follow runtime");
  }

  const provider = requireSupportedPersonDetectionProvider(detector.provider);

  return {
    enabled: true,
    sourceCameraId: requireString(
      detector.sourceCameraId,
      "vision.personDetection.sourceCameraId is required"
    ),
    modelFamily: "pinto0309",
    provider,
    modelPath: requireString(detector.modelPath, "vision.personDetection.modelPath is required"),
    inputWidth: requireNumber(detector.inputWidth, "vision.personDetection.inputWidth is required"),
    inputHeight: requireNumber(
      detector.inputHeight,
      "vision.personDetection.inputHeight is required"
    ),
    frameIntervalMs: requireNumber(
      detector.frameIntervalMs,
      "vision.personDetection.frameIntervalMs is required"
    ),
    confidenceThreshold: requireNumber(
      detector.confidenceThreshold,
      "vision.personDetection.confidenceThreshold is required"
    ),
    ...(detector.outputLayout === undefined ? {} : { outputLayout: detector.outputLayout }),
    ...(detector.coordinateScale === undefined
      ? {}
      : { coordinateScale: detector.coordinateScale }),
    ...(detector.coremlFlags === undefined ? {} : { coremlFlags: detector.coremlFlags }),
    ...(detector.nmsIouThreshold === undefined ? {} : { nmsIouThreshold: detector.nmsIouThreshold })
  };
}

function requireSupportedPersonDetectionProvider(
  provider: PicoConfig["vision"]["personDetection"]["provider"]
): "onnxruntime" | "coreml" {
  if (provider !== "onnxruntime" && provider !== "coreml") {
    throw new Error("person-follow runtime supports provider=onnxruntime or coreml");
  }

  return provider;
}

function requireEnabledPersonFollowConfig(config: PicoConfig): EnabledPersonFollowConfig {
  const follow = config.camera.personFollow;

  if (!follow.enabled) {
    throw new Error("camera.personFollow.enabled=true is required for person-follow runtime");
  }

  return {
    enabled: true,
    sourceCameraId: requireString(
      follow.sourceCameraId,
      "camera.personFollow.sourceCameraId is required"
    ),
    deadZone: requireNumber(follow.deadZone, "camera.personFollow.deadZone is required"),
    maxStep: requireNumber(follow.maxStep, "camera.personFollow.maxStep is required"),
    speed: requireNumber(follow.speed, "camera.personFollow.speed is required"),
    cooldownMs: requireNumber(follow.cooldownMs, "camera.personFollow.cooldownMs is required"),
    lostTargetTimeoutMs: requireNumber(
      follow.lostTargetTimeoutMs,
      "camera.personFollow.lostTargetTimeoutMs is required"
    )
  };
}

function requireTapoConfig(config: PicoConfig): NonNullable<PicoConfig["camera"]["tapo"]> {
  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    throw new Error("camera.tapo is required for person-follow runtime");
  }

  return tapo;
}

function personFollowRuntimeProvider(config: PicoConfig): PersonFollowRuntimeProvider {
  if (config.vision.personDetection.provider === "onnxruntime") {
    return "tapo-rtsp+onnxruntime+onvif";
  }

  if (config.vision.personDetection.provider === "coreml") {
    return "tapo-rtsp+coreml+onvif";
  }

  return "unsupported";
}

function requireString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function requireNumber(value: number | undefined, message: string): number {
  if (value === undefined) {
    throw new Error(message);
  }

  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
