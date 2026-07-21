import { describe, expect, it } from "vitest";

import {
  residentAudioInputSmokeExitCode,
  runResidentAudioInputSmoke
} from "../scripts/smoke/resident-audio-input.js";
import { definePicoConfig } from "../src/config/index.js";

describe("resident audio input smoke", () => {
  it("skips when resident voice audio input is not configured", async () => {
    const report = await runResidentAudioInputSmoke(definePicoConfig({}));

    expect(report).toEqual({
      status: "skipped",
      provider: "resident-audio-input",
      reason:
        "Set voice.resident.enabled=true and voice.resident.audioInput to run the resident audio input smoke."
    });
    expect(residentAudioInputSmokeExitCode(report)).toBe(0);
  });

  it("routes AVAudioEngine production validation to the native PTT field harness", async () => {
    const report = await runResidentAudioInputSmoke(residentAudioInputConfig());

    expect(report).toEqual({
      status: "skipped",
      provider: "resident-audio-input",
      reason:
        "AVAudioEngine admits audio only inside native PTT; run just field-resident-hold-to-talk for input signal validation."
    });
  });

  it("passes when measured input RMS meets the speech-gate threshold", async () => {
    const config = residentAudioInputConfig();
    const report = await runResidentAudioInputSmoke(config, {
      measureInputLevel: () =>
        Promise.resolve({
          provider: "avaudioengine",
          sampleRateHz: 16_000,
          channels: 1,
          capturedMs: 1_000,
          sampleCount: 16_000,
          durationMs: 1_000,
          rmsDb: -32,
          peakDb: -12,
          signalDetected: true
        })
    });

    expect(report).toEqual({
      status: "passed",
      provider: "resident-audio-input",
      details: {
        audioProvider: "avaudioengine",
        sampleRateHz: 16_000,
        channels: 1,
        capturedMs: 1_000,
        sampleCount: 16_000,
        durationMs: 1_000,
        rmsDb: -32,
        peakDb: -12,
        minimumRmsDb: -55
      }
    });
    expect(residentAudioInputSmokeExitCode(report)).toBe(0);
  });

  it("fails without leaking captured audio when input stays below the speech-gate threshold", async () => {
    const config = residentAudioInputConfig();
    const report = await runResidentAudioInputSmoke(config, {
      measureInputLevel: () =>
        Promise.resolve({
          provider: "avaudioengine",
          sampleRateHz: 16_000,
          channels: 1,
          capturedMs: 1_000,
          sampleCount: 16_000,
          durationMs: 1_000,
          rmsDb: -61.9,
          peakDb: -49.4,
          signalDetected: false
        })
    });
    const serialized = JSON.stringify(report);

    expect(report).toEqual({
      status: "failed",
      provider: "resident-audio-input",
      reason: "pico resident audio input RMS -61.9 dB is below minimum -55 dB",
      details: {
        audioProvider: "avaudioengine",
        sampleRateHz: 16_000,
        channels: 1,
        capturedMs: 1_000,
        sampleCount: 16_000,
        durationMs: 1_000,
        rmsDb: -61.9,
        peakDb: -49.4,
        minimumRmsDb: -55
      }
    });
    expect(serialized).not.toContain("capturedAudio");
    expect(serialized).not.toContain("pcm16le");
    expect(serialized).not.toContain("base64");
    expect(residentAudioInputSmokeExitCode(report)).toBe(1);
  });
});

function residentAudioInputConfig() {
  return definePicoConfig({
    voice: {
      resident: {
        enabled: true,
        audioInput: {
          provider: "avaudioengine",
          deviceUid: "BuiltInMicrophoneDevice"
        },
        audioOutput: {
          provider: "ffplay",
          route: "system_default"
        },
        vad: {
          provider: "energy",
          minRmsDb: -55
        }
      }
    }
  });
}
