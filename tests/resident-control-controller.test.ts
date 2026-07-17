import { describe, expect, it } from "vitest";

import {
  createResidentControlController,
  type ResidentControlScheduler,
  type ResidentControlState,
  type ResidentTurnGeneration
} from "../src/runtime/resident-control-controller.js";

describe("resident hold-to-talk control controller", () => {
  it("accepts one press, ignores keyboard repeat, and tails for exactly 250 ms", () => {
    const scheduler = createScheduler();
    const started: ResidentTurnGeneration[] = [];
    const tailReady: ResidentTurnGeneration[] = [];
    const controller = createResidentControlController({
      scheduler,
      onListen: (generation) => started.push(generation),
      onTailReady: (generation) => tailReady.push(generation)
    });

    expect(controller.handle(event("talk_pressed"))).toBe("accepted");
    expect(controller.state()).toBe("listening");
    expect(controller.handle(event("talk_pressed"))).toBe("noop");
    expect(started).toHaveLength(1);
    expect(controller.handle(event("talk_released"))).toBe("accepted");
    expect(controller.state()).toBe("tailing");
    expect(scheduler.delays()).toEqual([250]);

    scheduler.advance(249);
    expect(controller.state()).toBe("tailing");
    expect(tailReady).toEqual([]);
    scheduler.advance(1);
    expect(controller.state()).toBe("transcribing");
    expect(tailReady).toEqual(started);
  });

  it("ignores stale or repeated release events", () => {
    const controller = createResidentControlController();

    expect(controller.handle(event("talk_released"))).toBe("ignored_stale");
    expect(controller.handle(event("talk_pressed"))).toBe("accepted");
    expect(controller.handle(event("talk_released"))).toBe("accepted");
    expect(controller.handle(event("talk_released"))).toBe("noop");
  });

  it.each([
    "tailing",
    "transcribing",
    "processing",
    "synthesizing",
    "speaking",
    "cancelling"
  ] as const)("ignores talk while %s and never replays it", (state) => {
    const scheduler = createScheduler();
    const controller = createResidentControlController({ scheduler });
    const generation = beginAndReach(controller, scheduler, state);

    expect(controller.handle(event("talk_pressed"))).toBe("ignored_busy");
    expect(controller.completeCancellation(generation.id)).toBe(state === "cancelling");
    expect(controller.state()).toBe(state === "cancelling" ? "idle" : state);
  });

  it.each([
    "listening",
    "tailing",
    "transcribing",
    "processing",
    "synthesizing",
    "speaking"
  ] as const)("cancels idempotently from %s", (state) => {
    const scheduler = createScheduler();
    const cancelled: Array<{ state: ResidentControlState; generation: ResidentTurnGeneration }> =
      [];
    const controller = createResidentControlController({
      scheduler,
      onCancel: (generation, cancelledState) => {
        cancelled.push({ state: cancelledState, generation });
      }
    });
    const generation = beginAndReach(controller, scheduler, state);

    expect(controller.handle(event("cancel_pressed"))).toBe("accepted");
    expect(controller.state()).toBe("cancelling");
    expect(generation.signal.aborted).toBe(true);
    expect(controller.handle(event("cancel_pressed"))).toBe("noop");
    expect(cancelled).toEqual([{ state, generation }]);
    expect(controller.completeCancellation(generation.id)).toBe(true);
    expect(controller.state()).toBe("idle");
  });

  it("suppresses completions from an invalid generation", () => {
    const controller = createResidentControlController();

    controller.handle(event("talk_pressed"));
    const first = controller.generation();
    expect(first).toBeDefined();
    controller.handle(event("cancel_pressed"));
    controller.completeCancellation(first?.id ?? -1);
    controller.handle(event("talk_pressed"));
    const second = controller.generation();

    expect(controller.advance(first?.id ?? -1, "listening", "transcribing")).toBe(false);
    expect(controller.generation()).toBe(second);
    expect(controller.state()).toBe("listening");
  });

  it("makes error and stopped terminal", () => {
    const controller = createResidentControlController();

    controller.handle(event("talk_pressed"));
    const generation = controller.generation();
    controller.fail(generation?.id);
    expect(controller.state()).toBe("error");
    expect(controller.handle(event("talk_pressed"))).toBe("ignored_busy");
    expect(controller.handle(event("cancel_pressed"))).toBe("noop");

    controller.stop();
    expect(controller.state()).toBe("stopped");
    expect(controller.handle(event("talk_pressed"))).toBe("ignored_busy");
  });
});

function event(kind: "talk_pressed" | "talk_released" | "cancel_pressed") {
  return { kind, occurredAt: "2026-07-17T00:00:00.000Z" } as const;
}

function beginAndReach(
  controller: ReturnType<typeof createResidentControlController>,
  scheduler: ReturnType<typeof createScheduler>,
  state: Exclude<ResidentControlState, "idle" | "error" | "stopped">
): ResidentTurnGeneration {
  controller.handle(event("talk_pressed"));
  const generation = controller.generation();

  if (generation === undefined) {
    throw new Error("test generation was not created");
  }

  if (state === "listening") {
    return generation;
  }

  controller.handle(event("talk_released"));

  if (state === "tailing") {
    return generation;
  }

  scheduler.advance(250);

  if (state === "transcribing") {
    return generation;
  }

  if (state === "cancelling") {
    controller.handle(event("cancel_pressed"));
    return generation;
  }

  const stages = ["processing", "synthesizing", "speaking"] as const;
  let current: ResidentControlState = "transcribing";

  for (const next of stages) {
    controller.advance(generation.id, current, next);
    current = next;

    if (state === next) {
      return generation;
    }
  }

  throw new Error(`test could not reach ${state}`);
}

function createScheduler(): ResidentControlScheduler & {
  readonly advance: (milliseconds: number) => void;
  readonly delays: () => readonly number[];
} {
  let now = 0;
  const operations: Array<{
    readonly dueAt: number;
    readonly operation: () => void;
    cancelled: boolean;
  }> = [];
  const delays: number[] = [];

  return {
    schedule(delayMs, operation) {
      const item = { dueAt: now + delayMs, operation, cancelled: false };
      delays.push(delayMs);
      operations.push(item);

      return {
        cancel() {
          item.cancelled = true;
        }
      };
    },
    advance(milliseconds) {
      now += milliseconds;

      for (const item of operations) {
        if (!item.cancelled && item.dueAt <= now) {
          item.cancelled = true;
          item.operation();
        }
      }
    },
    delays: () => [...delays]
  };
}
