import { describe, expect, it } from "vitest";

import {
  buildTapoPersonFollowSmokePlan,
  runTapoPersonFollowSmoke,
  tapoPersonFollowSmokeExitCode
} from "../scripts/smoke/tapo-person-follow-nudge.js";
import { definePicoConfig } from "../src/config/index.js";

describe("Tapo person-follow PTZ smoke configuration", () => {
  it("skips unless the live PTZ nudge is explicitly enabled", async () => {
    await expect(runTapoPersonFollowSmoke(definePicoConfig({}), {})).resolves.toEqual({
      status: "skipped",
      provider: "tapo-onvif-ptz",
      reason: "Set PICO_ENABLE_LIVE_PTZ_NUDGE=1 to run the Tapo ONVIF PTZ smoke."
    });
  });

  it("builds a small safe nudge plan from configured YAML settings", () => {
    const plan = buildTapoPersonFollowSmokePlan(
      definePicoConfig({
        camera: {
          tapo: {
            sourceId: "tapo-main",
            host: "192.168.10.25",
            onvifPort: 2020,
            user: "camera-user",
            password: "camera-passphrase"
          },
          personFollow: {
            enabled: true,
            sourceCameraId: "tapo-main",
            deadZone: 0.1,
            maxStep: 0.25,
            speed: 0.4,
            cooldownMs: 500,
            lostTargetTimeoutMs: 1500
          }
        }
      }),
      {
        PICO_ENABLE_LIVE_PTZ_NUDGE: "1"
      }
    );

    expect(plan).toEqual({
      status: "run",
      sourceId: "tapo-main",
      connection: {
        host: "192.168.10.25",
        port: 2020,
        username: "camera-user",
        password: "camera-passphrase"
      },
      command: {
        pan: 0.05,
        tilt: 0,
        speed: 0.4
      }
    });
  });

  it("runs the safe nudge and stop sequence through an injected PTZ driver", async () => {
    const commands: string[] = [];
    const report = await runTapoPersonFollowSmoke(
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.10.25",
            user: "camera-user",
            password: "camera-passphrase"
          },
          personFollow: {
            enabled: true,
            sourceCameraId: "tapo-rtsp",
            deadZone: 0.1,
            maxStep: 0.25,
            speed: 0.4,
            cooldownMs: 500,
            lostTargetTimeoutMs: 1500
          }
        }
      }),
      {
        PICO_ENABLE_LIVE_PTZ_NUDGE: "1"
      },
      {
        createDriver: () => ({
          relativeMove: () => {
            commands.push("relativeMove");

            return Promise.resolve();
          },
          stop: () => {
            commands.push("stop");

            return Promise.resolve();
          }
        })
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "tapo-onvif-ptz",
      details: {
        sourceId: "tapo-rtsp",
        pan: 0.05,
        tilt: 0,
        speed: 0.4
      }
    });
    expect(commands).toEqual(["relativeMove", "stop"]);
  });

  it("returns a failing process code only for failed smoke reports", () => {
    expect(
      tapoPersonFollowSmokeExitCode({
        status: "skipped",
        provider: "tapo-onvif-ptz"
      })
    ).toBe(0);
    expect(
      tapoPersonFollowSmokeExitCode({
        status: "passed",
        provider: "tapo-onvif-ptz"
      })
    ).toBe(0);
    expect(
      tapoPersonFollowSmokeExitCode({
        status: "failed",
        provider: "tapo-onvif-ptz",
        reason: "PTZ command failed"
      })
    ).toBe(1);
  });
});
