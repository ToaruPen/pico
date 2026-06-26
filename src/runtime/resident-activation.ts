import { readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { SessionStartTrigger } from "../modules/session/index.js";

export type ResidentActivationEvent = {
  readonly id: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly trigger: SessionStartTrigger;
};

export type ResidentActivationQueue = {
  readonly requestActivation: () => ResidentActivationRequestResult;
  readonly take: (input: { readonly now: string }) => ResidentActivationEvent | undefined;
};

export type ResidentActivationRequestResult =
  | {
      readonly status: "accepted";
      readonly activationId: string;
    }
  | {
      readonly status: "ignored_active" | "ignored_debounce";
    };

export type ResidentActivationServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

export type ResidentActivationQueueOptions = {
  readonly debounceMs: number;
  readonly activationWindowMs: number;
  readonly now?: () => string;
};

export type LoopbackHttpResidentActivationServerOptions = {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authTokenPath: string;
  readonly queue: ResidentActivationQueue;
  readonly signal?: AbortSignal;
};

const defaultNow = (): string => new Date().toISOString();
const activationPath = "/v1/resident-voice/activate";

export function createResidentActivationQueue(
  options: ResidentActivationQueueOptions
): ResidentActivationQueue {
  const now = options.now ?? defaultNow;
  let pending: ResidentActivationEvent | undefined;
  let lastAcceptedAtMs: number | undefined;
  let nextActivationNumber = 1;

  return {
    requestActivation() {
      const occurredAt = now();
      const occurredAtMs = Date.parse(occurredAt);

      if (pending !== undefined && occurredAtMs > Date.parse(pending.expiresAt)) {
        pending = undefined;
      }

      if (pending !== undefined) {
        return { status: "ignored_active" };
      }

      if (lastAcceptedAtMs !== undefined && occurredAtMs - lastAcceptedAtMs < options.debounceMs) {
        return { status: "ignored_debounce" };
      }

      const id = `activation-${String(nextActivationNumber)}`;
      nextActivationNumber += 1;
      lastAcceptedAtMs = occurredAtMs;
      pending = {
        id,
        occurredAt,
        expiresAt: addMilliseconds(occurredAt, options.activationWindowMs),
        trigger: {
          kind: "button_trigger",
          label: "push_to_talk",
          source: "loopback_http"
        }
      };

      return {
        status: "accepted",
        activationId: id
      };
    },
    take(input) {
      if (pending === undefined) {
        return undefined;
      }

      const activation = pending;
      pending = undefined;

      if (Date.parse(input.now) > Date.parse(activation.expiresAt)) {
        return undefined;
      }

      return activation;
    }
  };
}

export async function createLoopbackHttpResidentActivationServer(
  options: LoopbackHttpResidentActivationServerOptions
): Promise<ResidentActivationServer> {
  const token = readActivationToken(options.authTokenPath);
  const server = createServer((request, response) => {
    if (request.url !== activationPath) {
      writeJson(response, 404, { status: "not_found" });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { status: "method_not_allowed" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${token}`) {
      writeJson(response, 401, { status: "unauthorized" });
      return;
    }

    const result = options.queue.requestActivation();
    writeJson(response, result.status === "accepted" ? 202 : 200, result);
  });

  if (options.signal !== undefined) {
    options.signal.addEventListener(
      "abort",
      () => {
        server.close();
      },
      { once: true }
    );
  }

  await listen(server, options.port, options.host);

  return {
    url: buildServerUrl(options.host, server.address()),
    close: () => close(server)
  };
}

function readActivationToken(path: string): string {
  const mode = statSync(path).mode & 0o777;

  if (mode !== 0o600) {
    throw new Error("pico resident activation token file must have 0600 permissions");
  }

  const token = readFileSync(path, "utf8").trim();

  if (token === "") {
    throw new Error("pico resident activation token file must not be empty");
  }

  return token;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: "127.0.0.1" | "::1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function buildServerUrl(host: "127.0.0.1" | "::1", address: string | AddressInfo | null): string {
  if (typeof address !== "object" || address === null) {
    throw new Error("pico resident activation server did not expose a TCP address");
  }

  const hostname = host === "::1" ? "[::1]" : host;

  return `http://${hostname}:${String(address.port)}`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
