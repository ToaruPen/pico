import { describe, expect, it, vi } from "vitest";

import {
  createAivisSpeechTtsClient,
  createAppleSpeechSttClient,
  defineAivisSpeechService,
  defineAppleSpeechSidecar,
  parseAppleSpeechSidecarResponse,
  type SttTranscriptionRequest,
  segmentJapaneseSentences,
  splitCompleteJapaneseSentences
} from "../src/modules/voice/index.js";

const sidecar = defineAppleSpeechSidecar({
  id: "local-apple-speech",
  provider: "apple-speech",
  localBaseUrl: "http://127.0.0.1:8766",
  language: "ja-JP",
  timeoutMs: 250,
  warmup: {
    audioSeconds: 0.25
  }
});

const audioRequest = {
  audio: Buffer.from([0, 0, 1, 0]),
  encoding: "pcm16le",
  sampleRateHz: 16_000,
  channels: 1
} as const satisfies SttTranscriptionRequest;

type RecordedRequest = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
};

function buildSidecarResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify(content), {
    status
  });
}

function buildWav(
  samples: Uint8Array,
  options: { sampleRateHz: number; channels: number }
): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = options.channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + samples.byteLength);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples.byteLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(options.channels, 22);
  buffer.writeUInt32LE(options.sampleRateHz, 24);
  buffer.writeUInt32LE(options.sampleRateHz * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples.byteLength, 40);
  Buffer.from(samples).copy(buffer, 44);

  return buffer;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return arrayBuffer;
}

function unresolvedResponse(): Response {
  return new Response(
    new ReadableStream({
      start() {}
    })
  );
}

function requireRecordedBody(body: string | undefined): string {
  if (body === undefined) {
    throw new Error("expected STT test to record a request body");
  }

  return body;
}

function requireRecordedRequest(recordedRequest: RecordedRequest | undefined): RecordedRequest {
  if (recordedRequest === undefined) {
    throw new Error("expected STT test to record a sidecar request");
  }

  return recordedRequest;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("expected STT sidecar request body to be a string");
  }

  return init.body;
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

describe("Apple Speech STT sidecar boundary", () => {
  it("requires the explicit Apple Speech provider", () => {
    expect(() =>
      defineAppleSpeechSidecar({
        id: "local-apple-speech",
        provider: "mlx-whisper",
        localBaseUrl: "http://127.0.0.1:8766",
        language: "ja-JP",
        timeoutMs: 250,
        warmup: {
          audioSeconds: 0.25
        }
      })
    ).toThrow("pico STT sidecar provider must be apple-speech");
  });

  it("normalizes string config fields at the sidecar boundary", () => {
    const normalizedSidecar = defineAppleSpeechSidecar({
      id: " local-apple-speech ",
      provider: "apple-speech",
      localBaseUrl: " http://127.0.0.1:8766 ",
      language: " ja-JP ",
      timeoutMs: 250,
      warmup: {
        audioSeconds: 0.25
      }
    });

    expect(normalizedSidecar).toEqual(sidecar);
  });

  it.each([
    "http://localhost:8766",
    "http://[::1]:8766",
    "https://127.0.0.1:8766"
  ])("rejects URLs the IPv4 HTTP sidecar cannot serve: %s", (localBaseUrl) => {
    expect(() =>
      defineAppleSpeechSidecar({
        id: "local-apple-speech",
        provider: "apple-speech",
        localBaseUrl,
        language: "ja-JP",
        timeoutMs: 250,
        warmup: {
          audioSeconds: 0.25
        }
      })
    ).toThrow("pico STT sidecar localBaseUrl must use an http://127.0.0.1 origin");
  });

  it("rejects unsupported languages at the sidecar boundary", () => {
    expect(() =>
      defineAppleSpeechSidecar({
        id: "local-apple-speech",
        provider: "apple-speech",
        localBaseUrl: "http://127.0.0.1:8766",
        language: "en-US",
        timeoutMs: 250,
        warmup: {
          audioSeconds: 0.25
        }
      })
    ).toThrow("pico STT sidecar language must be ja-JP");
  });

  it("rejects empty audio without calling the sidecar", async () => {
    const recordingFetch: typeof fetch = () => {
      throw new Error("empty audio should not call the STT sidecar");
    };
    const client = createAppleSpeechSttClient(sidecar, recordingFetch);

    await expect(
      client.transcribe({
        ...audioRequest,
        audio: Buffer.from("")
      })
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_request",
      message:
        "pico Apple Speech STT request must be non-empty 16 kHz mono PCM16LE audio with an even byte length",
      source: {
        sidecarId: "local-apple-speech",
        provider: "apple-speech",
        language: "ja-JP"
      }
    });
  });

  it("posts PCM16LE audio and maps a transcript response", async () => {
    let recordedRequest: RecordedRequest | undefined;
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(
        buildSidecarResponse({
          ok: true,
          provider: "apple-speech",
          result: {
            text: "  こんにちは世界  ",
            language: "ja-JP",
            confidence: 0.85,
            durationMs: 1250,
            segments: [
              {
                text: "こんにちは世界",
                startMs: 0,
                endMs: 1250,
                confidence: 0.85
              }
            ]
          }
        })
      );
    };
    const client = createAppleSpeechSttClient(sidecar, recordingFetch);

    await expect(client.transcribe(audioRequest)).resolves.toEqual({
      ok: true,
      text: "こんにちは世界",
      language: "ja-JP",
      confidence: 0.85,
      durationMs: 1250,
      segments: [
        {
          text: "こんにちは世界",
          startMs: 0,
          endMs: 1250,
          confidence: 0.85
        }
      ],
      source: {
        sidecarId: "local-apple-speech",
        provider: "apple-speech",
        language: "ja-JP"
      }
    });

    const request = requireRecordedRequest(recordedRequest);

    expect(request.input).toBe("http://127.0.0.1:8766/v1/transcriptions");
    expect(request.init?.method).toBe("POST");
    expect(request.init?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody(request.init)).toBe(
      JSON.stringify({
        provider: "apple-speech",
        language: "ja-JP",
        timeoutMs: 250,
        audio: {
          encoding: "pcm16le",
          sampleRateHz: 16_000,
          channels: 1,
          dataBase64: "AAABAA=="
        },
        normalization: {
          targetEncoding: "pcm16le",
          targetSampleRateHz: 16_000,
          targetChannels: 1
        }
      })
    );
  });

  it("normalizes trailing slash sidecar URLs when posting transcription requests", async () => {
    let recordedRequest: RecordedRequest | undefined;
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(
        buildSidecarResponse({
          ok: true,
          provider: "apple-speech",
          result: {
            text: "ok",
            language: "ja-JP",
            confidence: 1,
            durationMs: 1,
            segments: []
          }
        })
      );
    };
    const client = createAppleSpeechSttClient(
      {
        ...sidecar,
        localBaseUrl: "http://127.0.0.1:8766/"
      },
      recordingFetch
    );

    await client.transcribe(audioRequest);

    expect(requireRecordedRequest(recordedRequest).input).toBe(
      "http://127.0.0.1:8766/v1/transcriptions"
    );
  });

  it("maps sidecar request timeouts to an explicit failure result", async () => {
    vi.useFakeTimers();
    let abortObserved = false;
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const client = createAppleSpeechSttClient(sidecar, slowFetch);

    try {
      const resultPromise = client.transcribe(audioRequest);

      await vi.advanceTimersByTimeAsync(250);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        reason: "timeout",
        message: "pico STT Apple Speech sidecar request timed out",
        source: {
          sidecarId: "local-apple-speech",
          provider: "apple-speech",
          language: "ja-JP"
        }
      });
      expect(abortObserved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an active transcription without retrying or accepting a late result", async () => {
    let calls = 0;
    let abortObserved = false;
    const pendingFetch: typeof fetch = (_input, init) => {
      calls += 1;

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const controller = new AbortController();
    const client = createAppleSpeechSttClient(sidecar, pendingFetch);
    const transcription = client.transcribe({ ...audioRequest, signal: controller.signal });

    controller.abort();

    await expect(transcription).resolves.toEqual({
      ok: false,
      reason: "aborted",
      message: "pico STT Apple Speech sidecar request was aborted",
      source: {
        sidecarId: "local-apple-speech",
        provider: "apple-speech",
        language: "ja-JP"
      }
    });
    expect(abortObserved).toBe(true);
    expect(calls).toBe(1);
  });

  it("maps sidecar failure responses to explicit failure results", async () => {
    const failingFetch: typeof fetch = () =>
      Promise.resolve(
        buildSidecarResponse(
          {
            ok: false,
            provider: "apple-speech",
            error: {
              code: "model_load",
              message: "speech assets are unavailable"
            }
          },
          503
        )
      );
    const client = createAppleSpeechSttClient(sidecar, failingFetch);

    await expect(client.transcribe(audioRequest)).resolves.toEqual({
      ok: false,
      reason: "model_load",
      message: "speech assets are unavailable",
      source: {
        sidecarId: "local-apple-speech",
        provider: "apple-speech",
        language: "ja-JP"
      }
    });
  });

  it("maps sidecar transport failures to explicit failure results", async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new Error("connection refused"));
    const client = createAppleSpeechSttClient(sidecar, failingFetch);

    await expect(client.transcribe(audioRequest)).resolves.toEqual({
      ok: false,
      reason: "backend_error",
      message: "pico STT Apple Speech sidecar request failed: connection refused",
      source: {
        sidecarId: "local-apple-speech",
        provider: "apple-speech",
        language: "ja-JP"
      }
    });
  });

  it("maps malformed sidecar JSON to explicit failure results", async () => {
    const malformedFetch: typeof fetch = () =>
      Promise.resolve(
        new Response("not json", {
          status: 200
        })
      );
    const client = createAppleSpeechSttClient(sidecar, malformedFetch);

    const result = await client.transcribe(audioRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("backend_error");
      expect(result.message).toContain("pico STT Apple Speech sidecar request failed:");
    }
  });

  it.each([
    ["odd byte length", { audio: Buffer.from([0, 0, 1]) }],
    ["wrong sample rate", { sampleRateHz: 48_000 }],
    ["wrong channel count", { channels: 2 }]
  ])("rejects %s before calling the sidecar", async (_name, override) => {
    const recordingFetch: typeof fetch = () => {
      throw new Error("invalid PCM16LE audio should not call the STT sidecar");
    };
    const client = createAppleSpeechSttClient(sidecar, recordingFetch);

    const invalidRequest = {
      ...audioRequest,
      ...override
    } as unknown as SttTranscriptionRequest;

    await expect(client.transcribe(invalidRequest)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_request",
      message:
        "pico Apple Speech STT request must be non-empty 16 kHz mono PCM16LE audio with an even byte length"
    });
  });

  it.each([
    ["non-object response", []],
    [
      "old MLX response",
      {
        ok: true,
        provider: "mlx-whisper",
        result: {
          text: "こんにちは世界",
          language: "ja-JP",
          confidence: 0.85,
          durationMs: 1250,
          segments: []
        }
      }
    ],
    [
      "extra root field",
      {
        ok: true,
        provider: "apple-speech",
        result: {
          text: "こんにちは世界",
          language: "ja-JP",
          confidence: 0.85,
          durationMs: 1250,
          segments: []
        },
        extra: true
      }
    ],
    [
      "extra result field",
      {
        ok: true,
        provider: "apple-speech",
        result: {
          text: "こんにちは世界",
          language: "ja-JP",
          confidence: 0.85,
          durationMs: 1250,
          segments: [],
          extra: true
        }
      }
    ],
    [
      "extra failure field",
      {
        ok: false,
        provider: "apple-speech",
        error: {
          code: "model_load",
          message: "speech assets are unavailable",
          extra: true
        }
      }
    ],
    [
      "non-string text",
      {
        ok: true,
        provider: "apple-speech",
        result: {
          text: 1,
          language: "ja-JP",
          confidence: 0.85,
          durationMs: 1250,
          segments: []
        }
      }
    ],
    [
      "invalid segment",
      {
        ok: true,
        provider: "apple-speech",
        result: {
          text: "こんにちは世界",
          language: "ja-JP",
          confidence: 0.85,
          durationMs: 1250,
          segments: [{ text: "こんにちは世界", startMs: 1250, endMs: 0 }]
        }
      }
    ]
  ])("rejects malformed sidecar transcript responses: %s", (_name, payload) => {
    expect(() => parseAppleSpeechSidecarResponse(payload)).toThrow(
      "pico STT Apple Speech sidecar response is malformed"
    );
  });

  it("builds a repeatable warmup request with synthetic 16 kHz mono silence", async () => {
    const recordedBodies: string[] = [];
    const recordingFetch: typeof fetch = (_input, init) => {
      recordedBodies.push(requestBody(init));

      return Promise.resolve(
        buildSidecarResponse({
          ok: true,
          provider: "apple-speech",
          result: {
            text: "",
            language: "ja-JP",
            confidence: 0,
            durationMs: 0,
            segments: []
          }
        })
      );
    };
    const client = createAppleSpeechSttClient(sidecar, recordingFetch);

    await client.warmup();
    await client.warmup();

    expect(recordedBodies).toHaveLength(2);
    const firstBody = requireRecordedBody(recordedBodies[0]);
    expect(JSON.parse(firstBody) as unknown).toMatchObject({
      provider: "apple-speech",
      audio: {
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1
      }
    });
    expect(firstBody).toBe(recordedBodies[1]);
  });
});

const aivisService = defineAivisSpeechService({
  id: "local-aivis",
  provider: "aivis-speech",
  localBaseUrl: "http://127.0.0.1:10101",
  speakerId: 1,
  timeoutMs: 250,
  voice: {
    speedScale: 1.08,
    pitchScale: 0.03,
    intonationScale: 1.12,
    volumeScale: 1
  }
});

describe("Aivis Speech TTS boundary", () => {
  it("requires the explicit Aivis Speech provider", () => {
    expect(() =>
      defineAivisSpeechService({
        id: "other-tts",
        provider: "voicevox",
        localBaseUrl: "http://127.0.0.1:10101",
        speakerId: 1,
        timeoutMs: 250
      })
    ).toThrow("pico TTS service provider must be aivis-speech");
  });

  it("segments Japanese sentences with closing punctuation and residual text", () => {
    expect(segmentJapaneseSentences("こんにちは、元気？今日は楽しかった！また遊ぼう")).toEqual([
      "こんにちは、元気？",
      "今日は楽しかった！",
      "また遊ぼう"
    ]);

    expect(segmentJapaneseSentences("「今日は楽しかったね？」と聞いた。やったー！』")).toEqual([
      "「今日は楽しかったね？」",
      "と聞いた。",
      "やったー！』"
    ]);

    expect(splitCompleteJapaneseSentences("おかえり。今日はどう")).toEqual({
      complete: ["おかえり。"],
      residual: "今日はどう"
    });
  });

  it("posts audio_query then synthesis requests and returns ordered sentence audio chunks", async () => {
    const recordedRequests: RecordedRequest[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequests.push({ input, init });
      const url = requestUrl(input);

      if (url.includes("/audio_query")) {
        return Promise.resolve(
          buildSidecarResponse({
            speedScale: 1,
            pitchScale: 0,
            intonationScale: 1,
            volumeScale: 1
          })
        );
      }

      if (url.includes("/synthesis")) {
        const body = JSON.parse(requestBody(init)) as { text: string };
        const samples =
          body.text === "こんにちは。"
            ? Buffer.from([0x10, 0, 0x20, 0])
            : Buffer.from([0x30, 0, 0x40, 0]);

        return Promise.resolve(
          new Response(bytesToArrayBuffer(buildWav(samples, { sampleRateHz: 24_000, channels: 1 })))
        );
      }

      throw new Error(`unexpected Aivis Speech path: ${url}`);
    };
    const client = createAivisSpeechTtsClient(aivisService, recordingFetch);

    await expect(client.synthesize({ text: "こんにちは。今日は元気？" })).resolves.toEqual({
      ok: true,
      chunks: [
        {
          sentenceIndex: 0,
          text: "こんにちは。",
          audio: Buffer.from([0x10, 0, 0x20, 0]),
          encoding: "pcm16le",
          sampleRateHz: 24_000,
          channels: 1,
          durationMs: 1,
          source: {
            serviceId: "local-aivis",
            provider: "aivis-speech",
            speakerId: 1
          }
        },
        {
          sentenceIndex: 1,
          text: "今日は元気？",
          audio: Buffer.from([0x30, 0, 0x40, 0]),
          encoding: "pcm16le",
          sampleRateHz: 24_000,
          channels: 1,
          durationMs: 1,
          source: {
            serviceId: "local-aivis",
            provider: "aivis-speech",
            speakerId: 1
          }
        }
      ],
      totalDurationMs: 2,
      source: {
        serviceId: "local-aivis",
        provider: "aivis-speech",
        speakerId: 1
      }
    });

    expect(recordedRequests.map((request) => requestUrl(request.input))).toEqual([
      "http://127.0.0.1:10101/audio_query?text=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF%E3%80%82&speaker=1",
      "http://127.0.0.1:10101/synthesis?speaker=1",
      "http://127.0.0.1:10101/audio_query?text=%E4%BB%8A%E6%97%A5%E3%81%AF%E5%85%83%E6%B0%97%EF%BC%9F&speaker=1",
      "http://127.0.0.1:10101/synthesis?speaker=1"
    ]);
    expect(requestBody(recordedRequests[1]?.init)).toBe(
      JSON.stringify({
        speedScale: 1.08,
        pitchScale: 0.03,
        intonationScale: 1.12,
        volumeScale: 1,
        text: "こんにちは。"
      })
    );
  });

  it("maps Aivis Speech HTTP failures to structured synthesis failures", async () => {
    const failingFetch: typeof fetch = (input) => {
      if (requestUrl(input).includes("/audio_query")) {
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }

      throw new Error("synthesis should not run after audio_query failure");
    };
    const client = createAivisSpeechTtsClient(aivisService, failingFetch);

    await expect(client.synthesize({ text: "こんにちは。" })).resolves.toEqual({
      ok: false,
      reason: "backend_error",
      message: "pico TTS Aivis Speech audio_query request failed with status 503",
      sentenceIndex: 0,
      source: {
        serviceId: "local-aivis",
        provider: "aivis-speech",
        speakerId: 1
      }
    });
  });

  it("maps synthesis HTTP failures to structured synthesis failures", async () => {
    const failingFetch: typeof fetch = (input) => {
      if (requestUrl(input).includes("/audio_query")) {
        return Promise.resolve(buildSidecarResponse({}));
      }

      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };
    const client = createAivisSpeechTtsClient(aivisService, failingFetch);

    await expect(client.synthesize({ text: "こんにちは。" })).resolves.toEqual({
      ok: false,
      reason: "backend_error",
      message: "pico TTS Aivis Speech synthesis request failed with status 503",
      sentenceIndex: 0,
      source: {
        serviceId: "local-aivis",
        provider: "aivis-speech",
        speakerId: 1
      }
    });
  });

  it("maps malformed WAV responses to structured synthesis failures", async () => {
    const malformedFetch: typeof fetch = (input) => {
      if (requestUrl(input).includes("/audio_query")) {
        return Promise.resolve(buildSidecarResponse({}));
      }

      return Promise.resolve(new Response("not a wav"));
    };
    const client = createAivisSpeechTtsClient(aivisService, malformedFetch);

    await expect(client.synthesize({ text: "こんにちは。" })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_response",
      message: "pico TTS Aivis Speech WAV response is malformed",
      sentenceIndex: 0
    });
  });

  it("maps timeout and caller cancellation to separate synthesis failures", async () => {
    vi.useFakeTimers();
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const timeoutClient = createAivisSpeechTtsClient(aivisService, slowFetch);

    try {
      const resultPromise = timeoutClient.synthesize({ text: "こんにちは。" });
      await vi.advanceTimersByTimeAsync(250);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        reason: "timeout",
        sentenceIndex: 0
      });
    } finally {
      vi.useRealTimers();
    }

    const abortController = new AbortController();
    abortController.abort();
    const cancelledClient = createAivisSpeechTtsClient(aivisService, () => {
      throw new Error("cancelled request should not call Aivis Speech");
    });

    await expect(
      cancelledClient.synthesize({ text: "こんにちは。", signal: abortController.signal })
    ).resolves.toMatchObject({
      ok: false,
      reason: "cancelled",
      sentenceIndex: 0
    });
  });

  it("keeps timeouts active while reading Aivis Speech response bodies", async () => {
    vi.useFakeTimers();
    const stalledBodyFetch: typeof fetch = () => Promise.resolve(unresolvedResponse());
    const client = createAivisSpeechTtsClient(aivisService, stalledBodyFetch);
    const pending = Symbol("pending");

    try {
      const resultPromise = client.synthesize({ text: "こんにちは。" });

      await vi.advanceTimersByTimeAsync(250);

      await expect(Promise.race([resultPromise, Promise.resolve(pending)])).resolves.toMatchObject({
        ok: false,
        reason: "timeout",
        sentenceIndex: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caller cancellation active while reading Aivis Speech response bodies", async () => {
    const abortController = new AbortController();
    const stalledBodyFetch: typeof fetch = () => Promise.resolve(unresolvedResponse());
    const client = createAivisSpeechTtsClient(aivisService, stalledBodyFetch);
    const pending = Symbol("pending");

    const resultPromise = client.synthesize({
      text: "こんにちは。",
      signal: abortController.signal
    });
    await Promise.resolve();
    await Promise.resolve();
    abortController.abort();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    await expect(Promise.race([resultPromise, Promise.resolve(pending)])).resolves.toMatchObject({
      ok: false,
      reason: "cancelled",
      sentenceIndex: 0
    });
  });
});
