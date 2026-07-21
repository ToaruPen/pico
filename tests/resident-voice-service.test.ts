import { describe, expect, it } from "vitest";

import { definePicoConfig, type PicoResidentControlConfig } from "../src/config/index.js";
import {
  createResidentVoiceService,
  createResidentVoiceServiceController
} from "../src/runtime/resident-voice-service.js";
import type { PiAgentTurnClient } from "../src/runtime/voice-resident.js";

describe("resident voice service controller", () => {
  it("builds operator controls from the injected resident config", () => {
    const config = definePicoConfig({
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avaudioengine",
            deviceUid: "BuiltInMicrophoneDevice"
          },
          audioOutput: { provider: "ffplay", route: "system_default" },
          control: {
            provider: "macos_resident_io",
            keyboard: { provider: "macos", talkKey: "F13", cancelKey: "F14" }
          }
        },
        stt: {
          appleSpeech: { localBaseUrl: "http://127.0.0.1:8766" }
        },
        tts: {
          aivis: {
            id: "local-aivis",
            localBaseUrl: "http://127.0.0.1:10101",
            speakerId: 1,
            timeoutMs: 250
          }
        }
      }
    });
    const piAgent: PiAgentTurnClient = {
      prompt: () => Promise.resolve({ text: "unused" })
    };
    let receivedKeyboard: PicoResidentControlConfig["keyboard"] | undefined;

    expect(() =>
      createResidentVoiceService({
        config,
        createOperator: (keyboard) => {
          receivedKeyboard = keyboard;
          return { record() {} };
        },
        createPiAgent: () => piAgent,
        onError() {}
      })
    ).not.toThrow();
    expect(receivedKeyboard).toBe(config.voice.resident.control?.keyboard);
  });

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

  it("does not report a runtime rejection caused by intentional shutdown", async () => {
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
    const stop = controller.stop();
    failRuntime?.(new Error("shutdown interrupted runtime"));
    await stop;

    expect(events).toEqual(["release"]);
  });

  it("reports an unexpected successful runtime exit before releasing the lock", async () => {
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtimeResult = new Promise<void>((resolve) => {
      finishRuntime = resolve;
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
    finishRuntime?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["error:resident voice runtime exited unexpectedly", "release"]);
  });

  it("keeps the lock after shutdown timeout until the runtime actually exits", async () => {
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtimeResult = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const controller = createResidentVoiceServiceController({
      shutdownGraceMs: 1,
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

    await expect(controller.stop()).rejects.toThrow("shutdown exceeded 1 ms");
    expect(events).toEqual([]);

    finishRuntime?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["release"]);
  });
});
