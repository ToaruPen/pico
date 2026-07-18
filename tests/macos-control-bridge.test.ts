import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { PicoResidentControlConfig } from "../src/config/index.js";
import {
  type MacOSControlProcess,
  resolveMacOSControlExecutablePath,
  startMacOSControlBridge
} from "../src/runtime/macos-control-bridge.js";

describe("managed macOS resident control bridge", () => {
  it("resolves the package release executable independently of cwd", () => {
    expect(resolveMacOSControlExecutablePath()).toMatch(
      /sidecars\/macos-control\/\.build\/release\/pico-macos-control$/
    );
  });

  it("passes only control metadata, waits for ready, and stops with SIGTERM", async () => {
    const process = new ControlledProcess();
    const launches: Array<{ executable: string; arguments_: readonly string[] }> = [];
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: (executable, arguments_) => {
        launches.push({ executable, arguments_ });
        return process;
      }
    });

    process.stdout.write('{"event":"ready"}\n');
    const bridge = await starting;

    expect(launches).toEqual([
      {
        executable: resolveMacOSControlExecutablePath(),
        arguments_: [
          "--host",
          "127.0.0.1",
          "--port",
          "43127",
          "--token-path",
          "/tmp/pico-control-token",
          "--talk-key",
          "F13",
          "--cancel-key",
          "F14"
        ]
      }
    ]);
    expect(launches[0]?.arguments_).not.toContain("secret-token");

    const closing = bridge.close();
    expect(process.signals).toEqual(["SIGTERM"]);
    process.exit(0, "SIGTERM");
    await expect(closing).resolves.toBeUndefined();
    await expect(bridge.completion).resolves.toBeUndefined();
  });

  it("fails startup with bounded diagnostics when the bridge exits before ready", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: () => process
    });

    process.stderr.write("Input Monitoring permission is required\n");
    process.exit(1);

    await expect(starting).rejects.toThrow(
      "pico macOS control bridge exited before ready (code 1): Input Monitoring permission is required"
    );
  });

  it("keeps ownership until a readiness failure has terminated the child", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: () => process
    });
    const outcome = starting.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );

    process.stdout.write('{"event":"not-ready"}\n');

    expect(process.signals).toEqual(["SIGTERM"]);
    await expect(
      Promise.race([
        outcome,
        new Promise<string>((resolve) => setImmediate(() => resolve("still pending")))
      ])
    ).resolves.toBe("still pending");

    process.exit(0, "SIGTERM");
    await expect(outcome).resolves.toBe(
      "pico macOS control bridge emitted an invalid readiness line"
    );
  });

  it("settles a spawn failure when close follows error without exit", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: () => process
    });
    const outcome = starting.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );

    process.emit("error", new Error("spawn ENOENT"));
    process.close();

    try {
      await expect(
        Promise.race([
          outcome,
          new Promise<string>((resolve) => setImmediate(() => resolve("still pending")))
        ])
      ).resolves.toBe("pico macOS control bridge process failed: spawn ENOENT");
    } finally {
      process.exit();
      await starting.catch(() => undefined);
    }
  });

  it("reports an unexpected exit after readiness", async () => {
    const process = new ControlledProcess();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: () => process
    });
    process.stdout.write('{"event":"ready"}\n');
    const bridge = await starting;

    process.stderr.write("event tap was disabled\n");
    process.exit(2);

    await expect(bridge.completion).rejects.toThrow(
      "pico macOS control bridge exited unexpectedly (code 2): event tap was disabled"
    );
  });

  it("escalates close to SIGKILL and rejects when the child still does not exit", async () => {
    vi.useFakeTimers();
    const process = new ControlledProcess();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      spawnProcess: () => process
    });
    process.stdout.write('{"event":"ready"}\n');
    const bridge = await starting;
    const closing = bridge.close();
    const closeFailure = expect(closing).rejects.toThrow(
      "pico macOS control bridge did not stop after SIGKILL"
    );
    const completionFailure = expect(bridge.completion).rejects.toThrow(
      "pico macOS control bridge did not stop after SIGKILL"
    );
    void closeFailure.catch(() => undefined);
    void completionFailure.catch(() => undefined);

    try {
      expect(process.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await closeFailure;
      await completionFailure;
    } finally {
      process.exit(0, "SIGKILL");
      vi.useRealTimers();
    }
  });

  it("terminates startup when abort races process creation", async () => {
    const process = new ControlledProcess();
    const abortController = new AbortController();
    const starting = startMacOSControlBridge({
      control: controlConfig(),
      platform: "darwin",
      signal: abortController.signal,
      spawnProcess: () => {
        abortController.abort();
        return process;
      }
    });
    void starting.catch(() => undefined);

    try {
      expect(process.signals).toEqual(["SIGTERM"]);
    } finally {
      process.exit(0, "SIGTERM");
      await starting.catch(() => undefined);
    }
  });

  it("rejects unsupported platforms before spawning", async () => {
    let launches = 0;

    await expect(
      startMacOSControlBridge({
        control: controlConfig(),
        platform: "linux",
        spawnProcess: () => {
          launches += 1;
          return new ControlledProcess();
        }
      })
    ).rejects.toThrow("pico macOS control bridge requires macOS");
    expect(launches).toBe(0);
  });
});

function controlConfig(): PicoResidentControlConfig {
  return {
    provider: "loopback_http",
    host: "127.0.0.1",
    port: 43_127,
    authTokenPath: "/tmp/pico-control-token",
    keyboard: {
      provider: "macos",
      talkKey: "F13",
      cancelKey: "F14"
    }
  };
}

class ControlledProcess extends EventEmitter implements MacOSControlProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(code?: number, signal: NodeJS.Signals = "SIGTERM"): void {
    this.emit("exit", code, signal);
    this.close(code, signal);
  }

  close(code?: number, signal: NodeJS.Signals = "SIGTERM"): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}
