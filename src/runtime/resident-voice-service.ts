import { loadPicoConfigFromEnvironment } from "../config/index.js";
import type { PiAgentTurnClientOptions } from "./pi-agent-turn.js";
import type { PicoController as ResidentVoiceController } from "./pico-startup.js";
import { acquireResidentSingleInstanceLock } from "./resident-single-instance-lock.js";
import {
  requireResidentVoiceEnabled,
  runResidentVoiceWithProviders
} from "./resident-voice-runner.js";
import type { PiAgentTurnClient } from "./voice-resident.js";

type ResidentVoiceServiceLock = {
  readonly release: () => void;
};

export type ResidentVoiceServiceControllerOptions = {
  readonly shutdownGraceMs: number;
  readonly acquireLock: () => ResidentVoiceServiceLock;
  readonly startRuntime: (signal: AbortSignal) => Promise<void>;
  readonly onError: (error: Error) => void;
};

export function createResidentVoiceService(options: {
  readonly createPiAgent: (options: PiAgentTurnClientOptions) => PiAgentTurnClient;
  readonly onError: (error: Error) => void;
}): ResidentVoiceController {
  const config = loadPicoConfigFromEnvironment();
  requireResidentVoiceEnabled(config);

  return createResidentVoiceServiceController({
    shutdownGraceMs: config.voice.resident.shutdownGraceMs,
    acquireLock: () =>
      acquireResidentSingleInstanceLock(config.voice.resident.singleInstanceLockPath),
    startRuntime: (signal) =>
      runResidentVoiceWithProviders({
        config,
        signal,
        createPiAgent: options.createPiAgent
      }),
    onError: options.onError
  });
}

export function createResidentVoiceServiceController(
  options: ResidentVoiceServiceControllerOptions
): ResidentVoiceController {
  let state: "idle" | "running" | "stopping" | "stopped" = "idle";
  let abortController: AbortController | undefined;
  let lock: ResidentVoiceServiceLock | undefined;
  let runtimeCompletion: Promise<void> | undefined;
  let stopOperation: Promise<void> | undefined;

  const releaseLock = (): void => {
    const currentLock = lock;

    if (currentLock === undefined) {
      return;
    }

    lock = undefined;
    currentLock.release();
  };
  const finishRuntime = (errorIfUnexpected: unknown): void => {
    const exitedUnexpectedly = state === "running";
    state = "stopped";

    if (exitedUnexpectedly) {
      options.onError(
        errorIfUnexpected instanceof Error
          ? errorIfUnexpected
          : new Error(String(errorIfUnexpected))
      );
    }

    releaseLock();
  };

  return {
    start() {
      if (state === "running") {
        return;
      }

      if (state !== "idle") {
        throw new Error("resident voice service cannot restart after shutdown");
      }

      state = "running";
      abortController = new AbortController();
      lock = options.acquireLock();

      try {
        runtimeCompletion = options.startRuntime(abortController.signal).then(() => {
          finishRuntime(new Error("resident voice runtime exited unexpectedly"));
        }, finishRuntime);
      } catch (error) {
        state = "stopped";
        releaseLock();
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    stop() {
      if (stopOperation !== undefined) {
        return stopOperation;
      }

      if (state === "idle" || state === "stopped") {
        state = "stopped";
        return;
      }

      state = "stopping";
      abortController?.abort();
      stopOperation = waitForRuntimeShutdown(
        runtimeCompletion ?? Promise.resolve(),
        options.shutdownGraceMs
      ).then(() => {
        state = "stopped";
      });

      return stopOperation;
    }
  };
}

function waitForRuntimeShutdown(operation: Promise<void>, shutdownGraceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`pico resident voice shutdown exceeded ${shutdownGraceMs} ms`));
    }, shutdownGraceMs);
    timeout.unref();

    operation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
