import { describe, expect, it } from "vitest";

import { runResidentVoiceDeferredRalliesField } from "../scripts/field/resident-voice-deferred-rallies.js";

describe("resident voice deferred rallies field", () => {
  it("runs multiple resident voice rallies through deferred tool delivery", async () => {
    await expect(runResidentVoiceDeferredRalliesField()).resolves.toMatchObject({
      status: "passed",
      observed: {
        startedSessions: 1,
        completedTurns: 3,
        queuedDeferredJobs: ["deferred-job-1", "deferred-job-2"],
        deliveredDeferredJobs: ["deferred-job-1", "deferred-job-2"],
        acknowledgedDeferredJobs: ["deferred-job-1", "deferred-job-2"],
        sceneDescriptions: [
          "1回目: 机の上に教材が見えます。",
          "2回目: 入口付近は落ち着いています。"
        ],
        ttsRequests: [
          "確認します。",
          "1回目は教材が見えました。もう一度確認します。",
          "2回目は入口付近が落ち着いています。"
        ]
      }
    });
  });
});
