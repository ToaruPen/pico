import { loadPicoConfigFromEnvironment } from "../config/index.js";
import type { ResidentVoiceController } from "./pico-runtime-profile.js";
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
  readonly piAgent: PiAgentTurnClient;
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
        piAgent: options.piAgent
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
        runtimeCompletion = options.startRuntime(abortController.signal).then(
          () => {
            releaseLock();
          },
          (error: unknown) => {
            options.onError(error instanceof Error ? error : new Error(String(error)));
            releaseLock();
          }
        );
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
      ).finally(() => {
        releaseLock();
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
