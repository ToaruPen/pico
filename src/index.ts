import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiAgentTurnClient } from "./runtime/pi-agent-turn.js";
import { registerPicoExtensionWithRuntime } from "./runtime/pico-extension-runtime.js";
import { registerPicoStartup } from "./runtime/pico-startup.js";
import { createResidentVoiceService } from "./runtime/resident-voice-service.js";
import { createResidentVoiceTerminalOperator } from "./runtime/resident-voice-terminal-display.js";

export {
  buildPicoExtensionSystemPrompt,
  createPicoRegistry,
  type PicoExtensionRuntimeOptions,
  picoExtensionMetadata,
  registerPicoExtensionWithRuntime
} from "./runtime/pico-extension-runtime.js";

export default function registerPicoExtension(pi: ExtensionAPI): void {
  registerPicoExtensionWithRuntime(pi);

  registerPicoStartup(pi, {
    createController: (context, agentSettings, config) => {
      return createResidentVoiceService({
        config,
        createOperator: (keyboard) =>
          createResidentVoiceTerminalOperator({
            controls: keyboard,
            mode: context.mode,
            setWidget: (key, factory, options) => context.ui.setWidget(key, factory, options)
          }),
        createPiAgent: (options) =>
          createPiAgentTurnClient({
            ...options,
            model: agentSettings.model,
            thinkingLevel: agentSettings.thinkingLevel,
            activeToolNames: agentSettings.activeToolNames,
            perceptionMode: "standard"
          }),
        onError: (error) => {
          context.ui.notify(error.message, "error");
          context.shutdown();
        }
      });
    }
  });
}
