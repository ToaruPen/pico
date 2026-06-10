import { describe, expect, it } from "vitest";

import {
  buildTapoRtspSmokePlan,
  runTapoRtspSnapshotSmoke,
  tapoRtspSmokeExitCode
} from "../scripts/smoke/tapo-rtsp-snapshot.js";

describe("Tapo RTSP snapshot smoke configuration", () => {
  it("skips when the Tapo host is not configured", async () => {
    await expect(runTapoRtspSnapshotSmoke({})).resolves.toEqual({
      status: "skipped",
      provider: "tapo-rtsp",
      reason: "Set PICO_TAPO_HOST to run the Tapo RTSP snapshot smoke."
    });
  });

  it("builds a private RTSP source from configured environment", () => {
    const plan = buildTapoRtspSmokePlan({
      PICO_TAPO_HOST: "192.168.10.25",
      PICO_TAPO_USER: " camera user ",
      PICO_TAPO_PASSWORD: " camera passphrase ",
      PICO_TAPO_STREAM: "stream1",
      PICO_TAPO_PORT: "8554",
      PICO_TAPO_TIMEOUT_MS: "15000",
      PICO_TAPO_MAX_FRAME_BYTES: "1024"
    });

    expect(plan).toMatchObject({
      status: "run",
      timeoutMs: 15_000,
      maxFrameBytes: 1024,
      source: {
        id: "tapo-rtsp",
        url: "rtsp://camera%20user:camera%20passphrase@192.168.10.25:8554/stream1"
      }
    });
  });

  it("rejects partial Tapo smoke configuration", () => {
    expect(() =>
      buildTapoRtspSmokePlan({
        PICO_TAPO_HOST: "192.168.10.25"
      })
    ).toThrow("PICO_TAPO_USER is required when PICO_TAPO_HOST is set");

    expect(() =>
      buildTapoRtspSmokePlan({
        PICO_TAPO_HOST: "192.168.10.25",
        PICO_TAPO_USER: "camera"
      })
    ).toThrow("PICO_TAPO_PASSWORD is required when PICO_TAPO_HOST is set");
  });

  it("returns a failing process code only for failed smoke reports", () => {
    expect(
      tapoRtspSmokeExitCode({
        status: "skipped",
        provider: "tapo-rtsp"
      })
    ).toBe(0);
    expect(
      tapoRtspSmokeExitCode({
        status: "passed",
        provider: "tapo-rtsp",
        details: {
          sourceId: "tapo-rtsp",
          frameBytes: 128,
          mimeType: "image/jpeg"
        }
      })
    ).toBe(0);
    expect(
      tapoRtspSmokeExitCode({
        status: "failed",
        provider: "tapo-rtsp",
        reason: "capture failed"
      })
    ).toBe(1);
  });
});
