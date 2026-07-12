import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { definePicoConfig } from "../src/config/index.js";
import { type PicoController, registerPicoStartup } from "../src/runtime/pico-startup.js";

type StartupHandler = (event: unknown, context: ExtensionContext) => unknown;

function createStartupHarness(options: {
  readonly pico: boolean;
  readonly setModelResult?: boolean;
  readonly events?: string[];
}) {
  const handlers = new Map<string, StartupHandler[]>();
  const registeredFlags = new Map<
    string,
    { readonly type: "boolean" | "string"; readonly default?: boolean | string }
  >();
  const events = options.events ?? [];

  return {
    api: {
      registerFlag(
        name: string,
        input: { readonly type: "boolean" | "string"; readonly default?: boolean | string }
      ): void {
        registeredFlags.set(name, input);
      },
      getFlag(name: string): boolean | string | undefined {
        return name === "pico" ? options.pico : undefined;
      },
      setModel(model: { readonly provider: string; readonly id: string }): Promise<boolean> {
        events.push(`set-model:${model.provider}/${model.id}`);
        return Promise.resolve(options.setModelResult ?? true);
      },
      setThinkingLevel(level: string): void {
        events.push(`set-thinking:${level}`);
      },
      on(event: string, handler: StartupHandler): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }
    },
    events,
    registeredFlags,
    async emit(event: string, value: unknown, context: ExtensionContext): Promise<unknown[]> {
      const results: unknown[] = [];

      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, context));
      }

      return results;
    }
  };
}

function createContext(events: string[], modelAvailable = true): ExtensionContext {
  return {
    modelRegistry: {
      find(provider: string, id: string) {
        events.push(`find-model:${provider}/${id}`);
        return modelAvailable ? { provider, id } : undefined;
      }
    },
    ui: {
      notify: (message: string, level: string) => {
        events.push(`notify:${level}:${message}`);
      }
    },
    shutdown: () => {
      events.push("shutdown");
    }
  } as ExtensionContext;
}

function configuredPicoModel() {
  return definePicoConfig({
    pico: {
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        thinkingLevel: "medium"
      }
    }
  });
}

describe("Pico startup", () => {
  it("registers one boolean --pico flag and leaves normal Pi untouched", async () => {
    const harness = createStartupHarness({ pico: false });
    let configLoads = 0;
    let controllerCreations = 0;

    registerPicoStartup(harness.api as never, {
      loadConfig: () => {
        configLoads += 1;
        return configuredPicoModel();
      },
      createController: () => {
        controllerCreations += 1;
        return completedController();
      }
    });

    await harness.emit("session_start", { type: "session_start" }, createContext(harness.events));

    expect(harness.registeredFlags.get("pico")).toEqual({
      type: "boolean",
      default: false,
      description: "Start Pico"
    });
    expect(configLoads).toBe(0);
    expect(controllerCreations).toBe(0);
    expect(harness.events).toEqual([]);
  });

  it("selects the exact YAML model before starting one Pico controller", async () => {
    const events: string[] = [];
    const harness = createStartupHarness({ pico: true, events });

    registerPicoStartup(harness.api as never, {
      loadConfig: configuredPicoModel,
      createController: () => {
        events.push("create-controller");
        return {
          start: () => {
            events.push("start-controller");
          },
          stop: () => {
            events.push("stop-controller");
          }
        };
      }
    });

    const context = createContext(events);
    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit("session_start", { type: "session_start" }, context);

    expect(events).toEqual([
      "find-model:openai-codex/gpt-5.6-sol",
      "set-model:openai-codex/gpt-5.6-sol",
      "set-thinking:medium",
      "create-controller",
      "start-controller"
    ]);
  });

  it("fails closed without a configured model, a registry match, or authentication", async () => {
    for (const scenario of ["missing-config", "missing-model", "missing-auth"] as const) {
      const events: string[] = [];
      const harness = createStartupHarness({
        pico: true,
        events,
        setModelResult: scenario !== "missing-auth"
      });
      let controllerCreations = 0;

      registerPicoStartup(harness.api as never, {
        loadConfig: () =>
          scenario === "missing-config" ? definePicoConfig({}) : configuredPicoModel(),
        createController: () => {
          controllerCreations += 1;
          return completedController();
        }
      });

      await harness.emit(
        "session_start",
        { type: "session_start" },
        createContext(events, scenario !== "missing-model")
      );

      expect(controllerCreations).toBe(0);
      expect(events.at(-1)).toBe("shutdown");
      expect(events.some((event) => event.startsWith("notify:error:"))).toBe(true);
    }
  });

  it("never exposes config or provider error details in startup notifications", async () => {
    const events: string[] = [];
    const harness = createStartupHarness({ pico: true, events });

    registerPicoStartup(harness.api as never, {
      loadConfig: () => {
        throw new Error("credential: SECRET_CONFIG_VALUE");
      },
      createController: completedController
    });

    await harness.emit("session_start", { type: "session_start" }, createContext(events));

    expect(events).toContain("notify:error:Pico startup failed (startup_failed)");
    expect(JSON.stringify(events)).not.toContain("SECRET_CONFIG_VALUE");
  });

  it("waits for controller shutdown and stops it only once", async () => {
    const harness = createStartupHarness({ pico: true });
    let releaseStop: (() => void) | undefined;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    registerPicoStartup(harness.api as never, {
      loadConfig: configuredPicoModel,
      createController: () => ({
        start: () => undefined,
        stop: async () => {
          harness.events.push("stop:start");
          await stopBarrier;
          harness.events.push("stop:end");
        }
      })
    });

    const context = createContext(harness.events);
    await harness.emit("session_start", { type: "session_start" }, context);
    let completed = false;
    const shutdown = harness
      .emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context)
      .then(() => {
        completed = true;
      });

    await Promise.resolve();
    expect(completed).toBe(false);
    releaseStop?.();
    await shutdown;
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);

    expect(harness.events.filter((event) => event === "stop:start")).toHaveLength(1);
    expect(harness.events.at(-1)).toBe("stop:end");
  });
});

function completedController(): PicoController {
  return {
    start: () => undefined,
    stop: () => undefined
  };
}
