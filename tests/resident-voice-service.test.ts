import { describe, expect, it } from "vitest";

import { createResidentVoiceServiceController } from "../src/runtime/resident-voice-service.js";

describe("resident voice service controller", () => {
  it("starts one runtime and releases its lock after shutdown drains", async () => {
    const events: string[] = [];
    let runtimeSignal: AbortSignal | undefined;
    let finishRuntime: (() => void) | undefined;
    const runtimeBarrier = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const controller = createResidentVoiceServiceController({
      shutdownGraceMs: 1_000,
      acquireLock: () => {
        events.push("lock");
        return {
          release: () => {
            events.push("release");
          }
        };
      },
      startRuntime: (signal) => {
        events.push("runtime");
        runtimeSignal = signal;
        return runtimeBarrier;
      },
      onError: (error) => {
        events.push(`error:${error.message}`);
      }
    });

    await controller.start();
    await controller.start();

    expect(events).toEqual(["lock", "runtime"]);
    expect(runtimeSignal?.aborted).toBe(false);

    let stopped = false;
    const stop = Promise.resolve(controller.stop()).then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(runtimeSignal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(events).toEqual(["lock", "runtime"]);

    finishRuntime?.();
    await stop;
    await controller.stop();

    expect(events).toEqual(["lock", "runtime", "release"]);
  });

  it("reports a runtime failure and still releases the owned lock", async () => {
    const events: string[] = [];
    let failRuntime: ((error: Error) => void) | undefined;
    const runtimeResult = new Promise<void>((_resolve, reject) => {
      failRuntime = reject;
    });
    const controller = createResidentVoiceServiceController({
      shutdownGraceMs: 1_000,
      acquireLock: () => ({
        release: () => {
          events.push("release");
        }
      }),
      startRuntime: () => runtimeResult,
      onError: (error) => {
        events.push(`error:${error.message}`);
      }
    });

    await controller.start();
    failRuntime?.(new Error("runtime failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["error:runtime failed", "release"]);
    await controller.stop();
    expect(events).toEqual(["error:runtime failed", "release"]);
  });
});
