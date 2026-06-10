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
        "Describe this after-school care scene as bounded JSON. Do not identify children, infer private traits, diagnose, score, or make final safety decisions. Include only visible scene details, uncertainty, and items a human staff member may need to check.",
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

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out");
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

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out");
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

      expect(settled).toHaveBeenCalledWith("pico vision Ollama request timed out");
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
