import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PicoRuntimeProfile = "worker" | "interactive" | "resident";

export type ResidentVoiceController = {
  readonly start: () => void | Promise<void>;
  readonly stop: () => void | Promise<void>;
};

export type PicoRuntimeProfileOptions = {
  readonly createResidentController: (context: ExtensionContext) => ResidentVoiceController;
};

const runtimeProfileFlag = "pico-runtime-profile";

export function resolvePicoRuntimeProfile(value: unknown): PicoRuntimeProfile {
  if (value === undefined || value === "worker") {
    return "worker";
  }

  if (value === "interactive" || value === "resident") {
    return value;
  }

  throw new Error("pico-runtime-profile must be worker, interactive, or resident");
}

export function registerPicoRuntimeProfile(
  pi: ExtensionAPI,
  options: PicoRuntimeProfileOptions
): void {
  let selectedProfile: PicoRuntimeProfile | undefined;
  let controller: ResidentVoiceController | undefined;
  let startOperation: Promise<void> | undefined;
  let shutdownOperation: Promise<void> | undefined;
  let closed = false;

  pi.registerFlag(runtimeProfileFlag, {
    description: "Pico runtime profile: worker, interactive, or resident",
    type: "string",
    default: "worker"
  });

  pi.on("session_start", async (_event, context) => {
    try {
      if (closed) {
        throw new Error("pico runtime profile is shutting down");
      }

      const profile = resolvePicoRuntimeProfile(pi.getFlag(runtimeProfileFlag));

      if (selectedProfile !== undefined && selectedProfile !== profile) {
        throw new Error("pico-runtime-profile is startup-only and cannot change");
      }

      selectedProfile = profile;
      enforceActiveTools(pi, profile);

      if (profile !== "resident") {
        return;
      }

      if (controller === undefined) {
        controller = options.createResidentController(context);
        startOperation = Promise.resolve(controller.start());
      }

      await startOperation;
    } catch (error) {
      closed = true;
      failClosed(context, error);
    }
  });

  pi.on("tool_call", (event) => {
    const profile = selectedProfile ?? "worker";

    if (isToolAllowed(profile, event.toolName)) {
      return;
    }

    return {
      block: true,
      reason: `pico ${profile} profile denies ${event.toolName}`
    };
  });

  pi.on("session_shutdown", () => {
    if (shutdownOperation !== undefined) {
      return shutdownOperation;
    }

    closed = true;
    const currentController = controller;

    if (currentController === undefined) {
      return;
    }

    shutdownOperation = (async () => {
      try {
        await startOperation;
      } catch {
        // A partially started controller still owns cleanup responsibility.
      }

      try {
        await currentController.stop();
      } finally {
        controller = undefined;
      }
    })();

    return shutdownOperation;
  });
}

function enforceActiveTools(pi: ExtensionAPI, profile: PicoRuntimeProfile): void {
  const activeTools = pi.getActiveTools();

  if (profile === "interactive") {
    return;
  }

  pi.setActiveTools(activeTools.filter((toolName) => isToolAllowed(profile, toolName)));
}

function isToolAllowed(profile: PicoRuntimeProfile, toolName: string): boolean {
  if (profile === "interactive") {
    return true;
  }

  if (profile === "resident") {
    return toolName !== "pico_session" && toolName !== "subagent";
  }

  return (
    !toolName.startsWith("pico_") && !toolName.startsWith("stackchan_") && toolName !== "subagent"
  );
}

function failClosed(context: ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  context.ui.notify(message, "error");
  context.shutdown();
}
