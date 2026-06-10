import { describe, expect, it, vi } from "vitest";

import {
  createMlxWhisperSttClient,
  defineMlxWhisperSidecar,
  parseMlxWhisperSidecarResponse,
  type SttTranscriptionRequest
} from "../src/modules/voice/index.js";

const sidecar = defineMlxWhisperSidecar({
  id: "local-mlx-whisper",
  provider: "mlx-whisper",
  localBaseUrl: "http://127.0.0.1:8765",
  modelRepo: "mlx-community/whisper-large-v3-turbo",
  language: "ja",
  timeoutMs: 250,
  warmup: {
    audioSeconds: 0.25
  }
});

const audioRequest = {
  audio: Buffer.from([0, 0, 1, 0]),
  encoding: "pcm16le",
  sampleRateHz: 48_000,
  channels: 2
} as const satisfies SttTranscriptionRequest;

type RecordedRequest = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
};

function buildSidecarResponse(content: unknown): Response {
  return new Response(JSON.stringify(content), {
    status: 200
  });
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

describe("mlx-whisper STT sidecar boundary", () => {
  it("requires the explicit mlx-whisper provider", () => {
    expect(() =>
      defineMlxWhisperSidecar({
        id: "apple-speech",
        provider: "apple_speech_analyzer",
        localBaseUrl: "http://127.0.0.1:8765",
        modelRepo: "mlx-community/whisper-large-v3-turbo",
        language: "ja",
        timeoutMs: 250,
        warmup: {
          audioSeconds: 0.25
        }
      })
    ).toThrow("pico STT sidecar provider must be mlx-whisper");
  });

  it("normalizes string config fields at the sidecar boundary", () => {
    const normalizedSidecar = defineMlxWhisperSidecar({
      id: " local-mlx-whisper ",
      provider: "mlx-whisper",
      localBaseUrl: " http://127.0.0.1:8765 ",
      modelRepo: " mlx-community/whisper-large-v3-turbo ",
      language: " ja ",
      timeoutMs: 250,
      warmup: {
        audioSeconds: 0.25
      }
    });

    expect(normalizedSidecar).toEqual(sidecar);
  });

  it("returns an empty transcript for empty audio without calling the sidecar", async () => {
    const recordingFetch: typeof fetch = () => {
      throw new Error("empty audio should not call the STT sidecar");
    };
    const client = createMlxWhisperSttClient(sidecar, recordingFetch);

    await expect(
      client.transcribe({
        ...audioRequest,
        audio: Buffer.from("")
      })
    ).resolves.toEqual({
      ok: true,
      text: "",
      language: "ja",
      confidence: 0,
      durationMs: 0,
      segments: [],
      source: {
        sidecarId: "local-mlx-whisper",
        provider: "mlx-whisper",
        modelRepo: "mlx-community/whisper-large-v3-turbo"
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
          provider: "mlx-whisper",
          result: {
            text: "  こんにちは世界  ",
            language: "ja",
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
    const client = createMlxWhisperSttClient(sidecar, recordingFetch);

    await expect(client.transcribe(audioRequest)).resolves.toEqual({
      ok: true,
      text: "こんにちは世界",
      language: "ja",
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
        sidecarId: "local-mlx-whisper",
        provider: "mlx-whisper",
        modelRepo: "mlx-community/whisper-large-v3-turbo"
      }
    });

    const request = requireRecordedRequest(recordedRequest);

    expect(request.input).toBe("http://127.0.0.1:8765/v1/transcriptions");
    expect(request.init?.method).toBe("POST");
    expect(request.init?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody(request.init)).toBe(
      JSON.stringify({
        provider: "mlx-whisper",
        modelRepo: "mlx-community/whisper-large-v3-turbo",
        language: "ja",
        timeoutMs: 250,
        audio: {
          encoding: "pcm16le",
          sampleRateHz: 48_000,
          channels: 2,
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
    const client = createMlxWhisperSttClient(sidecar, slowFetch);

    try {
      const resultPromise = client.transcribe(audioRequest);

      await vi.advanceTimersByTimeAsync(250);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        reason: "timeout",
        message: "pico STT mlx-whisper sidecar request timed out",
        source: {
          sidecarId: "local-mlx-whisper",
          provider: "mlx-whisper",
          modelRepo: "mlx-community/whisper-large-v3-turbo"
        }
      });
      expect(abortObserved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps sidecar failure responses to explicit failure results", async () => {
    const failingFetch: typeof fetch = () =>
      Promise.resolve(
        buildSidecarResponse({
          ok: false,
          provider: "mlx-whisper",
          error: {
            code: "model_load",
            message: "HF cache missing"
          }
        })
      );
    const client = createMlxWhisperSttClient(sidecar, failingFetch);

    await expect(client.transcribe(audioRequest)).resolves.toEqual({
      ok: false,
      reason: "model_load",
      message: "HF cache missing",
      source: {
        sidecarId: "local-mlx-whisper",
        provider: "mlx-whisper",
        modelRepo: "mlx-community/whisper-large-v3-turbo"
      }
    });
  });

  it.each([
    ["non-object response", []],
    [
      "wrong provider",
      {
        ok: true,
        provider: "apple_speech_analyzer",
        result: {
          text: "こんにちは世界",
          language: "ja",
          confidence: 0.85,
          durationMs: 1250,
          segments: []
        }
      }
    ],
    [
      "non-string text",
      {
        ok: true,
        provider: "mlx-whisper",
        result: {
          text: 1,
          language: "ja",
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
        provider: "mlx-whisper",
        result: {
          text: "こんにちは世界",
          language: "ja",
          confidence: 0.85,
          durationMs: 1250,
          segments: [{ text: "こんにちは世界", startMs: 1250, endMs: 0 }]
        }
      }
    ]
  ])("rejects malformed sidecar transcript responses: %s", (_name, payload) => {
    expect(() => parseMlxWhisperSidecarResponse(payload)).toThrow(
      "pico STT mlx-whisper sidecar response is malformed"
    );
  });

  it("builds a repeatable warmup request with synthetic 16 kHz mono silence", async () => {
    const recordedBodies: string[] = [];
    const recordingFetch: typeof fetch = (_input, init) => {
      recordedBodies.push(requestBody(init));

      return Promise.resolve(
        buildSidecarResponse({
          ok: true,
          provider: "mlx-whisper",
          result: {
            text: "",
            language: "ja",
            confidence: 0,
            durationMs: 0,
            segments: []
          }
        })
      );
    };
    const client = createMlxWhisperSttClient(sidecar, recordingFetch);

    await client.warmup();
    await client.warmup();

    expect(recordedBodies).toHaveLength(2);
    const firstBody = requireRecordedBody(recordedBodies[0]);
    expect(JSON.parse(firstBody) as unknown).toMatchObject({
      provider: "mlx-whisper",
      audio: {
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1
      }
    });
    expect(firstBody).toBe(recordedBodies[1]);
  });
});
