import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  type ResidentVoiceController,
  registerPicoRuntimeProfile,
  resolvePicoRuntimeProfile
} from "../src/runtime/pico-runtime-profile.js";

type ProfileHandler = (event: unknown, context: ExtensionContext) => unknown;

function createProfileHarness(options: {
  readonly profile?: string;
  readonly activeTools?: readonly string[];
}) {
  const handlers = new Map<string, ProfileHandler[]>();
  const flagDefaults = new Map<string, boolean | string>();
  let activeTools = [...(options.activeTools ?? [])];

  return {
    api: {
      registerFlag(name: string, input: { readonly default?: boolean | string }): void {
        if (input.default !== undefined) {
          flagDefaults.set(name, input.default);
        }
      },
      getFlag(name: string): boolean | string | undefined {
        return options.profile ?? flagDefaults.get(name);
      },
      getActiveTools(): string[] {
        return [...activeTools];
      },
      setActiveTools(toolNames: string[]): void {
        activeTools = [...toolNames];
      },
      on(event: string, handler: ProfileHandler): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }
    },
    getActiveTools: () => [...activeTools],
    async emit(event: string, value: unknown, context: ExtensionContext): Promise<unknown[]> {
      const results: unknown[] = [];

      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, context));
      }

      return results;
    }
  };
}

function createContext(events: string[] = []): ExtensionContext {
  return {
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

describe("Pico runtime profile", () => {
  it("uses worker as the safe default and accepts only declared profiles", () => {
    expect(resolvePicoRuntimeProfile(undefined)).toBe("worker");
    expect(resolvePicoRuntimeProfile("worker")).toBe("worker");
    expect(resolvePicoRuntimeProfile("interactive")).toBe("interactive");
    expect(resolvePicoRuntimeProfile("resident")).toBe("resident");
    expect(() => resolvePicoRuntimeProfile("unknown")).toThrow("pico-runtime-profile");
  });

  it("removes Pico, Stack-chan, and recursive delegation tools from worker sessions", async () => {
    const harness = createProfileHarness({
      activeTools: [
        "read",
        "bash",
        "pico_session",
        "pico_camera_snapshot",
        "stackchan_get_status",
        "stackchan_say",
        "subagent"
      ]
    });
    let controllerCreations = 0;

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => {
        controllerCreations += 1;
        return createCompletedController();
      }
    });

    await harness.emit("session_start", { type: "session_start" }, createContext());

    expect(harness.getActiveTools()).toEqual(["read", "bash"]);
    expect(controllerCreations).toBe(0);
  });

  it("preserves active tools for an explicit interactive session", async () => {
    const activeTools = ["read", "pico_session", "stackchan_say", "subagent"];
    const harness = createProfileHarness({ profile: "interactive", activeTools });

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: createCompletedController
    });

    await harness.emit("session_start", { type: "session_start" }, createContext());

    expect(harness.getActiveTools()).toEqual(activeTools);
  });

  it("starts one resident controller and keeps Pi-owned parent capabilities", async () => {
    const harness = createProfileHarness({
      profile: "resident",
      activeTools: ["read", "pico_session", "pico_camera_snapshot", "stackchan_say", "subagent"]
    });
    const lifecycle: string[] = [];

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => ({
        start: () => {
          lifecycle.push("start");
        },
        stop: () => {
          lifecycle.push("stop");
        }
      })
    });

    const context = createContext();
    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit("session_start", { type: "session_start" }, context);

    expect(harness.getActiveTools()).toEqual(["read", "pico_camera_snapshot", "stackchan_say"]);
    expect(lifecycle).toEqual(["start"]);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
    expect(lifecycle).toEqual(["start", "stop"]);
  });

  it("waits for resident shutdown and stops the controller only once", async () => {
    const harness = createProfileHarness({ profile: "resident" });
    const lifecycle: string[] = [];
    let releaseStop: (() => void) | undefined;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => ({
        start: () => {
          lifecycle.push("start");
        },
        stop: async () => {
          lifecycle.push("stop:start");
          await stopBarrier;
          lifecycle.push("stop:end");
        }
      })
    });

    const context = createContext();
    await harness.emit("session_start", { type: "session_start" }, context);
    let shutdownCompleted = false;
    const shutdown = harness
      .emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context)
      .then(() => {
        shutdownCompleted = true;
      });

    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);
    expect(lifecycle).toEqual(["start", "stop:start"]);

    releaseStop?.();
    await shutdown;
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);

    expect(lifecycle).toEqual(["start", "stop:start", "stop:end"]);
  });

  it("fails closed for an unknown startup profile before creating resident state", async () => {
    const harness = createProfileHarness({ profile: "unknown" });
    const events: string[] = [];
    let controllerCreations = 0;

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => {
        controllerCreations += 1;
        return createCompletedController();
      }
    });

    await harness.emit("session_start", { type: "session_start" }, createContext(events));

    expect(controllerCreations).toBe(0);
    expect(events).toEqual([
      "notify:error:pico-runtime-profile must be worker, interactive, or resident",
      "shutdown"
    ]);
  });

  it("fails closed when resident controller startup fails", async () => {
    const harness = createProfileHarness({ profile: "resident" });
    const events: string[] = [];

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => ({
        start: () => {
          throw new Error("resident start failed");
        },
        stop: () => undefined
      })
    });

    await harness.emit("session_start", { type: "session_start" }, createContext(events));

    expect(events).toEqual(["notify:error:resident start failed", "shutdown"]);
  });

  it("blocks worker and resident capabilities even if another extension reactivates them", async () => {
    const workerHarness = createProfileHarness({ profile: "worker", activeTools: ["read"] });
    registerPicoRuntimeProfile(workerHarness.api as never, {
      createResidentController: createCompletedController
    });
    const workerContext = createContext();
    await workerHarness.emit("session_start", { type: "session_start" }, workerContext);
    workerHarness.api.setActiveTools(["read", "pico_session", "stackchan_say", "subagent"]);

    for (const toolName of ["pico_session", "stackchan_say", "subagent"]) {
      await expect(
        workerHarness.emit(
          "tool_call",
          { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} },
          workerContext
        )
      ).resolves.toContainEqual({
        block: true,
        reason: `pico worker profile denies ${toolName}`
      });
    }

    const residentHarness = createProfileHarness({ profile: "resident", activeTools: ["read"] });
    registerPicoRuntimeProfile(residentHarness.api as never, {
      createResidentController: createCompletedController
    });
    const residentContext = createContext();
    await residentHarness.emit("session_start", { type: "session_start" }, residentContext);
    residentHarness.api.setActiveTools(["read", "pico_session", "subagent"]);

    for (const toolName of ["pico_session", "subagent"]) {
      await expect(
        residentHarness.emit(
          "tool_call",
          { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} },
          residentContext
        )
      ).resolves.toContainEqual({
        block: true,
        reason: `pico resident profile denies ${toolName}`
      });
    }
  });

  it("uses the worker deny policy before session startup completes", async () => {
    const harness = createProfileHarness({ profile: "interactive", activeTools: ["read"] });
    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: createCompletedController
    });
    const context = createContext();

    for (const toolName of ["pico_session", "stackchan_say", "subagent"]) {
      await expect(
        harness.emit(
          "tool_call",
          { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} },
          context
        )
      ).resolves.toContainEqual({
        block: true,
        reason: `pico worker profile denies ${toolName}`
      });
    }

    await expect(
      harness.emit(
        "tool_call",
        { type: "tool_call", toolCallId: "call-read", toolName: "read", input: {} },
        context
      )
    ).resolves.toEqual([undefined]);
  });
});

function createCompletedController(): ResidentVoiceController {
  return {
    start: () => undefined,
    stop: () => undefined
  };
}
