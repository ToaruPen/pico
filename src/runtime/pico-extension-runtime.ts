import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { PicoConfig } from "../config/index.js";
import { picoIdentity } from "../identity/profile.js";
import { buildSystemPrompt } from "../identity/system-prompt.js";
import { createAuditModule } from "../modules/audit/index.js";
import { createContextModule } from "../modules/context/index.js";
import { futurePicoModules } from "../modules/future.js";
import { createHandoffModule } from "../modules/handoff/index.js";
import { createIdentityRegistryModule } from "../modules/identity-registry/index.js";
import { createLocalModelsModule } from "../modules/local-models/index.js";
import { createSessionModule } from "../modules/session/index.js";
import { createTransportModule } from "../modules/transport/index.js";
import {
  buildVoiceDesignSpeechInstruction,
  createVoiceDesignSpeechNonce,
  hashVoiceDesignSpeechText,
  inspectVoiceDesignEnvelope,
  type VoiceDesignSpeechPlanCache,
  type VoiceDesignSpeechProfile
} from "../modules/voice-design/index.js";
import { PicoModuleRegistry } from "../orchestrator/registry.js";
import type { DeferredToolCoordinator } from "./deferred-tool-coordinator.js";
import {
  createPicoCameraSceneDescriptionDeferredTool,
  createPicoCameraSceneDescriptionTool,
  createPicoCameraSnapshotTool,
  createPicoPersonDetectionTool
} from "./perception-tool.js";
import type { VoiceStageProbe } from "./voice-stage-probe.js";

export function createPicoRegistry(): PicoModuleRegistry {
  const registry = new PicoModuleRegistry();

  registry.register(createContextModule());
  registry.register(createSessionModule());
  registry.register(createLocalModelsModule());
  registry.register(createHandoffModule());
  registry.register(createAuditModule());
  registry.register(createIdentityRegistryModule());
  registry.register(createTransportModule());

  return registry;
}

export const picoExtensionMetadata = {
  id: "pico",
  identity: picoIdentity,
  systemPrompt: buildSystemPrompt(picoIdentity),
  modules: createPicoRegistry().listMetadata(),
  futureModules: futurePicoModules
};

function formatModuleMetadata(
  modules: typeof picoExtensionMetadata.modules | typeof picoExtensionMetadata.futureModules
): string {
  return modules
    .map((module) => {
      const capabilities =
        module.capabilities.length === 0
          ? "no runtime capabilities yet"
          : module.capabilities
              .map((capability) => `${capability.id} (${capability.description})`)
              .join("; ");

      return `- ${module.kind}: ${module.summary} Capabilities: ${capabilities}.`;
    })
    .join("\n");
}

export function buildPicoExtensionSystemPrompt(baseSystemPrompt: string): string {
  return [
    baseSystemPrompt,
    "",
    "## pico Domain Extension",
    picoExtensionMetadata.systemPrompt,
    "",
    "Available pico modules:",
    formatModuleMetadata(picoExtensionMetadata.modules),
    "",
    "Planned pico modules:",
    formatModuleMetadata(picoExtensionMetadata.futureModules)
  ].join("\n");
}

export type PicoExtensionRuntimeOptions = {
  readonly loadConfig?: () => PicoConfig;
  readonly voiceProbe?: VoiceStageProbe;
  readonly perceptionMode?: "standard" | "resident_deferred";
  readonly deferredTools?: {
    readonly sessionId: string;
    readonly coordinator: Pick<DeferredToolCoordinator, "enqueue">;
  };
  readonly speechPlan?: {
    readonly profile: VoiceDesignSpeechProfile;
    readonly cache: VoiceDesignSpeechPlanCache;
    readonly createNonce?: () => string;
  };
};

export function registerPicoExtensionWithRuntime(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions = {}
): void {
  registerPerceptionRuntimeTools(pi, options);
  registerPicoSystemPrompt(pi, options);
}

function registerPicoSystemPrompt(pi: ExtensionAPI, options: PicoExtensionRuntimeOptions): void {
  let speechNonce: string | undefined;

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    const picoSystemPrompt = buildPicoExtensionSystemPrompt(event.systemPrompt);
    if (options.speechPlan === undefined) {
      return { systemPrompt: picoSystemPrompt };
    }

    speechNonce = (options.speechPlan.createNonce ?? createVoiceDesignSpeechNonce)();
    return {
      systemPrompt: [
        picoSystemPrompt,
        "",
        buildVoiceDesignSpeechInstruction(speechNonce, options.speechPlan.profile)
      ].join("\n")
    };
  });

  registerVoiceDesignSpeechPlanHandlers(
    pi,
    options,
    () => speechNonce,
    () => {
      speechNonce = undefined;
    }
  );
}

function registerVoiceDesignSpeechPlanHandlers(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions,
  readNonce: () => string | undefined,
  clearNonce: () => void
): void {
  const speechPlan = options.speechPlan;
  if (speechPlan === undefined) {
    return;
  }

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }

    const nonce = readNonce();
    if (nonce === undefined) {
      return;
    }

    const renderedText = readAssistantText(event.message.content);
    const inspection = inspectVoiceDesignEnvelope(renderedText, nonce, speechPlan.profile);
    if (inspection.status === "absent") {
      return;
    }

    if (inspection.status === "accepted") {
      speechPlan.cache.record({
        assistantTimestamp: event.message.timestamp,
        textSha256: hashVoiceDesignSpeechText(inspection.text),
        plan: inspection.plan
      });
    }

    return {
      message: {
        ...event.message,
        content: stripAssistantTextSuffix(
          event.message.content,
          renderedText.length - inspection.text.length
        )
      }
    };
  });

  pi.on("agent_settled", () => {
    clearNonce();
    speechPlan.cache.clear();
  });
}

function readAssistantText(
  content: readonly { readonly type: string; readonly text?: string }[]
): string {
  return content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

function stripAssistantTextSuffix<
  ContentPart extends { readonly type: string; readonly text?: string }
>(content: readonly ContentPart[], suffixLength: number): ContentPart[] {
  let remaining = suffixLength;
  const stripped = [...content];

  for (let index = stripped.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const part = stripped[index];
    if (part?.type !== "text" || typeof part.text !== "string") {
      continue;
    }

    const removedLength = Math.min(remaining, part.text.length);
    stripped[index] = {
      ...part,
      text: part.text.slice(0, part.text.length - removedLength)
    };
    remaining -= removedLength;
  }

  return stripped;
}

function registerPerceptionRuntimeTools(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions
): void {
  const perceptionMode = options.perceptionMode ?? "standard";
  const perceptionToolOptions = {
    ...(options.voiceProbe === undefined ? {} : { probe: options.voiceProbe }),
    ...(options.loadConfig === undefined ? {} : { loadConfig: options.loadConfig })
  };

  if (perceptionMode === "resident_deferred" && options.deferredTools !== undefined) {
    pi.registerTool(
      createPicoCameraSceneDescriptionDeferredTool({
        ...perceptionToolOptions,
        sessionId: options.deferredTools.sessionId,
        coordinator: options.deferredTools.coordinator
      })
    );
  } else {
    pi.registerTool(createPicoCameraSnapshotTool(perceptionToolOptions));
    pi.registerTool(createPicoPersonDetectionTool(perceptionToolOptions));
    pi.registerTool(createPicoCameraSceneDescriptionTool(perceptionToolOptions));
  }
}
