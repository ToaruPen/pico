import { isIPv4 } from "node:net";

import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const cameraModuleMetadata = {
  kind: "camera",
  status: "planned",
  summary: "Snapshot-oriented camera access through RTSP, with ONVIF only when PTZ is needed.",
  capabilities: []
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

type RtspUrlParts = {
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly stream: string;
  readonly port: number;
};

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "RTSP snapshot capture failed";
}
