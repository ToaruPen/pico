import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  loadPicoConfigFromEnvironment,
  type PicoAgentModelConfig,
  type PicoConfig
} from "../config/index.js";

export type PicoController = {
  readonly start: () => void | Promise<void>;
  readonly stop: () => void | Promise<void>;
};

export type PicoStartupOptions = {
  readonly loadConfig?: () => PicoConfig;
  readonly createController: (context: ExtensionContext) => PicoController;
};

const picoFlag = "pico";

class PicoStartupUserError extends Error {}

export function registerPicoStartup(pi: ExtensionAPI, options: PicoStartupOptions): void {
  let controller: PicoController | undefined;
  let startOperation: Promise<void> | undefined;
  let shutdownOperation: Promise<void> | undefined;
  let closed = false;

  pi.registerFlag(picoFlag, {
    description: "Start Pico",
    type: "boolean",
    default: false
  });

  pi.on("session_start", async (_event, context) => {
    if (pi.getFlag(picoFlag) !== true) {
      return;
    }

    try {
      if (closed) {
        throw new PicoStartupUserError("Pico is shutting down");
      }

      if (startOperation === undefined) {
        startOperation = startPico(pi, context, options, (created) => {
          controller = created;
        });
      }

      await startOperation;
    } catch (error) {
      closed = true;
      failClosed(context, error);
    }
  });

  pi.on("session_shutdown", () => {
    if (shutdownOperation !== undefined) {
      return shutdownOperation;
    }

    closed = true;

    if (startOperation === undefined) {
      return;
    }

    shutdownOperation = stopPico(
      startOperation,
      () => controller,
      () => {
        controller = undefined;
      }
    );

    return shutdownOperation;
  });
}

async function startPico(
  pi: ExtensionAPI,
  context: ExtensionContext,
  options: PicoStartupOptions,
  setController: (controller: PicoController) => void
): Promise<void> {
  const config = (options.loadConfig ?? loadPicoConfigFromEnvironment)();
  const modelConfig = requirePicoModel(config);
  const model = context.modelRegistry.find(modelConfig.provider, modelConfig.id);

  if (model === undefined) {
    throw new PicoStartupUserError("configured Pico model is unavailable");
  }

  if (!(await pi.setModel(model))) {
    throw new PicoStartupUserError("configured Pico model authentication is unavailable");
  }

  pi.setThinkingLevel(modelConfig.thinkingLevel);
  const controller = options.createController(context);
  setController(controller);
  try {
    await controller.start();
  } catch {
    throw new PicoStartupUserError("Pico controller failed to start");
  }
}

function requirePicoModel(config: PicoConfig): PicoAgentModelConfig {
  if (config.pico.model === undefined) {
    throw new PicoStartupUserError("Pico startup requires pico.model config");
  }

  return config.pico.model;
}

async function stopPico(
  startOperation: Promise<void>,
  getController: () => PicoController | undefined,
  clearController: () => void
): Promise<void> {
  try {
    await startOperation;
  } catch {
    // A partially started controller still owns cleanup responsibility.
  }

  const controller = getController();

  if (controller === undefined) {
    return;
  }

  try {
    await controller.stop();
  } finally {
    clearController();
  }
}

function failClosed(context: ExtensionContext, error: unknown): void {
  const message =
    error instanceof PicoStartupUserError
      ? `Pico startup failed: ${error.message}`
      : "Pico startup failed (startup_failed)";

  context.ui.notify(message, "error");
  context.shutdown();
}
