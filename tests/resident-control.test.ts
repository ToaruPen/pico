import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLoopbackHttpResidentControlServer,
  type ResidentControlEvent,
  type ResidentControlHandler,
  type ResidentControlServer
} from "../src/runtime/resident-control.js";

const servers: ResidentControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("resident semantic control transport", () => {
  it("exposes an authenticated readiness endpoint for the managed key bridge", async () => {
    const server = await startControlServer({ handle: () => "accepted" });

    const unauthorized = await fetch(`${server.url}/v1/resident-control/health`);
    const ready = await fetch(`${server.url}/v1/resident-control/health`, {
      headers: { authorization: "Bearer secret-token" }
    });

    expect(unauthorized.status).toBe(401);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ok" });
  });

  it("delivers only authenticated semantic events directly to the handler", async () => {
    const received: ResidentControlEvent[] = [];
    const server = await startControlServer({
      handle: (event) => {
        received.push(event);
        return "accepted";
      }
    });

    const noToken = await postEvent(server, "talk_pressed");
    const accepted = await postEvent(server, "talk_pressed", "secret-token");

    expect(noToken.status).toBe(401);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ status: "accepted" });
    expect(received).toEqual([{ kind: "talk_pressed", occurredAt: "2026-07-17T00:00:00.000Z" }]);
  });

  it.each([
    ["talk_pressed", "ignored_busy"],
    ["talk_released", "ignored_stale"],
    ["cancel_pressed", "noop"]
  ] as const)("returns the %s handler outcome without queuing", async (event, outcome) => {
    let calls = 0;
    const server = await startControlServer({
      handle: () => {
        calls += 1;
        return outcome;
      }
    });

    const response = await postEvent(server, event, "secret-token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: outcome });
    expect(calls).toBe(1);
  });

  it("rejects invalid methods, paths, JSON, and event kinds", async () => {
    const server = await startControlServer({ handle: () => "accepted" });
    const headers = {
      authorization: "Bearer secret-token",
      "content-type": "application/json"
    };

    const wrongMethod = await fetch(`${server.url}/v1/resident-control/events`, { headers });
    const wrongPath = await fetch(`${server.url}/wrong`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "talk_pressed" })
    });
    const invalidJson = await fetch(`${server.url}/v1/resident-control/events`, {
      method: "POST",
      headers,
      body: "{"
    });
    const unknownEvent = await fetch(`${server.url}/v1/resident-control/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "activate" })
    });

    expect(wrongMethod.status).toBe(405);
    expect(wrongPath.status).toBe(404);
    expect(invalidJson.status).toBe(400);
    expect(unknownEvent.status).toBe(400);
  });

  it("rejects token files with unsafe permissions or symbolic links", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-control-test-"));
    const unsafePath = join(directory, "unsafe-token");
    const realPath = join(directory, "real-token");
    const linkPath = join(directory, "link-token");

    writeFileSync(unsafePath, "secret-token\n");
    chmodSync(unsafePath, 0o644);
    writeFileSync(realPath, "secret-token\n");
    chmodSync(realPath, 0o600);
    symlinkSync(realPath, linkPath);

    await expect(
      createLoopbackHttpResidentControlServer({
        host: "127.0.0.1",
        port: 0,
        authTokenPath: unsafePath,
        shutdownTimeoutMs: 1_000,
        handle: () => "accepted"
      })
    ).rejects.toThrow("pico resident control token file must have 0600 permissions");
    await expect(
      createLoopbackHttpResidentControlServer({
        host: "127.0.0.1",
        port: 0,
        authTokenPath: linkPath,
        shutdownTimeoutMs: 1_000,
        handle: () => "accepted"
      })
    ).rejects.toThrow("pico resident control token file must not be a symbolic link");
  });

  it("fails before reading the token when startup is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createLoopbackHttpResidentControlServer({
        host: "127.0.0.1",
        port: 0,
        authTokenPath: "/tmp/pico-missing-control-token",
        shutdownTimeoutMs: 1_000,
        handle: () => "accepted",
        signal: controller.signal
      })
    ).rejects.toThrow("pico resident control server startup was aborted");
  });

  it("closes a socket that starts listening after startup is aborted", async () => {
    const port = await reserveTcpPort();
    const directory = mkdtempSync(join(tmpdir(), "pico-control-test-"));
    const authTokenPath = join(directory, "control-token");
    writeFileSync(authTokenPath, "secret-token\n");
    chmodSync(authTokenPath, 0o600);
    const controller = new AbortController();
    const starting = createLoopbackHttpResidentControlServer({
      host: "127.0.0.1",
      port,
      authTokenPath,
      shutdownTimeoutMs: 1_000,
      handle: () => "accepted",
      signal: controller.signal
    });

    controller.abort();
    await expect(starting).rejects.toThrow("pico resident control server startup was aborted");

    const rebound = await bindTcpPort(port);
    await closeTcpServer(rebound);
  });

  it("shares an abort-triggered close and force-closes an active request at the deadline", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    let notifyStarted: () => void = () => undefined;
    let finishRequest: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const server = await startControlServer({
      signal: abortController.signal,
      shutdownTimeoutMs: 100,
      handle: async () => {
        notifyStarted();
        await requestGate;
        return "accepted" as const;
      }
    });
    const request = postEvent(server, "talk_pressed", "secret-token");
    void request.catch(() => undefined);
    await requestStarted;

    try {
      abortController.abort();
      const firstClose = server.close();
      const secondClose = server.close();
      let closed = false;
      void firstClose.then(
        () => {
          closed = true;
        },
        () => undefined
      );

      expect(firstClose).toBe(secondClose);
      await vi.advanceTimersByTimeAsync(99);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstClose).resolves.toBeUndefined();
      expect(closed).toBe(true);
      await expect(request).rejects.toThrow();
    } finally {
      finishRequest();
      vi.useRealTimers();
    }
  });
});

async function startControlServer(input: {
  readonly handle: ResidentControlHandler;
  readonly signal?: AbortSignal;
  readonly shutdownTimeoutMs?: number;
}): Promise<ResidentControlServer> {
  const directory = mkdtempSync(join(tmpdir(), "pico-control-test-"));
  const authTokenPath = join(directory, "control-token");

  writeFileSync(authTokenPath, "secret-token\n");
  chmodSync(authTokenPath, 0o600);

  const server = await createLoopbackHttpResidentControlServer({
    host: "127.0.0.1",
    port: 0,
    authTokenPath,
    handle: input.handle,
    now: () => "2026-07-17T00:00:00.000Z",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    shutdownTimeoutMs: input.shutdownTimeoutMs ?? 1_000
  });
  servers.push(server);

  return server;
}

function postEvent(
  server: ResidentControlServer,
  event: "talk_pressed" | "talk_released" | "cancel_pressed",
  token?: string
): Promise<Response> {
  return fetch(`${server.url}/v1/resident-control/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify({ event })
  });
}

async function reserveTcpPort(): Promise<number> {
  const server = await bindTcpPort(0);
  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeTcpServer(server);
    throw new Error("expected a TCP address");
  }

  await closeTcpServer(server);
  return address.port;
}

function bindTcpPort(port: number): Promise<TcpServer> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeTcpServer(server: TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
