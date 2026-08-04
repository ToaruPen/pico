import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import type {
  StackChanHeadTargetLane,
  StackChanHeadTargetStatus
} from "../src/modules/stackchan/head-target-lane.js";
import type { StackChanAdapter } from "../src/modules/stackchan/index.js";
import type { AttentionDetectionModel } from "../src/modules/vision/attention-detection.js";
import { createConfiguredStackChanAttentionOwner } from "../src/runtime/stackchan-attention-owner.js";
import type { StackChanAttentionRuntime } from "../src/runtime/stackchan-attention-runtime.js";

function enabledConfig() {
  return definePicoConfig({
    camera: {
      stackchan: {
        mcpUrl: "http://127.0.0.1:18767/mcp",
        bearerTokenEnv: "STACKCHAN_TOKEN",
        follow: {
          enabled: true,
          commandTransport: "async-latest",
          stepQuantization: "round",
          targetFilter: { enabled: false }
        }
      }
    },
    vision: {
      attentionDetection: {
        enabled: true,
        provider: "onnxruntime",
        modelFamily: "pinto441-yolox-body-head-hand-face-dist",
        modelPath: "/opt/pico/models/pinto-attention.onnx",
        inputWidth: 320,
        inputHeight: 256
      }
    }
  });
}

const inertModel: AttentionDetectionModel = {
  detect: () => Promise.resolve([])
};

const inertAdapter: StackChanAdapter = {
  connect: () => Promise.resolve(),
  captureJpeg: () =>
    Promise.resolve({
      bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      mimeType: "image/jpeg"
    }),
  getHeadAngles: () => Promise.resolve({ yaw: 0, pitch: 35 }),
  moveHead: () => Promise.resolve(),
  close: () => Promise.resolve()
};

const laneDistribution = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0
};
const inertLaneStatus: StackChanHeadTargetStatus = {
  phase: "running",
  leaseId: "lease-a",
  leaseIdMatch: true,
  accepted: 0,
  replaced: 0,
  dispatched: 0,
  confirmed: 0,
  confirmedApplyReplies: 0,
  failed: 0,
  staleDiscarded: 0,
  noOpDiscarded: 0,
  activeCalls: 0,
  pendingDepth: 0,
  maximumActiveCalls: 0,
  maximumPendingDepth: 0,
  postStopDispatches: 0,
  confirmedPose: { yaw: 0, pitch: 35 },
  updateAcknowledgmentMs: laneDistribution,
  pendingAgeMs: laneDistribution,
  deviceDispatchLatencyMs: laneDistribution,
  successfulReplyLatencyMs: laneDistribution,
  firmwareMcpStageUs: {
    count: 0,
    receiveToApply: { count: 0, p50: 0, p95: 0, max: 0 },
    toolApply: { count: 0, p50: 0, p95: 0, max: 0 },
    applyToReplyEnqueue: { count: 0, p50: 0, p95: 0, max: 0 },
    schedulerHops: {}
  }
};
const inertHeadTargetLane: StackChanHeadTargetLane = {
  connect: () => Promise.resolve(),
  start: () =>
    Promise.resolve({
      leaseId: "lease-a",
      confirmedPose: { yaw: 0, pitch: 35 },
      status: inertLaneStatus
    }),
  update: (target) =>
    Promise.resolve({
      accepted: true,
      replaced: false,
      pendingDepth: 1,
      acceptedCount: target.sequence,
      replacedCount: 0,
      lastAcceptedSequence: target.sequence
    }),
  clear: () => Promise.resolve(inertLaneStatus),
  status: () => Promise.resolve(inertLaneStatus),
  stop: () => Promise.resolve({ ...inertLaneStatus, phase: "stopped" }),
  close: () => Promise.resolve()
};

const inertFlow = {
  observationTicksStarted: 0,
  observationTicksCompleted: 0,
  observationsWhileMoveInFlight: 0,
  staleFramesDiscarded: 0,
  staleFrameDispatches: 0,
  pendingMoveDepth: 0 as const,
  maximumPendingMoveDepth: 0 as const,
  pendingMoveReplacements: 0,
  pendingMoveDispatches: 0,
  activeObservationTicks: 0,
  activeMoves: 0,
  maximumConcurrentObservationTicks: 0,
  maximumConcurrentMoves: 0,
  observationOverlapAttempts: 0,
  moveOverlapAttempts: 0
};

describe("configured StackChan attention owner", () => {
  it("allocates nothing when follow is disabled", async () => {
    const events: string[] = [];
    const owner = await createConfiguredStackChanAttentionOwner(definePicoConfig({}), {
      createModel: () => {
        events.push("model");
        return Promise.resolve(inertModel);
      },
      createAdapter: () => {
        events.push("adapter");
        return inertAdapter;
      },
      createHeadTargetLane: () => {
        events.push("lane");
        return inertHeadTargetLane;
      },
      createRuntime: () => {
        events.push("runtime");
        throw new Error("runtime should not be created");
      }
    });

    expect(owner).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("loads one model and creates a fresh adapter/runtime for each interaction", async () => {
    const events: string[] = [];
    let runtimeNumber = 0;
    let latestLane: StackChanHeadTargetLane | undefined;
    const owner = await createConfiguredStackChanAttentionOwner(enabledConfig(), {
      createModel: () => {
        events.push("model");
        return Promise.resolve(inertModel);
      },
      createAdapter: () => {
        events.push("adapter");
        return inertAdapter;
      },
      createHeadTargetLane: () => {
        events.push("lane");
        latestLane = inertHeadTargetLane;
        return inertHeadTargetLane;
      },
      createRuntime: (options): StackChanAttentionRuntime => {
        expect(options.headTargetLane).toBe(latestLane);
        runtimeNumber += 1;
        const id = runtimeNumber;
        return {
          start: () => {
            events.push(`start:${id}`);
            return Promise.resolve();
          },
          stop: () => {
            events.push(`stop:${id}`);
            return Promise.resolve();
          },
          status: () => ({
            phase: "running",
            framesProcessed: 0,
            moveCount: 0,
            flow: inertFlow,
            attention: {
              mode: "track",
              targetVisible: true,
              targetFrames: 3,
              centeredFrames: 2,
              lastTarget: {
                label: "face",
                confidence: 0.9,
                centerX: 0.5,
                centerY: 0.5,
                horizontalError: 0,
                verticalError: 0,
                centered: true,
                observedAtMs: 100,
                ageMs: 25
              }
            }
          })
        };
      }
    });

    await owner?.startInteraction();
    expect(owner?.status()).toEqual({
      active: true,
      runtime: {
        phase: "running",
        framesProcessed: 0,
        moveCount: 0,
        flow: inertFlow,
        attention: {
          mode: "track",
          targetVisible: true,
          targetFrames: 3,
          centeredFrames: 2,
          lastTarget: {
            label: "face",
            confidence: 0.9,
            centerX: 0.5,
            centerY: 0.5,
            horizontalError: 0,
            verticalError: 0,
            centered: true,
            observedAtMs: 100,
            ageMs: 25
          }
        }
      }
    });
    await owner?.startInteraction();
    await owner?.stopInteraction();
    expect(owner?.status()).toEqual({ active: false });
    await owner?.startInteraction();
    await owner?.stopInteraction();

    expect(events).toEqual([
      "model",
      "adapter",
      "lane",
      "start:1",
      "stop:1",
      "adapter",
      "lane",
      "start:2",
      "stop:2"
    ]);
  });

  it("contains model initialization failures without allocating downstream resources", async () => {
    const events: string[] = [];
    const owner = await createConfiguredStackChanAttentionOwner(enabledConfig(), {
      createModel: () => {
        events.push("model");
        return Promise.reject(
          new Error("failed to load /Users/operator/private/pinto-attention.onnx")
        );
      },
      createAdapter: () => {
        events.push("adapter");
        return inertAdapter;
      },
      createHeadTargetLane: () => {
        events.push("lane");
        return inertHeadTargetLane;
      },
      createRuntime: () => {
        events.push("runtime");
        throw new Error("runtime should not be created");
      }
    });

    await expect(owner?.startInteraction()).resolves.toBeUndefined();
    await expect(owner?.stopInteraction()).resolves.toBeUndefined();

    expect(events).toEqual(["model"]);
    expect(owner?.status()).toEqual({
      active: false,
      lastError: "StackChan attention model initialization failed",
      errors: [
        {
          code: "model_initialization_failed",
          message: "StackChan attention model initialization failed"
        }
      ]
    });
    expect(owner?.status().lastError).not.toContain("/Users/operator");
  });

  it("contains device failures and exposes only bounded status", async () => {
    const owner = await createConfiguredStackChanAttentionOwner(enabledConfig(), {
      createModel: () => Promise.resolve(inertModel),
      createAdapter: () => inertAdapter,
      createHeadTargetLane: () => inertHeadTargetLane,
      createRuntime: () => ({
        start: () =>
          Promise.reject(new Error("Bearer secret-device-token body={raw-start-tool-output}")),
        stop: () => Promise.reject(new Error("/Users/operator/private/close-adapter")),
        status: () => ({
          phase: "stopped",
          framesProcessed: 0,
          moveCount: 0,
          flow: inertFlow,
          attention: {
            mode: "acquire",
            targetVisible: false,
            targetFrames: 0,
            centeredFrames: 0
          }
        })
      })
    });

    await expect(owner?.startInteraction()).resolves.toBeUndefined();
    await expect(owner?.stopInteraction()).resolves.toBeUndefined();
    expect(owner?.status()).toEqual({
      active: false,
      lastError: "StackChan attention runtime cleanup failed",
      errors: [
        {
          code: "runtime_start_failed",
          message: "StackChan attention runtime startup failed"
        },
        {
          code: "runtime_cleanup_failed",
          message: "StackChan attention runtime cleanup failed"
        }
      ]
    });
    const serializedStatus = JSON.stringify(owner?.status());
    expect(serializedStatus).not.toContain("secret-device-token");
    expect(serializedStatus).not.toContain("raw-start-tool-output");
    expect(serializedStatus).not.toContain("/Users/operator");
  });
});
