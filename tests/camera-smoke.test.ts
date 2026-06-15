import { describe, expect, it } from "vitest";

import {
  buildTapoRtspSmokePlan,
  runTapoRtspSnapshotSmoke,
  tapoRtspSmokeExitCode
} from "../scripts/smoke/tapo-rtsp-snapshot.js";
import { definePicoConfig } from "../src/config/index.js";

describe("Tapo RTSP snapshot smoke configuration", () => {
  it("skips when the Tapo host is not configured", async () => {
    await expect(runTapoRtspSnapshotSmoke(definePicoConfig({}))).resolves.toEqual({
      status: "skipped",
      provider: "tapo-rtsp",
      reason: "Set camera.tapo in pico config to run the Tapo RTSP snapshot smoke."
    });
  });

  it("builds a private RTSP source from configured YAML settings", () => {
    const plan = buildTapoRtspSmokePlan(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: " camera user ",
            password: " camera passphrase ",
            streams: {
              scene: "stream1"
            },
            port: 8554,
            timeoutMs: 15_000,
            maxFrameBytes: 1024
          }
        }
      })
    );

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

  it("uses the high quality Tapo stream by default", () => {
    const plan = buildTapoRtspSmokePlan(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase"
          }
        }
      })
    );

    expect(plan).toMatchObject({
      status: "run",
      source: {
        url: "rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream1"
      }
    });
  });

  it("rejects partial Tapo smoke configuration", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25"
          }
        }
      })
    ).toThrow("pico config camera.tapo.user is required when camera.tapo is set");

    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera"
          }
        }
      })
    ).toThrow("pico config camera.tapo.password is required when camera.tapo is set");
  });

  it("redacts RTSP URLs and camera credentials from capture failure reports", async () => {
    const report = await runTapoRtspSnapshotSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase",
            streams: {
              scene: "stream1"
            }
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.resolve({
            ok: false,
            sourceId: "tapo-rtsp",
            reason: "capture_failed",
            message:
              "rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream1 camera-passphrase"
          })
      }
    );
    const reportText = JSON.stringify(report);

    expect(report.status).toBe("failed");
    expect(reportText).not.toContain("rtsp://");
    expect(reportText).not.toContain("camera-user");
    expect(reportText).not.toContain("camera-passphrase");
  });

  it("redacts RTSP URLs and camera credentials when snapshot capture throws", async () => {
    const report = await runTapoRtspSnapshotSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase",
            streams: {
              scene: "stream1"
            }
          }
        }
      }),
      {
        captureSnapshot: () =>
          Promise.reject(
            new Error(
              "rtsp://camera-user:camera-passphrase@192.168.10.25:554/stream1 camera-passphrase"
            )
          )
      }
    );
    const reportText = JSON.stringify(report);

    expect(report.status).toBe("failed");
    expect(reportText).not.toContain("rtsp://");
    expect(reportText).not.toContain("camera-user");
    expect(reportText).not.toContain("camera-passphrase");
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
