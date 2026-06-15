import { describe, expect, it, vi } from "vitest";

import { defineSelectedModelEndpoint } from "../src/modules/local-models/index.js";
import {
  createOllamaSceneDescriptionClient,
  describeScene,
  parseOllamaSceneDescriptionResponse,
  type SceneDescriptionRequest
} from "../src/modules/vision/index.js";

const selectedEndpoint = defineSelectedModelEndpoint({
  id: "windows-ollama-qwen3-5",
  provider: "ollama",
  model: "qwen3.5:9b",
  host: {
    platform: "windows",
    tunnel: {
      kind: "tailscale_ssh",
      localBaseUrl: "http://127.0.0.1:11434",
      sshTarget: "pico-vision-host"
    }
  }
});

const sceneRequest = {
  endpoint: selectedEndpoint,
  image: Buffer.from("jpeg-frame"),
  mimeType: "image/jpeg",
  purpose: "motion_followup"
} as const satisfies SceneDescriptionRequest;

const structuredSceneContent = {
  summary: "A room is visible.",
  observedPeople: [],
  environment: ["indoor room"],
  humanAttention: [],
  uncertainty: ["single snapshot"]
} as const;

const expectedOllamaSceneRequestBody = {
  model: "qwen3.5:9b",
  messages: [
    {
      role: "user",
      content:
        "Return exactly one JSON object and no markdown. The object must have these keys: summary, observedPeople, environment, humanAttention, uncertainty. Each key except summary must be an array of strings. Describe only visible after-school care scene details. Do not identify children, infer private traits, diagnose, score, or make final safety decisions. If no people, attention items, or uncertainties are visible, use an empty array. Uncertainty must be an array of short strings.",
      images: ["anBlZy1mcmFtZQ=="]
    }
  ],
  stream: false,
  think: false,
  format: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "observedPeople", "environment", "humanAttention", "uncertainty"],
    properties: {
      summary: { type: "string" },
      observedPeople: { type: "array", items: { type: "string" } },
      environment: { type: "array", items: { type: "string" } },
      humanAttention: { type: "array", items: { type: "string" } },
      uncertainty: { type: "array", items: { type: "string" } }
    }
  },
  options: {
    temperature: 0.2,
    num_predict: 256
  }
} as const;

type RecordedRequest = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
};

function buildOllamaResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      message: {
        content: JSON.stringify(content)
      },
      done: true
    }),
    {
      status: 200
    }
  );
}

function requireRecordedRequest(recordedRequest: RecordedRequest | undefined): RecordedRequest {
  if (recordedRequest === undefined) {
    throw new Error("expected vision test to record an Ollama request");
  }

  return recordedRequest;
}

describe("bounded vision scene description", () => {
  it("provides a bounded scene description client", async () => {
    const responseFetch: typeof fetch = () =>
      Promise.resolve(buildOllamaResponse(structuredSceneContent));
    const client = createOllamaSceneDescriptionClient(responseFetch);

    await expect(client.describeScene(sceneRequest)).resolves.toMatchObject({
      summary: "A room is visible.",
      source: {
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        purpose: "motion_followup"
      }
    });
  });

  it("posts a bounded Ollama image chat request through the selected endpoint", async () => {
    let recordedRequest: RecordedRequest | undefined;
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(buildOllamaResponse(structuredSceneContent));
    };

    await describeScene(sceneRequest, recordingFetch);

    const request = requireRecordedRequest(recordedRequest);

    expect(request.input).toBe("http://127.0.0.1:11434/api/chat");
    expect(request.init?.method).toBe("POST");
    expect(request.init?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(request.init?.body).toBe(JSON.stringify(expectedOllamaSceneRequestBody));
  });

  it("adds configured auth headers to protected Ollama image chat requests", async () => {
    let recordedRequest: RecordedRequest | undefined;
    const authenticatedEndpoint = defineSelectedModelEndpoint({
      ...selectedEndpoint,
      host: {
        ...selectedEndpoint.host,
        auth: {
          headerName: "x-api-key",
          apiKey: "local-dev-key"
        }
      }
    });
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(buildOllamaResponse(structuredSceneContent));
    };

    await describeScene(
      {
        ...sceneRequest,
        endpoint: authenticatedEndpoint
      },
      recordingFetch
    );

    expect(requireRecordedRequest(recordedRequest).init?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "local-dev-key"
    });
  });

  it("normalizes the Ollama image chat URL when the local tunnel URL has a trailing slash", async () => {
    let recordedRequest: RecordedRequest | undefined;
    const endpointWithSlash = defineSelectedModelEndpoint({
      ...selectedEndpoint,
      host: {
        ...selectedEndpoint.host,
        tunnel: {
          ...selectedEndpoint.host.tunnel,
          localBaseUrl: "http://127.0.0.1:11434/"
        }
      }
    });
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(buildOllamaResponse(structuredSceneContent));
    };

    await describeScene(
      {
        ...sceneRequest,
        endpoint: endpointWithSlash
      },
      recordingFetch
    );

    expect(requireRecordedRequest(recordedRequest).input).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("includes a bounded Ollama error body when the scene request fails", async () => {
    const failingFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "model failed to load, check ollama server logs for details"
          }),
          { status: 500 }
        )
      );

    await expect(describeScene(sceneRequest, failingFetch)).rejects.toThrow(
      'pico vision Ollama request failed with status 500: {"error":"model failed to load, check ollama server logs for details"}'
    );
  });

  it("truncates oversized Ollama error bodies in scene request failures", async () => {
    const oversizedBody = "x".repeat(620);
    const failingFetch: typeof fetch = () =>
      Promise.resolve(new Response(oversizedBody, { status: 500 }));

    let thrown: unknown;
    try {
      await describeScene(sceneRequest, failingFetch);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(
      `pico vision Ollama request failed with status 500: ${oversizedBody.slice(0, 500)}...`
    );
    expect(message).not.toContain(oversizedBody.slice(0, 501));
  });

  it("includes the network failure cause when the scene request cannot reach Ollama", async () => {
    const socketError = new Error("other side closed");
    socketError.name = "SocketError";
    const failingFetch: typeof fetch = () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: socketError
        })
      );

    await expect(describeScene(sceneRequest, failingFetch)).rejects.toThrow(
      "pico vision Ollama request failed: fetch failed: SocketError: other side closed"
    );
  });

  it("aborts Ollama scene requests after the bounded request timeout", async () => {
    vi.useFakeTimers();
    let abortObserved = false;
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    try {
      const resultPromise = describeScene(sceneRequest, slowFetch);
      const rejectionExpectation = expect(resultPromise).rejects.toThrow(
        "pico vision Ollama request timed out"
      );

      await vi.advanceTimersByTimeAsync(30_000);

      expect(abortObserved).toBe(true);
      await rejectionExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the request timeout when one is provided", async () => {
    vi.useFakeTimers();
    let abortObserved = false;
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    try {
      const resultPromise = describeScene({ ...sceneRequest, timeoutMs: 45_000 }, slowFetch);
      const rejectionExpectation = expect(resultPromise).rejects.toThrow(
        "pico vision Ollama request timed out after 45000 ms"
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(abortObserved).toBe(false);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(abortObserved).toBe(true);
      await rejectionExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Ollama scene requests on timeout even when the fetch adapter ignores abort", async () => {
    vi.useFakeTimers();
    const ignoringFetch: typeof fetch = () => new Promise<Response>(() => undefined);
    const settled = vi.fn<(message: string) => void>();

    try {
      void describeScene(sceneRequest, ignoringFetch).catch((error: unknown) => {
        settled(error instanceof Error ? error.message : String(error));
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out after 30000 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts Ollama scene response parsing after the bounded request timeout", async () => {
    vi.useFakeTimers();
    const slowResponse = new Response("{}", { status: 200 });
    vi.spyOn(slowResponse, "json").mockImplementation(() => new Promise<unknown>(() => undefined));
    const slowJsonFetch: typeof fetch = () => Promise.resolve(slowResponse);
    const settled = vi.fn<(message: string) => void>();

    try {
      void describeScene(sceneRequest, slowJsonFetch).catch((error: unknown) => {
        settled(error instanceof Error ? error.message : String(error));
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out after 30000 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects late Ollama responses after the request timeout has already fired", async () => {
    vi.useFakeTimers();
    const slowResponse = new Response("{}", { status: 200 });
    vi.spyOn(slowResponse, "json").mockImplementation(() => new Promise<unknown>(() => undefined));
    const lateFetch: typeof fetch = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(slowResponse);
        }, 31_000);
      });
    const settled = vi.fn<(message: string) => void>();

    try {
      void describeScene(sceneRequest, lateFetch).catch((error: unknown) => {
        settled(error instanceof Error ? error.message : String(error));
      });

      await vi.advanceTimersByTimeAsync(31_000);
      await Promise.resolve();

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out after 30000 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["non-object response", []],
    ["missing message", {}],
    ["invalid message", { message: [] }],
    ["non-string content", { message: { content: 1 } }],
    ["invalid JSON content", { message: { content: "not json" } }],
    [
      "schema mismatch",
      {
        message: {
          content: JSON.stringify({
            summary: "A room is visible.",
            observedPeople: ["one person"]
          })
        }
      }
    ]
  ])("rejects malformed Ollama scene responses: %s", (_name, responsePayload) => {
    expect(() => parseOllamaSceneDescriptionResponse(responsePayload)).toThrow(
      "pico vision scene response is malformed"
    );
  });

  it("rejects empty model output", () => {
    expect(() =>
      parseOllamaSceneDescriptionResponse({
        message: {
          content: "   "
        }
      })
    ).toThrow("pico vision scene response content is empty");
  });

  it("accepts fenced JSON object output from Ollama vision models", () => {
    expect(
      parseOllamaSceneDescriptionResponse({
        message: {
          content: `\`\`\`json
{
  "summary": "A room is visible.",
  "observedPeople": [],
  "environment": ["indoor room"],
  "humanAttention": [],
  "uncertainty": ["single snapshot"]
}
\`\`\``
        }
      })
    ).toEqual({
      summary: "A room is visible.",
      observedPeople: [],
      environment: ["indoor room"],
      humanAttention: [],
      uncertainty: ["single snapshot"]
    });
  });

  it("rejects model output that crosses individual child assessment boundaries", () => {
    expect(() =>
      parseOllamaSceneDescriptionResponse({
        message: {
          content: JSON.stringify({
            summary: "A child ID badge is visible.",
            observedPeople: ["child score appears high"],
            environment: ["indoor room"],
            humanAttention: ["staff should identify the child"],
            uncertainty: ["single snapshot"]
          })
        }
      })
    ).toThrow("pico vision scene response must not identify or assess individual children");
  });

  it.each([
    ["identify a child"],
    ["diagnose the child"],
    ["child diagnosis is likely"],
    ["assess the child"],
    ["evaluate the child"],
    ["child evaluation is visible"],
    ["ｃｈｉｌｄ　ｅｖａｌｕａｔｉｏｎ"],
    ["子どもを診断"],
    ["子どもを評価"],
    ["子どもの評価"]
  ])("rejects model output boundary variant: %s", (boundaryText) => {
    expect(() =>
      parseOllamaSceneDescriptionResponse({
        message: {
          content: JSON.stringify({
            summary: "A room is visible.",
            observedPeople: [boundaryText],
            environment: ["indoor room"],
            humanAttention: [],
            uncertainty: ["single snapshot"]
          })
        }
      })
    ).toThrow("pico vision scene response must not identify or assess individual children");
  });

  it("maps structured model output without returning raw image data", async () => {
    const responseFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                summary: "A child-sized table and indoor activity area are visible.",
                observedPeople: ["two people are seated near the table"],
                environment: ["indoor room", "activity table"],
                humanAttention: ["staff should verify whether the table area needs tidying"],
                uncertainty: ["faces and identities are not assessed"]
              })
            },
            done: true
          }),
          {
            status: 200
          }
        )
      );

    await expect(describeScene(sceneRequest, responseFetch)).resolves.toEqual({
      summary: "A child-sized table and indoor activity area are visible.",
      observedPeople: ["two people are seated near the table"],
      environment: ["indoor room", "activity table"],
      humanAttention: ["staff should verify whether the table area needs tidying"],
      uncertainty: ["faces and identities are not assessed"],
      source: {
        endpointId: "windows-ollama-qwen3-5",
        model: "qwen3.5:9b",
        purpose: "motion_followup"
      }
    });
  });
});
