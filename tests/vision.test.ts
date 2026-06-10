import { describe, expect, it } from "vitest";

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

describe("bounded vision scene description", () => {
  it("provides a bounded scene description client", async () => {
    const responseFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                summary: "A room is visible.",
                observedPeople: [],
                environment: ["indoor room"],
                humanAttention: [],
                uncertainty: ["single snapshot"]
              })
            },
            done: true
          }),
          {
            status: 200
          }
        )
      );
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
    let recordedRequest:
      | {
          readonly input: RequestInfo | URL;
          readonly init: RequestInit | undefined;
        }
      | undefined;
    const recordingFetch: typeof fetch = (input, init) => {
      recordedRequest = { input, init };

      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                summary: "A room is visible.",
                observedPeople: [],
                environment: ["indoor room"],
                humanAttention: [],
                uncertainty: ["single snapshot"]
              })
            },
            done: true
          }),
          {
            status: 200
          }
        )
      );
    };

    await describeScene(sceneRequest, recordingFetch);

    expect(recordedRequest?.input).toBe("http://127.0.0.1:11434/api/chat");
    expect(recordedRequest?.init).toEqual({
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
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
      })
    });
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
