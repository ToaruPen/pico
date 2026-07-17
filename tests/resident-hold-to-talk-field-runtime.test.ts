import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fieldTestState = vi.hoisted(() => ({
  handle: undefined as
    | ((event: { readonly kind: string; readonly occurredAt: string }) => string)
    | undefined,
  failNextCapture: false,
  starts: 0,
  captureCloses: 0,
  captureFrameCounts: [] as number[],
  serverFailure: undefined as Error | undefined,
  bridgeStartup: undefined as Promise<void> | undefined
}));

vi.mock("../src/config/index.js", () => ({
  loadPicoConfigFromEnvironment: () => ({
    voice: {
      resident: {
        enabled: true,
        shutdownGraceMs: 5_000,
        control: {
          provider: "loopback_http",
          host: "127.0.0.1",
          port: 8781,
          authTokenPath: "/tmp/pico-field-test-token",
          keyboard: {
            provider: "macos",
            talkKey: "F13",
            cancelKey: "F14"
          }
        }
      }
    }
  })
}));

vi.mock("../src/runtime/macos-control-bridge.js", () => ({
  startMacOSControlBridge: async () => {
    await fieldTestState.bridgeStartup;
    return {
      completion: new Promise<void>(() => undefined),
      close: () => Promise.resolve()
    };
  }
}));

vi.mock("../src/runtime/resident-control.js", () => ({
  createLoopbackHttpResidentControlServer: (options: {
    readonly handle: typeof fieldTestState.handle;
  }) => {
    fieldTestState.handle = options.handle;

    if (fieldTestState.serverFailure !== undefined) {
      return Promise.reject(fieldTestState.serverFailure);
    }

    return Promise.resolve({ close: () => Promise.resolve() });
  }
}));

vi.mock("../src/runtime/resident-audio-io.js", () => ({
  createResidentAudioCapture: () => ({
    start: () => {
      fieldTestState.starts += 1;
      let finish: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const fail = fieldTestState.failNextCapture;
      fieldTestState.failNextCapture = false;
      const frameCount = fieldTestState.captureFrameCounts.shift() ?? 1;

      return {
        frames: {
          async *[Symbol.asyncIterator]() {
            if (fail) {
              throw new Error("field capture failed");
            }

            for (let index = 0; index < frameCount; index += 1) {
              yield {};
            }

            await stopped;
          }
        },
        stop: () => {
          finish();
          return Promise.resolve();
        }
      };
    },
    close: () => {
      fieldTestState.captureCloses += 1;
      return Promise.resolve();
    }
  })
}));

import { runResidentHoldToTalkFieldValidation } from "../scripts/field/resident-hold-to-talk.js";

describe("resident hold-to-talk field runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fieldTestState.handle = undefined;
    fieldTestState.failNextCapture = false;
    fieldTestState.starts = 0;
    fieldTestState.captureCloses = 0;
    fieldTestState.captureFrameCounts = [];
    fieldTestState.serverFailure = undefined;
    fieldTestState.bridgeStartup = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a later hold after a completed metadata-only capture", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(250);
    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(500);

    await expect(validation).resolves.toMatchObject({
      completedHolds: 2,
      outcomes: { accepted: 4 }
    });
    expect(fieldTestState.starts).toBe(2);
  });

  it("does not record release timing for a rejected release after cancel", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("cancel_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("ignored_stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(validation).resolves.toMatchObject({
      cancelledHolds: 1,
      completedHolds: 1,
      holdDuration: { samples: 1 },
      releaseTailDuration: { samples: 1 }
    });
  });

  it("does not record release timing for a hold cancelled during tailing", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    expect(handle(control("cancel_pressed"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(0);

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(validation).resolves.toMatchObject({
      cancelledHolds: 1,
      completedHolds: 1,
      holdDuration: { samples: 1 },
      releaseTailDuration: { samples: 1 },
      cancellationDuration: { samples: 1 }
    });
  });

  it("fails immediately when capture collection rejects while held", async () => {
    fieldTestState.failNextCapture = true;
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("field capture failed");
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    await rejection;
  });

  it("observes capture failure while the macOS bridge is still starting", async () => {
    fieldTestState.failNextCapture = true;
    let finishBridgeStartup: () => void = () => undefined;
    fieldTestState.bridgeStartup = new Promise<void>((resolve) => {
      finishBridgeStartup = resolve;
    });
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("field capture failed");
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1);
    finishBridgeStartup();
    await rejection;
  });

  it("rejects a timeout with no completed audio capture", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    await waitForHandle();
    const rejection = expect(validation).rejects.toThrow(
      "pico hold-to-talk field validation observed no completed audio capture"
    );
    void rejection.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("requires frames from a completed hold instead of a cancelled hold", async () => {
    fieldTestState.captureFrameCounts = [0, 1];
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow(
      "pico hold-to-talk field validation observed no completed audio capture"
    );
    void rejection.catch(() => undefined);
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(250);

    expect(handle(control("talk_pressed"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(0);
    expect(handle(control("cancel_pressed"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(750);

    await rejection;
  });

  it("closes audio capture when the control server fails to start", async () => {
    fieldTestState.serverFailure = new Error("control server failed");

    await expect(
      runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false })
    ).rejects.toThrow("control server failed");
    expect(fieldTestState.captureCloses).toBe(1);
  });
});

async function waitForHandle(): Promise<NonNullable<typeof fieldTestState.handle>> {
  await vi.waitFor(() => expect(fieldTestState.handle).toBeTypeOf("function"));
  return fieldTestState.handle as NonNullable<typeof fieldTestState.handle>;
}

function control(kind: "talk_pressed" | "talk_released" | "cancel_pressed") {
  return { kind, occurredAt: "2026-07-17T00:00:00.000Z" } as const;
}
