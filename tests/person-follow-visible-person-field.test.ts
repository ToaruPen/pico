import { describe, expect, it } from "vitest";

import {
  personFollowVisiblePersonFieldExitCode,
  runPersonFollowVisiblePersonField
} from "../scripts/field/person-follow-visible-person.js";
import { definePicoConfig } from "../src/config/index.js";

describe("person-follow visible-person field harness", () => {
  it("skips unless visible-person live validation is explicitly enabled", async () => {
    await expect(runPersonFollowVisiblePersonField(definePicoConfig({}), {})).resolves.toEqual({
      status: "skipped",
      provider: "unsupported",
      reason:
        "Set PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE=1 to run visible-person person-follow field validation."
    });
  });

  it("fails a runtime pass that did not detect people", async () => {
    const report = await runPersonFollowVisiblePersonField(
      definePicoConfig({}),
      {
        PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE: "1"
      },
      {
        runRuntime: () =>
          Promise.resolve({
            status: "passed",
            provider: "tapo-rtsp+coreml+onvif",
            details: {
              sourceId: "tapo-main",
              framesProcessed: 3,
              personDetectionsTotal: 0,
              framesWithPersonDetections: 0,
              maxPersonDetectionsInFrame: 0,
              movesIssued: 0,
              stopsIssued: 1,
              errors: 0
            }
          })
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "visible-person field validation requires at least one person detection"
    });
    expect(personFollowVisiblePersonFieldExitCode(report)).toBe(1);
  });

  it("fails a detected-person runtime pass that did not move the camera", async () => {
    const report = await runPersonFollowVisiblePersonField(
      definePicoConfig({}),
      {
        PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE: "1"
      },
      {
        runRuntime: () =>
          Promise.resolve({
            status: "passed",
            provider: "tapo-rtsp+coreml+onvif",
            details: {
              sourceId: "tapo-main",
              framesProcessed: 3,
              personDetectionsTotal: 2,
              framesWithPersonDetections: 2,
              maxPersonDetectionsInFrame: 1,
              movesIssued: 0,
              stopsIssued: 1,
              errors: 0
            }
          })
      }
    );

    expect(report).toEqual({
      status: "failed",
      provider: "tapo-rtsp+coreml+onvif",
      reason: "visible-person field validation requires at least one bounded PTZ move"
    });
  });

  it("passes when visible-person detection issues a bounded PTZ move", async () => {
    const report = await runPersonFollowVisiblePersonField(
      definePicoConfig({}),
      {
        PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE: "1"
      },
      {
        runRuntime: () =>
          Promise.resolve({
            status: "passed",
            provider: "tapo-rtsp+coreml+onvif",
            details: {
              sourceId: "tapo-main",
              framesProcessed: 3,
              personDetectionsTotal: 2,
              framesWithPersonDetections: 2,
              maxPersonDetectionsInFrame: 1,
              movesIssued: 1,
              stopsIssued: 1,
              errors: 0
            }
          })
      }
    );

    expect(report).toEqual({
      status: "passed",
      provider: "tapo-rtsp+coreml+onvif",
      details: {
        sourceId: "tapo-main",
        framesProcessed: 3,
        personDetectionsTotal: 2,
        framesWithPersonDetections: 2,
        maxPersonDetectionsInFrame: 1,
        movesIssued: 1,
        stopsIssued: 1,
        errors: 0
      }
    });
    expect(personFollowVisiblePersonFieldExitCode(report)).toBe(0);
  });
});
