import { describe, expect, it } from "vitest";

import type { ResidentIoMessage } from "../src/runtime/resident-io-protocol.js";
import { createResidentHealthPublicationGate } from "../src/runtime/resident-health-publication.js";

type ResidentHealthEvent = Extract<ResidentIoMessage, { kind: "health_event" }>;

describe("resident health publication", () => {
  it("publishes healthy state initially and once per sixty-second cadence", () => {
    const gate = createResidentHealthPublicationGate();

    expect(gate.accept(healthEvent(), 0)).toBe(true);
    expect(gate.accept(healthEvent({ droppedFrameCount: 1 }), 1_000)).toBe(false);
    expect(
      gate.accept(
        healthEvent({
          droppedFrameCount: 20,
          outsidePttDroppedFrameCount: 20
        }),
        59_999
      )
    ).toBe(false);
    expect(gate.accept(healthEvent({ droppedFrameCount: 21 }), 60_000)).toBe(true);
    expect(gate.accept(healthEvent({ droppedFrameCount: 22 }), 119_999)).toBe(false);
    expect(gate.accept(healthEvent({ droppedFrameCount: 23 }), 120_000)).toBe(true);
  });

  it("publishes restart and state changes immediately", () => {
    const gate = createResidentHealthPublicationGate();

    expect(gate.accept(healthEvent(), 0)).toBe(true);
    expect(gate.accept(healthEvent({ restartCount: 1, code: "engine_restarted" }), 1)).toBe(true);
    expect(
      gate.accept(healthEvent({ state: "recovering", code: "configuration_changed" }), 2)
    ).toBe(true);
    expect(gate.accept(healthEvent({ state: "recovering", code: "engine_stopped" }), 3)).toBe(
      true
    );
    expect(gate.accept(healthEvent({ code: "health_sample" }), 4)).toBe(true);
  });
});

function healthEvent(overrides: Partial<ResidentHealthEvent> = {}): ResidentHealthEvent {
  return {
    kind: "health_event",
    state: "running",
    code: "health_sample",
    restartCount: 0,
    droppedFrameCount: 0,
    bufferCadenceMs: 10,
    outsidePttDroppedFrameCount: 0,
    suppressedDroppedFrameCount: 0,
    ...overrides
  };
}
