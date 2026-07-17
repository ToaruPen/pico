#!/usr/bin/env jiti
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment } from "../../src/config/index.js";
import { startMacOSControlBridge } from "../../src/runtime/macos-control-bridge.js";
import {
  createResidentAudioCapture,
  type ResidentCaptureSession
} from "../../src/runtime/resident-audio-io.js";
import {
  createResidentControlController,
  type ResidentTurnGeneration
} from "../../src/runtime/resident-control-controller.js";
import {
  createLoopbackHttpResidentControlServer,
  type ResidentControlResult
} from "../../src/runtime/resident-control.js";

export type ResidentHoldToTalkArguments = {
  readonly durationMs: number;
  readonly help: boolean;
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
  readonly idleSttCalls: 0;
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

export function readResidentHoldToTalkArguments(
  arguments_: readonly string[]
): ResidentHoldToTalkArguments {
  switch (arguments_.length) {
    case 0:
      return { durationMs: defaultDurationMs, help: false };
    case 1:
      return readHelpArgument(arguments_[0]);
    case 2:
      return readDurationArguments(arguments_[0], arguments_[1]);
    default:
      throw invalidArguments();
  }
}

function readHelpArgument(value: string | undefined): ResidentHoldToTalkArguments {
  if (value === "--help") {
    return { durationMs: defaultDurationMs, help: true };
  }

  throw invalidArguments();
}

function readDurationArguments(
  flag: string | undefined,
  value: string | undefined
): ResidentHoldToTalkArguments {
  const durationMs = Number(value);

  if (
    flag !== "--duration-ms" ||
    !Number.isInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > maximumDurationMs
  ) {
    throw invalidArguments();
  }

  return { durationMs, help: false };
}

function invalidArguments(): Error {
  return new Error("usage: field:resident-hold-to-talk [--duration-ms 1..300000]");
}

export function formatResidentHoldToTalkHelp(): string {
  return [
    "Usage: npm run field:resident-hold-to-talk -- [--duration-ms 30000]",
    "",
    "Runs a bounded macOS control-and-capture validation using the configured controls.",
    "It reports aggregate timing/resource metadata only and does not invoke STT, Pi, TTS, or playback."
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

  if (!config.voice.resident.enabled || control === undefined) {
    throw new Error(
      "pico hold-to-talk field validation requires voice.resident.enabled and voice.resident.control"
    );
  }

  const startedAtMs = performance.now();
  const startedCpu = process.cpuUsage();
  const stopController = new AbortController();
  const unregisterSignals = registerStopSignals(stopController);
  const durationTimer = setTimeout(() => stopController.abort(), arguments_.durationMs);
  const capture = createResidentAudioCapture(config);
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
  let completedHolds = 0;
  let cancelledHolds = 0;
  let totalFrameCount = 0;
  let active: ActiveCapture | undefined;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const fail = (error: unknown, generationId?: number): void => {
    controller.fail(generationId);
    rejectFailure(error instanceof Error ? error : new Error(String(error)));
  };
  const controller = createResidentControlController({
    onListen(generation) {
      const session = capture.start(generation.signal);
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
      active = turn;
    },
    onTailReady(generation) {
      const turn = active;

      if (turn === undefined || turn.generation.id !== generation.id) {
        return;
      }

      turn.operation = finishReleasedCapture(turn, controller).catch((error: unknown) => {
        fail(error, generation.id);
      });
    },
    onCancel(generation) {
      const turn = active;

      if (turn === undefined || turn.generation.id !== generation.id) {
        return;
      }

      turn.cancelledAtMs = performance.now();
      turn.operation = finishCancelledCapture(turn, controller).catch((error: unknown) => {
        fail(error, generation.id);
      });
    }
  });
  const collectFrames = async (turn: ActiveCapture): Promise<void> => {
    for await (const frame of turn.session.frames) {
      void frame;
      turn.firstFrameAtMs ??= performance.now();
      turn.frameCount += 1;
    }
  };
  const recordCaptureMetrics = (turn: ActiveCapture, completedAtMs: number): void => {
    totalFrameCount += turn.frameCount;

    if (turn.firstFrameAtMs !== undefined) {
      captureStartupLatencies.push(turn.firstFrameAtMs - turn.pressedAtMs);
    }

    if (turn.releasedAtMs !== undefined) {
      holdDurations.push(turn.releasedAtMs - turn.pressedAtMs);
      releaseTailDurations.push(completedAtMs - turn.releasedAtMs);
    }
  };
  const finishReleasedCapture = async (
    turn: ActiveCapture,
    owner: ReturnType<typeof createResidentControlController>
  ): Promise<void> => {
    await turn.session.stop();
    await turn.collection;
    recordCaptureMetrics(turn, performance.now());
    completedHolds += 1;
    owner.finish(turn.generation.id, "transcribing");

    if (active === turn) {
      active = undefined;
    }
  };
  const finishCancelledCapture = async (
    turn: ActiveCapture,
    owner: ReturnType<typeof createResidentControlController>
  ): Promise<void> => {
    await turn.session.stop();
    await turn.collection;
    const completedAtMs = performance.now();
    recordCaptureMetrics(turn, completedAtMs);

    if (turn.cancelledAtMs !== undefined) {
      cancellationDurations.push(completedAtMs - turn.cancelledAtMs);
    }

    cancelledHolds += 1;
    owner.completeCancellation(turn.generation.id);

    if (active === turn) {
      active = undefined;
    }
  };
  const server = await createLoopbackHttpResidentControlServer({
    host: control.host,
    port: control.port,
    authTokenPath: control.authTokenPath,
    handle: (event) => {
      const turn = active;

      if (event.kind === "talk_released" && turn !== undefined) {
        turn.releasedAtMs ??= performance.now();
      }

      try {
        const outcome = controller.handle(event);
        outcomes[outcome] += 1;
        return outcome;
      } catch (error) {
        fail(error, controller.generation()?.id);
        throw error;
      }
    },
    signal: stopController.signal
  });
  let bridge: Awaited<ReturnType<typeof startMacOSControlBridge>> | undefined;

  try {
    bridge = await startMacOSControlBridge({ control, signal: stopController.signal });
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
  } finally {
    clearTimeout(durationTimer);
    unregisterSignals();
    controller.stop();
    await active?.session.stop();
    await active?.collection.catch(() => undefined);
    await active?.operation?.catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    await server.close();
    await capture.close();
  }

  const elapsedMs = performance.now() - startedAtMs;
  const cpu = process.cpuUsage(startedCpu);

  return {
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
    idleSttCalls: 0,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: process.memoryUsage().rss
  };
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
