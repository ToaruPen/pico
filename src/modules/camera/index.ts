import { spawn } from "node:child_process";
import { isIPv4 } from "node:net";

import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const cameraModuleMetadata = {
  kind: "camera",
  status: "planned",
  summary: "Snapshot-oriented camera access through RTSP, with ONVIF only when PTZ is needed.",
  capabilities: [
    {
      id: "camera.person_follow",
      description: "Keep a detected person near frame center with bounded relative PTZ nudges."
    }
  ]
} as const satisfies FuturePicoModuleMetadata;

export type RtspSnapshotSourceInput = {
  readonly id: string;
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly stream: string;
  readonly port?: number;
};

export type RtspSnapshotSource = {
  readonly id: string;
  readonly url: string;
};

export type RtspSnapshotTransport = {
  readonly captureJpeg: (url: string) => Promise<Uint8Array>;
};

export type FfmpegRtspSnapshotTransportInput = {
  readonly ffmpegPath?: string;
  readonly timeoutMs: number;
  readonly maxFrameBytes?: number;
  readonly rtspTransport?: "tcp" | "udp";
};

export type FfmpegRtspSnapshotProcess = {
  readonly stdout: {
    readonly on: (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void) => void;
  };
  readonly stderr: {
    readonly on: (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void) => void;
  };
  readonly on: {
    (event: "error", listener: (error: Error) => void): FfmpegRtspSnapshotProcess;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): FfmpegRtspSnapshotProcess;
  };
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

export type FfmpegRtspSnapshotSpawner = (
  command: string,
  arguments_: readonly string[]
) => FfmpegRtspSnapshotProcess;

export type RtspSnapshotResult =
  | {
      readonly ok: true;
      readonly sourceId: string;
      readonly mimeType: "image/jpeg";
      readonly frame: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly sourceId: string;
      readonly reason: "capture_failed" | "in_flight";
      readonly message: string;
    };

export type RtspSnapshotClient = {
  readonly captureSnapshot: () => Promise<RtspSnapshotResult>;
};

export type PersonFollowBoundingBox = {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
};

export type PersonFollowDetection = {
  readonly boundingBox: PersonFollowBoundingBox;
  readonly confidence: number;
};

export type PersonFollowFrame = {
  readonly sourceId: string;
  readonly capturedAt: string;
  readonly detections: readonly PersonFollowDetection[];
};

export type PersonFollowMoveInput = {
  readonly boundingBox: PersonFollowBoundingBox;
  readonly deadZone: number;
  readonly maxStep: number;
  readonly speed: number;
};

export type PersonFollowPtzMoveCommand = {
  readonly pan: number;
  readonly tilt: number;
  readonly speed: number;
};

export type PersonFollowPtzDriver = {
  readonly relativeMove: (command: PersonFollowPtzMoveCommand) => Promise<void>;
  readonly stop: () => Promise<void>;
};

export type PersonFollowAuditEvent = {
  readonly name: "camera.person_follow.move" | "camera.person_follow.stop";
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly attributes: Readonly<Record<string, number | string>>;
};

export type PersonFollowControllerInput = {
  readonly sourceCameraId: string;
  readonly deadZone: number;
  readonly maxStep: number;
  readonly speed: number;
  readonly cooldownMs: number;
  readonly lostTargetTimeoutMs: number;
  readonly driver: PersonFollowPtzDriver;
  readonly audit?: (event: PersonFollowAuditEvent) => void;
  readonly nowMs?: () => number;
  readonly nowIso?: () => string;
};

export type PersonFollowController = {
  readonly processFrame: (frame: PersonFollowFrame) => Promise<void>;
  readonly stop: () => Promise<void>;
};

type RtspUrlParts = {
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly stream: string;
  readonly port: number;
};

const DEFAULT_MAX_FRAME_BYTES = 5 * 1024 * 1024;

export function defineRtspSnapshotSource(input: unknown): RtspSnapshotSource {
  if (input === undefined) {
    throw new Error("pico camera snapshot source config is required");
  }

  const source = requireRecord(input, "pico camera snapshot source must be one config object");
  const id = requireString(source.id, "pico camera snapshot source id is required");
  const host = requireHost(source.host);
  const username = requireString(
    source.username,
    "pico camera snapshot source username is required"
  );
  const password = requireString(
    source.password,
    "pico camera snapshot source password is required"
  );
  const stream = requireRelativeRtspPath(source.stream);
  const port = requirePort(source.port);

  return {
    id,
    url: buildRtspUrl({ host, username, password, stream, port })
  };
}

export function createRtspSnapshotClient(
  source: RtspSnapshotSource,
  transport: RtspSnapshotTransport
): RtspSnapshotClient {
  let inFlightSnapshot: Promise<RtspSnapshotResult> | undefined;

  return {
    captureSnapshot() {
      if (inFlightSnapshot !== undefined) {
        return Promise.resolve({
          ok: false,
          sourceId: source.id,
          reason: "in_flight",
          message: "previous RTSP snapshot capture is still in flight"
        });
      }

      inFlightSnapshot = Promise.resolve()
        .then(() => transport.captureJpeg(source.url))
        .then(
          (frame): RtspSnapshotResult => ({
            ok: true,
            sourceId: source.id,
            mimeType: "image/jpeg",
            frame
          })
        )
        .catch(
          (error: unknown): RtspSnapshotResult => ({
            ok: false,
            sourceId: source.id,
            reason: "capture_failed",
            message: errorMessage(error)
          })
        )
        .finally(() => {
          inFlightSnapshot = undefined;
        });

      return inFlightSnapshot;
    }
  };
}

export function createFfmpegRtspSnapshotTransport(
  input: FfmpegRtspSnapshotTransportInput,
  spawnProcess: FfmpegRtspSnapshotSpawner = spawnFfmpegProcess
): RtspSnapshotTransport {
  const ffmpegPath = input.ffmpegPath?.trim() || "ffmpeg";
  const timeoutMs = requirePositiveInteger(input.timeoutMs, "ffmpeg RTSP snapshot timeoutMs");
  const maxFrameBytes =
    input.maxFrameBytes === undefined
      ? DEFAULT_MAX_FRAME_BYTES
      : requirePositiveInteger(input.maxFrameBytes, "ffmpeg RTSP snapshot maxFrameBytes");
  const rtspTransport = input.rtspTransport ?? "tcp";

  return {
    captureJpeg(url) {
      return captureFfmpegJpeg({
        ffmpegPath,
        maxFrameBytes,
        rtspTransport,
        timeoutMs,
        url,
        spawnProcess
      });
    }
  };
}

export function buildPersonFollowMove(
  input: PersonFollowMoveInput
): PersonFollowPtzMoveCommand | undefined {
  const box = normalizePersonFollowBox(input.boundingBox);
  const deadZone = requireDeadZone(input.deadZone);
  const maxStep = requireUnitPositiveNumber(input.maxStep, "pico person follow max step");
  const speed = requireUnitPositiveNumber(input.speed, "pico person follow speed");
  const horizontalError = (box.xMin + box.xMax) / 2 - 0.5;
  const verticalError = (box.yMin + box.yMax) / 2 - 0.5;
  const pan = Math.abs(horizontalError) <= deadZone ? 0 : clamp(horizontalError, maxStep);
  const tilt = Math.abs(verticalError) <= deadZone ? 0 : clamp(-verticalError, maxStep);

  if (pan === 0 && tilt === 0) {
    return undefined;
  }

  return Object.freeze({
    pan: roundPtzStep(pan),
    tilt: roundPtzStep(tilt),
    speed
  });
}

export function createPersonFollowController(
  input: PersonFollowControllerInput
): PersonFollowController {
  const sourceCameraId = requireString(
    input.sourceCameraId,
    "pico person follow source camera id is required"
  );
  const deadZone = requireDeadZone(input.deadZone);
  const maxStep = requireUnitPositiveNumber(input.maxStep, "pico person follow max step");
  const speed = requireUnitPositiveNumber(input.speed, "pico person follow speed");
  const cooldownMs = requirePositiveInteger(input.cooldownMs, "pico person follow cooldownMs");
  const lostTargetTimeoutMs = requirePositiveInteger(
    input.lostTargetTimeoutMs,
    "pico person follow lostTargetTimeoutMs"
  );
  const nowMs = input.nowMs ?? (() => Date.now());
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  let stopped = false;
  let inFlightFrame = false;
  let lastMoveAtMs: number | undefined;
  let lastSeenAtMs: number | undefined;
  let lostStopSent = false;

  const recordAudit = (
    name: PersonFollowAuditEvent["name"],
    summary: string,
    attributes: Record<string, number | string>
  ): void => {
    input.audit?.(
      Object.freeze({
        name,
        sourceId: sourceCameraId,
        occurredAt: nowIso(),
        summary,
        attributes: Object.freeze(attributes)
      })
    );
  };

  const stopDriver = async (reason: string): Promise<void> => {
    await input.driver.stop();
    recordAudit("camera.person_follow.stop", "Stopped person-follow camera movement.", {
      reason
    });
  };

  const stopIfTargetLost = async (currentTimeMs: number): Promise<void> => {
    if (
      lastSeenAtMs !== undefined &&
      currentTimeMs - lastSeenAtMs >= lostTargetTimeoutMs &&
      !lostStopSent
    ) {
      await stopDriver("target_lost");
      lostStopSent = true;
    }
  };

  const issueMove = async (target: PersonFollowDetection, currentTimeMs: number): Promise<void> => {
    const move = buildPersonFollowMove({
      boundingBox: target.boundingBox,
      deadZone,
      maxStep,
      speed
    });

    if (move === undefined || isCoolingDown(lastMoveAtMs, currentTimeMs, cooldownMs)) {
      return;
    }

    await input.driver.relativeMove(move);
    lastMoveAtMs = currentTimeMs;
    recordAudit("camera.person_follow.move", "Issued person-follow relative PTZ move.", {
      pan: move.pan,
      tilt: move.tilt,
      speed: move.speed
    });
  };

  return {
    async processFrame(frame) {
      if (stopped || inFlightFrame || frame.sourceId !== sourceCameraId) {
        return;
      }

      inFlightFrame = true;
      try {
        const currentTimeMs = requireNonNegativeFiniteNumber(
          nowMs(),
          "pico person follow current time"
        );
        const target = selectPersonFollowTarget(frame.detections);

        if (target === undefined) {
          await stopIfTargetLost(currentTimeMs);
          return;
        }

        lastSeenAtMs = currentTimeMs;
        lostStopSent = false;

        await issueMove(target, currentTimeMs);
      } finally {
        inFlightFrame = false;
      }
    },
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      await stopDriver("manual_stop");
    }
  };
}

type FfmpegCaptureRequest = {
  readonly ffmpegPath: string;
  readonly maxFrameBytes: number;
  readonly rtspTransport: "tcp" | "udp";
  readonly timeoutMs: number;
  readonly url: string;
  readonly spawnProcess: FfmpegRtspSnapshotSpawner;
};

function captureFfmpegJpeg(request: FfmpegCaptureRequest): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const child = request.spawnProcess(
      request.ffmpegPath,
      buildFfmpegSnapshotArguments(request.url, request.rtspTransport, request.timeoutMs)
    );
    const timeout = setTimeout(() => {
      settleFfmpegCapture({
        settled,
        markSettled: () => {
          settled = true;
        },
        cleanup: () => {
          clearTimeout(timeout);
        },
        reject,
        error: new Error(`ffmpeg RTSP snapshot capture timed out after ${request.timeoutMs} ms`)
      });
      child.kill("SIGKILL");
    }, request.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      const totalBytes = stdoutChunks.reduce((total, current) => total + current.byteLength, 0);

      if (totalBytes > request.maxFrameBytes) {
        settleFfmpegCapture({
          settled,
          markSettled: () => {
            settled = true;
          },
          cleanup: () => {
            clearTimeout(timeout);
          },
          reject,
          error: new Error(`ffmpeg RTSP snapshot capture exceeded ${request.maxFrameBytes} bytes`)
        });
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      settleFfmpegCapture({
        settled,
        markSettled: () => {
          settled = true;
        },
        cleanup: () => {
          clearTimeout(timeout);
        },
        reject,
        error
      });
    });
    child.on("close", (code, signal) => {
      settleClosedFfmpegCapture({
        code,
        signal,
        settled,
        markSettled: () => {
          settled = true;
        },
        cleanup: () => {
          clearTimeout(timeout);
        },
        resolve,
        reject,
        stdout: Buffer.concat(stdoutChunks)
      });
    });
  });
}

type FfmpegCaptureSettlement = {
  readonly settled: boolean;
  readonly markSettled: () => void;
  readonly cleanup: () => void;
};

type FfmpegCaptureRejectSettlement = FfmpegCaptureSettlement & {
  readonly reject: (error: Error) => void;
  readonly error: Error;
};

type ClosedFfmpegCaptureSettlement = FfmpegCaptureSettlement & {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly resolve: (frame: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly stdout: Buffer;
};

function settleFfmpegCapture(settlement: FfmpegCaptureRejectSettlement): void {
  if (settlement.settled) {
    return;
  }

  settlement.markSettled();
  settlement.cleanup();
  settlement.reject(settlement.error);
}

function settleClosedFfmpegCapture(settlement: ClosedFfmpegCaptureSettlement): void {
  if (settlement.settled) {
    return;
  }

  settlement.markSettled();
  settlement.cleanup();

  if (settlement.code !== 0) {
    settlement.reject(buildFfmpegExitError(settlement.code, settlement.signal));

    return;
  }

  if (!isCompleteJpegFrame(settlement.stdout)) {
    settlement.reject(new Error("ffmpeg RTSP snapshot capture did not produce a JPEG frame"));

    return;
  }

  settlement.resolve(settlement.stdout);
}

function buildFfmpegSnapshotArguments(
  url: string,
  rtspTransport: "tcp" | "udp",
  timeoutMs: number
): readonly string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-rtsp_transport",
    rtspTransport,
    "-timeout",
    String(timeoutMs * 1000),
    "-i",
    url,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1"
  ];
}

function spawnFfmpegProcess(
  command: string,
  arguments_: readonly string[]
): FfmpegRtspSnapshotProcess {
  return spawn(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function buildFfmpegExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  const status = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;

  return new Error(`ffmpeg RTSP snapshot capture failed with ${status}`);
}

function isCompleteJpegFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= 4 &&
    frame[0] === 0xff &&
    frame[1] === 0xd8 &&
    frame.at(-2) === 0xff &&
    frame.at(-1) === 0xd9
  );
}

function buildRtspUrl(source: RtspUrlParts): string {
  const username = encodeURIComponent(source.username);
  const password = encodeURIComponent(source.password);
  const stream = source.stream
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `rtsp://${username}:${password}@${source.host}:${source.port}/${stream}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }

  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function requireHost(value: unknown): string {
  const host = requireString(
    value,
    "pico camera snapshot source host must be a hostname or IP address"
  );

  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error("pico camera snapshot source host must be a hostname or IP address");
  }

  if (!isPrivateOrLocalHost(host)) {
    throw new Error("pico camera snapshot source host must be a private or local address");
  }

  return host;
}

function isPrivateOrLocalHost(host: string): boolean {
  return isLocalHostname(host) || isPrivateOrLocalIpv4(host);
}

function isLocalHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".local");
}

function isPrivateOrLocalIpv4(host: string): boolean {
  const address = parseIpv4Address(host);

  if (address === undefined) {
    return false;
  }

  const [first, second] = address;

  return (
    first === 10 ||
    isPrivate172Address(first, second) ||
    isPrivate192Address(first, second) ||
    first === 127 ||
    isLinkLocalAddress(first, second)
  );
}

function parseIpv4Address(host: string): readonly [number, number, number, number] | undefined {
  if (!isIPv4(host)) {
    return undefined;
  }

  return host.split(".").map(Number) as [number, number, number, number];
}

function isPrivate172Address(first: number, second: number): boolean {
  return first === 172 && second >= 16 && second <= 31;
}

function isPrivate192Address(first: number, second: number): boolean {
  return first === 192 && second === 168;
}

function isLinkLocalAddress(first: number, second: number): boolean {
  return first === 169 && second === 254;
}

function requireRelativeRtspPath(value: unknown): string {
  const stream = requireString(
    value,
    "pico camera snapshot source stream must be a relative RTSP path"
  );

  if (stream.startsWith("/") || stream.includes("..") || stream.includes("://")) {
    throw new Error("pico camera snapshot source stream must be a relative RTSP path");
  }

  return stream;
}

function requirePort(value: unknown): number {
  if (value === undefined) {
    return 554;
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 65_535) {
    throw new Error("pico camera snapshot source port must be a valid TCP port");
  }

  return value;
}

function selectPersonFollowTarget(
  detections: readonly PersonFollowDetection[]
): PersonFollowDetection | undefined {
  return detections.reduce<PersonFollowDetection | undefined>((selected, detection) => {
    if (selected === undefined || detection.confidence > selected.confidence) {
      return detection;
    }

    return selected;
  }, undefined);
}

function isCoolingDown(
  lastMoveAtMs: number | undefined,
  currentTimeMs: number,
  cooldownMs: number
): boolean {
  return lastMoveAtMs !== undefined && currentTimeMs - lastMoveAtMs < cooldownMs;
}

function normalizePersonFollowBox(box: PersonFollowBoundingBox): PersonFollowBoundingBox {
  const xMin = requireNormalizedCoordinate(box.xMin, "pico person follow box xMin");
  const yMin = requireNormalizedCoordinate(box.yMin, "pico person follow box yMin");
  const xMax = requireNormalizedCoordinate(box.xMax, "pico person follow box xMax");
  const yMax = requireNormalizedCoordinate(box.yMax, "pico person follow box yMax");

  if (xMax <= xMin || yMax <= yMin) {
    throw new Error("pico person follow box must have positive area");
  }

  return Object.freeze({
    xMin,
    yMin,
    xMax,
    yMax
  });
}

function requireNormalizedCoordinate(value: unknown, label: string): number {
  const parsed = requireNonNegativeFiniteNumber(value, label);

  if (parsed > 1) {
    throw new Error(`${label} must be >= 0 and <= 1`);
  }

  return parsed;
}

function requireDeadZone(value: unknown): number {
  const parsed = requireNonNegativeFiniteNumber(value, "pico person follow dead zone");

  if (parsed >= 0.5) {
    throw new Error("pico person follow dead zone must be >= 0 and < 0.5");
  }

  return parsed;
}

function requireUnitPositiveNumber(value: unknown, label: string): number {
  const parsed = requireNonNegativeFiniteNumber(value, label);

  if (parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be > 0 and <= 1`);
  }

  return parsed;
}

function requireNonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }

  return value;
}

function clamp(value: number, maximumMagnitude: number): number {
  return Math.max(-maximumMagnitude, Math.min(maximumMagnitude, value));
}

function roundPtzStep(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "RTSP snapshot capture failed";
}
