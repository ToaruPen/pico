#!/usr/bin/env jiti
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment } from "../../src/config/index.js";
import { startMacOSResidentIoBridge } from "../../src/runtime/macos-resident-io-bridge.js";
import type {
  ResidentAudioCapture,
  ResidentCaptureSession
} from "../../src/runtime/resident-audio-io.js";
import type { ResidentControlResult } from "../../src/runtime/resident-control.js";
import {
  createResidentControlController,
  type ResidentTurnGeneration
} from "../../src/runtime/resident-control-controller.js";
import type { ResidentIoTimingStage } from "../../src/runtime/resident-io-protocol.js";
import { createResidentAudioFixtureCapture } from "./resident-audio-fixture.js";

export type ResidentHoldToTalkArguments = {
  readonly durationMs: number;
  readonly help: boolean;
  readonly audioFixturePath?: string;
};

export type BoundedMetricSummary = {
  readonly samples: number;
  readonly minimumMs: number | undefined;
  readonly maximumMs: number | undefined;
  readonly meanMs: number | undefined;
};

export type ResidentHoldToTalkFieldReport = {
  readonly status: "passed";
  readonly durationMs: number;
  readonly outcomes: Readonly<Record<ResidentControlResult, number>>;
  readonly completedHolds: number;
  readonly cancelledHolds: number;
  readonly frameCount: number;
  readonly captureStartupLatency: BoundedMetricSummary;
  readonly holdDuration: BoundedMetricSummary;
  readonly releaseTailDuration: BoundedMetricSummary;
  readonly cancellationDuration: BoundedMetricSummary;
  readonly residentIoHealthEvents: number;
  readonly residentIoRestartCount: number;
  readonly residentIoDroppedFrameCount: number;
  readonly residentIoOutsidePttDroppedFrameCount: number;
  readonly residentIoSuppressedDroppedFrameCount: number;
  readonly residentIoBufferCadenceMs: number;
  readonly residentIoTiming: Readonly<Record<ResidentIoTimingStage, BoundedMetricSummary>>;
  readonly captureInvalidations: number;
  readonly unexpectedPcmFrames: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly rssBytes: number;
};

type ActiveCapture = {
  readonly generation: ResidentTurnGeneration;
  readonly session: ResidentCaptureSession;
  readonly pressedAtMs: number;
  collection: Promise<void>;
  frameCount: number;
  firstFrameAtMs: number | undefined;
  releasedAtMs: number | undefined;
  cancelledAtMs: number | undefined;
  operation: Promise<void> | undefined;
};

const defaultDurationMs = 30_000;
const maximumDurationMs = 300_000;
const requiredTimingStages = [
  "key_to_admission",
  "admission_to_gate",
  "gate_to_first_sample",
  "first_sample_to_dispatch",
  "release_to_tail_complete",
  "engine_start"
] as const satisfies readonly ResidentIoTimingStage[];
const unhealthyResidentIoCodes = new Set([
  "engine_restarted",
  "sleep",
  "wake",
  "configuration_changed",
  "engine_stopped",
  "audio_timeline_discontinuity",
  "audio_callback_overrun",
  "admission_timeout"
]);

type MutableResidentHoldToTalkArguments = {
  durationMs: number;
  audioFixturePath?: string;
};

const residentHoldToTalkArgumentReaders: Readonly<
  Record<string, (state: MutableResidentHoldToTalkArguments, value: string) => void>
> = {
  "--duration-ms": (state, value) => {
    state.durationMs = readDuration(value);
  },
  "--audio-fixture": (state, value) => {
    state.audioFixturePath = value;
  }
};

export function readResidentHoldToTalkArguments(
  arguments_: readonly string[]
): ResidentHoldToTalkArguments {
  if (arguments_.length === 0) {
    return { durationMs: defaultDurationMs, help: false };
  }

  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { durationMs: defaultDurationMs, help: true };
  }

  return readResidentHoldToTalkArgumentPairs(arguments_);
}

function readResidentHoldToTalkArgumentPairs(
  arguments_: readonly string[]
): ResidentHoldToTalkArguments {
  const parsed: MutableResidentHoldToTalkArguments = { durationMs: defaultDurationMs };

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    const read = flag === undefined ? undefined : residentHoldToTalkArgumentReaders[flag];
    if (read === undefined || value === undefined || value.trim() === "") {
      throw invalidArguments();
    }
    read(parsed, value);
  }

  return {
    durationMs: parsed.durationMs,
    help: false,
    ...(parsed.audioFixturePath === undefined ? {} : { audioFixturePath: parsed.audioFixturePath })
  };
}

function readDuration(value: string): number {
  const durationMs = Number(value);

  if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > maximumDurationMs) {
    throw invalidArguments();
  }

  return durationMs;
}

function invalidArguments(): Error {
  return new Error(
    "usage: field:resident-hold-to-talk [--duration-ms 1..300000] [--audio-fixture path.wav|path.pcm]"
  );
}

export function formatResidentHoldToTalkHelp(): string {
  return [
    "Usage: npm run field:resident-hold-to-talk -- [--duration-ms 30000] [--audio-fixture path.wav|path.pcm]",
    "",
    "Runs a bounded macOS control-and-capture validation using the configured controls.",
    "It reports aggregate timing/resource metadata only and does not invoke STT, Pi, TTS, or playback.",
    "--audio-fixture explicitly replaces microphone frames only for this bounded field validation."
  ].join("\n");
}

export function summarizeBoundedMetric(values: readonly number[]): BoundedMetricSummary {
  if (values.length === 0) {
    return {
      samples: 0,
      minimumMs: undefined,
      maximumMs: undefined,
      meanMs: undefined
    };
  }

  const rounded = values.map((value) => Math.round(value * 100) / 100);

  return {
    samples: rounded.length,
    minimumMs: Math.min(...rounded),
    maximumMs: Math.max(...rounded),
    meanMs:
      Math.round((rounded.reduce((sum, value) => sum + value, 0) / rounded.length) * 100) / 100
  };
}

export async function runResidentHoldToTalkFieldValidation(
  arguments_: ResidentHoldToTalkArguments
): Promise<ResidentHoldToTalkFieldReport> {
  const config = loadPicoConfigFromEnvironment();
  const control = config.voice.resident.control;
  const audioInput = config.voice.resident.audioInput;

  if (
    !config.voice.resident.enabled ||
    control === undefined ||
    audioInput?.provider !== "avaudioengine"
  ) {
    throw new Error(
      "pico hold-to-talk field validation requires enabled macos_resident_io control and avaudioengine input"
    );
  }

  const startedAtMs = performance.now();
  const startedCpu = process.cpuUsage();
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterSignals: (() => void) | undefined;
  let capture: ResidentAudioCapture | undefined;
  let controller: ReturnType<typeof createResidentControlController> | undefined;
  let bridge: Awaited<ReturnType<typeof startMacOSResidentIoBridge>> | undefined;
  let active: ActiveCapture | undefined;
  let cleanupStarted = false;
  const closeResources = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await closeFieldValidationResources({
      durationTimer,
      unregisterSignals,
      controller,
      active,
      bridge,
      capture
    });
  };

  try {
    const stopController = new AbortController();
    unregisterSignals = registerStopSignals(stopController);
    durationTimer = setTimeout(() => stopController.abort(), arguments_.durationMs);
    const outcomes: Record<ResidentControlResult, number> = {
      accepted: 0,
      ignored_busy: 0,
      ignored_stale: 0,
      noop: 0
    };
    const captureStartupLatencies: number[] = [];
    const holdDurations: number[] = [];
    const releaseTailDurations: number[] = [];
    const cancellationDurations: number[] = [];
    const residentIoTiming = createResidentIoTimingValues();
    let completedHolds = 0;
    let completedHoldsWithFrames = 0;
    let cancelledHolds = 0;
    let totalFrameCount = 0;
    let healthEventCount = 0;
    let engineStartedObserved = false;
    let restartCount = 0;
    let droppedFrameCount = 0;
    let outsidePttDroppedFrameCount = 0;
    let suppressedDroppedFrameCount = 0;
    let bufferCadenceMs = 0;
    let captureInvalidations = 0;
    let unexpectedPcmFrames = 0;
    let rejectFailure: (error: Error) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    void failure.catch(() => undefined);
    const fail = (error: unknown, generationId?: number): void => {
      controller?.fail(generationId);
      rejectFailure(error instanceof Error ? error : new Error(String(error)));
    };
    const ownedController = createResidentControlController({
      onListen(generation) {
        if (capture === undefined) {
          throw new Error("pico macOS resident I/O capture is not ready");
        }
        const session = capture.start(generation.signal, generation.id);
        const turn: ActiveCapture = {
          generation,
          session,
          pressedAtMs: performance.now(),
          collection: Promise.resolve(),
          frameCount: 0,
          firstFrameAtMs: undefined,
          releasedAtMs: undefined,
          cancelledAtMs: undefined,
          operation: undefined
        };
        turn.collection = collectFrames(turn);
        void turn.collection.catch((error: unknown) => fail(error, generation.id));
        active = turn;
      },
      onTailReady(generation) {
        const turn = active;

        if (turn === undefined || turn.generation.id !== generation.id) {
          return;
        }

        turn.operation ??= settleCapture(turn, ownedController).catch((error: unknown) => {
          fail(error, generation.id);
        });
      },
      onCancel(generation) {
        const turn = active;

        if (turn === undefined || turn.generation.id !== generation.id) {
          return;
        }

        turn.cancelledAtMs ??= performance.now();
        turn.operation ??= settleCapture(turn, ownedController).catch((error: unknown) => {
          fail(error, generation.id);
        });
      }
    });
    controller = ownedController;
    const collectFrames = async (turn: ActiveCapture): Promise<void> => {
      for await (const frame of turn.session.frames) {
        void frame;
        turn.firstFrameAtMs ??= performance.now();
        turn.frameCount += 1;
      }
    };
    const recordCaptureMetrics = (turn: ActiveCapture): void => {
      totalFrameCount += turn.frameCount;

      if (turn.firstFrameAtMs !== undefined) {
        captureStartupLatencies.push(turn.firstFrameAtMs - turn.pressedAtMs);
      }
    };
    const settleCapture = async (
      turn: ActiveCapture,
      owner: ReturnType<typeof createResidentControlController>
    ): Promise<void> => {
      await turn.session.stop();
      await turn.collection;
      const completedAtMs = performance.now();
      const cancelledAtMs = turn.cancelledAtMs;
      const claimedTerminalState =
        cancelledAtMs === undefined
          ? owner.finish(turn.generation.id, "transcribing")
          : owner.completeCancellation(turn.generation.id);

      if (claimedTerminalState) {
        recordCaptureMetrics(turn);

        if (cancelledAtMs === undefined) {
          if (turn.releasedAtMs !== undefined) {
            holdDurations.push(turn.releasedAtMs - turn.pressedAtMs);
            releaseTailDurations.push(completedAtMs - turn.releasedAtMs);
          }

          completedHolds += 1;

          if (turn.frameCount > 0) {
            completedHoldsWithFrames += 1;
          }
        } else {
          cancellationDurations.push(completedAtMs - cancelledAtMs);
          cancelledHolds += 1;
        }
      }

      if (active === turn) {
        active = undefined;
      }
    };
    bridge = await startMacOSResidentIoBridge({
      input: {
        deviceUid: audioInput.deviceUid,
        sampleRateHz: config.voice.echoControl.sampleRateHz,
        channels: config.voice.echoControl.channels,
        frameMs: config.voice.echoControl.frameMs,
        releaseTailMs: 250,
        talkKey: control.keyboard.talkKey,
        cancelKey: control.keyboard.cancelKey
      },
      // Field accounting intentionally keeps admission, timing, and failure ownership together.
      // eslint-disable-next-line complexity
      handleControl: (nativeEvent) => {
        if (capture === undefined) {
          return { result: "ignored_busy" };
        }
        const turn = active;

        try {
          const event = {
            kind: nativeEvent.kind,
            occurredAt: new Date().toISOString()
          } as const;
          const outcome = ownedController.handle(event);

          if (event.kind === "talk_released" && outcome === "accepted" && turn !== undefined) {
            turn.releasedAtMs ??= performance.now();
          }

          outcomes[outcome] += 1;
          const generation =
            event.kind === "talk_pressed" && outcome === "accepted"
              ? ownedController.generation()?.id
              : undefined;
          return { result: outcome, ...(generation === undefined ? {} : { generation }) };
        } catch (error) {
          fail(error, ownedController.generation()?.id);
          throw error;
        }
      },
      handleTailComplete: (generation) => {
        ownedController.handle({
          kind: "tail_complete",
          generationId: generation,
          occurredAt: new Date().toISOString()
        });
      },
      handleCaptureInvalidated: (generation) => {
        captureInvalidations += 1;
        fail(
          new Error("pico hold-to-talk field validation observed capture invalidation"),
          generation
        );
      },
      observeHealth: (event) => {
        healthEventCount += 1;
        restartCount = event.restartCount;
        droppedFrameCount = event.droppedFrameCount;
        outsidePttDroppedFrameCount = event.outsidePttDroppedFrameCount;
        suppressedDroppedFrameCount = event.suppressedDroppedFrameCount;
        bufferCadenceMs = event.bufferCadenceMs;
        engineStartedObserved ||= event.code === "engine_started";
        if (unhealthyResidentIoCodes.has(event.code)) {
          fail(
            new Error(
              `pico hold-to-talk field validation observed unhealthy resident I/O: ${event.code}`
            ),
            ownedController.generation()?.id
          );
        }
      },
      observeTiming: (event) => {
        residentIoTiming[event.stage].push(event.durationMs);
      },
      observeUnexpectedPcmFrame: () => {
        unexpectedPcmFrames += 1;
        fail(
          new Error("pico hold-to-talk field validation observed PCM without an active generation"),
          ownedController.generation()?.id
        );
      },
      signal: stopController.signal
    });
    capture = bridge.audioCapture;
    if (arguments_.audioFixturePath !== undefined) {
      capture = createFixtureOverrideCapture(
        bridge.audioCapture,
        createResidentAudioFixtureCapture({
          path: arguments_.audioFixturePath,
          expectedSampleRateHz: config.voice.echoControl.sampleRateHz,
          expectedChannels: config.voice.echoControl.channels,
          frameMs: config.voice.echoControl.frameMs
        })
      );
    }
    process.stderr.write(
      `[pico field] ready; use the configured controls for ${String(arguments_.durationMs)} ms\n`
    );
    await Promise.race([
      waitForAbort(stopController.signal),
      failure,
      bridge.completion.then(() => {
        if (!stopController.signal.aborted) {
          throw new Error("pico macOS control bridge exited during field validation");
        }
      })
    ]);

    requireCompletedAudioCapture(completedHoldsWithFrames);
    requireResidentIoEvidence(engineStartedObserved, residentIoTiming);

    const elapsedMs = performance.now() - startedAtMs;
    const cpu = process.cpuUsage(startedCpu);

    const report: ResidentHoldToTalkFieldReport = {
      status: "passed",
      durationMs: Math.round(elapsedMs),
      outcomes: Object.freeze({ ...outcomes }),
      completedHolds,
      cancelledHolds,
      frameCount: totalFrameCount,
      captureStartupLatency: summarizeBoundedMetric(captureStartupLatencies),
      holdDuration: summarizeBoundedMetric(holdDurations),
      releaseTailDuration: summarizeBoundedMetric(releaseTailDurations),
      cancellationDuration: summarizeBoundedMetric(cancellationDurations),
      residentIoHealthEvents: healthEventCount,
      residentIoRestartCount: restartCount,
      residentIoDroppedFrameCount: droppedFrameCount,
      residentIoOutsidePttDroppedFrameCount: outsidePttDroppedFrameCount,
      residentIoSuppressedDroppedFrameCount: suppressedDroppedFrameCount,
      residentIoBufferCadenceMs: bufferCadenceMs,
      residentIoTiming: summarizeResidentIoTiming(residentIoTiming),
      captureInvalidations,
      unexpectedPcmFrames,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: process.memoryUsage().rss
    };
    await closeResources();
    return report;
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }
}

function createFixtureOverrideCapture(
  nativeCapture: ResidentAudioCapture,
  fixtureCapture: ResidentAudioCapture
): ResidentAudioCapture {
  return {
    start(signal, generationId) {
      const nativeSession = nativeCapture.start(signal, generationId);
      let fixtureSession: ResidentCaptureSession;
      try {
        fixtureSession = fixtureCapture.start(signal, generationId);
      } catch (error) {
        void nativeSession.stop().catch(() => undefined);
        throw error;
      }
      const nativeDrain = drainFrames(nativeSession.frames);
      void nativeDrain.catch(() => undefined);

      return {
        frames: fixtureSession.frames,
        async stop() {
          await settleCleanupOperations([fixtureSession.stop(), nativeSession.stop(), nativeDrain]);
        }
      };
    },
    async close() {
      await settleCleanupOperations([fixtureCapture.close(), nativeCapture.close()]);
    }
  };
}

async function drainFrames(frames: AsyncIterable<unknown>): Promise<void> {
  for await (const frame of frames) {
    // Fixture frames own the field measurements; native PCM remains content-free here.
    void frame;
  }
}

async function settleCleanupOperations(operations: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure !== undefined) {
    throw failure.reason;
  }
}

function requireCompletedAudioCapture(completedHoldsWithFrames: number): void {
  if (completedHoldsWithFrames === 0) {
    throw new Error("pico hold-to-talk field validation observed no completed audio capture");
  }
}

function createResidentIoTimingValues(): Record<ResidentIoTimingStage, number[]> {
  return {
    key_to_admission: [],
    cancel_key_to_admission: [],
    admission_to_gate: [],
    gate_to_first_sample: [],
    first_sample_to_dispatch: [],
    release_to_tail_complete: [],
    engine_start: [],
    engine_restart: []
  };
}

function summarizeResidentIoTiming(
  values: Readonly<Record<ResidentIoTimingStage, readonly number[]>>
): Readonly<Record<ResidentIoTimingStage, BoundedMetricSummary>> {
  return Object.freeze({
    key_to_admission: summarizeBoundedMetric(values.key_to_admission),
    cancel_key_to_admission: summarizeBoundedMetric(values.cancel_key_to_admission),
    admission_to_gate: summarizeBoundedMetric(values.admission_to_gate),
    gate_to_first_sample: summarizeBoundedMetric(values.gate_to_first_sample),
    first_sample_to_dispatch: summarizeBoundedMetric(values.first_sample_to_dispatch),
    release_to_tail_complete: summarizeBoundedMetric(values.release_to_tail_complete),
    engine_start: summarizeBoundedMetric(values.engine_start),
    engine_restart: summarizeBoundedMetric(values.engine_restart)
  });
}

function requireResidentIoEvidence(
  engineStartedObserved: boolean,
  timing: Readonly<Record<ResidentIoTimingStage, readonly number[]>>
): void {
  if (!engineStartedObserved) {
    throw new Error("pico hold-to-talk field validation observed no engine start health event");
  }
  const missing = requiredTimingStages.find((stage) => timing[stage].length === 0);
  if (missing !== undefined) {
    throw new Error(`pico hold-to-talk field validation observed no ${missing} timing event`);
  }
}

async function closeFieldValidationResources(input: {
  readonly durationTimer: ReturnType<typeof setTimeout> | undefined;
  readonly unregisterSignals: (() => void) | undefined;
  readonly controller: ReturnType<typeof createResidentControlController> | undefined;
  readonly active: ActiveCapture | undefined;
  readonly bridge: Awaited<ReturnType<typeof startMacOSResidentIoBridge>> | undefined;
  readonly capture: ResidentAudioCapture | undefined;
}): Promise<void> {
  if (input.durationTimer !== undefined) {
    clearTimeout(input.durationTimer);
  }

  input.unregisterSignals?.();
  input.controller?.stop();
  await settleCleanupActions([
    () => closeActiveCapture(input.active),
    () => input.capture?.close() ?? Promise.resolve(),
    () => input.bridge?.close() ?? Promise.resolve()
  ]);
}

async function settleCleanupActions(actions: readonly (() => Promise<void>)[]): Promise<void> {
  await settleCleanupOperations(actions.map(async (action) => action()));
}

async function closeActiveCapture(active: ActiveCapture | undefined): Promise<void> {
  await active?.session.stop();
  await active?.collection.catch(() => undefined);
  await active?.operation?.catch(() => undefined);
}

function registerStopSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const arguments_ = readResidentHoldToTalkArguments(process.argv.slice(2));

  if (arguments_.help) {
    process.stdout.write(`${formatResidentHoldToTalkHelp()}\n`);
  } else {
    const report = await runResidentHoldToTalkFieldValidation(arguments_);
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  }
}
