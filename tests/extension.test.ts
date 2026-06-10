import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  discoverAndLoadExtensions,
  type Extension,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import picoExtension, { createPicoRegistry, picoExtensionMetadata } from "../src/index.js";

type PicoBeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  context: ExtensionContext
) => BeforeAgentStartEventResult;

async function loadPicoExtension(): Promise<Extension> {
  const result = await discoverAndLoadExtensions(["./src/index.ts"], process.cwd());

  if (result.errors.length > 0) {
    throw new Error(`pico extension load errors: ${JSON.stringify(result.errors)}`);
  }

  const extension = result.extensions[0];

  if (extension === undefined) {
    throw new Error("pico extension did not load");
  }

  return extension;
}

function getBeforeAgentStartHandler(extension: Extension): PicoBeforeAgentStartHandler {
  const handler = extension.handlers.get("before_agent_start")?.[0] as
    | PicoBeforeAgentStartHandler
    | undefined;

  if (handler === undefined) {
    throw new Error("pico extension did not register a before_agent_start handler");
  }

  return handler;
}

describe("pico extension", () => {
  it("exports a Pi extension factory", () => {
    expect(picoExtension).toBeTypeOf("function");
    expect(picoExtensionMetadata.id).toBe("pico");
    expect(picoExtensionMetadata.systemPrompt).toContain("one AI support staff member");
    expect(picoExtensionMetadata.modules.map((module) => module.kind)).toEqual([
      "context",
      "memory",
      "local_models",
      "handoff",
      "audit",
      "transport"
    ]);
  });

  it("marks Qwen3.5-9B as the selected planned vision provider", () => {
    const vision = picoExtensionMetadata.futureModules.find((module) => module.kind === "vision");

    expect(vision?.selectedProvider).toBe(
      "Qwen/Qwen3.5-9B via Ollama qwen3.5:9b over a Tailscale or Cloudflare-protected SSH tunnel"
    );
  });

  it("creates an independent registry for each call", () => {
    expect(createPicoRegistry()).not.toBe(createPicoRegistry());
  });

  it("loads from package pi.extensions through the Pi extension loader", async () => {
    const packageJsonContents = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const packageJson = JSON.parse(packageJsonContents) as { pi: { extensions: string[] } };

    const result = await discoverAndLoadExtensions(packageJson.pi.extensions, process.cwd());

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.path).toBe(
      fileURLToPath(new URL("../src/index.ts", import.meta.url))
    );
  });

  it("adds pico identity and module metadata to the Pi system prompt", async () => {
    const event = {
      type: "before_agent_start",
      prompt: "今日の予定を確認して",
      systemPrompt: "Base Pi system prompt.",
      systemPromptOptions: { cwd: process.cwd() }
    } satisfies BeforeAgentStartEvent;

    const extension = await loadPicoExtension();
    const handlerResult = getBeforeAgentStartHandler(extension)(event, {} as ExtensionContext);

    expect(handlerResult.systemPrompt).toContain("Base Pi system prompt.");
    expect(handlerResult.systemPrompt).toContain(
      "You are pico, one AI support staff member in an after-school care facility."
    );
    expect(handlerResult.systemPrompt).toContain("Available pico modules:");
    expect(handlerResult.systemPrompt).toContain("context: Provides structured facility context");
    expect(handlerResult.systemPrompt).toContain("Planned pico modules:");
    expect(handlerResult.systemPrompt).toContain(
      "vision: Bounded scene understanding through Qwen/Qwen3.5-9B"
    );
  });
});
