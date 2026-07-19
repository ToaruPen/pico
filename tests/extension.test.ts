import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  discoverAndLoadExtensions,
  type Extension,
  type ExtensionContext,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import picoExtension, {
  createPicoRegistry,
  picoExtensionMetadata,
  registerPicoExtensionWithRuntime
} from "../src/index.js";

type PicoBeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  context: ExtensionContext
) => BeforeAgentStartEventResult;

type CapturedExtensionApi = {
  readonly handlers: Map<string, unknown[]>;
  readonly tools: ToolDefinition[];
  readonly flags: Map<
    string,
    { readonly type: "boolean" | "string"; readonly default?: boolean | string }
  >;
};

function createCapturedExtensionApi(): CapturedExtensionApi {
  return {
    handlers: new Map(),
    tools: [],
    flags: new Map()
  };
}

function extensionApiFromCapture(capture: CapturedExtensionApi) {
  return {
    on(event: string, handler: unknown) {
      capture.handlers.set(event, [...(capture.handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      capture.tools.push(tool);
    },
    registerFlag(
      name: string,
      options: { readonly type: "boolean" | "string"; readonly default?: boolean | string }
    ) {
      capture.flags.set(name, options);
    },
    getFlag(name: string) {
      return capture.flags.get(name)?.default;
    },
    getActiveTools() {
      return capture.tools.map((tool) => tool.name);
    },
    setActiveTools() {
      return undefined;
    },
    sendUserMessage() {
      return undefined;
    }
  };
}

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
      "session",
      "local_models",
      "handoff",
      "audit",
      "identity_registry",
      "transport"
    ]);
    expect(picoExtensionMetadata.futureModules.map((module) => module.kind)).toEqual([
      "voice",
      "vision",
      "camera",
      "channels"
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
  }, 15_000);

  it("keeps the parent extension limited to identity and resident lifecycle", () => {
    const capture = createCapturedExtensionApi();

    picoExtension(extensionApiFromCapture(capture) as never);

    expect(capture.flags.get("pico")).toEqual({
      type: "boolean",
      default: false,
      description: "Start Pico"
    });
    expect([...capture.handlers.keys()].sort()).toEqual([
      "before_agent_start",
      "session_shutdown",
      "session_start"
    ]);
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
    expect(handlerResult.systemPrompt).toContain(
      "identity_registry: Provides a local child identity registry"
    );
    expect(handlerResult.systemPrompt).toContain("Planned pico modules:");
    expect(handlerResult.systemPrompt).toContain(
      "vision: Bounded scene understanding through Qwen/Qwen3.5-9B"
    );
  });

  it("registers exactly the standard perception tools", () => {
    const capture = createCapturedExtensionApi();

    picoExtension(extensionApiFromCapture(capture) as never);

    expect(capture.tools.map((tool) => tool.name).sort()).toEqual([
      "pico_camera_scene_description",
      "pico_camera_snapshot",
      "pico_person_detection"
    ]);
  });

  it("uses deferred perception tools for resident voice sessions", () => {
    const capture = createCapturedExtensionApi();

    registerPicoExtensionWithRuntime(extensionApiFromCapture(capture) as never, {
      perceptionMode: "resident_deferred",
      deferredTools: {
        sessionId: "session-1",
        coordinator: {
          enqueue: () => ({
            status: "queued",
            kind: "camera_scene_description",
            jobId: "deferred-job-1",
            sessionId: "session-1"
          })
        } as never
      }
    });

    expect(capture.tools.map((tool) => tool.name).sort()).toEqual([
      "pico_camera_scene_description_deferred"
    ]);
  });

  it("passes injected config loading into default perception tools", async () => {
    const capture = createCapturedExtensionApi();
    let loadConfigCalls = 0;

    registerPicoExtensionWithRuntime(extensionApiFromCapture(capture) as never, {
      loadConfig: () => {
        loadConfigCalls += 1;
        throw new Error("test config loader reached");
      }
    });

    const perceptionTools = capture.tools.filter((tool) =>
      ["pico_camera_scene_description", "pico_camera_snapshot", "pico_person_detection"].includes(
        tool.name
      )
    );

    for (const tool of perceptionTools) {
      await tool.execute("tool-call-config", {}, undefined, undefined, {} as ExtensionContext);
    }

    expect(perceptionTools.map((tool) => tool.name).sort()).toEqual([
      "pico_camera_scene_description",
      "pico_camera_snapshot",
      "pico_person_detection"
    ]);
    expect(loadConfigCalls).toBe(3);
  });

  it("uses standard perception tools when resident deferred mode has no coordinator", () => {
    const capture = createCapturedExtensionApi();

    registerPicoExtensionWithRuntime(extensionApiFromCapture(capture) as never, {
      perceptionMode: "resident_deferred"
    });

    expect(capture.tools.map((tool) => tool.name).sort()).toEqual([
      "pico_camera_scene_description",
      "pico_camera_snapshot",
      "pico_person_detection"
    ]);
  });
});
