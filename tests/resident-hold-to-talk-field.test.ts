import { describe, expect, it } from "vitest";

import {
  formatResidentHoldToTalkHelp,
  readResidentHoldToTalkArguments,
  summarizeBoundedMetric
} from "../scripts/field/resident-hold-to-talk.js";

describe("resident hold-to-talk field contract", () => {
  it("uses a bounded default and accepts an explicit bounded duration", () => {
    expect(readResidentHoldToTalkArguments([])).toEqual({ durationMs: 30_000, help: false });
    expect(readResidentHoldToTalkArguments(["--duration-ms", "1200"])).toEqual({
      durationMs: 1200,
      help: false
    });
    expect(() => readResidentHoldToTalkArguments(["--duration-ms", "300001"])).toThrow(
      "usage: field:resident-hold-to-talk"
    );
  });

  it("documents a metadata-only run without provider work", () => {
    const help = formatResidentHoldToTalkHelp();

    expect(help).toContain("aggregate timing/resource metadata only");
    expect(help).toContain("does not invoke STT, Pi, TTS, or playback");
  });

  it("summarizes samples without retaining per-activation values", () => {
    expect(summarizeBoundedMetric([])).toEqual({
      samples: 0,
      minimumMs: undefined,
      maximumMs: undefined,
      meanMs: undefined
    });
    expect(summarizeBoundedMetric([10.111, 20.229])).toEqual({
      samples: 2,
      minimumMs: 10.11,
      maximumMs: 20.23,
      meanMs: 15.17
    });
  });
});
