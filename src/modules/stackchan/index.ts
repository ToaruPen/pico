import { constants } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { PicoStackChanConfig } from "../../config/index.js";

export type StackChanJpegFrame = {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/jpeg";
  readonly sequence?: number;
  readonly capturedAtMs?: number;
  readonly encodedAtMs?: number;
  readonly receivedAtMs?: number;
};

export type StackChanLatestJpegFrame = StackChanJpegFrame & {
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly encodedAtMs: number;
  readonly receivedAtMs: number;
};

export type StackChanHeadPose = {
  readonly yaw: number;
  readonly pitch: number;
};

export type StackChanHeadMotion = {
  readonly speedDps: number;
};

export type StackChanMcpToolRequest = {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
};

export type StackChanMcpClient = {
  readonly connect: () => Promise<void>;
  readonly callTool: (request: StackChanMcpToolRequest) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

export async function closeStackChanMcpSession(
  transport: { readonly terminateSession: () => Promise<void> },
  client: { readonly close: () => Promise<void> }
): Promise<void> {
  try {
    await transport.terminateSession();
  } finally {
    await client.close();
  }
}

export type StackChanAdapter = {
  readonly connect: () => Promise<void>;
  readonly captureJpeg: () => Promise<StackChanJpegFrame>;
  readonly getHeadAngles: () => Promise<StackChanHeadPose>;
  readonly moveHead: (pose: StackChanHeadPose, motion?: StackChanHeadMotion) => Promise<void>;
  readonly close: () => Promise<void>;
};

type StackChanCaptureFileHandle = {
  readonly stat: () => Promise<{ readonly isFile: () => boolean }>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
};

type StackChanCaptureFileAccess = {
  readonly realpath: (path: string) => Promise<string>;
  readonly open: (path: string, flags: number) => Promise<StackChanCaptureFileHandle>;
  readonly unlink: (path: string) => Promise<void>;
};

type StackChanCaptureReader = (
  path: string,
  captureRoot: string,
  maxBytes: number
) => Promise<Uint8Array>;

export type CreateStackChanAdapterOptions = {
  readonly client: StackChanMcpClient;
  readonly readCaptureFile?: StackChanCaptureReader;
  readonly captureFileAccess?: StackChanCaptureFileAccess;
  readonly captureRoot: string;
  readonly maxFrameBytes: number;
  readonly stream?: {
    readonly fps: number;
    readonly quality: number;
    readonly readLatestFrame: (
      afterSequence: number | undefined
    ) => Promise<StackChanLatestJpegFrame>;
  };
};

const cameraStreamStopAttempts = 3;
type StackChanHardwareLane = "capture" | "move";

let stackChanCaptureLaneTail: Promise<void> = Promise.resolve();
let stackChanMoveLaneTail: Promise<void> = Promise.resolve();

export function createStackChanAdapter(options: CreateStackChanAdapterOptions): StackChanAdapter {
  const captureFileAccess = options.captureFileAccess ?? nodeCaptureFileAccess;
  const readCaptureFile =
    options.readCaptureFile ??
    ((path, captureRoot, maxBytes) =>
      readBoundedCaptureFile(captureFileAccess, path, captureRoot, maxBytes));

  let latestSequence: number | undefined;
  let streamLeaseActive = false;

  return {
    connect: async () => {
      await connectStackChanMcp(options.client);
      if (options.stream === undefined) {
        return;
      }
      try {
        const result = await callStackChanTool(options.client, "camera_stream", {
          action: "start",
          fps: options.stream.fps,
          quality: options.stream.quality
        });
        requireSuccessfulToolResult(result, "camera_stream");
        streamLeaseActive = true;
      } catch {
        await options.client.close().catch(() => undefined);
        throw new Error("StackChan camera stream start failed");
      }
    },
    captureJpeg: async () =>
      runStackChanHardwareOperation("capture", () =>
        options.stream === undefined
          ? captureStackChanJpeg(options, readCaptureFile)
          : captureLatestStackChanJpeg(
              options.stream.readLatestFrame,
              latestSequence,
              options.maxFrameBytes
            ).then((frame) => {
              latestSequence = frame.sequence;
              return frame;
            })
      ),
    getHeadAngles: async () => readStackChanHeadPose(options.client),
    moveHead: async (pose, motion) =>
      runStackChanHardwareOperation("move", () => moveStackChanHead(options.client, pose, motion)),
    close: async () => {
      let failed = false;
      if (streamLeaseActive) {
        const released = await releaseCameraStream(options.client);
        if (released) {
          streamLeaseActive = false;
        } else {
          failed = true;
        }
      }
      try {
        await options.client.close();
      } catch {
        failed = true;
      }
      if (failed) {
        throw new Error("StackChan MCP close failed");
      }
    }
  };
}

async function releaseCameraStream(client: StackChanMcpClient): Promise<boolean> {
  for (let attempt = 0; attempt < cameraStreamStopAttempts; attempt += 1) {
    try {
      const result = await callStackChanTool(client, "camera_stream", {
        action: "stop"
      });
      requireSuccessfulToolResult(result, "camera_stream");
      return true;
    } catch {
      // Retry the bounded release before closing the only MCP client that owns the lease.
    }
  }
  return false;
}

async function runStackChanHardwareOperation<T>(
  lane: StackChanHardwareLane,
  operation: () => Promise<T>
): Promise<T> {
  let releaseLane = (): void => undefined;
  const currentLane = new Promise<void>((resolveLane) => {
    releaseLane = resolveLane;
  });
  const previousLane = stackChanHardwareLaneTail(lane).catch(() => undefined);
  setStackChanHardwareLaneTail(
    lane,
    previousLane.then(() => currentLane)
  );

  try {
    await previousLane;
    return await operation();
  } finally {
    releaseLane();
  }
}

function stackChanHardwareLaneTail(lane: StackChanHardwareLane): Promise<void> {
  return lane === "capture" ? stackChanCaptureLaneTail : stackChanMoveLaneTail;
}

function setStackChanHardwareLaneTail(lane: StackChanHardwareLane, tail: Promise<void>): void {
  if (lane === "capture") {
    stackChanCaptureLaneTail = tail;
    return;
  }
  stackChanMoveLaneTail = tail;
}

export function createStackChanAdapterFromConfig(
  config: PicoStackChanConfig,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    readonly client?: StackChanMcpClient;
    readonly fetch?: typeof fetch;
  } = {}
): StackChanAdapter {
  const token = environment[config.bearerTokenEnv]?.trim();
  if (token === undefined || token === "") {
    throw new Error("StackChan bearer token is missing");
  }

  let client = dependencies.client;
  if (client === undefined) {
    const sdkClient = new Client({
      name: "pico-stackchan",
      version: "0.0.0"
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    });
    client = {
      connect: async () => connectMcpClient(sdkClient, transport),
      callTool: async (request) =>
        sdkClient.callTool(
          {
            name: request.name,
            arguments: request.arguments
          },
          undefined,
          { timeout: config.timeoutMs }
        ),
      close: async () => closeStackChanMcpSession(transport, sdkClient)
    };
  }

  const latestFrameUrl = new URL("/camera/latest", config.mcpUrl);
  const readLatestFrame = createLatestStackChanFrameReader({
    fetch: dependencies.fetch ?? fetch,
    url: latestFrameUrl,
    bearerToken: token,
    timeoutMs: config.timeoutMs,
    maxFrameBytes: config.maxFrameBytes
  });

  return createStackChanAdapter({
    client,
    captureRoot: resolve(homedir(), ".stackchan/captures"),
    maxFrameBytes: config.maxFrameBytes,
    stream: {
      fps: config.streamFps,
      quality: config.streamJpegQuality,
      readLatestFrame
    }
  });
}

type LatestStackChanFrameReaderOptions = {
  readonly fetch: typeof fetch;
  readonly url: URL;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly maxFrameBytes: number;
};

function createLatestStackChanFrameReader(
  options: LatestStackChanFrameReaderOptions
): (afterSequence: number | undefined) => Promise<StackChanLatestJpegFrame> {
  return async (afterSequence) => {
    const url = new URL(options.url);
    if (afterSequence !== undefined) {
      url.searchParams.set("after_sequence", String(afterSequence));
    }
    url.searchParams.set("timeout_ms", String(Math.min(options.timeoutMs, 30_000)));

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
    timeout.unref();

    try {
      const response = await options.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.bearerToken}`
        },
        signal: controller.signal
      });
      const sequence = requireLatestFrameResponse(response, afterSequence);
      const bytes = await readBoundedHttpBody(response, options.maxFrameBytes);
      return {
        sequence,
        capturedAtMs: requireNonnegativeIntegerHeader(response, "x-camera-captured-at-ms"),
        encodedAtMs: requireNonnegativeIntegerHeader(response, "x-camera-encoded-at-ms"),
        receivedAtMs: requireNonnegativeIntegerHeader(response, "x-camera-received-at-ms"),
        bytes,
        mimeType: "image/jpeg"
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function requireNonnegativeIntegerHeader(response: Response, name: string): number {
  const value = Number(response.headers.get(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("latest frame timing was invalid");
  }
  return value;
}

function requireLatestFrameResponse(response: Response, afterSequence: number | undefined): number {
  if (response.status !== 200) {
    throw new Error("latest frame response was unavailable");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "image/jpeg") {
    throw new Error("latest frame response was not JPEG");
  }
  const sequence = Number(response.headers.get("x-camera-sequence"));
  if (!isNewCameraSequence(sequence, afterSequence)) {
    throw new Error("latest frame sequence was invalid");
  }
  return sequence;
}

function isNewCameraSequence(sequence: number, afterSequence: number | undefined): boolean {
  return (
    Number.isSafeInteger(sequence) &&
    sequence >= 0 &&
    (afterSequence === undefined || sequence > afterSequence)
  );
}

async function readBoundedHttpBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  requireBoundedContentLength(response.headers.get("content-length"), maxBytes);
  const body = response.body;
  if (body === null) {
    throw new Error("latest frame response body was missing");
  }

  return readBoundedStream(body.getReader(), maxBytes);
}

function requireBoundedContentLength(value: string | null, maxBytes: number): void {
  if (value === null) {
    return;
  }
  const declaredLength = Number(value);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
    throw new Error("latest frame response exceeded byte limit");
  }
}

async function readBoundedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let result = await reader.read();
  while (!result.done) {
    totalBytes += result.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("latest frame response exceeded byte limit");
    }
    chunks.push(result.value);
    result = await reader.read();
  }

  return concatenateChunks(chunks, totalBytes);
}

function concatenateChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function captureLatestStackChanJpeg(
  readLatestFrame: (afterSequence: number | undefined) => Promise<StackChanLatestJpegFrame>,
  afterSequence: number | undefined,
  maxFrameBytes: number
): Promise<StackChanLatestJpegFrame> {
  let frame: StackChanLatestJpegFrame;
  try {
    frame = await readLatestFrame(afterSequence);
  } catch {
    throw new Error("StackChan latest camera frame failed");
  }
  if (!isValidLatestCameraFrame(frame, afterSequence, maxFrameBytes)) {
    throw new Error("StackChan latest camera frame was invalid");
  }
  return frame;
}

function isValidLatestCameraFrame(
  frame: StackChanLatestJpegFrame,
  afterSequence: number | undefined,
  maxFrameBytes: number
): boolean {
  return (
    isNewCameraSequence(frame.sequence, afterSequence) &&
    frame.bytes.byteLength <= maxFrameBytes &&
    isJpeg(frame.bytes)
  );
}

function connectMcpClient(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
  // The SDK Transport interface and concrete transport disagree on sessionId
  // under exactOptionalPropertyTypes.
  return client.connect(transport as unknown as Transport);
}

async function captureStackChanJpeg(
  options: CreateStackChanAdapterOptions,
  readCaptureFile: StackChanCaptureReader
): Promise<StackChanJpegFrame> {
  const result = await callStackChanTool(options.client, "take_photo", {
    question: "pico scene capture"
  });
  requireSuccessfulToolResult(result, "take_photo");
  const capturePath = findStringField(result, "image_path");

  if (capturePath === undefined) {
    throw new Error("StackChan take_photo returned invalid capture metadata");
  }
  requireCapturePath(capturePath, options.captureRoot);

  let bytes: Uint8Array;
  try {
    bytes = await readCaptureFile(capturePath, options.captureRoot, options.maxFrameBytes);
  } catch {
    throw new Error("StackChan capture could not be read");
  }
  if (bytes.byteLength > options.maxFrameBytes) {
    throw new Error("StackChan capture exceeds the configured byte limit");
  }
  if (!isJpeg(bytes)) {
    throw new Error("StackChan capture is not a JPEG");
  }

  return {
    bytes,
    mimeType: "image/jpeg"
  };
}

const nodeCaptureFileAccess: StackChanCaptureFileAccess = {
  realpath: async (path) => realpath(path),
  open: async (path, flags) => open(path, flags),
  unlink: async (path) => unlink(path)
};

async function readBoundedCaptureFile(
  access: StackChanCaptureFileAccess,
  path: string,
  captureRoot: string,
  maxBytes: number
): Promise<Uint8Array> {
  const realCapturePath = await resolveCapturePath(access, path, captureRoot);
  const handle = await access.open(
    realCapturePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  return consumeCaptureFile(access, handle, realCapturePath, maxBytes);
}

async function resolveCapturePath(
  access: StackChanCaptureFileAccess,
  path: string,
  captureRoot: string
): Promise<string> {
  requireCapturePath(path, captureRoot);
  const resolvedCaptureRoot = resolve(captureRoot);
  const realCaptureRoot = await access.realpath(captureRoot);
  if (realCaptureRoot !== resolvedCaptureRoot) {
    throw new Error("StackChan capture root must be canonical");
  }
  const realCapturePath = await access.realpath(path);
  const expectedRealCapturePath = resolve(
    realCaptureRoot,
    relative(resolve(captureRoot), resolve(path))
  );
  if (realCapturePath !== expectedRealCapturePath) {
    throw new Error("StackChan capture path must not be a symlink");
  }
  requireCapturePath(realCapturePath, realCaptureRoot);

  return realCapturePath;
}

async function consumeCaptureFile(
  access: StackChanCaptureFileAccess,
  handle: StackChanCaptureFileHandle,
  realCapturePath: string,
  maxBytes: number
): Promise<Uint8Array> {
  let result: Uint8Array | undefined;
  let operationFailed = false;

  try {
    result = await readRegularCaptureFile(handle, maxBytes);
  } catch {
    operationFailed = true;
  }

  const cleanupFailed = await cleanupCaptureFile(access, handle, realCapturePath);
  if (operationFailed || cleanupFailed || result === undefined) {
    throw new Error("StackChan capture could not be read");
  }

  return result;
}

async function readRegularCaptureFile(
  handle: StackChanCaptureFileHandle,
  maxBytes: number
): Promise<Uint8Array> {
  const status = await handle.stat();
  if (!status.isFile()) {
    throw new Error("StackChan capture is not a regular file");
  }

  const bytes = new Uint8Array(maxBytes + 1);
  let offset = 0;

  while (offset < bytes.byteLength) {
    const requestedBytes = bytes.byteLength - offset;
    const { bytesRead } = await handle.read(bytes, offset, requestedBytes, offset);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > requestedBytes) {
      throw new Error("StackChan capture reader returned an invalid byte count");
    }
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  return bytes.subarray(0, offset);
}

async function cleanupCaptureFile(
  access: StackChanCaptureFileAccess,
  handle: StackChanCaptureFileHandle,
  realCapturePath: string
): Promise<boolean> {
  let failed = false;
  try {
    await handle.close();
  } catch {
    failed = true;
  }
  try {
    await access.unlink(realCapturePath);
  } catch {
    failed = true;
  }

  return failed;
}

async function readStackChanHeadPose(client: StackChanMcpClient): Promise<StackChanHeadPose> {
  const result = await callStackChanTool(client, "get_head_angles", {});
  requireSuccessfulToolResult(result, "get_head_angles");
  const yaw = findNumberField(result, "yaw");
  const pitch = findNumberField(result, "pitch");

  if (
    yaw === undefined ||
    pitch === undefined ||
    !isBoundedInteger(yaw, -90, 90) ||
    !isBoundedInteger(pitch, 5, 85)
  ) {
    throw new Error("StackChan get_head_angles returned invalid pose");
  }

  return { yaw, pitch };
}

async function moveStackChanHead(
  client: StackChanMcpClient,
  pose: StackChanHeadPose,
  motion: StackChanHeadMotion | undefined
): Promise<void> {
  requireBoundedInteger(pose.yaw, "yaw", -90, 90);
  requireBoundedInteger(pose.pitch, "pitch", 5, 85);
  const arguments_: Record<string, unknown> = {
    yaw: pose.yaw,
    pitch: pose.pitch
  };
  if (motion !== undefined) {
    requireBoundedInteger(motion.speedDps, "speedDps", 15, 240);
    arguments_.speed = motion.speedDps;
  }
  const result = await callStackChanTool(client, "move_head", arguments_);
  requireSuccessfulToolResult(result, "move_head");
}

type StackChanInternalToolName = "take_photo" | "get_head_angles" | "move_head" | "camera_stream";

async function connectStackChanMcp(client: StackChanMcpClient): Promise<void> {
  try {
    await client.connect();
  } catch {
    throw new Error("StackChan MCP connect failed");
  }
}

async function callStackChanTool(
  client: StackChanMcpClient,
  name: StackChanInternalToolName,
  arguments_: Record<string, unknown>
): Promise<unknown> {
  try {
    return await client.callTool({
      name,
      arguments: arguments_
    });
  } catch {
    throw new Error(`StackChan ${name} failed`);
  }
}

function requireSuccessfulToolResult(result: unknown, toolName: string): void {
  if (
    (isRecord(result) && result.isError === true) ||
    findStringField(result, "error") !== undefined
  ) {
    throw new Error(`StackChan ${toolName} failed`);
  }
}

function findStringField(value: unknown, field: string, depth = 0): string | undefined {
  const found = findField(value, field, depth);
  return typeof found === "string" && found.trim() !== "" ? found : undefined;
}

function findNumberField(value: unknown, field: string): number | undefined {
  const found = findField(value, field, 0);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function findField(value: unknown, field: string, depth: number): unknown {
  if (depth > 12) {
    return undefined;
  }
  if (typeof value === "string") {
    return findField(parseJson(value), field, depth + 1);
  }
  if (Array.isArray(value)) {
    return findFieldInArray(value, field, depth + 1);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (Object.hasOwn(value, field)) {
    return value[field];
  }

  return findFieldInArray(Object.values(value), field, depth + 1);
}

function findFieldInArray(values: readonly unknown[], field: string, depth: number): unknown {
  for (const value of values) {
    const found = findField(value, field, depth);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function requireCapturePath(path: string, captureRoot: string): void {
  const root = resolve(captureRoot);
  const candidate = resolve(path);
  const pathFromRoot = relative(root, candidate);

  if (
    !isAbsolute(path) ||
    pathFromRoot === "" ||
    pathFromRoot !== basename(candidate) ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("StackChan capture path is outside the allowed directory");
  }
}

function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

function requireBoundedInteger(
  value: number,
  label: "yaw" | "pitch" | "speedDps",
  minimum: number,
  maximum: number
): void {
  if (!isBoundedInteger(value, minimum, maximum)) {
    throw new Error(`StackChan ${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
