import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildVoiceSmokePlan,
  runVoiceProviderSmoke,
  type VoiceSmokeReport,
  voiceSmokeExitCode
} from "../scripts/smoke/voice-providers.js";
import { definePicoConfig } from "../src/config/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildWav(samples: Uint8Array): ArrayBuffer {
  const sampleRateHz = 16_000;
  const channels = 1;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + samples.byteLength);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples.byteLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples.byteLength, 40);
  Buffer.from(samples).copy(buffer, 44);

  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function buildIrodoriStreamResponse(wav: ArrayBuffer): Response {
  const wavBytes = Buffer.from(wav);
  const handshake = Buffer.from(
    `${JSON.stringify({ kind: "handshake", v: 1, max_chunk_size: 4 * 1024 * 1024 })}\n`
  );
  const header = Buffer.from(
    `${JSON.stringify({
      kind: "chunk",
      v: 1,
      index: 0,
      nbytes: wavBytes.byteLength,
      final: true,
      elapsed: 0.1
    })}\n`
  );

  return new Response(Buffer.concat([handshake, header, wavBytes]), {
    headers: { "content-type": "application/octet-stream" }
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function ttsSmokeConfig() {
  return definePicoConfig({
    voice: {
      tts: {
        aivis: {
          localBaseUrl: "http://127.0.0.1:10101",
          speakerId: 1,
          text: "こんにちは。"
        }
      }
    }
  });
}

function irodoriSmokeConfig() {
  return definePicoConfig({
    voice: {
      tts: {
        provider: "irodori",
        aivis: {
          localBaseUrl: "http://127.0.0.1:10101",
          speakerId: 1
        },
        irodori: {
          localBaseUrl: "http://127.0.0.1:18923",
          speaker: "カスミ",
          style: "calm",
          numSteps: 30,
          seed: 42,
          text: "こんにちは。"
        }
      }
    }
  });
}

describe("voice provider smoke configuration", () => {
  it("keeps the finite TTS success report after collecting synthesis events", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      if (requestUrl(input).includes("/audio_query")) {
        return Promise.resolve(new Response(JSON.stringify({})));
      }

      return Promise.resolve(new Response(buildWav(Buffer.from([1, 0]))));
    });

    await expect(runVoiceProviderSmoke(ttsSmokeConfig())).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "apple-speech",
        reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
      },
      tts: {
        status: "passed",
        provider: "aivis-speech",
        details: {
          serviceId: "local-aivis",
          speakerId: 1,
          chunkCount: 1,
          totalAudioBytes: 2,
          totalDurationMs: 1,
          sampleRateHz: 16_000,
          channels: 1,
          encoding: "pcm16le"
        }
      }
    });
  });

  it("keeps the finite TTS failure report after collecting synthesis events", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("unavailable", { status: 503 })));

    await expect(runVoiceProviderSmoke(ttsSmokeConfig())).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "apple-speech",
        reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
      },
      tts: {
        status: "failed",
        provider: "aivis-speech",
        reason:
          "pico voice TTS smoke failed at sentence 0: backend_error: pico TTS Aivis Speech audio_query request failed with status 503"
      }
    });
  });

  it("smokes the selected Irodori provider and reports its voice identity", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(buildIrodoriStreamResponse(buildWav(Buffer.from([1, 0]))))
    );

    const monotonicNow = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_125);

    await expect(runVoiceProviderSmoke(irodoriSmokeConfig(), { monotonicNow })).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "apple-speech",
        reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
      },
      tts: {
        status: "passed",
        provider: "irodori",
        details: {
          serviceId: "windows-irodori-voicedesign",
          speaker: "カスミ",
          style: "calm",
          chunkCount: 1,
          totalAudioBytes: 2,
          totalDurationMs: 1,
          wallTimeMs: 125,
          serviceSynthesisMs: 100,
          realTimeFactor: 125,
          sampleRateHz: 16_000,
          channels: 1,
          encoding: "pcm16le"
        }
      }
    });
  });

  it("skips both provider smokes when endpoints are not configured", async () => {
    await expect(runVoiceProviderSmoke(definePicoConfig({}))).resolves.toEqual({
      stt: {
        status: "skipped",
        provider: "apple-speech",
        reason: "Set voice.stt.appleSpeech in pico config to run the Apple Speech STT smoke."
      },
      tts: {
        status: "skipped",
        provider: "aivis-speech",
        reason: "Set voice.tts.aivis in pico config to run the Aivis Speech TTS smoke."
      }
    });
  });

  it("builds explicit Apple Speech and Aivis Speech smoke plans from YAML config", () => {
    const plan = buildVoiceSmokePlan(
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: " http://127.0.0.1:8766 ",
              samplePcm16lePath: " ./samples/known-ja.pcm ",
              sampleRateHz: 16_000,
              channels: 1
            }
          },
          tts: {
            aivis: {
              localBaseUrl: " http://127.0.0.1:10101 ",
              speakerId: 1,
              text: "こんにちは。"
            }
          }
        }
      })
    );

    expect(plan.stt).toMatchObject({
      status: "run",
      samplePath: "./samples/known-ja.pcm",
      sampleRateHz: 16_000,
      channels: 1,
      sidecar: {
        id: "local-apple-speech",
        provider: "apple-speech",
        localBaseUrl: "http://127.0.0.1:8766",
        language: "ja-JP",
        timeoutMs: 30_000,
        warmup: {
          audioSeconds: 0.25
        }
      }
    });
    expect(plan.tts).toMatchObject({
      status: "run",
      text: "こんにちは。",
      service: {
        provider: "aivis-speech",
        localBaseUrl: "http://127.0.0.1:10101",
        speakerId: 1
      }
    });
  });

  it("builds only the selected Irodori TTS smoke plan", () => {
    expect(buildVoiceSmokePlan(irodoriSmokeConfig()).tts).toMatchObject({
      status: "run",
      text: "こんにちは。",
      service: {
        id: "windows-irodori-voicedesign",
        provider: "irodori",
        localBaseUrl: "http://127.0.0.1:18923",
        speaker: "カスミ",
        style: "calm",
        numSteps: 30,
        seed: 42
      }
    });
  });

  it("rejects invalid numeric smoke config values", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: -1
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.speakerId must be a non-negative integer");
  });

  it("uses a distinct skip reason when Apple Speech has no smoke sample", () => {
    expect(
      buildVoiceSmokePlan(
        definePicoConfig({
          voice: {
            stt: {
              appleSpeech: {
                localBaseUrl: "http://127.0.0.1:8766"
              }
            }
          }
        })
      ).stt
    ).toEqual({
      status: "skip",
      reason: "Set voice.stt.appleSpeech.samplePcm16lePath to run the Apple Speech STT smoke."
    });
  });

  it("rejects partial TTS provider smoke configuration", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101"
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.speakerId is required when voice.tts.aivis is set");
  });

  it("returns a failing process code only when a smoke section fails", () => {
    const report = {
      stt: {
        status: "skipped",
        provider: "apple-speech"
      },
      tts: {
        status: "failed",
        provider: "aivis-speech",
        reason: "empty audio"
      }
    } satisfies VoiceSmokeReport;

    expect(voiceSmokeExitCode(report)).toBe(1);

    const nonFailingReport = {
      stt: {
        status: "skipped",
        provider: "apple-speech"
      },
      tts: {
        status: "passed",
        provider: "aivis-speech"
      }
    } satisfies VoiceSmokeReport;

    expect(voiceSmokeExitCode(nonFailingReport)).toBe(0);
  });
});
