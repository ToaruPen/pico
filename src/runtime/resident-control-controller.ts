import type { ResidentControlEvent, ResidentControlResult } from "./resident-control.js";

export type ResidentControlState =
  | "idle"
  | "listening"
  | "tailing"
  | "transcribing"
  | "processing"
  | "synthesizing"
  | "speaking"
  | "cancelling"
  | "error"
  | "stopped";

export type ResidentTurnGeneration = {
  readonly id: number;
  readonly signal: AbortSignal;
};

export type ResidentControlScheduler = {
  readonly schedule: (delayMs: number, operation: () => void) => { readonly cancel: () => void };
};

export type ResidentControlController = {
  readonly state: () => ResidentControlState;
  readonly generation: () => ResidentTurnGeneration | undefined;
  readonly handle: (event: ResidentControlEvent) => ResidentControlResult;
  readonly advance: (
    generationId: number,
    expected: ResidentControlState,
    next: ResidentControlState
  ) => boolean;
  readonly finish: (generationId: number, expected: ResidentControlState) => boolean;
  readonly completeCancellation: (generationId: number) => boolean;
  readonly fail: (generationId?: number) => boolean;
  readonly stop: () => void;
};

export type ResidentControlControllerOptions = {
  readonly scheduler?: ResidentControlScheduler;
  readonly onListen?: (generation: ResidentTurnGeneration) => void;
  readonly onTailReady?: (generation: ResidentTurnGeneration) => void;
  readonly onCancel?: (
    generation: ResidentTurnGeneration,
    cancelledState: ResidentControlState
  ) => void;
  readonly onTransition?: (input: {
    readonly from: ResidentControlState;
    readonly to: ResidentControlState;
  }) => void;
};

type OwnedGeneration = {
  readonly value: ResidentTurnGeneration;
  readonly abortController: AbortController;
};

const releaseTailMs = 250;

export function createResidentControlController(
  options: ResidentControlControllerOptions = {}
): ResidentControlController {
  const scheduler = options.scheduler ?? defaultScheduler;
  let currentState: ResidentControlState = "idle";
  let currentGeneration: OwnedGeneration | undefined;
  let releaseTimer: { readonly cancel: () => void } | undefined;
  let nextGenerationId = 1;

  const clearReleaseTimer = (): void => {
    releaseTimer?.cancel();
    releaseTimer = undefined;
  };
  const enterError = (error: unknown): void => {
    clearReleaseTimer();
    currentGeneration?.abortController.abort(error);
    currentState = "error";
  };
  const transition = (next: ResidentControlState): void => {
    const from = currentState;
    currentState = next;

    try {
      options.onTransition?.({ from, to: next });
    } catch (error) {
      enterError(error);
      throw error;
    }
  };
  const clearGeneration = (): void => {
    clearReleaseTimer();
    currentGeneration = undefined;
  };
  const matches = (generationId: number, expected: ResidentControlState): boolean =>
    currentGeneration?.value.id === generationId && currentState === expected;
  const returnToIdle = (): void => {
    clearGeneration();
    transition("idle");
  };
  const handleTalkPressed = (): ResidentControlResult => {
    if (currentState === "listening") {
      return "noop";
    }

    if (currentState !== "idle") {
      return "ignored_busy";
    }

    const abortController = new AbortController();
    const generation = Object.freeze({
      id: nextGenerationId,
      signal: abortController.signal
    });
    nextGenerationId += 1;
    currentGeneration = { value: generation, abortController };
    transition("listening");

    try {
      options.onListen?.(generation);
    } catch (error) {
      enterError(error);
      throw error;
    }

    return "accepted";
  };
  const handleTalkReleased = (): ResidentControlResult => {
    if (currentState === "tailing") {
      return "noop";
    }

    if (currentState !== "listening" || currentGeneration === undefined) {
      return "ignored_stale";
    }

    const generation = currentGeneration.value;
    transition("tailing");
    releaseTimer = scheduler.schedule(releaseTailMs, () => {
      releaseTimer = undefined;

      if (!matches(generation.id, "tailing")) {
        return;
      }

      transition("transcribing");

      try {
        options.onTailReady?.(generation);
      } catch (error) {
        enterError(error);
      }
    });

    return "accepted";
  };
  const handleCancelPressed = (): ResidentControlResult => {
    if (
      currentState === "idle" ||
      currentState === "cancelling" ||
      currentState === "error" ||
      currentState === "stopped" ||
      currentGeneration === undefined
    ) {
      return "noop";
    }

    const cancelledState = currentState;
    const generation = currentGeneration.value;
    clearReleaseTimer();
    transition("cancelling");
    currentGeneration.abortController.abort(
      new Error(`pico resident turn cancelled during ${cancelledState}`)
    );

    try {
      options.onCancel?.(generation, cancelledState);
    } catch (error) {
      enterError(error);
      throw error;
    }

    return "accepted";
  };

  return {
    state: () => currentState,
    generation: () => currentGeneration?.value,
    handle(event) {
      switch (event.kind) {
        case "talk_pressed":
          return handleTalkPressed();
        case "talk_released":
          return handleTalkReleased();
        case "cancel_pressed":
          return handleCancelPressed();
      }
    },
    advance(generationId, expected, next) {
      if (!matches(generationId, expected)) {
        return false;
      }

      transition(next);
      return true;
    },
    finish(generationId, expected) {
      if (!matches(generationId, expected)) {
        return false;
      }

      returnToIdle();
      return true;
    },
    completeCancellation(generationId) {
      if (!matches(generationId, "cancelling")) {
        return false;
      }

      returnToIdle();
      return true;
    },
    fail(generationId) {
      if (
        currentState === "stopped" ||
        (generationId !== undefined && currentGeneration?.value.id !== generationId)
      ) {
        return false;
      }

      clearReleaseTimer();
      currentGeneration?.abortController.abort(new Error("pico resident turn failed"));
      transition("error");
      return true;
    },
    stop() {
      clearReleaseTimer();
      currentGeneration?.abortController.abort(new Error("pico resident control stopped"));
      clearGeneration();
      transition("stopped");
    }
  };
}

const defaultScheduler: ResidentControlScheduler = {
  schedule(delayMs, operation) {
    const timer = setTimeout(operation, delayMs);
    timer.unref();

    return {
      cancel() {
        clearTimeout(timer);
      }
    };
  }
};
