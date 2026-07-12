import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  registerPicoRuntimeProfile,
  resolvePicoRuntimeProfile,
  type ResidentVoiceController
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
      registerFlag(
        name: string,
        input: { readonly default?: boolean | string }
      ): void {
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
    async emit(event: string, value: unknown, context: ExtensionContext): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler(value, context);
      }
    }
  };
}

function createContext(): ExtensionContext {
  return {} as ExtensionContext;
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

    expect(harness.getActiveTools()).toEqual([
      "read",
      "pico_camera_snapshot",
      "stackchan_say",
      "subagent"
    ]);
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

  it("rejects an unknown startup profile before creating resident state", async () => {
    const harness = createProfileHarness({ profile: "unknown" });
    let controllerCreations = 0;

    registerPicoRuntimeProfile(harness.api as never, {
      createResidentController: () => {
        controllerCreations += 1;
        return createCompletedController();
      }
    });

    await expect(
      harness.emit("session_start", { type: "session_start" }, createContext())
    ).rejects.toThrow("pico-runtime-profile");
    expect(controllerCreations).toBe(0);
  });
});

function createCompletedController(): ResidentVoiceController {
  return {
    start: () => undefined,
    stop: () => undefined
  };
}
