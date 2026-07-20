import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fieldTestState = vi.hoisted(() => ({
  handle: undefined as
    | ((event: { readonly kind: string; readonly occurredAt: string }) => string)
    | undefined,
  failNextCapture: false,
  starts: 0,
  captureCloses: 0,
  captureFrameCounts: [] as number[],
  captureStopGate: undefined as Promise<void> | undefined,
  serverFailure: undefined as Error | undefined,
  bridgeCloseFailure: undefined as Error | undefined,
  bridgeCloses: 0,
  bridgeStartup: undefined as Promise<void> | undefined,
  captureCloseFailure: undefined as Error | undefined,
  fixtureStarts: 0,
  observeHealth: undefined as
    | ((event: {
        readonly state: "running" | "recovering" | "suspended";
        readonly code: string;
        readonly restartCount: number;
        readonly droppedFrameCount: number;
        readonly bufferCadenceMs: number;
        readonly outsidePttDroppedFrameCount: number;
        readonly suppressedDroppedFrameCount: number;
      }) => void)
    | undefined,
  observeTiming: undefined as
    | ((event: { readonly stage: string; readonly durationMs: number }) => void)
    | undefined,
  invalidateCapture: undefined as ((generation: number) => void) | undefined,
  observeUnexpectedPcmFrame: undefined as (() => void) | undefined
}));

vi.mock("../scripts/field/resident-audio-fixture.js", () => ({
  createResidentAudioFixtureCapture: () => ({
    start: () => {
      fieldTestState.fixtureStarts += 1;
      let finish: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        frames: {
          async *[Symbol.asyncIterator]() {
            yield {};
            await stopped;
          }
        },
        stop: () => {
          finish();
          return Promise.resolve();
        }
      };
    },
    close: () => Promise.resolve()
  })
}));

vi.mock("../src/config/index.js", () => ({
  loadPicoConfigFromEnvironment: () => ({
    voice: {
      resident: {
        enabled: true,
        shutdownGraceMs: 5_000,
        audioInput: {
          provider: "avaudioengine",
          deviceUid: "BuiltInMicrophoneDevice"
        },
        control: {
          provider: "macos_resident_io",
          keyboard: {
            provider: "macos",
            talkKey: "F13",
            cancelKey: "F14"
          }
        }
      },
      echoControl: { sampleRateHz: 16_000, channels: 1, frameMs: 10 }
    }
  })
}));

vi.mock("../src/runtime/macos-resident-io-bridge.js", () => ({
  startMacOSResidentIoBridge: async (options: {
    readonly handleControl: (event: {
      readonly kind: "talk_pressed" | "talk_released" | "cancel_pressed";
      readonly physicalTimestampNanoseconds: string;
    }) => { readonly result: string; readonly generation?: number };
    readonly handleTailComplete: (generation: number) => void;
    readonly observeHealth?: (event: {
      readonly state: "running" | "recovering" | "suspended";
      readonly code: string;
      readonly restartCount: number;
      readonly droppedFrameCount: number;
      readonly bufferCadenceMs: number;
      readonly outsidePttDroppedFrameCount: number;
      readonly suppressedDroppedFrameCount: number;
    }) => void;
    readonly observeTiming?: (event: {
      readonly stage: string;
      readonly durationMs: number;
    }) => void;
    readonly handleCaptureInvalidated?: (generation: number) => void;
    readonly observeUnexpectedPcmFrame?: () => void;
  }) => {
    await fieldTestState.bridgeStartup;

    if (fieldTestState.serverFailure !== undefined) {
      throw fieldTestState.serverFailure;
    }
    let generation: number | undefined;
    let nativeCaptureActive = false;
    fieldTestState.observeHealth = options.observeHealth;
    fieldTestState.observeTiming = options.observeTiming;
    fieldTestState.invalidateCapture = options.handleCaptureInvalidated;
    fieldTestState.observeUnexpectedPcmFrame = options.observeUnexpectedPcmFrame;
    options.observeHealth?.({
      state: "running",
      code: "engine_started",
      restartCount: 0,
      droppedFrameCount: 0,
      bufferCadenceMs: 10,
      outsidePttDroppedFrameCount: 0,
      suppressedDroppedFrameCount: 0
    });
    options.observeTiming?.({ stage: "engine_start", durationMs: 1 });
    const recordTalkAdmission = (acceptedGeneration: number | undefined): void => {
      generation = acceptedGeneration;
      options.observeTiming?.({ stage: "key_to_admission", durationMs: 1 });
      options.observeTiming?.({ stage: "admission_to_gate", durationMs: 1 });
      options.observeTiming?.({ stage: "gate_to_first_sample", durationMs: 1 });
      options.observeTiming?.({ stage: "first_sample_to_dispatch", durationMs: 1 });
    };
    const scheduleTailCompletion = (): void => {
      if (generation === undefined) return;
      const releasedGeneration = generation;
      setTimeout(() => {
        options.observeTiming?.({ stage: "release_to_tail_complete", durationMs: 250 });
        options.handleTailComplete(releasedGeneration);
      }, 250);
    };
    const recordAcceptedTalk = (result: string, acceptedGeneration: number | undefined): void => {
      if (result !== "accepted") return;
      recordTalkAdmission(acceptedGeneration);
      if (!nativeCaptureActive) options.observeUnexpectedPcmFrame?.();
    };
    fieldTestState.handle = (event) => {
      const outcome = options.handleControl({
        kind: event.kind as "talk_pressed" | "talk_released" | "cancel_pressed",
        physicalTimestampNanoseconds: "1"
      });
      if (outcome instanceof Promise) {
        throw new Error("unexpected asynchronous field control outcome");
      }
      switch (event.kind) {
        case "talk_pressed":
          recordAcceptedTalk(outcome.result, outcome.generation);
          break;
        case "talk_released":
          if (outcome.result === "accepted") scheduleTailCompletion();
          break;
        case "cancel_pressed":
          generation = undefined;
          break;
      }
      return outcome.result;
    };
    const audioCapture = {
      start: () => {
        fieldTestState.starts += 1;
        nativeCaptureActive = true;
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
          stop: async () => {
            await fieldTestState.captureStopGate;
            nativeCaptureActive = false;
            finish();
          }
        };
      },
      close: () => {
        fieldTestState.captureCloses += 1;
        return fieldTestState.captureCloseFailure === undefined
          ? Promise.resolve()
          : Promise.reject(fieldTestState.captureCloseFailure);
      }
    };
    return {
      audioCapture,
      completion: new Promise<void>(() => undefined),
      suppressCapture: () => Promise.resolve(),
      resumeCapture: () => Promise.resolve(),
      close: () => {
        fieldTestState.bridgeCloses += 1;
        return fieldTestState.bridgeCloseFailure === undefined
          ? Promise.resolve()
          : Promise.reject(fieldTestState.bridgeCloseFailure);
      }
    };
  }
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
    fieldTestState.captureStopGate = undefined;
    fieldTestState.serverFailure = undefined;
    fieldTestState.bridgeCloseFailure = undefined;
    fieldTestState.bridgeCloses = 0;
    fieldTestState.bridgeStartup = undefined;
    fieldTestState.captureCloseFailure = undefined;
    fieldTestState.fixtureStarts = 0;
    fieldTestState.observeHealth = undefined;
    fieldTestState.observeTiming = undefined;
    fieldTestState.invalidateCapture = undefined;
    fieldTestState.observeUnexpectedPcmFrame = undefined;
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

  it("settles a cancellation once when capture stop is already in progress", async () => {
    let allowCaptureStop: () => void = () => undefined;
    fieldTestState.captureStopGate = new Promise<void>((resolve) => {
      allowCaptureStop = resolve;
    });
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(250);
    expect(handle(control("cancel_pressed"))).toBe("accepted");
    allowCaptureStop();
    fieldTestState.captureStopGate = undefined;
    await vi.advanceTimersByTimeAsync(0);

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(750);

    await expect(validation).resolves.toMatchObject({
      cancelledHolds: 1,
      completedHolds: 1,
      frameCount: 2,
      captureStartupLatency: { samples: 2 },
      holdDuration: { samples: 1 },
      releaseTailDuration: { samples: 1 },
      cancellationDuration: { samples: 1 }
    });
  });

  it("fails immediately when capture collection rejects while held", async () => {
    fieldTestState.failNextCapture = true;
    fieldTestState.bridgeCloseFailure = new Error("resident I/O close also failed");
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("field capture failed");
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    await rejection;
  });

  it("does not admit controls until resident I/O startup completes", async () => {
    fieldTestState.failNextCapture = true;
    let finishBridgeStartup: () => void = () => undefined;
    fieldTestState.bridgeStartup = new Promise<void>((resolve) => {
      finishBridgeStartup = resolve;
    });
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("field capture failed");

    await vi.advanceTimersByTimeAsync(1);
    expect(fieldTestState.handle).toBeUndefined();
    finishBridgeStartup();
    const handle = await waitForHandle();
    expect(handle(control("talk_pressed"))).toBe("accepted");
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

  it("does not leak capture ownership when resident I/O fails to start", async () => {
    fieldTestState.serverFailure = new Error("resident I/O failed");

    await expect(
      runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false })
    ).rejects.toThrow("resident I/O failed");
    expect(fieldTestState.captureCloses).toBe(0);
  });

  it("fails instead of reporting PASS after a native recovery event", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow(
      "pico hold-to-talk field validation observed unhealthy resident I/O: engine_stopped"
    );
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    fieldTestState.observeHealth?.({
      state: "recovering",
      code: "engine_stopped",
      restartCount: 0,
      droppedFrameCount: 0,
      bufferCadenceMs: 10,
      outsidePttDroppedFrameCount: 0,
      suppressedDroppedFrameCount: 0
    });

    await rejection;
  });

  it("fails instead of reporting PASS after unexpected native PCM", async () => {
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow(
      "pico hold-to-talk field validation observed PCM without an active generation"
    );
    await waitForHandle();

    fieldTestState.observeUnexpectedPcmFrame?.();

    await rejection;
  });

  it("propagates a resident I/O close failure instead of reporting PASS", async () => {
    fieldTestState.bridgeCloseFailure = new Error("resident I/O close failed");
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("resident I/O close failed");
    void rejection.catch(() => undefined);
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
  });

  it("closes resident I/O even when capture cleanup fails", async () => {
    fieldTestState.captureCloseFailure = new Error("capture close failed");
    const validation = runResidentHoldToTalkFieldValidation({ durationMs: 1_000, help: false });
    const rejection = expect(validation).rejects.toThrow("capture close failed");
    void rejection.catch(() => undefined);
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fieldTestState.bridgeCloses).toBe(1);
  });

  it("drains native PCM while an audio fixture supplies validation frames", async () => {
    const validation = runResidentHoldToTalkFieldValidation({
      durationMs: 1_000,
      help: false,
      audioFixturePath: "/tmp/pico-field-fixture.pcm"
    });
    const handle = await waitForHandle();

    expect(handle(control("talk_pressed"))).toBe("accepted");
    expect(handle(control("talk_released"))).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(validation).resolves.toMatchObject({
      completedHolds: 1,
      unexpectedPcmFrames: 0
    });
    expect(fieldTestState.fixtureStarts).toBe(1);
    expect(fieldTestState.starts).toBe(1);
  });
});

async function waitForHandle(): Promise<NonNullable<typeof fieldTestState.handle>> {
  await vi.waitFor(() => expect(fieldTestState.handle).toBeTypeOf("function"));
  return fieldTestState.handle as NonNullable<typeof fieldTestState.handle>;
}

function control(kind: "talk_pressed" | "talk_released" | "cancel_pressed") {
  return { kind, occurredAt: "2026-07-17T00:00:00.000Z" } as const;
}
