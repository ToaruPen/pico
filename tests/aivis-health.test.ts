import { describe, expect, it } from "vitest";

import {
  checkAivisSpeechServiceHealth,
  defineAivisSpeechService
} from "../src/modules/voice/index.js";

const service = defineAivisSpeechService({
  id: "local-aivis",
  provider: "aivis-speech",
  localBaseUrl: "http://127.0.0.1:10101",
  speakerId: 1,
  timeoutMs: 250
});

describe("Aivis Speech health", () => {
  it("passes when the speakers endpoint is reachable", async () => {
    const fetchImplementation: typeof fetch = (input) => {
      expect(input).toBeInstanceOf(URL);
      expect((input as URL).href).toBe("http://127.0.0.1:10101/speakers");

      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              name: "test speaker",
              styles: [{ id: 1, name: "normal" }]
            }
          ]),
          { status: 200 }
        )
      );
    };

    await expect(checkAivisSpeechServiceHealth(service, fetchImplementation)).resolves.toEqual({
      ok: true
    });
  });

  it("returns a fail-closed health result when the service is unavailable", async () => {
    const fetchImplementation: typeof fetch = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:10101");
    };

    await expect(checkAivisSpeechServiceHealth(service, fetchImplementation)).resolves.toEqual({
      ok: false,
      message: "pico TTS Aivis Speech speakers request failed: connect ECONNREFUSED 127.0.0.1:10101"
    });
  });

  it("fails when the configured speaker id is missing", async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              name: "different speaker",
              styles: [{ id: 99, name: "normal" }]
            }
          ]),
          { status: 200 }
        )
      );

    await expect(checkAivisSpeechServiceHealth(service, fetchImplementation)).resolves.toEqual({
      ok: false,
      message: "pico TTS Aivis Speech speakerId 1 is not available from /speakers"
    });
  });
});
