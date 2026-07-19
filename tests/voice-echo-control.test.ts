import { describe, expect, it, vi } from "vitest";

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
    await expect(
      echoControl.acceptFarEndReference(farEnd, new AbortController().signal)
    ).resolves.toEqual({ status: "applied" });

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
      capturedAt: "2026-06-14T10:00:00.400Z",
      durationMs: 100
    });

    await echoControl.acceptFarEndReference(farEnd, new AbortController().signal);
    await expect(echoControl.flush()).resolves.toEqual({ status: "reset" });

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

  it("reports an aborted half-duplex registration as definitely not applied", async () => {
    const echoControl = createHalfDuplexEchoControl({ tailMuteMs: 700 });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const farEnd = defineVoicePcmFrame({
      id: "tts-frame-aborted",
      direction: "far_end",
      audio: new Uint8Array([1, 2]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.000Z",
      durationMs: 300
    });
    const nearEnd = defineVoicePcmFrame({
      id: "mic-frame-after-abort",
      direction: "near_end",
      audio: new Uint8Array([3, 4]),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T10:00:00.100Z",
      durationMs: 100
    });

    await expect(
      echoControl.acceptFarEndReference(farEnd, controller.signal)
    ).resolves.toMatchObject({
      status: "definitely_not_applied",
      error: new Error("cancelled")
    });
    await expect(echoControl.processNearEnd(nearEnd)).resolves.toMatchObject({
      action: "pass",
      reason: "no_far_end_tail"
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

    await echoControl.acceptFarEndReference(farEnd, new AbortController().signal);
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

    await expect(
      provider.acceptFarEndReference(farEnd, new AbortController().signal)
    ).resolves.toEqual({ status: "applied" });

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

  it("propagates caller cancellation to HTTP far-end registration", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let requestCount = 0;
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: (_url, init) => {
        requestCount += 1;
        if (requestCount > 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                action: "pass",
                reason: "aec_processed",
                audioBase64: Buffer.from([1, 2]).toString("base64"),
                diagnostics: { residualEchoProbability: 0, voiceActivity: false }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true
          });
        });
      }
    });
    const controller = new AbortController();
    const registration = provider.acceptFarEndReference(
      defineVoicePcmFrame({
        id: "tts-frame-cancelled-http",
        direction: "far_end",
        audio: new Uint8Array([1, 2]),
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        capturedAt: "2026-06-14T10:00:00.000Z",
        durationMs: 300
      }),
      controller.signal
    );
    const outcome = registration.then(
      (value) => ({ settlement: "resolved" as const, value }),
      (error: unknown) => ({ settlement: "rejected" as const, error })
    );

    controller.abort(new Error("cancelled"));

    await expect(outcome).resolves.toMatchObject({
      settlement: "resolved",
      value: { status: "indeterminate", error: new Error("cancelled") }
    });
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
    await expect(provider.flush()).resolves.toEqual({ status: "unsupported" });
    await expect(
      provider.acceptFarEndReference(
        defineVoicePcmFrame({
          id: "tts-frame-after-indeterminate",
          direction: "far_end",
          audio: new Uint8Array([3, 4]),
          encoding: "pcm16le",
          sampleRateHz: 16_000,
          channels: 1,
          capturedAt: "2026-06-14T10:00:01.000Z",
          durationMs: 300
        }),
        new AbortController().signal
      )
    ).resolves.toMatchObject({ status: "indeterminate" });
    expect(requestCount).toBe(1);
  });

  it("times out HTTP far-end registration with a fixed internal bound", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const provider = createHttpEchoControlProvider({
        provider: "web_rtc_aec3",
        mode: "aec",
        providerEndpoint: "http://127.0.0.1:8770",
        fetchImplementation: (_url, init) => {
          requestSignal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), {
              once: true
            });
          });
        }
      });
      const registration = provider.acceptFarEndReference(
        defineVoicePcmFrame({
          id: "tts-frame-timeout-http",
          direction: "far_end",
          audio: new Uint8Array([1, 2]),
          encoding: "pcm16le",
          sampleRateHz: 16_000,
          channels: 1,
          capturedAt: "2026-06-14T10:00:00.000Z",
          durationMs: 300
        }),
        new AbortController().signal
      );
      const outcome = registration.then(
        (value) => ({ settlement: "resolved" as const, value }),
        (error: unknown) => ({ settlement: "rejected" as const, error })
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(outcome).resolves.toMatchObject({
        settlement: "resolved",
        value: {
          status: "indeterminate",
          error: new Error("pico echo-control far-end registration timed out after 1000 ms")
        }
      });
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks explicit HTTP AEC provider health before live use", async () => {
    const requests: string[] = [];
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: (url) => {
        if (!(url instanceof URL)) {
          throw new Error("unexpected echo-control health request");
        }

        requests.push(url.href);

        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              provider: "web_rtc_aec3",
              mode: "aec",
              engine: "webrtc-aec3"
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

    await expect(provider.checkHealth()).resolves.toEqual({
      ok: true,
      provider: "web_rtc_aec3",
      mode: "aec",
      engine: "webrtc-aec3"
    });
    expect(requests).toEqual(["http://127.0.0.1:8770/v1/echo-control/health"]);
  });

  it("rejects malformed HTTP AEC provider health responses", async () => {
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
        )
    });

    await expect(provider.checkHealth()).rejects.toThrow(
      "pico echo-control provider health response is malformed"
    );
  });

  it("returns provider-reported unhealthy HTTP AEC health responses", async () => {
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              provider: "web_rtc_aec3",
              mode: "aec",
              reason: "unavailable",
              message: "AEC engine is not ready"
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json"
              }
            }
          )
        )
    });

    await expect(provider.checkHealth()).resolves.toEqual({
      ok: false,
      provider: "web_rtc_aec3",
      mode: "aec",
      reason: "unavailable",
      message: "AEC engine is not ready"
    });
  });

  it("rejects non-JSON HTTP AEC provider health responses as malformed", async () => {
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () =>
        Promise.resolve(
          new Response("{", {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
        )
    });

    await expect(provider.checkHealth()).rejects.toThrow(
      "pico echo-control provider health response is malformed"
    );
  });

  it("rejects HTTP AEC pass responses that omit processed audio", async () => {
    const provider = createHttpEchoControlProvider({
      provider: "web_rtc_aec3",
      mode: "aec",
      providerEndpoint: "http://127.0.0.1:8770",
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              action: "pass",
              reason: "aec_processed",
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
        )
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

    await expect(provider.processNearEnd(nearEnd)).rejects.toThrow(
      "pico echo-control provider audioBase64 is required"
    );
  });
});
