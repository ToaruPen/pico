import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeStackChanAttentionReplayCli,
  parseStackChanAttentionReplayArguments,
  probeStackChanAttentionQuantizationCoupling,
  runStackChanAttentionReplay,
  STACKCHAN_ATTENTION_REPLAY_FIXTURE,
  type StackChanAttentionReplayDependencies,
  summarizeReplayInitialConfirmedProgress,
  summarizeReplayKinematics,
  summarizeReplayWaypoints
} from "../scripts/field/stackchan-attention-replay.js";
import { createStackChanAttentionRuntime } from "../src/runtime/stackchan-attention-runtime.js";

const TEST_PRODUCER_SOURCE_HASH = "a".repeat(64);

describe("StackChan attention replay field harness", { timeout: 30_000 }, () => {
  it("isolates visual-frame residual release from reply-cadence lane outcomes", async () => {
    const probe = await probeStackChanAttentionQuantizationCoupling();

    expect(probe.fixedDelayedReply.releasesBeforeFirstConfirmation).toBeGreaterThan(0);
    expect(probe.fixedDelayedReply.unDispatchedResidualReleaseCount).toBeGreaterThan(0);
    expect(probe.visualCadence.fast.residualReleaseCount).toBeGreaterThan(
      probe.visualCadence.slow.residualReleaseCount
    );
    expect(probe.visualCadence.fast.firstResidualReleaseAtMs).toBeLessThan(
      probe.visualCadence.slow.firstResidualReleaseAtMs ?? Number.POSITIVE_INFINITY
    );
    expect(probe.replyCadence.fast.residualReleaseAtMs).toEqual(
      probe.replyCadence.delayed.residualReleaseAtMs
    );
    expect(probe.replyCadence.fast.residualReleaseCount).toBe(
      probe.replyCadence.delayed.residualReleaseCount
    );
    expect(probe.replyCadence.fast.dispatchCount).not.toBe(
      probe.replyCadence.delayed.dispatchCount
    );
    expect(probe.findings).toEqual({
      releasesFromUnconfirmedVisualObservations: true,
      residualReleaseIsVisualCadenceDependent: true,
      laneOutcomeIsReplyCadenceDependent: true
    });
  });

  it("accepts only an absolute report path, exactly three repeats, and explicit producer hash", () => {
    const producerSourceHash = TEST_PRODUCER_SOURCE_HASH;
    expect(
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/stackchan-attention-replay.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        producerSourceHash,
        "--step-quantization",
        "error-feedback"
      ])
    ).toEqual({
      reportOutput: "/tmp/stackchan-attention-replay.json",
      repeat: 3,
      producerSourceHash,
      stepQuantization: "error-feedback"
    });
    expect(
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/stackchan-attention-replay.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        producerSourceHash,
        "--step-quantization",
        "round"
      ])
    ).toMatchObject({ stepQuantization: "round" });

    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "relative.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        producerSourceHash
      ])
    ).toThrow("--report-output");
    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/report.json",
        "--repeat",
        "2",
        "--producer-source-hash",
        producerSourceHash
      ])
    ).toThrow("--repeat");
    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/report.json",
        "--repeat",
        "4",
        "--producer-source-hash",
        producerSourceHash
      ])
    ).toThrow("--repeat");
    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/report.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        producerSourceHash,
        "--seed",
        "4"
      ])
    ).toThrow("--seed");
    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/report.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        "not-a-hash"
      ])
    ).toThrow("--producer-source-hash");
    expect(() =>
      parseStackChanAttentionReplayArguments([
        "--report-output",
        "/tmp/report.json",
        "--repeat",
        "3",
        "--producer-source-hash",
        producerSourceHash,
        "--step-quantization",
        "diffusion"
      ])
    ).toThrow("--step-quantization");
  });

  it("runs round and error-feedback from the same producer with isolated runtime state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-quantization-"));
    const modes = ["round", "error-feedback"] as const;
    const reports: Awaited<ReturnType<typeof runStackChanAttentionReplay>>[] = [];

    try {
      for (const mode of modes) {
        const runtimeOptions: Parameters<typeof createStackChanAttentionRuntime>[0][] = [];
        const report = await runStackChanAttentionReplay(
          {
            reportOutput: resolve(directory, `${mode}.json`),
            repeat: 3,
            producerSourceHash: TEST_PRODUCER_SOURCE_HASH,
            stepQuantization: mode
          },
          {
            createRuntime(options) {
              runtimeOptions.push(options);
              return createStackChanAttentionRuntime(options);
            }
          }
        );
        expect(runtimeOptions).toHaveLength(66);
        expect(runtimeOptions.every((options) => options.config.stepQuantization === mode)).toBe(
          true
        );
        expect(report.metadata.quantizationMode).toBe(mode);
        expect(report.metadata.fixture.follow.stepQuantization).toBe(mode);
        expect(report.repeatDeterminism.deterministic).toBe(true);
        reports.push(report);
      }

      expect(reports.map((report) => report.producerSourceHash)).toEqual([
        TEST_PRODUCER_SOURCE_HASH,
        TEST_PRODUCER_SOURCE_HASH
      ]);
      expect(reports[0]?.scenarios).not.toEqual(reports[1]?.scenarios);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("injects a virtual home wait into deterministic runtimes", async () => {
    let waitMs: ((durationMs: number) => Promise<void>) | undefined;

    await expect(
      runStackChanAttentionReplay(
        {
          reportOutput: "/tmp/unused-attention-replay.json",
          repeat: 3,
          producerSourceHash: TEST_PRODUCER_SOURCE_HASH
        },
        {
          createRuntime(options) {
            waitMs = options.waitMs;
            throw new Error("runtime options captured");
          }
        }
      )
    ).rejects.toThrow("runtime options captured");
    expect(waitMs).toBeTypeOf("function");
  });

  it("uses the production runtime with the exact shared field fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-runtime-"));
    const reportOutput = resolve(directory, "report.json");
    const runtimeOptions: Parameters<typeof createStackChanAttentionRuntime>[0][] = [];

    try {
      const report = await runStackChanAttentionReplay(
        { reportOutput, repeat: 3, producerSourceHash: TEST_PRODUCER_SOURCE_HASH },
        {
          createRuntime(options) {
            runtimeOptions.push(options);
            return createStackChanAttentionRuntime(options);
          }
        }
      );

      expect(runtimeOptions).toHaveLength(66);
      for (const options of runtimeOptions) {
        expect(options.config).toEqual(STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow);
        expect(options.scheduler).toBeTypeOf("function");
        expect(options.nowMs).toBeTypeOf("function");
      }
      expect(STACKCHAN_ATTENTION_REPLAY_FIXTURE).toMatchObject({
        seed: 20_260_730,
        syntheticFovDeg: { yaw: 64, pitch: 48 },
        virtualDeviceCommandDurationMs: 200,
        follow: {
          commandTransport: "async-latest",
          stepQuantization: "error-feedback",
          targetFilter: { enabled: false },
          frameIntervalMs: 125,
          commandRateHz: 10,
          maxPendingCommandAgeMs: 180,
          maxFrameAgeMs: 180,
          homeYaw: 0,
          homePitch: 33,
          deadZone: 0.1,
          deadZoneRelease: 0.14,
          yawGainDeg: 44,
          pitchGainDeg: 30,
          flipYaw: 1,
          flipPitch: -1,
          maxStepDeg: 4,
          moveSpeedDps: 90,
          lostHoldMs: 1_000,
          scanDwellMs: 900,
          scanYaw: [-35, 0, 35],
          scanPitch: [33, 23]
        }
      });
      expect(report.metadata).toMatchObject({
        runtimeFactory: "createStackChanAttentionRuntime",
        fixture: STACKCHAN_ATTENTION_REPLAY_FIXTURE,
        derivativeRule: "dt<=0 fails the run"
      });
      expect(report.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records one controller-sourced quantization decision per visible accepted frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-decisions-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH,
        stepQuantization: "error-feedback"
      });
      expect(report.metadata.motionEvidence).toBe("virtual-confirmed-not-physical");
      for (const scenario of report.scenarios) {
        const decisions = scenario.events.flatMap((event) =>
          event.decision === null ? [] : [{ event, decision: event.decision }]
        );
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.map(({ decision }) => decision.id)).toEqual(
          [...decisions.map(({ decision }) => decision.id)].sort((left, right) => left - right)
        );
        for (const { event, decision } of decisions) {
          expect(decision.id).toBe(event.sequence);
          expect(decision.decisionAtMs).toBe(event.timestampMs);
          expect(decision.quantizationMode).toBe("error-feedback");
          expect(decision.centered).toBe(event.centered);
          expect(decision.baseConfirmedPose).toEqual(event.rpcConfirmedPose);
          expect(decision.requestedPose).toEqual(event.requestedPose);
          expect(decision.requestSequence).toBe(event.requestSequence);
          expect(["dispatched", "replaced", "noop", "stale", "none"]).toContain(
            decision.effectOutcome
          );
          expect(Number.isInteger(decision.ticksWithoutConfirmedUpdate)).toBe(true);
          expect(Number.isFinite(decision.yaw.rawCorrectionDeg)).toBe(true);
          expect(Number.isFinite(decision.pitch.rawCorrectionDeg)).toBe(true);
          expect(Number.isFinite(decision.yaw.normalizedError)).toBe(true);
          expect(Number.isFinite(decision.yaw.clampedCorrectionDeg)).toBe(true);
          expect(Number.isFinite(decision.yaw.legacyRoundedStepDeg)).toBe(true);
          expect(Number.isFinite(decision.yaw.quantizedStepDeg)).toBe(true);
          expect(Number.isFinite(decision.yaw.residualBeforeDeg)).toBe(true);
          expect(Number.isFinite(decision.yaw.residualAfterDeg)).toBe(true);
          expect(typeof decision.yaw.residualAction).toBe("string");
          expect(Object.is(decision.yaw.quantizedStepDeg, -0)).toBe(false);
          expect(Object.is(decision.pitch.quantizedStepDeg, -0)).toBe(false);
        }
        expect(
          scenario.events
            .filter((event) => event.frameSequence !== null && event.detectorState === "visible")
            .every((event) => event.decision !== null)
        ).toBe(true);
        expect(
          scenario.events.filter((event) => event.stop).every((event) => event.decision === null)
        ).toBe(true);
        expect(scenario.aggregates.quantization.yaw.negativeZeroCount).toBe(0);
        expect(scenario.aggregates.quantization.pitch.negativeZeroCount).toBe(0);
        expect(scenario.aggregates.dispatchIntervalMs.count).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.dispatchIntervalMs).toHaveProperty("p90");
      }
      const fast = requireScenario(report, "fast-reversals");
      expect(fast.aggregates.quantization.yaw.residualReleaseCount).toBeGreaterThan(0);
      expect(
        fast.aggregates.quantization.yaw.residualReleaseTicksWithoutConfirmedUpdate.p95
      ).not.toBeNull();
      expect(fast.aggregates.dispatchIntervalMs.count).toBeGreaterThan(0);
      expect(fast.aggregates.replyToNextDispatchMs.count).toBeGreaterThan(0);
      expect(fast.aggregates.settlingMs.p90).not.toBeNull();
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes five canonical deterministic scenario baselines and one JSON stdout line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-"));
    const reportOutput = resolve(directory, "report.json");
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const exitCode = await executeStackChanAttentionReplayCli(
        [
          "--report-output",
          reportOutput,
          "--repeat",
          "3",
          "--producer-source-hash",
          TEST_PRODUCER_SOURCE_HASH
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line)
        }
      );
      const serialized = await readFile(reportOutput, "utf8");
      const report = JSON.parse(serialized) as Awaited<
        ReturnType<typeof runStackChanAttentionReplay>
      >;

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      expect(stdout[0]?.endsWith("\n")).toBe(true);
      expect(stdout[0]?.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout[0] ?? "{}")).toEqual(report);
      expect((await stat(reportOutput)).mode & 0o777).toBe(0o600);
      expect(report.schemaVersion).toBe(7);
      expect(report.status).toBe("passed");
      expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
        "static-hold",
        "slow-continuous-tracking",
        "fast-reversals",
        "target-loss-reacquisition",
        "stop-home"
      ]);
      expect(report.repeatDeterminism).toMatchObject({
        requested: 3,
        deterministic: true
      });
      expect(report.repeatDeterminism.canonicalHashes).toHaveLength(3);
      expect(new Set(report.repeatDeterminism.canonicalHashes).size).toBe(1);
      expect(report.repeatDeterminism.scenarioHashes).toHaveLength(3);
      expect(
        new Set(report.repeatDeterminism.scenarioHashes.map((hashes) => JSON.stringify(hashes)))
          .size
      ).toBe(1);

      for (const scenario of report.scenarios) {
        expect(scenario.status).toBe("passed");
        expect(scenario.canonicalInputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(scenario.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
        expect(scenario.canonicalInput).toBeDefined();
        expectRuntimeEventSchema(scenario.events);
        expectMetricShape(scenario.aggregates);
        expect(scenario.runtimeStatus).toMatchObject({
          phase: "stopped",
          staleFramesDiscarded: 0,
          observationOverlapAttempts: 0,
          errorCount: 0,
          errorCodes: []
        });
        expect(scenario.invariants).toMatchObject({
          angleBounds: true,
          pendingDepth: true,
          activeCalls: true,
          noOverlap: true,
          noStale: true,
          noPostStopNormalDispatch: true,
          postStopQuiescent: true,
          homeReturned: true,
          errorFree: true,
          framesAndTicksComplete: true,
          sufficientPostArrivalDwell: true,
          targetLossAcceptance: true,
          noSamePoseScanDispatches: true
        });
      }

      expect(serialized).not.toMatch(
        /image|jpeg|png|boundingBox|bbox|xMin|xMax|yMin|yMax|token|secret|bearer|password|apiKey/i
      );
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("measures a long initial stall from new demand instead of an already in-flight confirmation", () => {
    const progress = summarizeReplayInitialConfirmedProgress([
      trackingProgressEvent(-200, {
        centered: true,
        dispatchSequence: 1,
        dispatchedPose: { yaw: 2, pitch: 33 },
        counters: { activeCalls: 1, pendingDepth: 0 }
      }),
      trackingProgressEvent(0, {
        requestedPose: { yaw: 8, pitch: 33 },
        counters: { activeCalls: 1, pendingDepth: 1 }
      }),
      trackingProgressEvent(100, {
        dispatchSequence: 2,
        dispatchedPose: { yaw: 6, pitch: 33 },
        confirmedSequence: 1,
        confirmedBeforeDispatch: { yaw: 2, pitch: 33 },
        rpcConfirmedPose: { yaw: 2, pitch: 33 },
        counters: { activeCalls: 1, pendingDepth: 0 }
      }),
      trackingProgressEvent(1_000, {
        centered: true,
        confirmedSequence: 2,
        rpcConfirmedPose: { yaw: 6, pitch: 33 }
      })
    ]);

    expect(progress.initialEffectiveConfirmedProgressLatencyMs).toEqual({
      count: 1,
      p50: 1_000,
      p90: 1_000,
      p95: 1_000,
      p99: 1_000,
      max: 1_000
    });
    expect(progress.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress).toBe(0);
  });

  it("records one pose-changing confirmation for one active non-centered episode", () => {
    const progress = summarizeReplayInitialConfirmedProgress([
      trackingProgressEvent(0, {
        requestedPose: { yaw: 8, pitch: 33 },
        dispatchSequence: 1,
        dispatchedPose: { yaw: 4, pitch: 33 },
        counters: { activeCalls: 1, pendingDepth: 0 }
      }),
      trackingProgressEvent(200, {
        centered: true,
        confirmedSequence: 1,
        rpcConfirmedPose: { yaw: 4, pitch: 33 }
      })
    ]);

    expect(progress.initialEffectiveConfirmedProgressLatencyMs).toMatchObject({
      count: 1,
      p95: 200
    });
    expect(progress.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress).toBe(0);
  });

  it("counts an active non-centered episode that ends without a pose change", () => {
    const progress = summarizeReplayInitialConfirmedProgress([
      trackingProgressEvent(0),
      trackingProgressEvent(500, { centered: true })
    ]);

    expect(progress.initialEffectiveConfirmedProgressLatencyMs.count).toBe(0);
    expect(progress.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress).toBe(1);
  });

  it("does not open tracking-progress episodes on a centered idle plateau", () => {
    const progress = summarizeReplayInitialConfirmedProgress([
      trackingProgressEvent(0, { centered: true }),
      trackingProgressEvent(250, {
        centered: true,
        dispatchSequence: 1,
        dispatchedPose: { yaw: 4, pitch: 33 },
        counters: { activeCalls: 1, pendingDepth: 0 }
      }),
      trackingProgressEvent(500, {
        centered: true,
        confirmedSequence: 1,
        rpcConfirmedPose: { yaw: 4, pitch: 33 }
      })
    ]);

    expect(progress.initialEffectiveConfirmedProgressLatencyMs.count).toBe(0);
    expect(progress.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress).toBe(0);
  });

  it("fails deterministically when any derivative interval is non-positive", () => {
    expect(() =>
      summarizeReplayKinematics([
        { timestampMs: 0, pose: { yaw: 0, pitch: 33 } },
        { timestampMs: 0, pose: { yaw: 2, pitch: 35 } }
      ])
    ).toThrow("dt<=0");
    expect(() =>
      summarizeReplayKinematics([
        { timestampMs: 100, pose: { yaw: 0, pitch: 33 } },
        { timestampMs: 90, pose: { yaw: 2, pitch: 35 } }
      ])
    ).toThrow("dt<=0");
  });

  // This assertion intentionally follows world visibility through the complete scan trace.
  // eslint-disable-next-line complexity
  it("derives visibility from world pose and confirmed pose across the synthetic FOV", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-fov-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH
      });
      const loss = requireScenario(report, "target-loss-reacquisition");
      const outside = loss.events.find(
        (event) => event.detectorState === "outside-fov" && event.targetWorldPose !== null
      );
      const visibleAfterOutside = loss.events.find(
        (event) =>
          outside !== undefined &&
          event.timestampMs > outside.timestampMs &&
          event.detectorState === "visible"
      );

      expect(outside).toBeDefined();
      expect(visibleAfterOutside).toBeDefined();
      expect(outside?.targetWorldPose).not.toEqual(outside?.rpcConfirmedPose);
      expect(Math.abs(outside?.targetErrorDeg?.yaw ?? 0)).toBeGreaterThan(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw / 2
      );
      expect(Math.abs(visibleAfterOutside?.targetErrorDeg?.yaw ?? 0)).toBeLessThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw / 2
      );
      expect(loss.aggregates.reacquisitionLatencyMs).toBeGreaterThan(0);
      expect(loss.aggregates.reacquisitionLatencyMs).toBeLessThan(7_125);
      expect(loss.aggregates.prematureWaypointAdvances).toBe(0);
      expect(loss.aggregates.insufficientPostArrivalDwells).toBe(0);
      expect(loss.aggregates.samePoseScanDispatches).toBe(0);
      expect(loss.aggregates.actualPostArrivalDwellMs.count).toBeGreaterThan(0);
      expect(loss.aggregates.actualPostArrivalDwellMs.p50).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(loss.aggregates.actualPostArrivalDwellMs.p95).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(loss.aggregates.actualPostArrivalDwellMs.p99).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(loss.aggregates.actualPostArrivalDwellMs.max).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(loss.aggregates.minimumPostArrivalDwellMs).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(loss.aggregates.waypointReachRatio).toBe(1);
      expect(loss.aggregates.dwellBeforeArrivalMs.count).toBe(0);
      expect(loss.aggregates.progressReversals).toBeGreaterThanOrEqual(0);
      const observedEvents = report.scenarios.flatMap((scenario) =>
        scenario.events.filter(
          (event) => event.detectorState === "visible" || event.detectorState === "outside-fov"
        )
      );
      for (const event of observedEvents) {
        expect(event.targetWorldPose).not.toBeNull();
        expect(event.targetErrorDeg?.yaw).toBeCloseTo(
          (event.targetWorldPose?.yaw ?? 0) - event.rpcConfirmedPose.yaw,
          6
        );
        expect(event.targetErrorDeg?.pitch).toBeCloseTo(
          (event.targetWorldPose?.pitch ?? 0) - event.rpcConfirmedPose.pitch,
          6
        );
        const insideFov =
          Math.abs(event.targetErrorDeg?.yaw ?? 0) <=
            STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.yaw / 2 &&
          Math.abs(event.targetErrorDeg?.pitch ?? 0) <=
            STACKCHAN_ATTENTION_REPLAY_FIXTURE.syntheticFovDeg.pitch / 2;
        expect(insideFov).toBe(event.detectorState === "visible");
      }
      const scanRequests = loss.events.filter(
        (event) => event.controllerMode === "scan" && event.requestedPose !== null
      );
      const firstWaypoint = scanRequests[0];
      if (firstWaypoint?.requestedPose === null || firstWaypoint?.requestedPose === undefined) {
        throw new Error("target-loss replay did not request a scan waypoint");
      }
      const firstWaypointPose = firstWaypoint.requestedPose;
      const firstArrival = loss.events.find(
        (event) =>
          event.timestampMs >= firstWaypoint.timestampMs &&
          sameReplayPose(event.rpcConfirmedPose, firstWaypointPose)
      );
      if (firstArrival === undefined) {
        throw new Error("target-loss replay did not reach the first scan waypoint");
      }
      const nextWaypoint = scanRequests.find(
        (event) =>
          event.timestampMs > firstArrival.timestampMs &&
          event.requestedPose !== null &&
          !sameReplayPose(event.requestedPose, firstWaypointPose)
      );
      expect(firstWaypointPose).not.toEqual(firstWaypoint.rpcConfirmedPose);
      expect(nextWaypoint).toBeDefined();
      expect((nextWaypoint?.timestampMs ?? 0) - firstArrival.timestampMs).toBeGreaterThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
      );
      expect(
        loss.events
          .filter(
            (event) =>
              event.timestampMs >= firstWaypoint.timestampMs &&
              event.timestampMs <= firstArrival.timestampMs
          )
          .every(
            (event) =>
              event.requestedPose === null || sameReplayPose(event.requestedPose, firstWaypointPose)
          )
      ).toBe(true);
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  // This assertion deliberately covers the complete runtime/lane lifecycle boundary.
  // eslint-disable-next-line complexity
  it("separates request, one-shot dispatch, confirmation, clear, stop, and home events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-lifecycle-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH
      });
      const events = report.scenarios.flatMap((scenario) => scenario.events);
      const farDispatch = events.find(
        (event) =>
          event.requestedPose !== null &&
          event.dispatchedPose !== null &&
          (Math.abs(event.requestedPose.yaw - event.plannedBeforeDispatch.yaw) > 4 ||
            Math.abs(event.requestedPose.pitch - event.plannedBeforeDispatch.pitch) > 4)
      );
      expect(report.metadata.gateway).toMatchObject({
        reclampFromPlannedPose: true,
        maximumActiveCalls: 1
      });
      expect(farDispatch).toBeDefined();
      expect(farDispatch?.requestedPose).not.toEqual(farDispatch?.dispatchedPose);
      expect(
        Math.abs(
          (farDispatch?.dispatchedPose?.yaw ?? 0) - (farDispatch?.plannedBeforeDispatch.yaw ?? 0)
        )
      ).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          (farDispatch?.dispatchedPose?.pitch ?? 0) -
            (farDispatch?.plannedBeforeDispatch.pitch ?? 0)
        )
      ).toBeLessThanOrEqual(4);
      expect(events.some((event) => event.clear)).toBe(true);
      expect(events.some((event) => event.stop)).toBe(true);
      expect(events.some((event) => event.home)).toBe(true);
      const stopHome = requireScenario(report, "stop-home");
      expect(
        stopHome.events
          .filter((event) => event.stop)
          .map((event) => ({ variant: event.variant, home: event.home }))
      ).toEqual([
        { variant: "track-moving", home: true },
        { variant: "pending-present", home: true },
        { variant: "scan-active", home: true }
      ]);
      const stopEvents = stopHome.events.filter((event) => event.stop);
      expect(stopEvents[0]?.confirmedSequence).not.toBeNull();
      expect(
        stopEvents.every(
          (event) =>
            event.homeAcknowledgedAtMs !== null &&
            event.homeAcknowledgedPose?.yaw === 0 &&
            event.homeAcknowledgedPose.pitch === 33
        )
      ).toBe(true);
      expect(
        stopEvents.some(
          (event) => event.variant !== "scan-active" && event.rpcConfirmedPose.yaw !== 0
        )
      ).toBe(true);
      expect(
        stopEvents.every(
          (event) =>
            event.counters.activeCalls === 0 &&
            event.counters.pendingDepth === 0 &&
            event.counters.confirmed === event.counters.dispatched
        )
      ).toBe(true);
      expect(stopHome.aggregates.dispatchCount).toBe(
        stopEvents.reduce((sum, event) => sum + event.counters.dispatched, 0)
      );
      expect(stopHome.aggregates.homeCompletionMs).toBeGreaterThan(0);
      expect(stopHome.aggregates.homeErrorDeg).toEqual({ yaw: 0, pitch: 0 });
      expect(events.every((event) => event.counters.pendingDepth <= 1)).toBe(true);
      expect(events.every((event) => event.counters.activeCalls <= 1)).toBe(true);
      expect(
        events.some(
          (event) => event.counters.activeCalls === 1 && event.counters.pendingDepth === 1
        )
      ).toBe(true);
      expect(events.every((event) => event.counters.failed === 0)).toBe(true);
      expect(events.every((event) => event.counters.staleDiscarded === 0)).toBe(true);
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collapses repeated requests for one scan pose into a single waypoint visit", () => {
    const summary = summarizeReplayWaypoints([
      scanWaypointSample(0, { yaw: -35, pitch: 33 }, { yaw: 0, pitch: 33 }),
      scanWaypointSample(125, { yaw: -35, pitch: 33 }, { yaw: -4, pitch: 33 }),
      scanWaypointSample(250, { yaw: -35, pitch: 33 }, { yaw: -20, pitch: 33 }),
      scanWaypointSample(375, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 })
    ]);

    expect(summary).toMatchObject({
      waypointReachRatio: 1,
      prematureWaypointAdvances: 0,
      insufficientPostArrivalDwells: 0,
      actualPostArrivalDwellMs: { count: 0 },
      dwellBeforeArrivalMs: { count: 0 },
      progressReversals: 0
    });
  });

  it("fails a waypoint advance that occurs before a full post-arrival dwell", () => {
    const summary = summarizeReplayWaypoints([
      scanWaypointSample(0, { yaw: -35, pitch: 33 }, { yaw: 0, pitch: 33 }),
      scanWaypointSample(375, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 }),
      scanWaypointSample(900, { yaw: 0, pitch: 33 }, { yaw: -35, pitch: 33 })
    ]);

    expect(summary).toMatchObject({
      waypointReachRatio: 0.5,
      prematureWaypointAdvances: 0,
      insufficientPostArrivalDwells: 1,
      actualPostArrivalDwellMs: {
        count: 1,
        p50: 525,
        p95: 525,
        p99: 525,
        max: 525
      }
    });
  });

  it("does not classify reacquisition or stop interruption as a waypoint advance", () => {
    const interrupted = summarizeReplayWaypoints([
      scanWaypointSample(0, { yaw: -35, pitch: 33 }, { yaw: 0, pitch: 33 }),
      scanWaypointSample(375, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 }),
      {
        ...scanWaypointSample(500, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 }),
        controllerMode: "track" as const,
        detectorState: "visible" as const
      },
      scanWaypointSample(900, { yaw: 0, pitch: 33 }, { yaw: -35, pitch: 33 }),
      {
        ...scanWaypointSample(1_000, { yaw: 0, pitch: 33 }, { yaw: 0, pitch: 33 }),
        stop: true
      },
      scanWaypointSample(1_125, { yaw: 35, pitch: 33 }, { yaw: 0, pitch: 33 })
    ]);

    expect(interrupted.insufficientPostArrivalDwells).toBe(0);
    expect(interrupted.actualPostArrivalDwellMs.count).toBe(0);
  });

  it("excludes a reacquisition-interrupted active waypoint from the reach denominator", () => {
    const summary = summarizeReplayWaypoints([
      scanWaypointSample(0, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 }),
      scanWaypointSample(1_000, { yaw: 0, pitch: 33 }, { yaw: -35, pitch: 33 }),
      scanWaypointSample(1_375, { yaw: 0, pitch: 33 }, { yaw: 0, pitch: 33 }),
      scanWaypointSample(2_375, { yaw: 35, pitch: 33 }, { yaw: 0, pitch: 33 }),
      scanWaypointSample(2_500, { yaw: 35, pitch: 33 }, { yaw: 4, pitch: 33 }),
      {
        ...scanWaypointSample(2_625, { yaw: 35, pitch: 33 }, { yaw: 4, pitch: 33 }),
        controllerMode: "track" as const,
        detectorState: "visible" as const
      }
    ]);

    expect(summary).toMatchObject({
      waypointReachRatio: 1,
      prematureWaypointAdvances: 0,
      insufficientPostArrivalDwells: 0,
      actualPostArrivalDwellMs: {
        count: 2,
        p50: 1_000,
        p95: 1_000,
        p99: 1_000,
        max: 1_000
      }
    });
  });

  it("keeps an unreached waypoint in the denominator across transient hold and occlusion", () => {
    const summary = summarizeReplayWaypoints([
      scanWaypointSample(0, { yaw: -35, pitch: 33 }, { yaw: -35, pitch: 33 }),
      scanWaypointSample(900, { yaw: 0, pitch: 33 }, { yaw: -35, pitch: 33 }),
      {
        ...scanWaypointSample(1_000, { yaw: 0, pitch: 33 }, { yaw: -31, pitch: 33 }),
        controllerMode: "hold" as const
      },
      scanWaypointSample(1_800, { yaw: 35, pitch: 33 }, { yaw: -31, pitch: 33 })
    ]);

    expect(summary).toMatchObject({
      waypointReachRatio: 0.333_333,
      prematureWaypointAdvances: 1,
      insufficientPostArrivalDwells: 0,
      actualPostArrivalDwellMs: {
        count: 1,
        p50: 900,
        p95: 900,
        p99: 900,
        max: 900
      },
      dwellBeforeArrivalMs: {
        count: 1,
        p50: 900,
        p95: 900,
        p99: 900,
        max: 900
      }
    });
  });

  it("probes cancelled scheduling and the stopped lane without changing dispatch counters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-post-stop-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH
      });
      const stopEvents = requireScenario(report, "stop-home").events.filter((event) => event.stop);
      const minimumProbeDelayMs =
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs +
        1_000 / STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.commandRateHz;

      expect(stopEvents).toHaveLength(3);
      for (const event of stopEvents) {
        expect(event.postStopProbe).toMatchObject({
          schedulerTickRejected: true,
          lanePhase: "stopped",
          dispatchAttempts: 1
        });
        expect(event.timestampMs - (event.stopRequestedAtMs ?? event.timestampMs)).toBeGreaterThan(
          minimumProbeDelayMs
        );
        expect(event.postStopProbe?.dispatchedAfter).toBe(event.postStopProbe?.dispatchedBefore);
        expect(event.postStopProbe?.confirmedAfter).toBe(event.postStopProbe?.confirmedBefore);
      }
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails the CLI stop-home scenario for every non-quiescent post-stop probe result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-probe-failure-"));
    const reportOutput = resolve(directory, "report.json");
    const mutations: readonly ((probe: ReplayPostStopProbe) => ReplayPostStopProbe | null)[] = [
      // eslint-disable-next-line unicorn/no-null
      () => null,
      (probe) => ({ ...probe, schedulerTickRejected: false }),
      (probe) => ({ ...probe, lanePhase: "running" }),
      (probe) => ({ ...probe, dispatchAttempts: 0 }),
      (probe) => ({ ...probe, dispatchedAfter: probe.dispatchedAfter + 1 }),
      (probe) => ({ ...probe, confirmedAfter: probe.confirmedAfter + 1 })
    ];

    try {
      for (const mutate of mutations) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const executeWithDependencies = executeStackChanAttentionReplayCli as ExecuteReplayCli;
        const exitCode = await executeWithDependencies(
          [
            "--report-output",
            reportOutput,
            "--repeat",
            "3",
            "--producer-source-hash",
            TEST_PRODUCER_SOURCE_HASH
          ],
          {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line)
          },
          {
            postStopProbe(probe, context) {
              return context.id === "stop-home" ? mutate(probe) : probe;
            }
          }
        );
        const report = JSON.parse(stdout[0] ?? "{}") as ReplayReport;
        const stopHome = requireScenario(report, "stop-home");

        expect(exitCode).toBe(1);
        expect(stderr).toEqual([]);
        expect(stopHome.status).toBe("failed");
        expect(stopHome.invariants.postStopQuiescent).toBe(false);
      }
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid virtual lane sequences and poses without changing lane state", async () => {
    const replayModule: object = await import("../scripts/field/stackchan-attention-replay.js");
    const candidate: unknown = Reflect.get(replayModule, "probeReplayLaneUpdateValidation");

    expect(candidate).toBeTypeOf("function");
    if (typeof candidate !== "function") {
      return;
    }
    const probe = candidate as ReplayLaneValidationProbe;
    const results = await probe([
      { sequence: 1, pose: { yaw: 0, pitch: 33 } },
      { sequence: 1, pose: { yaw: 1, pitch: 33 } },
      { sequence: 0, pose: { yaw: 1, pitch: 33 } },
      { sequence: Number.MAX_SAFE_INTEGER + 1, pose: { yaw: 1, pitch: 33 } },
      { sequence: 1.5, pose: { yaw: 1, pitch: 33 } },
      { sequence: 2, pose: { yaw: -91, pitch: 33 } },
      { sequence: 2, pose: { yaw: 90.5, pitch: 33 } },
      { sequence: 2, pose: { yaw: 0, pitch: 4 } },
      { sequence: 2, pose: { yaw: 0, pitch: 86 } },
      { sequence: 2, pose: { yaw: 0, pitch: 33.5 } },
      { sequence: 2, pose: { yaw: -90, pitch: 5 } },
      { sequence: 3, pose: { yaw: 90, pitch: 85 } }
    ]);

    expect(results.map((result) => result.accepted)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true
    ]);
    for (const result of results.filter((candidate) => !candidate.accepted)) {
      expect(result.after).toEqual(result.before);
    }
  });

  it("keeps one active command and dispatches only the latest pending target", async () => {
    const replayModule: object = await import("../scripts/field/stackchan-attention-replay.js");
    const candidate: unknown = Reflect.get(replayModule, "probeReplayLaneTimedUpdates");

    expect(candidate).toBeTypeOf("function");
    if (typeof candidate !== "function") {
      return;
    }
    const probe = candidate as ReplayLaneTimedUpdateProbe;
    const results = await probe([
      { atMs: 0, sequence: 1, pose: { yaw: 4, pitch: 33 } },
      { atMs: 125, sequence: 2, pose: { yaw: 0, pitch: 33 } },
      { atMs: 150, sequence: 3, pose: { yaw: 8, pitch: 33 } },
      { atMs: 200, sequence: 4, pose: { yaw: -4, pitch: 33 } }
    ]);

    expect(results[1]).toMatchObject({
      // eslint-disable-next-line unicorn/no-null -- The report contract uses JSON null markers.
      dispatchedPose: null,
      // eslint-disable-next-line unicorn/no-null -- The report contract uses JSON null markers.
      noOpDiscardedSequence: null,
      after: {
        dispatched: 1,
        confirmed: 0,
        pendingDepth: 1,
        activeCalls: 1
      }
    });
    expect(results[2]).toMatchObject({
      // eslint-disable-next-line unicorn/no-null -- The report contract uses JSON null markers.
      dispatchedPose: null,
      after: {
        accepted: 3,
        replaced: 1,
        dispatched: 1,
        confirmed: 0,
        pendingDepth: 1,
        activeCalls: 1
      }
    });
    expect(results[3]).toMatchObject({
      dispatchedPose: { yaw: 8, pitch: 33 },
      confirmedBeforeDispatch: { yaw: 4, pitch: 33 },
      plannedBeforeDispatch: { yaw: 4, pitch: 33 },
      after: {
        accepted: 4,
        replaced: 1,
        dispatched: 2,
        confirmed: 1,
        pendingDepth: 1,
        activeCalls: 1
      }
    });
  });

  it("linearly interpolates the slow continuous world target between keyframes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-linear-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH
      });
      const slow = requireScenario(report, "slow-continuous-tracking");
      const observations = slow.events.filter((event) => event.frameSequence !== null);

      expect(observations[0]?.targetWorldPose).toEqual({ yaw: 0, pitch: 33 });
      expect(observations[1]?.targetWorldPose).toEqual({ yaw: 1, pitch: 33.25 });
      expect(observations[2]?.targetWorldPose).toEqual({ yaw: 2, pitch: 33.5 });
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports segment settling latency and censored intervals instead of empty success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-settling-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay({
        reportOutput,
        repeat: 3,
        producerSourceHash: TEST_PRODUCER_SOURCE_HASH
      });
      const slow = requireScenario(report, "slow-continuous-tracking");
      const fast = requireScenario(report, "fast-reversals");

      expect(slow.aggregates.settlingIntervalCount).toBeGreaterThan(0);
      expect(slow.aggregates.settlingMs.count).toBeGreaterThan(0);
      expect(slow.aggregates.settlingMs.max).toBeGreaterThan(0);
      expect(fast.aggregates.settlingIntervalCount).toBeGreaterThan(0);
      expect(fast.aggregates.settlingCensoredCount).toBeLessThanOrEqual(2);
      expect(fast.aggregates.settlingMs.count).toBe(
        fast.aggregates.settlingIntervalCount - fast.aggregates.settlingCensoredCount
      );
      expect(fast.aggregates.settlingUncensoredRatio).toBeGreaterThanOrEqual(0.8);

      const untracked = await runStackChanAttentionReplay(
        { reportOutput, repeat: 3, producerSourceHash: TEST_PRODUCER_SOURCE_HASH },
        {
          createRuntime(options) {
            return createStackChanAttentionRuntime({
              ...options,
              model: {
                async detect(jpeg) {
                  await options.model.detect(jpeg);
                  return [];
                }
              }
            });
          }
        }
      );
      const untrackedSlow = requireScenario(untracked, "slow-continuous-tracking");
      expect(untrackedSlow.aggregates.settlingMs.count).toBe(0);
      expect(untrackedSlow.aggregates.settlingCensoredCount).toBeGreaterThan(0);
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails scenarios with bounded runtime error codes and incomplete frame processing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-errors-"));
    const reportOutput = resolve(directory, "report.json");

    try {
      const report = await runStackChanAttentionReplay(
        { reportOutput, repeat: 3, producerSourceHash: TEST_PRODUCER_SOURCE_HASH },
        {
          createRuntime(options) {
            let failNextTick = true;
            return createStackChanAttentionRuntime({
              ...options,
              model: {
                async detect(jpeg) {
                  if (failNextTick) {
                    failNextTick = false;
                    throw new Error("sensitive detector implementation detail");
                  }
                  return options.model.detect(jpeg);
                }
              }
            });
          }
        }
      );
      const serialized = JSON.stringify(report);

      expect(report.status).toBe("failed");
      for (const scenario of report.scenarios) {
        expect(scenario.status).toBe("failed");
        expect(scenario.runtimeStatus.errorCount).toBeGreaterThan(0);
        expect(scenario.runtimeStatus.errorCount).toBeLessThanOrEqual(8);
        expect(scenario.runtimeStatus.errorCodes).toContain("tick_failed");
        expect(scenario.runtimeStatus.errorCodes).toHaveLength(scenario.runtimeStatus.errorCount);
        expect(scenario.runtimeStatus.framesProcessed).toBeLessThan(
          scenario.runtimeStatus.expectedFramesProcessed
        );
        expect(scenario.runtimeStatus.observationTicksStarted).toBe(
          scenario.runtimeStatus.expectedObservationTicks
        );
        expect(scenario.invariants).toMatchObject({
          errorFree: false,
          framesAndTicksComplete: false
        });
      }
      expect(serialized).not.toContain("sensitive detector implementation detail");
      expect(serialized).not.toMatch(/lastError|message/);
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a bounded failure record without leaking parser details or exceptions", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeStackChanAttentionReplayCli(["--repeat", "3"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['{"status":"failed","code":"invalid_arguments"}\n']);
    expect(stderr.join("")).not.toMatch(/stack|Error|--report-output|Users|token|secret/i);
  });
});

function expectRuntimeEventSchema(
  events: Awaited<ReturnType<typeof runStackChanAttentionReplay>>["scenarios"][number]["events"]
): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(events.map((event) => event.timestampMs)).toEqual(
    events.map((event) => event.timestampMs).sort((left, right) => left - right)
  );
  for (const event of events) {
    expect(event.observationId).toBeTypeOf("string");
    expect(event.frameSequence === null || Number.isSafeInteger(event.frameSequence)).toBe(true);
    if (event.frameSequence !== null) {
      expect(event.runtimeAcceptedFrameSequence).toBe(event.frameSequence);
    }
    expect(event.pendingAgeMs === null || event.pendingAgeMs >= 0).toBe(true);
    expect(typeof event.counters.accepted).toBe("number");
    expect(typeof event.counters.replaced).toBe("number");
    expect(typeof event.counters.dispatched).toBe("number");
    expect(typeof event.counters.confirmed).toBe("number");
    expect(typeof event.counters.failed).toBe("number");
    expect(typeof event.counters.staleDiscarded).toBe("number");
    expect(typeof event.counters.pendingDepth).toBe("number");
    expect(typeof event.counters.activeCalls).toBe("number");
  }
}

function expectMetricShape(
  aggregates: Awaited<
    ReturnType<typeof runStackChanAttentionReplay>
  >["scenarios"][number]["aggregates"]
): void {
  expect(aggregates.requestKinematics.velocity.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.requestKinematics.acceleration.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.requestKinematics.jerk.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.dispatchKinematics.velocity.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.dispatchKinematics.acceleration.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.dispatchKinematics.jerk.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.confirmedKinematics.velocity.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.confirmedKinematics.acceleration.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.confirmedKinematics.jerk.yaw.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.angularPathDeg.request).toBeGreaterThanOrEqual(0);
  expect(aggregates.angularPathDeg.dispatch).toBeGreaterThanOrEqual(0);
  expect(aggregates.angularPathDeg.confirmed).toBeGreaterThanOrEqual(0);
  expect(aggregates.velocityTotalVariation.combined).toBeGreaterThanOrEqual(0);
  expect(aggregates.directionReversals.combined).toBeGreaterThanOrEqual(0);
  expect(aggregates.centeredRatio === null || aggregates.centeredRatio >= 0).toBe(true);
  expect(aggregates.settlingMs.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.initialEffectiveConfirmedProgressLatencyMs.count).toBeGreaterThanOrEqual(0);
  expect(
    aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress
  ).toBeGreaterThanOrEqual(0);
  expect(aggregates.settlingIntervalCount).toBeGreaterThanOrEqual(0);
  expect(aggregates.settlingCensoredCount).toBeGreaterThanOrEqual(0);
  expect(aggregates.samePoseRequests).toBeGreaterThanOrEqual(0);
  expect(aggregates.samePoseDispatches).toBeGreaterThanOrEqual(0);
  expect(aggregates.samePoseScanDispatches).toBeGreaterThanOrEqual(0);
  expect(aggregates.waypointReachRatio).toBeGreaterThanOrEqual(0);
  expect(aggregates.prematureWaypointAdvances).toBeGreaterThanOrEqual(0);
  expect(aggregates.insufficientPostArrivalDwells).toBeGreaterThanOrEqual(0);
  expect(aggregates.actualPostArrivalDwellMs.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.dwellBeforeArrivalMs.count).toBeGreaterThanOrEqual(0);
  expect(aggregates.progressReversals).toBeGreaterThanOrEqual(0);
}

function sameReplayPose(
  left: { readonly yaw: number; readonly pitch: number },
  right: { readonly yaw: number; readonly pitch: number }
): boolean {
  return left.yaw === right.yaw && left.pitch === right.pitch;
}

function scanWaypointSample(
  timestampMs: number,
  requestedPose: { yaw: number; pitch: number },
  rpcConfirmedPose: { yaw: number; pitch: number }
) {
  return {
    timestampMs,
    controllerMode: "scan" as const,
    requestedPose,
    rpcConfirmedPose,
    detectorState: "occluded" as const,
    stop: false,
    variant: "scan" as const
  };
}

function trackingProgressEvent(
  timestampMs: number,
  overrides: Partial<Parameters<typeof summarizeReplayInitialConfirmedProgress>[0][number]> = {}
): Parameters<typeof summarizeReplayInitialConfirmedProgress>[0][number] {
  /* eslint-disable unicorn/no-null -- Replay JSON events use explicit null for absent fields. */
  return {
    timestampMs,
    variant: null,
    probeId: null,
    controllerMode: "track",
    centered: false,
    requestedPose: null,
    dispatchSequence: null,
    dispatchedPose: null,
    confirmedSequence: null,
    confirmedBeforeDispatch: { yaw: 0, pitch: 33 },
    plannedBeforeDispatch: { yaw: 0, pitch: 33 },
    rpcConfirmedPose: { yaw: 0, pitch: 33 },
    counters: { activeCalls: 0, pendingDepth: 0 },
    ...overrides
  };
  /* eslint-enable unicorn/no-null */
}

function requireScenario(
  report: Awaited<ReturnType<typeof runStackChanAttentionReplay>>,
  id: Awaited<ReturnType<typeof runStackChanAttentionReplay>>["scenarios"][number]["id"]
) {
  const scenario = report.scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`missing scenario ${id}`);
  }
  return scenario;
}

type ReplayReport = Awaited<ReturnType<typeof runStackChanAttentionReplay>>;
type ReplayPostStopProbe = NonNullable<
  ReplayReport["scenarios"][number]["events"][number]["postStopProbe"]
>;
type ReplayProbeContext = {
  readonly id: ReplayReport["scenarios"][number]["id"];
  readonly variant: ReplayReport["scenarios"][number]["events"][number]["variant"];
};
type ReplayProbeDependencies = StackChanAttentionReplayDependencies & {
  readonly postStopProbe?: (
    probe: ReplayPostStopProbe,
    context: ReplayProbeContext
  ) => ReplayPostStopProbe | null;
};
type ExecuteReplayCli = (
  arguments_: readonly string[],
  io: {
    readonly stdout: (line: string) => void;
    readonly stderr: (line: string) => void;
  },
  dependencies: ReplayProbeDependencies
) => Promise<number>;
type ReplayLaneValidationProbe = (
  updates: readonly {
    readonly sequence: number;
    readonly pose: { readonly yaw: number; readonly pitch: number };
  }[]
) => Promise<
  readonly {
    readonly accepted: boolean;
    readonly before: unknown;
    readonly after: unknown;
  }[]
>;
type ReplayLaneTimedUpdateProbe = (
  updates: readonly {
    readonly atMs: number;
    readonly sequence: number;
    readonly pose: { readonly yaw: number; readonly pitch: number };
  }[]
) => Promise<
  readonly {
    readonly dispatchedPose: { readonly yaw: number; readonly pitch: number } | null;
    readonly confirmedBeforeDispatch: { readonly yaw: number; readonly pitch: number };
    readonly plannedBeforeDispatch: { readonly yaw: number; readonly pitch: number };
    readonly noOpDiscardedSequence: number | null;
    readonly after: unknown;
  }[]
>;
