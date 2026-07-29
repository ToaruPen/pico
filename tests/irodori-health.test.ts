import { describe, expect, it } from "vitest";

import { checkIrodoriServiceHealth, defineIrodoriService } from "../src/modules/voice/index.js";

const service = defineIrodoriService({
  id: "windows-irodori-voicedesign",
  provider: "irodori",
  localBaseUrl: "http://127.0.0.1:18923",
  speaker: "カスミ",
  style: "calm",
  numSteps: 30,
  seed: 42
});

describe("Irodori health boundary", () => {
  it("requires an ok and loaded Irodori runtime", async () => {
    const fetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      expect(url).toBe("http://127.0.0.1:18923/health");
      expect(init?.redirect).toBe("error");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "ok",
            model_loaded: true,
            max_chunk_size: 4_194_304
          })
        )
      );
    };

    await expect(checkIrodoriServiceHealth(service, fetchImplementation)).resolves.toEqual({
      ok: true
    });
  });

  it("uses caller cancellation without adding an application timeout", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const health = checkIrodoriServiceHealth(
      service,
      (_input, init) => {
        receivedSignal = init?.signal;
        if (init?.signal === undefined || init.signal === null) {
          return Promise.reject(new Error("missing caller signal"));
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("caller cancelled health", "AbortError")),
            { once: true }
          );
        });
      },
      abortController.signal
    );

    expect(receivedSignal).toBe(abortController.signal);
    abortController.abort();
    const result = await health;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancelled Irodori health");
    expect(result.message).toContain("caller cancelled health");
  });

  it("reports a degraded runtime", async () => {
    const result = await checkIrodoriServiceHealth(service, () =>
      Promise.resolve(new Response(JSON.stringify({ status: "degraded", model_loaded: false })))
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected degraded Irodori health");
    expect(result.message).toContain("pico TTS Irodori health response is not ready");
  });

  it("reports a failed health status", async () => {
    const result = await checkIrodoriServiceHealth(service, () =>
      Promise.resolve(new Response("unavailable", { status: 503 }))
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed Irodori health");
    expect(result.message).toContain("status 503");
  });

  it("reports malformed health JSON", async () => {
    const result = await checkIrodoriServiceHealth(service, () =>
      Promise.resolve(new Response("{"))
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed Irodori health");
    expect(result.message).toContain("request failed");
  });

  it("rejects a health response whose declared size exceeds the boundary", async () => {
    const result = await checkIrodoriServiceHealth(service, () =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok", model_loaded: true }), {
          headers: {
            "content-length": String(64 * 1024 + 1)
          }
        })
      )
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected oversized Irodori health");
    expect(result.message).toContain("response is malformed");
  });

  it("rejects an oversized chunked health response", async () => {
    const oversizedPayload = new TextEncoder().encode(
      JSON.stringify({
        status: "ok",
        model_loaded: true,
        padding: "x".repeat(64 * 1024)
      })
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedPayload.slice(0, 32 * 1024));
          controller.enqueue(oversizedPayload.slice(32 * 1024));
          controller.close();
        }
      })
    );
    expect(response.headers.get("content-length")).toBeNull();

    const result = await checkIrodoriServiceHealth(service, () => Promise.resolve(response));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected oversized chunked Irodori health");
    expect(result.message).toContain("response is malformed");
  });
});
