import { describe, expect, it } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  defineVoicePcmFrame
} from "../src/modules/voice/echo-control.js";

describe("voice echo control", () => {
  it("suppresses near-end frames while the TTS tail mute window is active", async () => {
    const echoControl = createHalfDuplexEchoControl({ tailMuteMs: 700 });
    const farEnd = defineVoicePcmFrame({
      id: "tts-frame-1",
      direction: "far_end",
      audio: new Uint8Array([1, 2, 3]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.000Z",
      durationMs: 300
    });

    expect(echoControl.describe()).toEqual({
      provider: "half_duplex",
      mode: "half_duplex"
    });
    await echoControl.acceptFarEndReference(farEnd);

    const nearEnd = defineVoicePcmFrame({
      id: "mic-frame-1",
      direction: "near_end",
      audio: new Uint8Array([4, 5, 6]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.400Z",
      durationMs: 100
    });

    await expect(echoControl.processNearEnd(nearEnd)).resolves.toEqual({
      action: "suppress",
      reason: "far_end_tail_mute",
      diagnostics: {
        provider: "half_duplex",
        residualEchoProbability: 1,
        voiceActivity: false
      }
    });
  });

  it("passes near-end frames after the half-duplex state is flushed", async () => {
    const echoControl = createHalfDuplexEchoControl({ tailMuteMs: 700 });
    const farEnd = defineVoicePcmFrame({
      id: "tts-frame-1",
      direction: "far_end",
      audio: new Uint8Array([1, 2, 3]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.000Z",
      durationMs: 300
    });
    const nearEnd = defineVoicePcmFrame({
      id: "mic-frame-2",
      direction: "near_end",
      audio: new Uint8Array([4, 5, 6]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:01.100Z",
      durationMs: 100
    });

    await echoControl.acceptFarEndReference(farEnd);

    await expect(echoControl.processNearEnd(nearEnd)).resolves.toEqual({
      action: "pass",
      reason: "no_far_end_tail",
      frame: nearEnd,
      diagnostics: {
        provider: "half_duplex",
        residualEchoProbability: 0,
        voiceActivity: true
      }
    });
  });

  it("records audit-safe suspension and resume events", async () => {
    const audit = createStructuredAuditLog();
    const echoControl = createHalfDuplexEchoControl({
      tailMuteMs: 700,
      audit
    });
    const farEnd = defineVoicePcmFrame({
      id: "tts-frame-1",
      direction: "far_end",
      audio: new Uint8Array([1, 2, 3]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.000Z",
      durationMs: 300
    });
    const afterTail = defineVoicePcmFrame({
      id: "mic-frame-after-tail",
      direction: "near_end",
      audio: new Uint8Array([4, 5, 6]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:01.100Z",
      durationMs: 100
    });

    await echoControl.acceptFarEndReference(farEnd);
    await echoControl.processNearEnd(afterTail);

    expect(audit.entries()).toMatchObject([
      {
        name: "voice.listen.suspended_for_tts",
        category: "transport_event"
      },
      {
        name: "voice.listen.resumed",
        category: "transport_event"
      }
    ]);
  });

  it("uses an explicit local HTTP echo-control provider for AEC processing", async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: (url, init) => {
        if (!(url instanceof URL) || typeof init?.body !== "string") {
          throw new Error("unexpected echo-control request");
        }

        requests.push({
          url: url.href,
          body: JSON.parse(init.body)
        });

        return Promise.resolve(
          new Response(
            JSON.stringify({
              action: "pass",
              reason: "aec_processed",
              audioBase64: Buffer.from([7, 8, 9]).toString("base64"),
              diagnostics: {
                residualEchoProbability: 0.2,
                voiceActivity: true
              }
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json"
              }
            }
          )
        );
      }
    });

    const farEnd = defineVoicePcmFrame({
      id: "tts-frame-1",
      direction: "far_end",
      audio: new Uint8Array([1, 2, 3]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.000Z",
      durationMs: 300
    });
    const nearEnd = defineVoicePcmFrame({
      id: "mic-frame-1",
      direction: "near_end",
      audio: new Uint8Array([4, 5, 6]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.400Z",
      durationMs: 100
    });

    await provider.acceptFarEndReference(farEnd);

    await expect(provider.processNearEnd(nearEnd)).resolves.toMatchObject({
      action: "pass",
      reason: "aec_processed",
      frame: {
        audio: new Uint8Array([7, 8, 9])
      },
      diagnostics: {
        provider: "web_rtc_aec3",
        residualEchoProbability: 0.2,
        voiceActivity: true
      }
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8770/v1/echo-control/far-end",
      "http://127.0.0.1:8770/v1/echo-control/near-end"
    ]);
  });
});
