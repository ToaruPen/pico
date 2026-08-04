import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  assertStackChanAttentionReplayReportsComparable,
  evaluateStackChanAttentionReplayAcceptance,
  normalizeStackChanAttentionReplayReport,
  reduceStackChanAttentionReplayEvidence,
  runStackChanAttentionReplay,
  STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE,
  STACKCHAN_ATTENTION_REPLAY_FIXTURE,
  STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES,
  validateStackChanAttentionReplayReport,
  verifyQualifiedReplayAgainstFreshCurrentProducer
} from "../scripts/field/stackchan-attention-replay.js";
import {
  loadStackChanAttentionReplaySchema,
  validateStackChanAttentionReplaySchemaValue
} from "../scripts/field/stackchan-attention-replay-schema.js";

describe("StackChan attention replay qualification gate", () => {
  it("binds every production source used by the replay producer", () => {
    expect(STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES).toEqual([
      "pico-attention-controller",
      "pico-target-center-filter",
      "pico-attention-runtime",
      "pico-attention-detection",
      "replay-sut-lane-policy",
      "gateway-head-target-lane"
    ]);
  });

  it("emits and validates an exact schema-v7 report with locked comparison hashes", async () => {
    await withReplayReport(async (report) => {
      expect(report.schemaVersion).toBe(7);
      expect(() => validateStackChanAttentionReplayReport(report)).not.toThrow();
      const verification = await verifyQualifiedReplayAgainstFreshCurrentProducer(report);
      expect(verification.freshReport).toEqual(report);
      expect(verification.candidateCanonicalSha256).toBe(verification.freshCanonicalSha256);
      expect(report.reportSchemaHash).toMatch(HASH_PATTERN);
      expect(report.eventSchemaHash).toMatch(HASH_PATTERN);
      expect(report.metricDefinitionHash).toMatch(HASH_PATTERN);
      expect(report.metricImplementationHash).toMatch(HASH_PATTERN);
      expect(report.acceptanceProfileHash).toMatch(HASH_PATTERN);
      expect(report.fixtureHash).toMatch(HASH_PATTERN);
      expect(report.scenarioInputHash).toMatch(HASH_PATTERN);
      expect(report.producerSourceHash).toMatch(HASH_PATTERN);
      expect(report.comparisonSetHash).toMatch(HASH_PATTERN);
      expect(report.repeatDeterminism.comparisonSetHashes).toEqual([
        report.comparisonSetHash,
        report.comparisonSetHash,
        report.comparisonSetHash
      ]);
      expect(() =>
        assertStackChanAttentionReplayReportsComparable(report, structuredClone(report))
      ).not.toThrow();
    });
  });

  it.each([
    {
      name: "virtual-clock timestamps",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "static-hold");
        for (const [index, event] of scenario.events.entries()) {
          event.timestampMs = index + 1;
          if (event.decision !== null) {
            event.decision.decisionAtMs = event.timestampMs;
            event.decision.observedAtMs = event.timestampMs;
          }
        }
      }
    },
    {
      name: "target error geometry",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        for (const event of scenario.events) {
          if (!event.stop) {
            event.targetErrorDeg = { yaw: 0, pitch: 0 };
            event.targetNormalizedError = { yaw: 0, pitch: 0 };
          }
        }
      }
    },
    {
      name: "detector visibility state",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "target-loss-reacquisition");
        const occluded = scenario.events.find((event) => event.detectorState === "occluded");
        if (occluded === undefined) {
          throw new Error("test report has no occluded observation");
        }
        occluded.detectorState = "visible";
      }
    },
    {
      name: "controller centered state",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        for (const event of scenario.events) {
          event.centered = !event.stop;
          if (event.decision !== null) {
            event.decision.centered = event.centered;
          }
        }
      }
    },
    {
      name: "controller mode",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "target-loss-reacquisition");
        for (const event of scenario.events) {
          if (event.controllerMode === "scan") {
            event.controllerMode = "hold";
          }
        }
      }
    },
    {
      name: "a target segment marker",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        const events = scenario.events.filter((candidate) => candidate.targetSegmentIndex !== null);
        if (events.length === 0) {
          throw new Error("test report has no target segment marker");
        }
        for (const event of events) {
          if (event.targetSegmentIndex !== null) {
            event.targetSegmentIndex += 100;
          }
        }
      }
    },
    {
      name: "an uncaused lane clear",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        const event = scenario.events.find(
          (candidate) =>
            !candidate.stop &&
            !candidate.clear &&
            candidate.counters.pendingDepth === 0 &&
            candidate.counters.activeCalls === 0
        );
        if (event === undefined) {
          throw new Error("test report has no idle event");
        }
        event.clear = true;
      }
    },
    {
      name: "home acknowledgement chronology",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        const stop = requireFirstStopEventInScenario(scenario);
        if (stop.homeAcknowledgedAtMs === null) {
          throw new Error("test report has no home acknowledgement");
        }
        stop.homeAcknowledgedAtMs += 1;
      }
    },
    {
      name: "post-stop probe counters",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        const probe = requireFirstStopEventInScenario(scenario).postStopProbe;
        if (probe === null) {
          throw new Error("test report has no post-stop probe");
        }
        probe.dispatchedBefore = 999;
        probe.dispatchedAfter = 999;
        probe.confirmedBefore = 888;
        probe.confirmedAfter = 888;
      }
    },
    {
      name: "runtime maximum concurrency",
      mutate: (report: MutableReplayReport) => {
        const scenario = requireMutableScenario(report, "slow-continuous-tracking");
        const evidence = requireFirstStopEventInScenario(scenario).finalRuntimeEvidence;
        if (evidence === null) {
          throw new Error("test report has no final runtime evidence");
        }
        evidence.maximumConcurrentObservationTicks = 99;
      }
    }
  ])("requires fresh current-producer equality when $name is self-consistently changed", async ({
    mutate
  }) => {
    await withReplayReport(async (report) => {
      const candidate = reduceMutatedReplayEvidence(report, mutate);

      expect(() => validateStackChanAttentionReplayReport(candidate)).not.toThrow();
      await expect(verifyQualifiedReplayAgainstFreshCurrentProducer(candidate)).rejects.toThrow(
        "does not match fresh current producer"
      );
    });
  });

  it.each([
    {
      name: "a missing key",
      mutate: (report: MutableReplayReport) => {
        delete report.status;
      }
    },
    {
      name: "an extra key",
      mutate: (report: MutableReplayReport) => {
        report.unexpected = true;
      }
    },
    {
      name: "an unexpected type",
      mutate: (report: MutableReplayReport) => {
        requireFirstEvent(report).counters.accepted = "1";
      }
    },
    {
      name: "a non-finite number",
      mutate: (report: MutableReplayReport) => {
        requireFirstEvent(report).timestampMs = Number.NaN;
      }
    },
    {
      name: "a non-monotonic timestamp",
      mutate: (report: MutableReplayReport) => {
        const events = requireFirstScenario(report).events;
        const first = events[0];
        const second = events[1];
        if (first === undefined || second === undefined) {
          throw new Error("test report has too few events");
        }
        second.timestampMs = first.timestampMs;
      }
    },
    {
      name: "a report schema hash mismatch",
      mutate: (report: MutableReplayReport) => {
        report.reportSchemaHash = ZERO_HASH;
      }
    },
    {
      name: "an event schema hash mismatch",
      mutate: (report: MutableReplayReport) => {
        report.eventSchemaHash = ZERO_HASH;
      }
    }
  ])("fails closed when the report contains $name", async ({ mutate }) => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      mutate(candidate);
      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("recomputes all derived fields from raw events and ignores stored aggregate tampering", async () => {
    await withReplayReport((report) => {
      const normalized = normalizeStackChanAttentionReplayReport(report);
      const tampered = structuredClone(report) as unknown as MutableReplayReport;
      const scenario = requireFirstScenario(tampered);
      scenario.aggregates.dispatchCount = 999_999;
      scenario.aggregates.initialEffectiveConfirmedProgressLatencyMs.p95 = 999_999;
      scenario.aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress = 999_999;
      scenario.invariants.angleBounds = false;
      scenario.canonicalHash = ZERO_HASH;

      expect(normalizeStackChanAttentionReplayReport(tampered)).toEqual(normalized);
    });
  });

  it("separates qualified evidence from explicitly historical normalization", async () => {
    await withReplayReport((report) => {
      const normalized = normalizeStackChanAttentionReplayReport(report);

      expect(report.evidenceKind).toBe("qualified");
      expect(report.runtimeEvidenceSource).toBe("recorded-final-events");
      expect(report.producerSourceHash).toMatch(HASH_PATTERN);
      expect(normalized.evidenceKind).toBe("historical-normalized");
      expect(normalized.runtimeEvidenceSource).toBe("legacy-scenario-status");
      expect(normalized.producerSourceHash).toBeNull();
      expect(normalized.repeatDeterminism.requested).toBe(1);
      expect(() =>
        validateStackChanAttentionReplayReport(normalized, "historical-normalized")
      ).not.toThrow();
      expect(() => validateStackChanAttentionReplayReport(normalized)).toThrow(
        "report.evidenceKind mismatch"
      );
      expect(() =>
        assertStackChanAttentionReplayReportsComparable(
          normalized,
          structuredClone(normalized),
          "historical-normalized"
        )
      ).not.toThrow();
    });
  });

  it("rejects unknown producer provenance for qualified evidence", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      // eslint-disable-next-line unicorn/no-null -- JSON null is the unknown-provenance sentinel.
      candidate.producerSourceHash = null;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.producerSourceHash"
      );
    });
  });

  it("rejects missing or misplaced final runtime event evidence", async () => {
    await withReplayReport((report) => {
      const missing = structuredClone(report) as unknown as MutableReplayReport;
      // eslint-disable-next-line unicorn/no-null -- This mutation exercises the JSON null boundary.
      requireFirstStopEvent(missing).finalRuntimeEvidence = null;
      expect(() => validateStackChanAttentionReplayReport(missing)).toThrow(
        "final runtime evidence boundary mismatch"
      );

      const misplaced = structuredClone(report) as unknown as MutableReplayReport;
      const stopEvidence = requireFirstStopEvent(misplaced).finalRuntimeEvidence;
      if (stopEvidence === null) {
        throw new Error("test report has no final runtime evidence");
      }
      requireFirstEvent(misplaced).finalRuntimeEvidence = structuredClone(stopEvidence);
      expect(() => validateStackChanAttentionReplayReport(misplaced)).toThrow(
        "final runtime evidence boundary mismatch"
      );
    });
  });

  it("binds final runtime event evidence to the scenario runtime summary", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const finalRuntimeEvidence = requireFirstStopEvent(candidate).finalRuntimeEvidence;
      if (finalRuntimeEvidence === null) {
        throw new Error("test report has no final runtime evidence");
      }
      finalRuntimeEvidence.framesProcessed += 1;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "attention replay final runtime evidence mismatch"
      );
    });
  });

  it("rejects a qualified subrun whose captured-frame evidence is incomplete", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          const observation = slow.events.find((event) => !event.stop);
          if (observation === undefined) {
            throw new Error("test report has no slow observation");
          }
          // eslint-disable-next-line unicorn/no-null -- This mutation exercises missing JSON evidence.
          observation.frameSequence = null;
        })
      ).toThrow("captured frame evidence mismatch");
    });
  });

  it("fails qualification when a stop event reports a non-stopped runtime phase", async () => {
    await withReplayReport((report) => {
      const candidate = reduceMutatedReplayEvidence(report, (mutable) => {
        const slow = requireMutableScenario(mutable, "slow-continuous-tracking");
        const finalEvidence = requireFirstStopEventInScenario(slow).finalRuntimeEvidence;
        if (finalEvidence === null) {
          throw new Error("test report has no final runtime evidence");
        }
        finalEvidence.phase = "running";
      });
      const slow = requireScenario(candidate, "slow-continuous-tracking");

      expect(slow.invariants.runtimeStopped).toBe(false);
      expect(slow.status).toBe("failed");
      expect(candidate.status).toBe("failed");
      expect(() => validateStackChanAttentionReplayReport(candidate)).not.toThrow();
    });
  });

  it("rejects a cumulative safety counter that decreases within a subrun", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          const observation = slow.events.find((event) => !event.stop);
          if (observation === undefined) {
            throw new Error("test report has no slow observation");
          }
          observation.counters.staleDiscarded = 1;
        })
      ).toThrow("cumulative counter decreased");
    });
  });

  it("rejects observation evidence attached to a stop event", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          requireFirstStopEventInScenario(slow).frameSequence = 50;
        })
      ).toThrow("stop event contains observation evidence");
    });
  });

  it("binds dispatch and confirmation events to cumulative counter deltas", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          for (const event of slow.events) {
            event.counters.dispatched = 0;
            event.counters.confirmed = 0;
          }
        })
      ).toThrow("event counter delta mismatch");
    });
  });

  it("binds confirmed no-op discards to an explicit request sequence marker", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          for (const event of slow.events) {
            event.counters.noOpDiscarded = 1;
          }
        })
      ).toThrow("event counter delta mismatch: noOpDiscarded");
    });
  });

  it("rejects a replaced request dispatched later from an idle lane", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          injectReplacedRequestDispatch(slow);
        })
      ).toThrow("dispatch is not current pending request");
    });
  });

  it("rejects a qualified lane whose final active command failed", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          injectFinalActiveFailure(slow);
        })
      ).toThrow("qualified lane contains a device failure");
    });
  });

  it("rejects request identities that disagree with the accepted counter", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          for (const event of slow.events) {
            event.requestSequence = reverseSequence(event.requestSequence);
            event.dispatchSequence = reverseSequence(event.dispatchSequence);
            event.confirmedSequence = reverseSequence(event.confirmedSequence);
          }
        })
      ).toThrow("request sequence does not match accepted counter");
    });
  });

  it("binds every qualified event to its canonical scenario subrun", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const fast = requireMutableScenario(candidate, "fast-reversals");
          const observation = fast.events.find((event) => !event.stop);
          if (observation === undefined) {
            throw new Error("test report has no fast observation");
          }
          observation.variant = "track-moving";
        })
      ).toThrow("scenario event subrun roster mismatch");
    });
  });

  it("rejects confirmed-pose motion without a confirmation event", async () => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const fast = requireMutableScenario(candidate, "fast-reversals");
          const event = fast.events.find(
            (candidate) => !candidate.stop && candidate.confirmedSequence === null
          );
          if (event === undefined) {
            throw new Error("test report has no unconfirmed fast observation");
          }
          event.rpcConfirmedPose.yaw += 1;
        })
      ).toThrow("confirmed pose changed without confirmation");
    });
  });

  it.each([
    {
      name: "a request sequence without its pose",
      mutate: (event: MutableEvent) => {
        // eslint-disable-next-line unicorn/no-null -- This mutation exercises missing JSON evidence.
        event.requestedPose = null;
      },
      select: (events: MutableEvent[]) => events.find((event) => event.requestSequence !== null)
    },
    {
      name: "a dispatch sequence without its pose",
      mutate: (event: MutableEvent) => {
        // eslint-disable-next-line unicorn/no-null -- This mutation exercises missing JSON evidence.
        event.dispatchedPose = null;
      },
      select: (events: MutableEvent[]) =>
        events.find(
          (event) => event.dispatchSequence !== null && event.noOpDiscardedSequence === null
        )
    }
  ])("rejects $name", async ({ mutate, select }) => {
    await withReplayReport((report) => {
      expect(() =>
        reduceMutatedReplayEvidence(report, (candidate) => {
          const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
          const event = select(slow.events);
          if (event === undefined) {
            throw new Error("test report has no matching pose event");
          }
          mutate(event);
        })
      ).toThrow("event pose binding mismatch");
    });
  });

  it("rejects a self-rehashed qualified canonical input outside the fixed fixture", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const slow = candidate.scenarios[1];
      if (slow === undefined || typeof slow.canonicalInput.durationMs !== "number") {
        throw new Error("test report slow scenario input is missing");
      }
      slow.canonicalInput.durationMs += 125;
      rebindScenarioContractHashes(candidate);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.scenarios[1].canonicalInput mismatch"
      );
    });
  });

  it("rejects a top-level status that disagrees with the reduced scenario statuses", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.status = candidate.status === "passed" ? "failed" : "passed";

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.status mismatch"
      );
    });
  });

  it("rejects fixture metadata whose content does not match fixtureHash", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.metadata.fixture.seed += 1;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects qualified repeat canonical hashes that disagree with the canonical report", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.canonicalHashes[0] = ALTERNATE_HASH;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects qualified repeat scenario hashes that disagree with the scenario report", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const firstRun = candidate.repeatDeterminism.scenarioHashes[0];
      if (firstRun === undefined) {
        throw new Error("test report has no qualified repeat scenario hashes");
      }
      firstRun["static-hold"] = ALTERNATE_HASH;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects qualified repeat comparison hashes that disagree with comparisonSetHash", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.comparisonSetHashes[0] = ALTERNATE_HASH;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects deterministic qualification when repeated canonical evidence disagrees", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.canonicalHashes[1] = ALTERNATE_HASH;
      candidate.repeatDeterminism.deterministic = true;

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects qualification with fewer than three repeats", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.requested = 2;
      candidate.repeatDeterminism.canonicalHashes =
        candidate.repeatDeterminism.canonicalHashes.slice(0, 2);
      candidate.repeatDeterminism.scenarioHashes = candidate.repeatDeterminism.scenarioHashes.slice(
        0,
        2
      );
      candidate.repeatDeterminism.comparisonSetHashes =
        candidate.repeatDeterminism.comparisonSetHashes.slice(0, 2);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects a claimed repeat count backed only by copied hash attestations", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.requested = 100;
      candidate.repeatDeterminism.canonicalHashes = Array.from(
        { length: 100 },
        () => candidate.repeatDeterminism.canonicalHashes[0] ?? ZERO_HASH
      );
      candidate.repeatDeterminism.scenarioHashes = Array.from({ length: 100 }, () =>
        structuredClone(candidate.repeatDeterminism.scenarioHashes[0] ?? {})
      );
      candidate.repeatDeterminism.comparisonSetHashes = Array.from(
        { length: 100 },
        () => candidate.comparisonSetHash
      );

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.repeatDeterminism.requested is invalid"
      );
    });
  });

  it("rejects repeat hash attestations without one raw evidence run each", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      candidate.repeatDeterminism.evidenceRuns = candidate.repeatDeterminism.evidenceRuns.slice(
        0,
        1
      );

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.repeatDeterminism.evidenceRuns length mismatch"
      );
    });
  });

  it("rejects duplicate canonical scenarios even when contract hashes are rebound", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const first = candidate.scenarios[0];
      if (first === undefined) {
        throw new Error("test report has no canonical scenarios");
      }
      candidate.scenarios[candidate.scenarios.length - 1] = structuredClone(first);
      rebindScenarioContractHashes(candidate);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects a missing canonical scenario even when the scenario count remains unchanged", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const replacement = candidate.scenarios[1];
      if (replacement === undefined) {
        throw new Error("test report has too few canonical scenarios");
      }
      candidate.scenarios[2] = structuredClone(replacement);
      rebindScenarioContractHashes(candidate);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects out-of-order canonical scenarios even when contract hashes are rebound", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const first = candidate.scenarios[0];
      const second = candidate.scenarios[1];
      if (first === undefined || second === undefined) {
        throw new Error("test report has too few canonical scenarios");
      }
      candidate.scenarios[0] = second;
      candidate.scenarios[1] = first;
      rebindScenarioContractHashes(candidate);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow();
    });
  });

  it("rejects out-of-order historical stop variants", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(
        normalizeStackChanAttentionReplayReport(report)
      ) as unknown as MutableReplayReport;
      const stopHome = candidate.scenarios.find((scenario) => scenario.id === "stop-home");
      if (stopHome?.canonicalInput.id !== "stop-home") {
        throw new Error("test report has no stop-home scenario");
      }
      const variants = stopHome.canonicalInput.variants;
      if (variants === undefined) {
        throw new Error("test report has no stop-home variants");
      }
      variants.reverse();
      rebindScenarioContractHashes(candidate);

      expect(() =>
        validateStackChanAttentionReplayReport(candidate, "historical-normalized")
      ).toThrow("stop variant order mismatch");
    });
  });

  it("rejects a scenario id that disagrees with canonicalInput.id at the trust boundary", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const scenario = requireFirstScenario(candidate);
      scenario.id = "slow-continuous-tracking";

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(
        "report.scenarios[0].id does not match canonicalInput.id"
      );
    });
  });

  it.each([
    {
      name: "processed frame counts not supported by raw events",
      expectedError: "report.scenarios[0].runtimeStatus.framesProcessed mismatch",
      mutate: (status: MutableRuntimeStatus) => {
        status.framesProcessed += 1;
        status.expectedFramesProcessed += 1;
      }
    },
    {
      name: "an accepted frame sequence not supported by raw events",
      expectedError: "report.scenarios[0].runtimeStatus.lastAcceptedFrameSequence mismatch",
      mutate: (status: MutableRuntimeStatus) => {
        status.lastAcceptedFrameSequence =
          status.lastAcceptedFrameSequence === null ? 1 : status.lastAcceptedFrameSequence + 1;
      }
    },
    {
      name: "a lifecycle phase not supported by raw events",
      expectedError: "report.scenarios[0].runtimeStatus.phase mismatch",
      mutate: (status: MutableRuntimeStatus) => {
        status.phase = "running";
      }
    },
    {
      name: "an error history whose length disagrees with errorCount",
      expectedError: "report.scenarios[0].runtimeStatus.errorCount mismatch",
      mutate: (status: MutableRuntimeStatus) => {
        status.errorCount += 1;
      }
    },
    {
      name: "observation tick counts not supported by raw events",
      expectedError: "report.scenarios[0].runtimeStatus.observationTicksStarted mismatch",
      mutate: (status: MutableRuntimeStatus) => {
        status.observationTicksStarted += 1;
        status.observationTicksCompleted += 1;
        status.expectedObservationTicks += 1;
      }
    }
  ])("rejects runtimeStatus with $name", async ({ mutate, expectedError }) => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      mutate(requireFirstScenario(candidate).runtimeStatus);

      expect(() => validateStackChanAttentionReplayReport(candidate)).toThrow(expectedError);
    });
  });

  it("refuses A/B comparison when any comparison-set hash differs", async () => {
    await withReplayReport((report) => {
      for (const field of [
        "reportSchemaHash",
        "eventSchemaHash",
        "metricDefinitionHash",
        "metricImplementationHash",
        "acceptanceProfileHash",
        "fixtureHash",
        "scenarioInputHash",
        "comparisonSetHash"
      ] as const) {
        const candidate = structuredClone(report) as unknown as MutableReplayReport;
        candidate[field] = ZERO_HASH;
        expect(() =>
          assertStackChanAttentionReplayReportsComparable(report, candidate as never)
        ).toThrow(field);
      }
    });
  });

  it("allows producer provenance to differ without changing the comparison set", async () => {
    await withReplayReport((report) => {
      const candidate = {
        ...structuredClone(report),
        producerSourceHash: "1".repeat(64)
      };

      expect(() => validateStackChanAttentionReplayReport(candidate)).not.toThrow();
      expect(() =>
        assertStackChanAttentionReplayReportsComparable(report, candidate)
      ).not.toThrow();
      expect(candidate.comparisonSetHash).toBe(report.comparisonSetHash);
    });
  });

  it("defines every objective and guardrail as a closed version-6 check spec", () => {
    expect(STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.version).toBe(6);
    expect(STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.checks).toHaveLength(30);
    expect(STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.checks).toEqual([
      {
        id: "slow-tracking-provably-redundant-dispatches",
        kind: "objective",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.trackingProvablyRedundantDispatches",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "slow-tracking-provably-redundant-occupancy",
        kind: "objective",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.trackingProvablyRedundantOccupancyMs",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "fast-tracking-provably-redundant-dispatches",
        kind: "objective",
        scenarioId: "fast-reversals",
        metric: "aggregates.trackingProvablyRedundantDispatches",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "fast-tracking-provably-redundant-occupancy",
        kind: "objective",
        scenarioId: "fast-reversals",
        metric: "aggregates.trackingProvablyRedundantOccupancyMs",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "slow-tracking-provably-redundant-discards",
        kind: "objective",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.trackingProvablyRedundantDiscarded",
        rule: { type: "absolute-minimum", minimum: 1 }
      },
      {
        id: "fast-tracking-provably-redundant-discards",
        kind: "objective",
        scenarioId: "fast-reversals",
        metric: "aggregates.trackingProvablyRedundantDiscarded",
        rule: { type: "absolute-minimum", minimum: 1 }
      },
      {
        id: "fast-confirmed-jerk-p95",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.confirmedKinematics.jerk.combined.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "slow-target-error-p95",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.targetAbsoluteError.combined.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "fast-target-error-p95",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.targetAbsoluteError.combined.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "slow-centered-ratio",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.centeredRatio",
        rule: { type: "maximum-absolute-drop", maximumDrop: 0.02 }
      },
      {
        id: "slow-settling-p95",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.settlingMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "fast-settling-p95",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.settlingMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "slow-effective-progress-p95",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.effectiveConfirmedProgressIntervalMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "fast-effective-progress-p95",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.effectiveConfirmedProgressIntervalMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "slow-initial-effective-progress-p95",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.initialEffectiveConfirmedProgressLatencyMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "fast-initial-effective-progress-p95",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.initialEffectiveConfirmedProgressLatencyMs.p95",
        rule: { type: "relative-maximum-regression", maximumRatio: 0.05 }
      },
      {
        id: "slow-tracking-episodes-without-progress",
        kind: "guardrail",
        scenarioId: "slow-continuous-tracking",
        metric: "aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "fast-tracking-episodes-without-progress",
        kind: "guardrail",
        scenarioId: "fast-reversals",
        metric: "aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "target-loss-waypoint-reach",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.waypointReachRatio",
        rule: { type: "absolute-minimum", minimum: 1 }
      },
      {
        id: "target-loss-premature-waypoint-advances",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.prematureWaypointAdvances",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "target-loss-insufficient-post-arrival-dwells",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.insufficientPostArrivalDwells",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "target-loss-same-pose-scan-dispatches",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.samePoseScanDispatches",
        rule: { type: "absolute-maximum", maximum: 0 }
      },
      {
        id: "target-loss-post-arrival-dwell",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.minimumPostArrivalDwellMs",
        rule: {
          type: "absolute-minimum",
          minimum: STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.scanDwellMs
        }
      },
      {
        id: "target-loss-reacquisition-latency",
        kind: "guardrail",
        scenarioId: "target-loss-reacquisition",
        metric: "aggregates.reacquisitionLatencyMs",
        rule: { type: "absolute-maximum", maximum: 2_125 }
      },
      ...(
        [
          "static-hold",
          "slow-continuous-tracking",
          "fast-reversals",
          "target-loss-reacquisition",
          "stop-home"
        ] as const
      ).map((scenarioId) => ({
        id: `${scenarioId}-absolute-safety`,
        kind: "guardrail" as const,
        scenarioId,
        metric: "invariants.absoluteSafety",
        rule: { type: "absolute-boolean" as const, expected: true }
      })),
      {
        id: "stop-home-variants-qualified",
        kind: "guardrail",
        scenarioId: "stop-home",
        metric: "invariants.stopVariantsQualified",
        rule: { type: "absolute-boolean", expected: true }
      }
    ]);
  });

  it("returns a closed verdict bound to both canonical reports without embedding it in v6", async () => {
    await withReplayReport((report) => {
      const verdict = evaluateStackChanAttentionReplayAcceptance(report, report);
      const objectives = verdict.checks.filter((check) => check.kind === "objective");
      const expectedStatus = verdict.checks.every((check) => check.status === "passed")
        ? "accepted"
        : "rejected";

      expect(verdict).toEqual({
        verdictVersion: 1,
        status: expectedStatus,
        acceptanceProfileVersion: 6,
        acceptanceProfileHash: report.acceptanceProfileHash,
        comparisonSetHash: report.comparisonSetHash,
        baselineCanonicalReportHash: canonicalHash(report),
        candidateCanonicalReportHash: canonicalHash(report),
        checks: verdict.checks
      });
      expect(verdict.checks).toHaveLength(
        STACKCHAN_ATTENTION_REPLAY_ACCEPTANCE_PROFILE.checks.length
      );
      expect(objectives).toHaveLength(6);
      expect(verdict.status).toBe(expectedStatus);
      expect(
        verdict.checks.every((check) =>
          check.status === "passed" ? check.failureReason === null : check.failureReason !== null
        )
      ).toBe(true);
      expect(Object.hasOwn(report, "acceptanceVerdict")).toBe(false);

      const reportSchema = loadStackChanAttentionReplaySchema();
      const verdictSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/acceptanceVerdict",
        $defs: reportSchema.$defs
      };
      expect(() =>
        validateStackChanAttentionReplaySchemaValue(verdict, verdictSchema)
      ).not.toThrow();
      expect(() =>
        validateStackChanAttentionReplaySchemaValue({ ...verdict, unexpected: true }, verdictSchema)
      ).toThrow("additional property is not allowed");
    });
  });

  it("permits producer changes but fails closed on non-qualified or invalid pair inputs", async () => {
    await withReplayReport((report) => {
      const changedProducer = {
        ...structuredClone(report),
        producerSourceHash: ALTERNATE_HASH
      };
      expect(() =>
        evaluateStackChanAttentionReplayAcceptance(report, changedProducer)
      ).not.toThrow();

      const historical = normalizeStackChanAttentionReplayReport(report);
      expect(() => evaluateStackChanAttentionReplayAcceptance(report, historical)).toThrow(
        "report.evidenceKind mismatch"
      );

      // eslint-disable-next-line unicorn/no-null -- Null is an explicit fail-closed metric case.
      for (const invalid of [null, Number.NaN, -1] as const) {
        const candidate = structuredClone(report) as unknown as MutableReplayReport;
        const slow = requireMutableScenario(candidate, "slow-continuous-tracking");
        (
          slow as MutableScenario & {
            aggregates: { centeredRatio: number | null };
          }
        ).aggregates.centeredRatio = invalid;
        expect(() =>
          evaluateStackChanAttentionReplayAcceptance(report, candidate as never)
        ).toThrow();
      }
    });
  });

  it("exercises the static dead-zone and release boundary on both axes", async () => {
    await withReplayReport((report) => {
      const scenario = requireScenario(report, "static-hold");
      const observations = scenario.events.filter((event) => event.frameSequence !== null);
      const normalizedYaw = new Set(
        observations.map((event) => event.targetNormalizedError?.yaw ?? Number.NaN)
      );
      const normalizedPitch = new Set(
        observations.map((event) => event.targetNormalizedError?.pitch ?? Number.NaN)
      );

      expect(observations.length).toBeGreaterThanOrEqual(32);
      for (const value of [0, -0.09, 0.09, -0.11, 0.11, -0.13, 0.13, -0.15, 0.15]) {
        expect(normalizedYaw.has(value) || normalizedPitch.has(value)).toBe(true);
      }
      expect(scenario.aggregates.staticBoundaryObservationCount).toBe(observations.length);
      expect(scenario.aggregates.staticBoundaryPrematureReleaseCount).toBe(0);
      expect(scenario.aggregates.staticBoundaryRequestOverflowCount).toBe(0);
      expect(scenario.invariants.staticBoundaryQualified).toBe(true);
    });
  });

  it("qualifies slow and fast tracking without target-loss contamination", async () => {
    await withReplayReport((report) => {
      const slow = requireScenario(report, "slow-continuous-tracking");
      const fast = requireScenario(report, "fast-reversals");

      expect(slow.aggregates.visibilityRatio).toBeGreaterThanOrEqual(0.95);
      expect(slow.aggregates.scanDispatchCount).toBe(0);
      expect(slow.aggregates.targetAbsoluteError.combined.count).toBeGreaterThan(0);
      expect(slow.aggregates.confirmedKinematics.velocity.combined.count).toBeGreaterThan(0);
      expect(slow.aggregates.settlingCensoredCount).toBeLessThanOrEqual(1);
      expect(slow.aggregates.effectiveConfirmedProgressIntervalMs.p95).toBeLessThanOrEqual(500);
      expect(slow.invariants.slowTrackingQualified).toBe(true);

      expect(fast.aggregates.visibilityRatio).toBeGreaterThanOrEqual(0.95);
      expect(fast.aggregates.plannedTargetReversals).toBeGreaterThanOrEqual(6);
      expect(fast.aggregates.scanDispatchCount).toBe(0);
      expect(fast.aggregates.effectiveConfirmedMovements).toBeGreaterThanOrEqual(16);
      expect(fast.aggregates.trackingRequiredReversalDispatches).toBe(0);
      expect(fast.aggregates.trackingRequiredReversalOccupancyMs).toBe(
        fast.aggregates.trackingRequiredReversalDispatches *
          STACKCHAN_ATTENTION_REPLAY_FIXTURE.virtualDeviceCommandDurationMs
      );
      expect(fast.aggregates.trackingProvablyRedundantDispatches).toBe(0);
      expect(fast.aggregates.trackingProvablyRedundantOccupancyMs).toBe(0);
      const trackingDispatches = fast.events.filter(
        (event) => event.controllerMode === "track" && event.dispatchedPose !== null
      ).length;
      expect(
        fast.aggregates.trackingOrdinaryDispatches +
          fast.aggregates.trackingRequiredReversalDispatches +
          fast.aggregates.trackingProvablyRedundantDispatches
      ).toBe(trackingDispatches);
      expect(fast.aggregates.reversalResponseLatencyMs.count).toBeGreaterThanOrEqual(1);
      expect(fast.aggregates.reversalResponseLatencyMs.p95).toBeLessThanOrEqual(
        STACKCHAN_ATTENTION_REPLAY_FIXTURE.follow.frameIntervalMs
      );
      expect(fast.aggregates.settlingUncensoredRatio).toBeGreaterThanOrEqual(0.8);
      expect(fast.invariants.fastReversalQualified).toBe(true);
    });
  });

  it("qualifies every stop/home variant independently and fails the aggregate by AND", async () => {
    await withReplayReport((report) => {
      const stop = requireScenario(report, "stop-home");
      if (stop.stopVariants === null) {
        throw new Error("stop-home variants are missing");
      }

      expect(Object.keys(stop.stopVariants)).toEqual([
        "track-moving",
        "pending-present",
        "scan-active"
      ]);
      for (const variant of Object.values(stop.stopVariants)) {
        expect(variant.status).toBe("passed");
        expect(variant.preconditionReached).toBe(true);
        expect(variant.runtimeStopped).toBe(true);
        expect(variant.laneStopped).toBe(true);
        expect(variant.schedulerTickRejected).toBe(true);
        expect(variant.stoppedLaneUpdateRejected).toBe(true);
        expect(variant.pendingDrained).toBe(true);
        expect(variant.activeDrained).toBe(true);
        expect(variant.noPostStopDispatch).toBe(true);
        expect(variant.homeAcknowledged).toBe(true);
        expect(variant.homeErrorDeg).toEqual({ yaw: 0, pitch: 0 });
        expect(variant.homeAcknowledgementCount).toBe(1);
      }
      expect(stop.invariants.stopVariantsQualified).toBe(true);
    });
  });

  it("creates the pending-present stop precondition from a distinct latest target", async () => {
    await withReplayReport((report) => {
      const stop = requireScenario(report, "stop-home");
      const pendingEvents = stop.events.filter(
        (event) => event.variant === "pending-present" && !event.stop
      );
      const preconditionIndex = pendingEvents.findIndex(
        (event) => event.counters.activeCalls === 1 && event.counters.pendingDepth === 1
      );
      const precondition = pendingEvents[preconditionIndex];
      const activeDispatch = pendingEvents
        .slice(0, preconditionIndex)
        .reverse()
        .find((event) => event.dispatchedPose !== null);

      expect(precondition).toBeDefined();
      expect(activeDispatch).toBeDefined();
      expect(precondition?.requestedPose).not.toEqual(activeDispatch?.dispatchedPose);
      expect(precondition?.targetWorldPose).not.toEqual(activeDispatch?.targetWorldPose);
    });
  });

  it.each([
    "track-moving",
    "pending-present",
    "scan-active"
  ] as const)("fails only the %s stop/home variant when its scheduler remains usable", async (failedVariant) => {
    const directory = await mkdtemp(join(tmpdir(), "pico-attention-stop-variant-"));
    const reportOutput = resolve(directory, "report.json");
    try {
      const report = await runStackChanAttentionReplay(
        { reportOutput, repeat: 3, producerSourceHash: TEST_PRODUCER_SOURCE_HASH },
        {
          postStopProbe(probe, context) {
            return context.variant === failedVariant
              ? { ...probe, schedulerTickRejected: false }
              : probe;
          }
        }
      );
      const stop = requireScenario(report, "stop-home");
      if (stop.stopVariants === null) {
        throw new Error("stop-home variants are missing");
      }

      expect(report.status).toBe("failed");
      expect(stop.status).toBe("failed");
      expect(stop.invariants.stopVariantsQualified).toBe(false);
      expect(stop.stopVariants[failedVariant].status).toBe("failed");
      for (const [variant, result] of Object.entries(stop.stopVariants)) {
        if (variant !== failedVariant) {
          expect(result.status).toBe("passed");
        }
      }
    } finally {
      await chmod(reportOutput, 0o600).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails static qualification when one boundary observation is absent", async () => {
    await withReplayReport((report) => {
      const candidate = structuredClone(report) as unknown as MutableReplayReport;
      const scenario = candidate.scenarios[0];
      const event = scenario?.events.find(
        (item) => (item as MutableEvent & { isProbeObservation?: boolean }).isProbeObservation
      ) as (MutableEvent & { isProbeObservation: boolean }) | undefined;
      if (event === undefined) {
        throw new Error("static boundary observation is missing");
      }
      event.isProbeObservation = false;

      const normalized = normalizeStackChanAttentionReplayReport(candidate);
      const staticHold = requireScenario(normalized, "static-hold");
      expect(staticHold.status).toBe("failed");
      expect(staticHold.invariants.staticBoundaryQualified).toBe(false);
      expect(normalized.status).toBe("failed");
    });
  });

  it("records semantically consistent no-op and effective-progress observations per scenario", async () => {
    await withReplayReport((report) => {
      for (const scenario of report.scenarios) {
        const discardMarkers = scenario.events.filter(
          (event) => event.noOpDiscardedSequence !== null
        ).length;
        const finalDiscardCount = scenario.events
          .filter((event) => event.stop)
          .reduce((sum, event) => sum + event.counters.noOpDiscarded, 0);

        expect(scenario.aggregates.trackingRequiredReversalDispatches).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.trackingRequiredReversalOccupancyMs).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.trackingProvablyRedundantDispatches).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.trackingProvablyRedundantOccupancyMs).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.trackingProvablyRedundantDiscarded).toBe(discardMarkers);
        expect(scenario.aggregates.trackingOrdinaryDispatches).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.reversalResponseLatencyMs.count).toBeGreaterThanOrEqual(0);
        expect(discardMarkers).toBe(finalDiscardCount);
        expect(scenario.aggregates.sameAbsoluteTargetWhileActive).toBeGreaterThanOrEqual(0);
        expect(scenario.aggregates.pendingSameTargetReplacements).toBeGreaterThanOrEqual(0);
        expect(
          scenario.aggregates.effectiveConfirmedProgressIntervalMs.count
        ).toBeGreaterThanOrEqual(0);
        expect(
          scenario.aggregates.initialEffectiveConfirmedProgressLatencyMs.count
        ).toBeGreaterThanOrEqual(0);
        expect(
          scenario.aggregates.activeNonCenteredTrackingEpisodesWithoutConfirmedProgress
        ).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ZERO_HASH = "0".repeat(64);
const ALTERNATE_HASH = "1".repeat(64);
const TEST_PRODUCER_SOURCE_HASH = "a".repeat(64);

async function withReplayReport(
  assertion: (
    report: Awaited<ReturnType<typeof runStackChanAttentionReplay>>
  ) => Promise<void> | void
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-attention-replay-gate-"));
  const reportOutput = resolve(directory, "report.json");
  try {
    const report = await runStackChanAttentionReplay({
      reportOutput,
      repeat: 3,
      producerSourceHash: TEST_PRODUCER_SOURCE_HASH
    });
    const persisted = JSON.parse(await readFile(reportOutput, "utf8")) as unknown;
    expect(persisted).toEqual(report);
    await assertion(report);
  } finally {
    await chmod(reportOutput, 0o600).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
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

function requireMutableScenario(report: MutableReplayReport, id: string): MutableScenario {
  const scenario = report.scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`missing mutable scenario ${id}`);
  }
  return scenario;
}

function requireFirstStopEventInScenario(scenario: MutableScenario): MutableEvent {
  const event = scenario.events.find((candidate) => candidate.stop);
  if (event === undefined) {
    throw new Error(`scenario ${scenario.id} has no stop event`);
  }
  return event;
}

function injectReplacedRequestDispatch(scenario: MutableScenario): void {
  const request = requireMutableRequestEvent(scenario, 15);
  if (request.decision === null) {
    throw new Error(`scenario ${scenario.id} request 15 has no controller decision`);
  }
  request.decision.effectOutcome = "dispatched";
  const dispatchIndex = 38;
  const dispatch = requireMutableEventAt(scenario, dispatchIndex);
  const confirmation = requireMutableEventAt(scenario, dispatchIndex + 1);
  dispatch.dispatchSequence = request.requestSequence;
  dispatch.dispatchedRequestPose = structuredClone(request.requestedPose);
  dispatch.dispatchedPose = structuredClone(request.requestedPose);
  dispatch.confirmedBeforeDispatch = structuredClone(dispatch.rpcConfirmedPose);
  dispatch.plannedBeforeDispatch = structuredClone(dispatch.rpcConfirmedPose);
  dispatch.counters.activeCalls = 1;
  confirmation.confirmedSequence = request.requestSequence;
  for (const event of scenario.events.slice(dispatchIndex)) {
    event.counters.dispatched += 1;
  }
  for (const event of scenario.events.slice(dispatchIndex + 1)) {
    event.counters.confirmed += 1;
  }
  recomputeMutableDecisionTicks(scenario.events);
}

function recomputeMutableDecisionTicks(events: readonly MutableEvent[]): void {
  let ticksWithoutConfirmedUpdate = 0;
  for (const event of events) {
    if (event.confirmedSequence !== null) {
      ticksWithoutConfirmedUpdate = 0;
    } else if (event.frameSequence !== null) {
      ticksWithoutConfirmedUpdate += 1;
    }
    if (event.decision !== null) {
      event.decision.ticksWithoutConfirmedUpdate = ticksWithoutConfirmedUpdate;
    }
  }
}

function injectFinalActiveFailure(scenario: MutableScenario): void {
  const confirmationIndex = requireLastConfirmationIndex(scenario);
  const confirmation = requireMutableEventAt(scenario, confirmationIndex);
  const priorConfirmedPose = structuredClone(
    requireMutableEventAt(scenario, confirmationIndex - 1).rpcConfirmedPose
  );
  // eslint-disable-next-line unicorn/no-null -- The attack replaces confirmation with failure.
  confirmation.confirmedSequence = null;
  for (const event of scenario.events.slice(confirmationIndex)) {
    event.rpcConfirmedPose = structuredClone(priorConfirmedPose);
    event.counters.confirmed -= 1;
    event.counters.failed += 1;
  }
}

function requireLastConfirmationIndex(scenario: MutableScenario): number {
  let result: number | undefined;
  for (const [index, event] of scenario.events.entries()) {
    if (event.confirmedSequence !== null) {
      result = index;
    }
  }
  if (result === undefined) {
    throw new Error(`scenario ${scenario.id} has no confirmation`);
  }
  return result;
}

function requireMutableRequestEvent(
  scenario: MutableScenario,
  requestSequence: number
): MutableEvent & {
  requestSequence: number;
  requestedPose: { yaw: number; pitch: number };
} {
  const event = scenario.events.find((candidate) => candidate.requestSequence === requestSequence);
  if (event?.requestedPose === null || event === undefined) {
    throw new Error(`scenario ${scenario.id} has no request ${requestSequence}`);
  }
  return event as MutableEvent & {
    requestSequence: number;
    requestedPose: { yaw: number; pitch: number };
  };
}

function requireMutableEventAt(scenario: MutableScenario, index: number): MutableEvent {
  const event = scenario.events[index];
  if (event === undefined) {
    throw new Error(`scenario ${scenario.id} has no event ${index}`);
  }
  return event;
}

function reverseSequence(sequence: number | null): number | null {
  // eslint-disable-next-line unicorn/no-null -- The mutation preserves absent JSON sequence markers.
  return sequence === null ? null : 10_000 - sequence;
}

function reduceMutatedReplayEvidence(
  report: Awaited<ReturnType<typeof runStackChanAttentionReplay>>,
  mutate: (candidate: MutableReplayReport) => void
): ReturnType<typeof reduceStackChanAttentionReplayEvidence> {
  const candidate = structuredClone(report) as unknown as MutableReplayReport;
  mutate(candidate);
  const rawRun = candidate.scenarios.map((scenario) => ({
    canonicalInput: scenario.canonicalInput,
    events: scenario.events
  })) as unknown as Parameters<typeof reduceStackChanAttentionReplayEvidence>[0][number];
  return reduceStackChanAttentionReplayEvidence(
    [structuredClone(rawRun), structuredClone(rawRun), structuredClone(rawRun)],
    3,
    {
      evidenceKind: "qualified",
      runtimeEvidenceSource: "recorded-final-events",
      producerSourceHash: TEST_PRODUCER_SOURCE_HASH
    }
  );
}

type MutableReplayReport = {
  [key: string]: unknown;
  status?: "passed" | "failed";
  unexpected?: unknown;
  reportSchemaHash: string;
  eventSchemaHash: string;
  metricDefinitionHash: string;
  metricImplementationHash: string;
  acceptanceProfileHash: string;
  fixtureHash: string;
  scenarioInputHash: string;
  producerSourceHash: string | null;
  comparisonSetHash: string;
  metadata: {
    fixture: {
      seed: number;
    };
  };
  scenarios: MutableScenario[];
  repeatDeterminism: {
    requested: number;
    deterministic: boolean;
    evidenceRuns: { canonicalInput: unknown; events: MutableEvent[] }[][];
    canonicalHashes: string[];
    scenarioHashes: Record<string, string>[];
    comparisonSetHashes: string[];
  };
};

type MutableScenario = {
  id: string;
  canonicalInput: {
    id: string;
    durationMs?: number;
    variants?: { variant: string }[];
  };
  canonicalHash: string;
  events: MutableEvent[];
  aggregates: {
    dispatchCount: number;
    initialEffectiveConfirmedProgressLatencyMs: { p95: number | null };
    activeNonCenteredTrackingEpisodesWithoutConfirmedProgress: number;
  };
  invariants: { angleBounds: boolean };
  runtimeStatus: MutableRuntimeStatus;
};

type MutableEvent = {
  variant: null | "track-moving" | "pending-present" | "scan-active";
  frameSequence: number | null;
  targetWorldPose: { yaw: number; pitch: number } | null;
  targetSegmentIndex: number | null;
  detectorState: "visible" | "occluded" | "outside-fov" | null;
  targetErrorDeg: { yaw: number; pitch: number } | null;
  targetNormalizedError: { yaw: number; pitch: number } | null;
  centered: boolean;
  controllerMode: "acquire" | "track" | "hold" | "scan";
  decision: {
    decisionAtMs: number;
    observedAtMs: number;
    centered: boolean;
    effectOutcome: "dispatched" | "replaced" | "noop" | "stale" | "none";
    ticksWithoutConfirmedUpdate: number;
  } | null;
  requestSequence: number | null;
  requestedPose: { yaw: number; pitch: number } | null;
  dispatchSequence: number | null;
  dispatchedRequestPose: { yaw: number; pitch: number } | null;
  dispatchedPose: { yaw: number; pitch: number } | null;
  confirmedSequence: number | null;
  noOpDiscardedSequence: number | null;
  confirmedBeforeDispatch: { yaw: number; pitch: number };
  plannedBeforeDispatch: { yaw: number; pitch: number };
  rpcConfirmedPose: { yaw: number; pitch: number };
  timestampMs: number;
  counters: {
    accepted: number | string;
    replaced: number;
    dispatched: number;
    confirmed: number;
    failed: number;
    staleDiscarded: number;
    noOpDiscarded: number;
    pendingDepth: number;
    activeCalls: number;
    maximumPendingDepth: number;
    maximumActiveCalls: number;
  };
  clear: boolean;
  stop: boolean;
  stopRequestedAtMs: number | null;
  homeAcknowledgedAtMs: number | null;
  postStopProbe: {
    dispatchedBefore: number;
    dispatchedAfter: number;
    confirmedBefore: number;
    confirmedAfter: number;
  } | null;
  finalRuntimeEvidence: MutableFinalRuntimeEvidence | null;
};

type MutableFinalRuntimeEvidence = {
  phase: "idle" | "starting" | "running" | "stopping" | "stopped";
  framesProcessed: number;
  maximumConcurrentObservationTicks: number;
};

type MutableRuntimeStatus = {
  phase: "idle" | "starting" | "running" | "stopping" | "stopped";
  framesProcessed: number;
  lastAcceptedFrameSequence: number | null;
  observationTicksStarted: number;
  observationTicksCompleted: number;
  expectedFramesProcessed: number;
  expectedObservationTicks: number;
  errorCount: number;
  errorCodes: string[];
};

function requireFirstScenario(report: MutableReplayReport): MutableScenario {
  const scenario = report.scenarios[0];
  if (scenario === undefined) {
    throw new Error("test report has no scenarios");
  }
  return scenario;
}

function requireFirstEvent(report: MutableReplayReport): MutableEvent {
  const event = requireFirstScenario(report).events[0];
  if (event === undefined) {
    throw new Error("test report has no events");
  }
  return event;
}

function requireFirstStopEvent(report: MutableReplayReport): MutableEvent {
  const event = requireFirstScenario(report).events.find((candidate) => candidate.stop);
  if (event === undefined) {
    throw new Error("test report has no stop event");
  }
  return event;
}

function rebindScenarioContractHashes(report: MutableReplayReport): void {
  report.scenarioInputHash = canonicalHash(
    report.scenarios.map((scenario) => scenario.canonicalInput)
  );
  report.comparisonSetHash = canonicalHash({
    reportSchemaHash: report.reportSchemaHash,
    eventSchemaHash: report.eventSchemaHash,
    metricDefinitionHash: report.metricDefinitionHash,
    metricImplementationHash: report.metricImplementationHash,
    acceptanceProfileHash: report.acceptanceProfileHash,
    fixtureHash: report.fixtureHash,
    scenarioInputHash: report.scenarioInputHash
  });
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const scalar = JSON.stringify(value);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify(undefined) is undefined.
    if (scalar === undefined) {
      throw new Error("test canonical JSON does not support undefined");
    }
    return scalar;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
