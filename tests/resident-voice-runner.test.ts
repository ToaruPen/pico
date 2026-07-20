import { describe, expect, it } from "vitest";

import { definePicoConfig, type PicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import type {
  OpenTelemetryProviderOptions,
  PicoTelemetry
} from "../src/modules/telemetry/index.js";
import type { TtsSynthesisEvent } from "../src/modules/voice/index.js";
import type { ResidentControlHandler } from "../src/runtime/resident-control.js";
import {
  assertResidentVoiceStartupReadiness,
  createConfiguredOpenTelemetry,
  createConfiguredTts,
  createResidentVoiceStageProbe,
  requireResidentVoiceEnabled,
  runResidentControlLifecycle,
  runResidentVoiceWithProviders,
  shutdownResidentVoiceTelemetry,
  waitForDirectResidentVoiceRuntime
} from "../src/runtime/resident-voice-runner.js";
import { recordVoiceStageProbe } from "../src/runtime/voice-stage-probe.js";

const aivisBaseUrl = "http://127.0.0.1:10101";

function residentConfig(output: "ffplay" | "alsa" = "ffplay"): PicoConfig {
  return definePicoConfig({
    voice: {
      resident: {
        enabled: true,
        audioInput:
          output === "ffplay"
            ? { provider: "avfoundation", device: ":0" }
            : { provider: "alsa", device: "hw:1,0" },
        audioOutput:
          output === "ffplay"
            ? { provider: "ffplay", route: "system_default" }
            : { provider: "alsa", device: "hw:0,0" },
        control: {
          provider: "loopback_http",
          host: "127.0.0.1",
          port: 8781,
          authTokenPath: "tmp/pico-control-token",
          keyboard: { provider: "macos", talkKey: "F13", cancelKey: "F14" }
        }
      },
      tts: {
        aivis: {
          id: "local-aivis",
          localBaseUrl: aivisBaseUrl,
          speakerId: 1,
          timeoutMs: 250
        }
      }
    }
  });
}

async function collectEvents(
  events: AsyncIterable<TtsSynthesisEvent>
): Promise<TtsSynthesisEvent[]> {
  const collected: TtsSynthesisEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function requestPath(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).pathname;
}

function wavResponse(): Response {
  const samples = Buffer.from([1, 0]);
  const wav = Buffer.alloc(44 + samples.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.byteLength, 40);
  samples.copy(wav, 44);
  return new Response(wav);
}

describe("resident voice TTS telemetry wiring", () => {
  it("fans validated stage observations into the operator sink", () => {
    const events: unknown[] = [];
    const probe = createResidentVoiceStageProbe(undefined, {
      record: (event) => events.push(event)
    });

    recordVoiceStageProbe(probe, {
      stage: "stt",
      status: "ok",
      startedAt: "2026-07-19T00:00:00.000Z",
      durationMs: 125,
      attributes: { "pico.voice.utterance_duration_ms": 800 }
    });

    expect(events).toEqual([
      {
        kind: "stage",
        stage: "stt",
        status: "ok",
        durationMs: 125,
        attributes: { "pico.voice.utterance_duration_ms": 800 }
      }
    ]);
  });

  it("maps successful provider observations to allowlisted voice stage probes", async () => {
    const audit = createStructuredAuditLog();
    const wallClock = ["2026-07-19T00:00:00.000Z", "2026-07-19T00:00:01.000Z"];
    const monotonicClock = [10, 13, 20, 27];
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: (input) =>
          Promise.resolve(
            requestPath(input) === "/audio_query"
              ? new Response(JSON.stringify({ providerQuery: "private" }))
              : wavResponse()
          ),
        now: () => wallClock.shift() ?? "unexpected wall clock read",
        monotonicNow: () => monotonicClock.shift() ?? Number.NaN
      }
    );

    await collectEvents(tts.synthesize({ text: "秘密の本文。" }));

    expect(audit.entries().map((event) => event.attributes)).toEqual([
      {
        "pico.voice.stage": "tts_audio_query",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 3,
        "pico.voice.sentence_index": 0
      },
      {
        "pico.voice.stage": "tts_synthesize",
        "pico.voice.stage_status": "ok",
        "pico.voice.stage_duration_ms": 7,
        "pico.voice.sentence_index": 0
      }
    ]);
    const serialized = JSON.stringify(audit.entries());
    expect(serialized).not.toContain("秘密の本文");
    expect(serialized).not.toContain("providerQuery");
    expect(serialized).not.toContain("UklGR");
  });

  it("delivers each provider observation once to both the caller and runner probe", async () => {
    const audit = createStructuredAuditLog();
    const callerObservations: unknown[] = [];
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: (input) =>
          Promise.resolve(
            requestPath(input) === "/audio_query" ? new Response("{}") : wavResponse()
          ),
        observeStage: (observation) => {
          callerObservations.push(observation);
        }
      }
    );

    await collectEvents(tts.synthesize({ text: "一文。" }));

    expect(callerObservations).toHaveLength(2);
    expect(audit.entries()).toHaveLength(2);
    expect(callerObservations.map((value) => (value as { stage: string }).stage)).toEqual([
      "audio_query",
      "synthesis"
    ]);
    expect(audit.entries().map((event) => event.attributes["pico.voice.stage"])).toEqual([
      "tts_audio_query",
      "tts_synthesize"
    ]);
  });

  it("records the runner probe when the caller observer throws", async () => {
    const audit = createStructuredAuditLog();
    let callerObservationCount = 0;
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: (input) =>
          Promise.resolve(
            requestPath(input) === "/audio_query" ? new Response("{}") : wavResponse()
          ),
        observeStage: () => {
          callerObservationCount += 1;
          throw new Error("caller telemetry unavailable");
        }
      }
    );

    await expect(collectEvents(tts.synthesize({ text: "一文。" }))).resolves.toMatchObject([
      { kind: "chunk", chunk: { sentenceIndex: 0 } },
      { kind: "completed", chunkCount: 1 }
    ]);
    expect(callerObservationCount).toBe(2);
    expect(audit.entries()).toHaveLength(2);
  });

  it("prevents caller observation mutation from injecting trusted probe attributes", async () => {
    const audit = createStructuredAuditLog();
    let callerObservationCount = 0;
    let callerObservationWasFrozen = false;
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: () => Promise.resolve(new Response("provider unavailable", { status: 503 })),
        observeStage: (observation) => {
          callerObservationCount += 1;
          callerObservationWasFrozen = Object.isFrozen(observation);
          try {
            Object.defineProperty(observation, "errorCode", {
              configurable: true,
              enumerable: true,
              value: "injected-child-secret",
              writable: true
            });
            Object.defineProperty(observation, "status", {
              configurable: true,
              enumerable: true,
              value: "ok",
              writable: true
            });
          } catch {
            // Frozen observer input rejects runtime mutation.
          }
        }
      }
    );

    await expect(collectEvents(tts.synthesize({ text: "一文。" }))).resolves.toMatchObject([
      { kind: "failed", failure: { reason: "backend_error" } }
    ]);

    expect(callerObservationCount).toBe(1);
    expect(callerObservationWasFrozen).toBe(true);
    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0]?.attributes).toMatchObject({
      "pico.voice.stage": "tts_audio_query",
      "pico.voice.stage_status": "error",
      "pico.voice.error_code": "backend_error"
    });
    expect(JSON.stringify(audit.entries())).not.toContain("injected-child-secret");
  });

  it("maps provider error and skipped observations with only bounded error attributes", async () => {
    const errorAudit = createStructuredAuditLog();
    const errorTts = createConfiguredTts(
      residentConfig(),
      { audit: errorAudit },
      {
        fetch: () => Promise.resolve(new Response("private response", { status: 503 })),
        now: () => "2026-07-19T00:00:00.000Z",
        monotonicNow: () => 0
      }
    );

    await collectEvents(errorTts.synthesize({ text: "失敗する本文。" }));

    expect(errorAudit.entries().map((event) => event.attributes)).toEqual([
      {
        "pico.voice.stage": "tts_audio_query",
        "pico.voice.stage_status": "error",
        "pico.voice.stage_duration_ms": 0,
        "pico.voice.sentence_index": 0,
        "pico.voice.error_code": "backend_error"
      }
    ]);

    const skippedAudit = createStructuredAuditLog();
    const abortController = new AbortController();
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const skippedTts = createConfiguredTts(
      residentConfig(),
      { audit: skippedAudit },
      {
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requestStarted?.();
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
        now: () => "2026-07-19T00:00:00.000Z",
        monotonicNow: () => 0
      }
    );
    const events = collectEvents(
      skippedTts.synthesize({ text: "取り消す本文。", signal: abortController.signal })
    );
    await started;
    abortController.abort();
    await events;

    expect(skippedAudit.entries().map((event) => event.attributes)).toEqual([
      {
        "pico.voice.stage": "tts_audio_query",
        "pico.voice.stage_status": "skipped",
        "pico.voice.stage_duration_ms": 0,
        "pico.voice.sentence_index": 0,
        "pico.voice.error_code": "cancelled"
      }
    ]);
    expect(JSON.stringify([...errorAudit.entries(), ...skippedAudit.entries()])).not.toContain(
      "本文"
    );
  });

  it("keeps provider exception URLs and content out of runner probe serialization", async () => {
    const audit = createStructuredAuditLog();
    const callerObservations: unknown[] = [];
    const privateDiagnostic =
      "fetch failed /audio_query?text=runner秘密本文&speaker=private-speaker";
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: () => Promise.reject(new Error(privateDiagnostic)),
        observeStage: (observation) => {
          callerObservations.push(observation);
        }
      }
    );

    const events = await collectEvents(tts.synthesize({ text: "runner秘密本文。" }));
    const failureMessage = events[0]?.kind === "failed" ? events[0].failure.message : "";
    const serialized = JSON.stringify({
      failureMessage,
      callerObservations,
      auditEvents: audit.entries()
    });

    expect(failureMessage).toBe("pico TTS Aivis Speech audio_query request failed");
    expect(audit.entries()[0]?.attributes).toMatchObject({
      "pico.voice.stage": "tts_audio_query",
      "pico.voice.stage_status": "error",
      "pico.voice.error_code": "backend_error"
    });
    expect(serialized).not.toContain("runner秘密本文");
    expect(serialized).not.toContain("text=");
    expect(serialized).not.toContain("private-speaker");
  });

  it("contains probe validation failures without changing TTS completion", async () => {
    const audit = createStructuredAuditLog();
    let callerObservationCount = 0;
    const tts = createConfiguredTts(
      residentConfig(),
      { audit },
      {
        fetch: (input) =>
          Promise.resolve(
            requestPath(input) === "/audio_query" ? new Response("{}") : wavResponse()
          ),
        now: () => "invalid timestamp",
        observeStage: () => {
          callerObservationCount += 1;
        }
      }
    );

    await expect(collectEvents(tts.synthesize({ text: "一文。" }))).resolves.toMatchObject([
      { kind: "chunk", chunk: { sentenceIndex: 0 } },
      { kind: "completed", chunkCount: 1 }
    ]);
    expect(callerObservationCount).toBe(2);
    expect(audit.entries()).toEqual([]);
  });
});

describe("resident voice startup readiness", () => {
  it.each([
    {
      platform: "darwin",
      config: residentConfig("ffplay"),
      expectedPlan: { provider: "ffplay", command: "ffplay", route: "system_default" }
    },
    {
      platform: "linux",
      config: residentConfig("alsa"),
      expectedPlan: { provider: "alsa", command: "aplay", device: "hw:0,0" }
    }
  ] as const)("checks Aivis and $expectedPlan.provider playback readiness", async ({
    config,
    expectedPlan,
    platform
  }) => {
    const calls: string[] = [];

    await assertResidentVoiceStartupReadiness(config, {
      platform,
      checkAivisHealth: (service) => {
        calls.push(`aivis:${service.localBaseUrl}`);
        return Promise.resolve({ ok: true });
      },
      assertPlaybackReadiness: (plan) => {
        calls.push(`playback:${plan.command}`);
        expect(plan).toEqual(expectedPlan);
        return Promise.resolve();
      }
    });

    expect(calls).toEqual([`aivis:${aivisBaseUrl}`, `playback:${expectedPlan.command}`]);
  });

  it("invokes playback readiness even when Aivis health fails", async () => {
    const calls: string[] = [];

    await expect(
      assertResidentVoiceStartupReadiness(residentConfig(), {
        platform: "darwin",
        checkAivisHealth: () => {
          calls.push("aivis");
          return Promise.resolve({ ok: false, message: "speaker unavailable" });
        },
        assertPlaybackReadiness: () => {
          calls.push("playback");
          return Promise.resolve();
        }
      })
    ).rejects.toThrow("pico resident voice TTS provider is unhealthy: speaker unavailable");
    expect(calls).toEqual(["aivis", "playback"]);
  });

  it.each([
    "pico resident playback command ffplay is unavailable",
    "pico resident playback command ffplay exited with code 2 signal null",
    "pico resident playback command ffplay timed out after 5000ms"
  ])("preserves playback readiness failure identity: %s", async (message) => {
    const calls: string[] = [];

    await expect(
      assertResidentVoiceStartupReadiness(residentConfig(), {
        platform: "darwin",
        checkAivisHealth: () => {
          calls.push("aivis");
          return Promise.resolve({ ok: true });
        },
        assertPlaybackReadiness: () => {
          calls.push("playback");
          return Promise.reject(new Error(message));
        }
      })
    ).rejects.toThrow(message);
    expect(calls).toEqual(["aivis", "playback"]);
  });

  it("fails before creating resident loop owners when startup readiness rejects", async () => {
    const calls: string[] = [];

    await expect(
      runResidentVoiceWithProviders({
        config: residentConfig(),
        signal: new AbortController().signal,
        startupReadiness: () => {
          calls.push("readiness");
          return Promise.reject(new Error("readiness blocked"));
        },
        createPiAgent: () => {
          calls.push("pi");
          throw new Error("Pi owner must not be created");
        },
        createTelemetry: () => {
          calls.push("telemetry");
          throw new Error("telemetry owner must not be created");
        }
      })
    ).rejects.toThrow("readiness blocked");
    expect(calls).toEqual(["readiness"]);
  });
});

describe("resident voice runner ownership", () => {
  it("constructs OpenTelemetry only when enabled", async () => {
    const constructed: string[] = [];
    const createTelemetry = (options: OpenTelemetryProviderOptions): PicoTelemetry => {
      constructed.push(options.serviceName);
      return {
        record: () => undefined,
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
        health: () => ({
          logs: { consecutiveFailures: 0 },
          metrics: { consecutiveFailures: 0 }
        })
      };
    };

    expect(createConfiguredOpenTelemetry({ enabled: false }, createTelemetry)).toBeUndefined();
    const telemetry = createConfiguredOpenTelemetry(
      {
        enabled: true,
        baseUrl: "http://127.0.0.1:4318",
        serviceName: "pico-resident",
        timeoutMs: 10_000,
        metricExportIntervalMs: 15_000,
        shutdownTimeoutMs: 5_000
      },
      createTelemetry
    );

    expect(constructed).toEqual(["pico-resident"]);
    await expect(telemetry?.shutdown()).resolves.toBeUndefined();
  });

  it("contains telemetry shutdown failures to a bounded process diagnostic", async () => {
    const lines: string[] = [];

    await expect(
      shutdownResidentVoiceTelemetry(
        {
          record: () => undefined,
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.reject(new Error("collector shutdown failed")),
          health: () => ({
            logs: { consecutiveFailures: 1 },
            metrics: { consecutiveFailures: 1 }
          })
        },
        (line) => {
          lines.push(line);
        }
      )
    ).resolves.toBeUndefined();
    expect(lines).toEqual(["[pico] telemetry shutdown failed\n"]);
  });

  it("keeps the direct harness lock until a timed-out runtime actually settles", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
      },
      unregisterShutdownCleanup: () => {
        events.push("unregister");
      }
    });

    abortController.abort();

    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");
    expect(events).toEqual(["unregister"]);

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["unregister", "release"]);
  });

  it("releases the direct harness lock once when the runtime rejects", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.reject(new Error("runtime failed")),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("runtime failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("reports a direct harness lock release failure", async () => {
    const events: string[] = [];

    await expect(
      waitForDirectResidentVoiceRuntime({
        runtime: Promise.resolve(),
        signal: new AbortController().signal,
        shutdownGraceMs: 1_000,
        releaseLock: () => {
          events.push("release");
          throw new Error("release failed");
        },
        unregisterShutdownCleanup: () => {
          events.push("unregister");
        }
      })
    ).rejects.toThrow("release failed");
    expect(events).toEqual(["release", "unregister"]);
  });

  it("does not leak a late lock release failure after shutdown timeout", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let finishRuntime: (() => void) | undefined;
    const runtime = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const wait = waitForDirectResidentVoiceRuntime({
      runtime,
      signal: abortController.signal,
      shutdownGraceMs: 1,
      releaseLock: () => {
        events.push("release");
        throw new Error("late release failed");
      },
      unregisterShutdownCleanup: () => undefined
    });

    abortController.abort();
    await expect(wait).rejects.toThrow("shutdown exceeded 1 ms");

    finishRuntime?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["release"]);
  });

  it("starts the server, runtime, and bridge in order and shuts them down in reverse", async () => {
    const abortController = new AbortController();
    const events: string[] = [];
    let serverHandler: ResidentControlHandler | undefined;
    const lifecycle = runResidentControlLifecycle({
      signal: abortController.signal,
      startServer: (handle) => {
        events.push("server:start");
        serverHandler = handle;
        return Promise.resolve({
          url: "http://127.0.0.1:43127",
          close: () => {
            events.push("server:close");
            return Promise.resolve();
          }
        });
      },
      createRuntime: () => {
        events.push("runtime:start");
        return {
          handleControl: () => Promise.resolve("accepted"),
          state: () => "idle",
          completion: new Promise(() => undefined),
          stop: () => {
            events.push("runtime:stop");
            return Promise.resolve();
          }
        };
      },
      startBridge: () => {
        events.push("bridge:start");
        return Promise.resolve({
          completion: new Promise(() => undefined),
          close: () => {
            events.push("bridge:close");
            return Promise.resolve();
          }
        });
      }
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["server:start", "runtime:start", "bridge:start"]);
    await expect(
      serverHandler?.({ kind: "talk_pressed", occurredAt: "2026-07-17T00:00:00.000Z" })
    ).resolves.toBe("accepted");

    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
    expect(events).toEqual([
      "server:start",
      "runtime:start",
      "bridge:start",
      "runtime:stop",
      "bridge:close",
      "server:close"
    ]);
  });

  it("fails closed and cleans up when the managed bridge exits", async () => {
    const events: string[] = [];
    let rejectBridge: (error: Error) => void = () => undefined;
    const bridgeCompletion = new Promise<void>((_resolve, reject) => {
      rejectBridge = reject;
    });
    const lifecycle = runResidentControlLifecycle({
      signal: new AbortController().signal,
      startServer: () =>
        Promise.resolve({
          url: "http://127.0.0.1:43127",
          close: () => {
            events.push("server:close");
            return Promise.resolve();
          }
        }),
      createRuntime: () => ({
        handleControl: () => Promise.resolve("accepted"),
        state: () => "idle",
        completion: new Promise(() => undefined),
        stop: () => {
          events.push("runtime:stop");
          return Promise.resolve();
        }
      }),
      startBridge: () =>
        Promise.resolve({
          completion: bridgeCompletion,
          close: () => {
            events.push("bridge:close");
            return Promise.reject(new Error("bridge close also failed"));
          }
        })
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    rejectBridge(new Error("event tap stopped"));

    await expect(lifecycle).rejects.toThrow("event tap stopped");
    expect(events).toEqual(["runtime:stop", "bridge:close", "server:close"]);
  });

  it("requires the immutable control contract when resident voice is enabled", () => {
    expect(() =>
      requireResidentVoiceEnabled({
        voice: { resident: { enabled: true } }
      } as never)
    ).toThrow("pico resident voice runtime requires voice.resident.control config");
  });
});
