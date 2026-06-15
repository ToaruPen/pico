import type { PicoConfig } from "../config/index.js";
import {
  createFfmpegRtspSnapshotTransport,
  createRtspSnapshotClient,
  defineRtspSnapshotSource,
  type RtspSnapshotResult,
  type RtspSnapshotSource
} from "../modules/camera/index.js";

const defaultTapoSceneStream = "stream1";
const defaultTapoPort = 554;
const defaultTimeoutMs = 10_000;
const defaultMaxFrameBytes = 5 * 1024 * 1024;

export type PicoCameraSnapshotResult =
  | {
      readonly status: "passed";
      readonly sourceId: string;
      readonly streamPurpose: "scene";
      readonly mimeType: "image/jpeg";
      readonly frameBytes: number;
      readonly capturedAt: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export type PicoPersonDetectionResult = {
  readonly status: "failed";
  readonly reason: string;
};

export type PicoCameraSceneDescriptionResult = {
  readonly status: "failed";
  readonly reason: string;
};

export type PicoPerceptionService = {
  readonly captureSceneSnapshot: () => Promise<PicoCameraSnapshotResult>;
  readonly detectPeople: () => Promise<PicoPersonDetectionResult>;
  readonly describeCameraScene: () => Promise<PicoCameraSceneDescriptionResult>;
};

export type PicoPerceptionServiceDependencies = {
  readonly captureSnapshot?: (
    source: RtspSnapshotSource,
    timeoutMs: number,
    maxFrameBytes: number
  ) => Promise<RtspSnapshotResult>;
  readonly now?: () => string;
};

export function createPicoPerceptionService(
  config: PicoConfig,
  dependencies: PicoPerceptionServiceDependencies = {}
): PicoPerceptionService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const inFlightCapturePurposes = new Set<"scene" | "detection">();

  return {
    async captureSceneSnapshot() {
      let source: RtspSnapshotSource;
      try {
        source = buildTapoSceneSnapshotSource(config);
      } catch (error: unknown) {
        return {
          status: "failed",
          reason: sanitizeRtspMessage(errorMessage(error), config)
        };
      }

      const snapshot = await captureSnapshotSafely(
        config,
        source,
        "scene",
        inFlightCapturePurposes,
        dependencies
      );

      if (!snapshot.ok) {
        return {
          status: "failed",
          reason: `pico camera snapshot failed: ${snapshot.reason}: ${sanitizeRtspMessage(
            snapshot.message,
            config,
            source
          )}`
        };
      }

      return {
        status: "passed",
        sourceId: snapshot.sourceId,
        streamPurpose: "scene",
        mimeType: snapshot.mimeType,
        frameBytes: snapshot.frame.byteLength,
        capturedAt: now()
      };
    },
    detectPeople() {
      return Promise.resolve({
        status: "failed",
        reason: "pico person detection is not implemented in Task 1"
      });
    },
    describeCameraScene() {
      return Promise.resolve({
        status: "failed",
        reason: "pico camera scene description is not implemented in Task 1"
      });
    }
  };
}

function buildTapoSceneSnapshotSource(config: PicoConfig): RtspSnapshotSource {
  const tapo = config.camera.tapo;

  if (tapo === undefined) {
    throw new Error("camera.tapo is required to use pico_camera_snapshot");
  }

  return defineRtspSnapshotSource({
    id: tapo.sourceId ?? "tapo-rtsp",
    host: tapo.host,
    username: tapo.user,
    password: tapo.password,
    stream: tapo.streams?.scene ?? defaultTapoSceneStream,
    port: tapo.port ?? defaultTapoPort
  });
}

async function captureSnapshotSafely(
  config: PicoConfig,
  source: RtspSnapshotSource,
  purpose: "scene" | "detection",
  inFlightCapturePurposes: Set<"scene" | "detection">,
  dependencies: PicoPerceptionServiceDependencies
): Promise<RtspSnapshotResult> {
  const tapo = config.camera.tapo;
  const timeoutMs = tapo?.timeoutMs ?? defaultTimeoutMs;
  const maxFrameBytes = tapo?.maxFrameBytes ?? defaultMaxFrameBytes;

  if (inFlightCapturePurposes.has(purpose)) {
    return {
      ok: false,
      sourceId: source.id,
      reason: "in_flight",
      message: "previous RTSP snapshot capture is still in flight"
    };
  }

  try {
    inFlightCapturePurposes.add(purpose);

    return await (dependencies.captureSnapshot ?? captureSnapshotWithRtsp)(
      source,
      timeoutMs,
      maxFrameBytes
    );
  } catch (error: unknown) {
    return {
      ok: false,
      sourceId: source.id,
      reason: "capture_failed",
      message: errorMessage(error)
    };
  } finally {
    inFlightCapturePurposes.delete(purpose);
  }
}

function captureSnapshotWithRtsp(
  source: RtspSnapshotSource,
  timeoutMs: number,
  maxFrameBytes: number
): Promise<RtspSnapshotResult> {
  const transport = createFfmpegRtspSnapshotTransport({
    timeoutMs,
    maxFrameBytes
  });
  const client = createRtspSnapshotClient(source, transport);

  return client.captureSnapshot();
}

function sanitizeRtspMessage(
  message: string,
  config: PicoConfig,
  source?: RtspSnapshotSource
): string {
  let sanitized = message.replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]");

  for (const value of rtspSensitiveValues(config, source)) {
    sanitized = sanitized.replaceAll(value, "[redacted]");
  }

  return sanitized;
}

function rtspSensitiveValues(config: PicoConfig, source?: RtspSnapshotSource): readonly string[] {
  const tapo = config.camera.tapo;

  return [
    source?.url,
    tapo?.user,
    tapo?.password,
    tapo?.user === undefined ? undefined : encodeURIComponent(tapo.user),
    tapo?.password === undefined ? undefined : encodeURIComponent(tapo.password)
  ].filter((value): value is string => value !== undefined && value.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
