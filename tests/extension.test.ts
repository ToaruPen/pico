import { describe, expect, it } from "vitest";

import picoExtension, { createPicoRegistry } from "../src/index.js";

describe("pico extension", () => {
  it("exports a Pi package extension shape", () => {
    expect(picoExtension.id).toBe("pico");
    expect(picoExtension.systemPrompt).toContain("one AI support staff member");
    expect(picoExtension.modules.map((module) => module.kind)).toEqual([
      "context",
      "memory",
      "local_models",
      "handoff",
      "audit",
      "transport"
    ]);
  });

  it("marks Qwen3.5-9B as the selected planned vision provider", () => {
    const vision = picoExtension.futureModules.find((module) => module.kind === "vision");

    expect(vision?.selectedProvider).toBe(
      "Qwen/Qwen3.5-9B via Ollama qwen3.5:9b over a Tailscale or Cloudflare-protected SSH tunnel"
    );
  });

  it("creates an independent registry for each call", () => {
    expect(createPicoRegistry()).not.toBe(createPicoRegistry());
  });
});
