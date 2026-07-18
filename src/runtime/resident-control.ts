import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ResidentControlEvent =
  | { readonly kind: "talk_pressed"; readonly occurredAt: string }
  | { readonly kind: "talk_released"; readonly occurredAt: string }
  | { readonly kind: "cancel_pressed"; readonly occurredAt: string };

export type ResidentControlResult = "accepted" | "ignored_busy" | "ignored_stale" | "noop";

export type ResidentControlHandler = (
  event: ResidentControlEvent
) => ResidentControlResult | Promise<ResidentControlResult>;

export type ResidentControlServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

export type LoopbackHttpResidentControlServerOptions = {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authTokenPath: string;
  readonly handle: ResidentControlHandler;
  readonly shutdownTimeoutMs: number;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
};

const controlPath = "/v1/resident-control/events";
const healthPath = "/v1/resident-control/health";
const maximumRequestBytes = 4096;
const maximumTimeoutMs = 2_147_483_647;
const controlKinds = new Set(["talk_pressed", "talk_released", "cancel_pressed"]);
const defaultNow = (): string => new Date().toISOString();

export async function createLoopbackHttpResidentControlServer(
  options: LoopbackHttpResidentControlServerOptions
): Promise<ResidentControlServer> {
  throwIfControlStartupAborted(options.signal);
  const token = readControlToken(options.authTokenPath);
  throwIfControlStartupAborted(options.signal);
  const shutdownTimeoutMs = requireShutdownTimeout(options.shutdownTimeoutMs);
  const now = options.now ?? defaultNow;
  const server = createServer((request, response) => {
    void handleControlRequest(request, response, token, now, options.handle).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { status: "internal_error" });
        return;
      }

      response.destroy();
    });
  });
  let closeOperation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    options.signal?.removeEventListener("abort", closeOnAbort);
    closeOperation ??= closeServer(server, shutdownTimeoutMs);
    return closeOperation;
  };
  const closeOnAbort = (): void => {
    void close().catch(() => undefined);
  };

  options.signal?.addEventListener("abort", closeOnAbort, { once: true });

  try {
    throwIfControlStartupAborted(options.signal);
    await listen(server, options.port, options.host);
    throwIfControlStartupAborted(options.signal);

    return {
      url: buildServerUrl(options.host, server.address()),
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  now: () => string,
  handle: ResidentControlHandler
): Promise<void> {
  const route = authorizeControlRoute(request, response, token);

  if (route === undefined) {
    return;
  }

  if (route === "health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  const kind = await readControlKind(request);

  if (kind === undefined) {
    writeJson(response, 400, { status: "invalid_request" });
    return;
  }

  const result = await handle({ kind, occurredAt: now() });
  writeJson(response, result === "accepted" ? 202 : 200, { status: result });
}

function authorizeControlRoute(
  request: IncomingMessage,
  response: ServerResponse,
  token: string
): "events" | "health" | undefined {
  if (request.url !== controlPath && request.url !== healthPath) {
    writeJson(response, 404, { status: "not_found" });
    return undefined;
  }

  const route = request.url === healthPath ? "health" : "events";
  const expectedMethod = route === "health" ? "GET" : "POST";

  if (request.method !== expectedMethod) {
    writeJson(response, 405, { status: "method_not_allowed" });
    return undefined;
  }

  if (request.headers.authorization !== `Bearer ${token}`) {
    writeJson(response, 401, { status: "unauthorized" });
    return undefined;
  }

  return route;
}

async function readControlKind(
  request: IncomingMessage
): Promise<ResidentControlEvent["kind"] | undefined> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array);
      byteLength += buffer.byteLength;

      if (byteLength > maximumRequestBytes) {
        return undefined;
      }

      chunks.push(buffer);
    }

    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;

    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.event !== "string") {
      return undefined;
    }

    return controlKinds.has(value.event)
      ? (value.event as ResidentControlEvent["kind"])
      : undefined;
  } catch {
    return undefined;
  }
}

function throwIfControlStartupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("pico resident control server startup was aborted");
  }
}

function requireShutdownTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumTimeoutMs) {
    throw new Error(
      `pico resident control shutdownTimeoutMs must be a positive integer <= ${maximumTimeoutMs}`
    );
  }

  return value;
}

function readControlToken(path: string): string {
  const descriptor = openControlTokenFile(path);

  try {
    const stat = fstatSync(descriptor);

    if (!stat.isFile()) {
      throw new Error("pico resident control token file must be a regular file");
    }

    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("pico resident control token file must have 0600 permissions");
    }

    const token = readFileSync(descriptor, "utf8").trim();

    if (token === "") {
      throw new Error("pico resident control token file must not be empty");
    }

    return token;
  } finally {
    closeSync(descriptor);
  }
}

function openControlTokenFile(path: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("pico resident control token file must not be a symbolic link", {
        cause: error
      });
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: "127.0.0.1" | "::1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };

    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server, shutdownTimeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      server.closeAllConnections();
    }, shutdownTimeoutMs);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);

      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function buildServerUrl(host: "127.0.0.1" | "::1", address: string | AddressInfo | null): string {
  if (address === null || typeof address === "string") {
    throw new Error("pico resident control server did not expose a TCP address");
  }

  return `http://${host === "::1" ? "[::1]" : host}:${String(address.port)}`;
}
