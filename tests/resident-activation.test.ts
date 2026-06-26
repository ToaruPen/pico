import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLoopbackHttpResidentActivationServer,
  createResidentActivationQueue,
  type ResidentActivationServer
} from "../src/runtime/resident-activation.js";

const servers: ResidentActivationServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("resident push-to-talk activation", () => {
  it("accepts only authorized loopback POST activation requests", async () => {
    const queue = createResidentActivationQueue({
      debounceMs: 800,
      activationWindowMs: 8_000,
      now: sequenceNow(["2026-06-27T00:00:00.000Z"])
    });
    const server = await startActivationServer(queue, "secret-token");

    const getResponse = await fetch(`${server.url}/v1/resident-voice/activate`);
    const noTokenResponse = await fetch(`${server.url}/v1/resident-voice/activate`, {
      method: "POST"
    });
    const acceptedResponse = await fetch(`${server.url}/v1/resident-voice/activate`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token"
      }
    });

    expect(getResponse.status).toBe(405);
    expect(noTokenResponse.status).toBe(401);
    expect(acceptedResponse.status).toBe(202);
    await expect(acceptedResponse.json()).resolves.toEqual({
      status: "accepted",
      activationId: "activation-1"
    });
    expect(queue.take({ now: "2026-06-27T00:00:01.000Z" })).toEqual({
      id: "activation-1",
      occurredAt: "2026-06-27T00:00:00.000Z",
      expiresAt: "2026-06-27T00:00:08.000Z",
      trigger: {
        kind: "button_trigger",
        label: "push_to_talk",
        source: "loopback_http"
      }
    });
  });

  it("debounces repeated button activations and ignores requests while one is pending", async () => {
    const queue = createResidentActivationQueue({
      debounceMs: 800,
      activationWindowMs: 8_000,
      now: sequenceNow([
        "2026-06-27T00:00:00.000Z",
        "2026-06-27T00:00:00.100Z",
        "2026-06-27T00:00:00.700Z"
      ])
    });
    const server = await startActivationServer(queue, "secret-token");

    const first = await postActivation(server, "secret-token");
    const pendingDuplicate = await postActivation(server, "secret-token");
    queue.take({ now: "2026-06-27T00:00:00.200Z" });
    const debounced = await postActivation(server, "secret-token");

    expect(first).toEqual({ status: "accepted", activationId: "activation-1" });
    expect(pendingDuplicate).toEqual({ status: "ignored_active" });
    expect(debounced).toEqual({ status: "ignored_debounce" });
  });

  it("expires pending activations before accepting the next button press", async () => {
    const queue = createResidentActivationQueue({
      debounceMs: 800,
      activationWindowMs: 1_000,
      now: sequenceNow(["2026-06-27T00:00:00.000Z", "2026-06-27T00:00:02.000Z"])
    });
    const server = await startActivationServer(queue, "secret-token");

    const first = await postActivation(server, "secret-token");
    const afterExpiredPending = await postActivation(server, "secret-token");

    expect(first).toEqual({ status: "accepted", activationId: "activation-1" });
    expect(afterExpiredPending).toEqual({ status: "accepted", activationId: "activation-2" });
    expect(queue.take({ now: "2026-06-27T00:00:02.100Z" })?.id).toBe("activation-2");
  });

  it("rejects activation token files that are readable by other users", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-activation-test-"));
    const authTokenPath = join(directory, "activation-token");

    writeFileSync(authTokenPath, "secret-token\n");
    chmodSync(authTokenPath, 0o644);

    await expect(
      createLoopbackHttpResidentActivationServer({
        host: "127.0.0.1",
        port: 0,
        authTokenPath,
        queue: createResidentActivationQueue({
          debounceMs: 800,
          activationWindowMs: 8_000,
          now: () => "2026-06-27T00:00:00.000Z"
        })
      })
    ).rejects.toThrow("pico resident activation token file must have 0600 permissions");
  });
});

async function startActivationServer(
  queue: ReturnType<typeof createResidentActivationQueue>,
  token: string
): Promise<ResidentActivationServer> {
  const directory = mkdtempSync(join(tmpdir(), "pico-activation-test-"));
  const authTokenPath = join(directory, "activation-token");

  writeFileSync(authTokenPath, `${token}\n`);
  chmodSync(authTokenPath, 0o600);

  const server = await createLoopbackHttpResidentActivationServer({
    host: "127.0.0.1",
    port: 0,
    authTokenPath,
    queue
  });

  servers.push(server);

  return server;
}

async function postActivation(server: ResidentActivationServer, token: string): Promise<unknown> {
  const response = await fetch(`${server.url}/v1/resident-voice/activate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  return response.json();
}

function sequenceNow(values: readonly string[]): () => string {
  const remaining = [...values];

  return () => remaining.shift() ?? values.at(-1) ?? "2026-06-27T00:00:00.000Z";
}
