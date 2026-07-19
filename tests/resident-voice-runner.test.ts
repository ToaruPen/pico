import { describe, expect, it } from "vitest";

import type {
  OpenTelemetryProviderOptions,
  PicoTelemetry
} from "../src/modules/telemetry/index.js";
import type { ResidentControlHandler } from "../src/runtime/resident-control.js";
import {
  createConfiguredOpenTelemetry,
  requireResidentVoiceEnabled,
  runResidentControlLifecycle,
  shutdownResidentVoiceTelemetry,
  waitForDirectResidentVoiceRuntime
} from "../src/runtime/resident-voice-runner.js";

describe("resident voice runner ownership", () => {
  it("constructs OpenTelemetry only when enabled", async () => {
    const constructed: string[] = [];
    const createTelemetry = (options: OpenTelemetryProviderOptions): PicoTelemetry => {
      constructed.push(options.serviceName);
      return {
        record: () => undefined,
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
        health: () => ({
          logs: { consecutiveFailures: 0 },
          metrics: { consecutiveFailures: 0 }
        })
      };
    };

    expect(createConfiguredOpenTelemetry({ enabled: false }, createTelemetry)).toBeUndefined();
    const telemetry = createConfiguredOpenTelemetry(
      {
        enabled: true,
        baseUrl: "http://127.0.0.1:4318",
        serviceName: "pico-resident",
        timeoutMs: 10_000,
        metricExportIntervalMs: 15_000,
        shutdownTimeoutMs: 5_000
      },
      createTelemetry
    );

    expect(constructed).toEqual(["pico-resident"]);
    await expect(telemetry?.shutdown()).resolves.toBeUndefined();
  });

  it("contains telemetry shutdown failures to a bounded process diagnostic", async () => {
    const lines: string[] = [];

    await expect(
      shutdownResidentVoiceTelemetry(
        {
          record: () => undefined,
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.reject(new Error("collector shutdown failed")),
          health: () => ({
            logs: { consecutiveFailures: 1 },
            metrics: { consecutiveFailures: 1 }
          })
        },
        (line) => {
          lines.push(line);
        }
      )
    ).resolves.toBeUndefined();
    expect(lines).toEqual(["[pico] telemetry shutdown failed\n"]);
  });

  it("keeps the direct harness lock until a timed-out runtime actually settles", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
      },
      unregisterShutdownCleanup: () => {
        events.push("unregister");
      }
    });

    abortController.abort();

    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");
    expect(events).toEqual(["unregister"]);

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["unregister", "release"]);
  });

  it("releases the direct harness lock once when the runtime rejects", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.reject(new Error("runtime failed")),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("runtime failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("reports a direct harness lock release failure", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.resolve(),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
          throw new Error("release failed");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("release failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("does not leak a late lock release failure after shutdown timeout", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
        throw new Error("late release failed");
      },
      unregisterShutdownCleanup: () => undefined
    });

    abortController.abort();
    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["release"]);
  });

  it("starts the server, runtime, and bridge in order and shuts them down in reverse", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let serverHandler: ResidentControlHandler | undefined;
    const lifecycle = runResidentControlLifecycle({
      signal: abortController.signal,
      startServer: (handle) => {
        events.push("server:start");
        serverHandler = handle;
        return Promise.resolve({
          url: "http://127.0.0.1:43127",
          close: () => {
            events.push("server:close");
            return Promise.resolve();
          }
        });
      },
      createRuntime: () => {
        events.push("runtime:start");
        return {
          handleControl: () => Promise.resolve("accepted"),
          state: () => "idle",
          completion: new Promise(() => undefined),
          stop: () => {
            events.push("runtime:stop");
            return Promise.resolve();
          }
        };
      },
      startBridge: () => {
        events.push("bridge:start");
        return Promise.resolve({
          completion: new Promise(() => undefined),
          close: () => {
            events.push("bridge:close");
            return Promise.resolve();
          }
        });
      }
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["server:start", "runtime:start", "bridge:start"]);
    await expect(
      serverHandler?.({ kind: "talk_pressed", occurredAt: "2026-07-17T00:00:00.000Z" })
    ).resolves.toBe("accepted");

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
    expect(events).toEqual([
      "server:start",
      "runtime:start",
      "bridge:start",
      "runtime:stop",
      "bridge:close",
      "server:close"
    ]);
  });

  it("fails closed and cleans up when the managed bridge exits", async () => {
    const events: string[] = [];
    let rejectBridge: (error: Error) => void = () => undefined;
    const bridgeCompletion = new Promise<void>((_resolve, reject) => {
      rejectBridge = reject;
    });
    const lifecycle = runResidentControlLifecycle({
      signal: new AbortController().signal,
      startServer: () =>
        Promise.resolve({
          url: "http://127.0.0.1:43127",
          close: () => {
            events.push("server:close");
            return Promise.resolve();
          }
        }),
      createRuntime: () => ({
        handleControl: () => Promise.resolve("accepted"),
        state: () => "idle",
        completion: new Promise(() => undefined),
        stop: () => {
          events.push("runtime:stop");
          return Promise.resolve();
        }
      }),
      startBridge: () =>
        Promise.resolve({
          completion: bridgeCompletion,
          close: () => {
            events.push("bridge:close");
            return Promise.reject(new Error("bridge close also failed"));
          }
        })
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    rejectBridge(new Error("event tap stopped"));

    await expect(lifecycle).rejects.toThrow("event tap stopped");
    expect(events).toEqual(["runtime:stop", "bridge:close", "server:close"]);
  });

  it("requires the immutable control contract when resident voice is enabled", () => {
    expect(() =>
      requireResidentVoiceEnabled({
        voice: { resident: { enabled: true } }
      } as never)
    ).toThrow("pico resident voice runtime requires voice.resident.control config");
  });
});
