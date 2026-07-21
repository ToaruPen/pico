import { describe, expect, it } from "vitest";
import type { ResidentControlEvent } from "../src/runtime/resident-control.js";
import { createResidentControlController } from "../src/runtime/resident-control-controller.js";

describe("native resident control contract", () => {
  it("admits one physical press and requires its matching native tail boundary", () => {
    const controller = createResidentControlController();
    const press = physical("talk_pressed");
    const release = physical("talk_released");

    expect(controller.handle(press)).toBe("accepted");
    const generation = controller.generation()?.id;
    expect(controller.handle(release)).toBe("accepted");
    expect(controller.handle(tail(generation ?? -1))).toBe("accepted");
    expect(controller.state()).toBe("transcribing");
  });

  it("rejects a tail boundary from another generation", () => {
    const controller = createResidentControlController();

    controller.handle(physical("talk_pressed"));
    controller.handle(physical("talk_released"));

    expect(controller.handle(tail(99))).toBe("ignored_stale");
    expect(controller.state()).toBe("tailing");
  });

  it("cancels without accepting a later tail boundary", () => {
    const controller = createResidentControlController();

    controller.handle(physical("talk_pressed"));
    const generation = controller.generation()?.id ?? -1;
    controller.handle(physical("talk_released"));
    expect(controller.handle(physical("cancel_pressed"))).toBe("accepted");
    expect(controller.handle(tail(generation))).toBe("ignored_stale");
  });
});

function physical(kind: "talk_pressed" | "talk_released" | "cancel_pressed"): ResidentControlEvent {
  return { kind, occurredAt: "2026-07-20T00:00:00.000Z" };
}

function tail(generationId: number): ResidentControlEvent {
  return {
    kind: "tail_complete",
    generationId,
    occurredAt: "2026-07-20T00:00:00.250Z"
  };
}
