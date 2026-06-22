import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { parse } from "yaml";

export type PicoConfig = DeepReadonly<{
  session: PicoSessionConfig;
  memory: {
    mem0: PicoMem0Config;
  };
  audit: {
    otel: PicoAuditOtelConfig;
  };
  camera: {
    tapo?: PicoTapoConfig;
    personFollow: PicoPersonFollowConfig;
  };
  vision: {
    ollama?: PicoOllamaConfig;
    personDetection: PicoPersonDetectionConfig;
  };
  voice: {
    resident: PicoVoiceResidentConfig;
    probes: PicoVoiceProbeConfig;
    echoControl: PicoEchoControlConfig;
    stt: {
      mlxWhisper?: PicoMlxWhisperConfig;
    };
    tts: {
      aivis?: PicoAivisConfig;
    };
  };
}>;

export type PicoSessionConfig = {
  readonly enabled: boolean;
  readonly startTriggers: {
    readonly wakeNames: readonly string[];
    readonly greetings: readonly string[];
    readonly candidateTimeoutMs: number;
  };
  readonly ending: {
    readonly mode: "timed";
    readonly durationMs: number;
  };
};

export type PicoMem0Config = {
  readonly enabled: boolean;
  readonly infer?: boolean;
  readonly historyDbPath?: string;
  readonly vectorStore?: PicoMem0VectorStoreConfig;
  readonly llm?: PicoMem0LlmConfig;
  readonly embedder?: PicoMem0EmbedderConfig;
};

export type PicoMem0VectorStoreConfig = {
  readonly provider: "qdrant";
  readonly localBaseUrl: string;
  readonly collectionName: string;
};

export type PicoMem0LlmConfig = PicoMem0OllamaLlmConfig | PicoMem0PiModelLlmConfig;

export type PicoMem0OllamaLlmConfig = {
  readonly provider: "ollama";
  readonly localBaseUrl: string;
  readonly model: string;
};

export type PicoMem0PiModelLlmConfig = {
  readonly provider: "pi_model";
  readonly piProvider: "openai-codex";
  readonly api: "openai-codex-responses";
  readonly model: string;
  readonly timeoutMs?: number;
};

export type PicoMem0EmbedderConfig = {
  readonly provider: "ollama" | "sidecar";
  readonly localBaseUrl: string;
  readonly model: string;
  readonly embeddingDims?: number;
  readonly timeoutMs?: number;
};

export type PicoAuditOtelConfig = {
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly serviceName?: string;
  readonly timeoutMs?: number;
};

export type PicoTapoConfig = {
  readonly sourceId?: string;
  readonly host: string;
  readonly port?: number;
  readonly onvifPort?: number;
  readonly user: string;
  readonly password: string;
  readonly streams?: {
    readonly scene?: string;
    readonly detection?: string;
  };
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
};

export type PicoPersonFollowConfig = {
  readonly enabled: boolean;
  readonly sourceCameraId?: string;
  readonly deadZone?: number;
  readonly maxStep?: number;
  readonly speed?: number;
  readonly cooldownMs?: number;
  readonly lostTargetTimeoutMs?: number;
};

export type PicoOllamaConfig = {
  readonly endpointId?: string;
  readonly localBaseUrl: string;
  readonly auth?: {
    readonly headerName?: string;
    readonly apiKey: string;
  };
  readonly tunnel?: {
    readonly kind?: string;
    readonly sshTarget?: string;
  };
  readonly timeoutMs?: number;
  readonly maxImageEdgePixels?: number;
};

export type PicoPersonDetectionConfig = {
  readonly enabled: boolean;
  readonly sourceCameraId?: string;
  readonly modelFamily?: "pinto0309";
  readonly provider?: PicoPersonDetectionProvider;
  readonly modelPath?: string;
  readonly inputWidth?: number;
  readonly inputHeight?: number;
  readonly outputLayout?: PicoPersonDetectionOutputLayout;
  readonly coordinateScale?: PicoPersonDetectionCoordinateScale;
  readonly frameIntervalMs?: number;
  readonly confidenceThreshold?: number;
  readonly coremlFlags?: number;
  readonly nmsIouThreshold?: number;
};

export type PicoPersonDetectionProvider = "onnxruntime" | "coreml" | "tflite" | "openvino";
export type PicoPersonDetectionOutputLayout =
  | "xyxy_score_class"
  | "cxcywh_score_class"
  | "yolox_coco_raw";
export type PicoPersonDetectionCoordinateScale = "pixel" | "normalized";

export type PicoEchoControlMode = "aec" | "platform_voice_processing" | "half_duplex";
export type PicoEchoControlProvider =
  | "web_rtc_aec3"
  | "platform_voice_processing"
  | "speexdsp"
  | "half_duplex";

export type PicoVoiceResidentConfig = {
  readonly enabled: boolean;
  readonly audioInput?: PicoResidentAudioInputConfig;
  readonly audioOutput?: PicoResidentAudioOutputConfig;
  readonly singleInstanceLockPath: string;
  readonly minTriggerConfidence: number;
  readonly shutdownGraceMs: number;
  readonly utteranceWindow: PicoVoiceUtteranceWindowConfig;
};

export type PicoVoiceUtteranceWindowConfig = {
  readonly minSpeechMs: number;
  readonly silenceMs: number;
  readonly maxUtteranceMs: number;
  readonly minRmsDb: number;
};

export type PicoResidentAudioInputConfig =
  | {
      readonly provider: "alsa";
      readonly device: string;
    }
  | {
      readonly provider: "avfoundation";
      readonly device: string;
    };

export type PicoResidentAudioOutputConfig =
  | {
      readonly provider: "alsa";
      readonly device: string;
    }
  | {
      readonly provider: "afplay";
      readonly route: "system_default";
    };

export type PicoVoiceProbeConfig = {
  readonly enabled: boolean;
};

export type PicoEchoControlConfig = {
  readonly enabled: boolean;
  readonly mode: PicoEchoControlMode;
  readonly provider?: PicoEchoControlProvider;
  readonly providerEndpoint?: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly frameMs: number;
  readonly tailMuteMs: number;
  readonly diagnostics: {
    readonly enabled: boolean;
  };
};

export type PicoMlxWhisperConfig = {
  readonly id?: string;
  readonly localBaseUrl: string;
  readonly modelRepo?: string;
  readonly language?: string;
  readonly timeoutMs?: number;
  readonly warmupAudioSeconds?: number;
  readonly samplePcm16lePath: string;
  readonly sampleRateHz?: number;
  readonly channels?: number;
};

export type PicoAivisConfig = {
  readonly id?: string;
  readonly localBaseUrl: string;
  readonly speakerId: number;
  readonly timeoutMs?: number;
  readonly text?: string;
};

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends (...arguments_: unknown[]) => unknown
    ? T[K]
    : T[K] extends readonly unknown[]
      ? ReadonlyArray<DeepReadonly<T[K][number]>>
      : T[K] extends object
        ? DeepReadonly<T[K]>
        : T[K];
};

type OptionalPersonDetectionFields = {
  readonly enabled: boolean;
  readonly sourceCameraId: string | undefined;
  readonly modelFamily: "pinto0309" | undefined;
  readonly provider: PicoPersonDetectionProvider | undefined;
  readonly modelPath: string | undefined;
  readonly inputWidth: number | undefined;
  readonly inputHeight: number | undefined;
  readonly outputLayout: PicoPersonDetectionOutputLayout | undefined;
  readonly coordinateScale: PicoPersonDetectionCoordinateScale | undefined;
  readonly frameIntervalMs: number | undefined;
  readonly confidenceThreshold: number | undefined;
  readonly coremlFlags: number | undefined;
  readonly nmsIouThreshold: number | undefined;
};

export type LoadPicoConfigOptions = {
  readonly path?: string;
  readonly cwd?: string;
};

const defaultConfigPath = "config/pico.local.yaml";
const maxNodeTimeoutMs = 2_147_483_647;
const maxVoiceUtteranceWindowMs = 60_000;
const maxTcpPort = 65_535;
const maxOllamaImageEdgePixels = 4096;

export const emptyPicoConfig: PicoConfig = deepFreeze({
  session: {
    enabled: true,
    startTriggers: {
      wakeNames: [],
      greetings: [],
      candidateTimeoutMs: 10_000
    },
    ending: {
      mode: "timed",
      durationMs: 60_000
    }
  },
  memory: {
    mem0: {
      enabled: false
    }
  },
  audit: {
    otel: {
      enabled: false
    }
  },
  camera: {
    personFollow: {
      enabled: false
    }
  },
  vision: {
    personDetection: {
      enabled: false
    }
  },
  voice: {
    resident: {
      enabled: false,
      singleInstanceLockPath: "tmp/pico-voice-resident.lock",
      minTriggerConfidence: 0.5,
      shutdownGraceMs: 5_000,
      utteranceWindow: {
        minSpeechMs: 300,
        silenceMs: 700,
        maxUtteranceMs: 5_000,
        minRmsDb: -55
      }
    },
    probes: {
      enabled: true
    },
    echoControl: {
      enabled: false,
      mode: "half_duplex",
      sampleRateHz: 16_000,
      channels: 1,
      frameMs: 10,
      tailMuteMs: 700,
      diagnostics: {
        enabled: false
      }
    },
    stt: {},
    tts: {}
  }
});

export function loadPicoConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: Omit<LoadPicoConfigOptions, "path"> = {}
): PicoConfig {
  const configuredPath = readOptionalString(environment.PICO_CONFIG_PATH);

  return loadPicoConfig({
    ...options,
    ...(configuredPath === undefined ? {} : { path: configuredPath })
  });
}

export function loadPicoConfig(options: LoadPicoConfigOptions = {}): PicoConfig {
  const configPath = resolveConfigPath(options);

  if (!existsSync(configPath)) {
    if (options.path !== undefined) {
      throw new Error(`pico config file not found: ${configPath}`);
    }

    return emptyPicoConfig;
  }

  const parsed = parse(readFileSync(configPath, "utf8")) as unknown;

  return resolveConfigRelativePaths(
    definePicoConfig(parsed),
    resolveConfigRelativeBaseDirectory(configPath)
  );
}

export function definePicoConfig(input: unknown): PicoConfig {
  const root = input === null || input === undefined ? {} : requireRecord(input, "pico config");

  return deepFreeze({
    session: defineSessionSection(root),
    memory: defineMemorySection(root),
    audit: defineAuditSection(root),
    camera: defineCameraSection(root),
    vision: defineVisionSection(root),
    voice: defineVoiceSection(root)
  });
}

function defineSessionSection(root: Record<string, unknown>): PicoConfig["session"] {
  const session = readOptionalRecord(root.session, "pico config session");

  return {
    enabled: defineSessionEnabled(session),
    startTriggers: defineSessionStartTriggers(session),
    ending: defineSessionEnding(readOptionalRecord(session?.ending, "pico config session.ending"))
  };
}

function defineSessionEnabled(input: Record<string, unknown> | undefined): boolean {
  return readOptionalBoolean(input?.enabled, "pico config session.enabled") ?? true;
}

function defineSessionStartTriggers(
  input: Record<string, unknown> | undefined
): PicoSessionConfig["startTriggers"] {
  const startTriggers = readOptionalRecord(
    input?.startTriggers,
    "pico config session.startTriggers"
  );

  return {
    wakeNames: readOptionalStringList(
      startTriggers?.wakeNames,
      "pico config session.startTriggers.wakeNames"
    ),
    greetings: readOptionalStringList(
      startTriggers?.greetings,
      "pico config session.startTriggers.greetings"
    ),
    candidateTimeoutMs:
      readOptionalPositiveInteger(
        startTriggers?.candidateTimeoutMs,
        "pico config session.startTriggers.candidateTimeoutMs"
      ) ?? 10_000
  };
}

function defineSessionEnding(
  input: Record<string, unknown> | undefined
): PicoSessionConfig["ending"] {
  const mode = readOptionalString(input?.mode, "pico config session.ending.mode") ?? "timed";

  if (mode !== "timed") {
    throw new Error("pico config session.ending.mode must be timed");
  }

  return {
    mode,
    durationMs:
      readOptionalBoundedPositiveInteger(
        input?.durationMs,
        "pico config session.ending.durationMs",
        maxNodeTimeoutMs
      ) ?? 60_000
  };
}

function defineMemorySection(root: Record<string, unknown>): PicoConfig["memory"] {
  const memory = readOptionalRecord(root.memory, "pico config memory");
  const mem0 = readOptionalRecord(memory?.mem0, "pico config memory.mem0");

  return {
    mem0: defineMem0Config(mem0)
  };
}

function defineMem0Config(input: Record<string, unknown> | undefined): PicoMem0Config {
  if (input === undefined) {
    return {
      enabled: false
    };
  }

  const enabled = readOptionalBoolean(input.enabled, "pico config memory.mem0.enabled") ?? false;
  const historyDatabasePath = readOptionalString(
    input.historyDbPath,
    "pico config memory.mem0.historyDbPath"
  );
  const vectorStore = readOptionalRecord(input.vectorStore, "pico config memory.mem0.vectorStore");
  const llm = readOptionalRecord(input.llm, "pico config memory.mem0.llm");
  const embedder = readOptionalRecord(input.embedder, "pico config memory.mem0.embedder");

  if (enabled) {
    return {
      enabled,
      ...optionalBooleanProperty(input, "infer", "pico config memory.mem0.infer"),
      historyDbPath: requireString(historyDatabasePath, "pico config memory.mem0.historyDbPath"),
      vectorStore: defineMem0VectorStore(
        requireRecord(vectorStore, "pico config memory.mem0.vectorStore")
      ),
      llm: defineMem0Llm(requireRecord(llm, "pico config memory.mem0.llm")),
      embedder: defineMem0Embedder(
        requireRecord(embedder, "pico config memory.mem0.embedder"),
        "pico config memory.mem0.embedder"
      )
    };
  }

  return {
    enabled,
    ...optionalBooleanProperty(input, "infer", "pico config memory.mem0.infer"),
    ...(historyDatabasePath === undefined ? {} : { historyDbPath: historyDatabasePath }),
    ...(vectorStore === undefined ? {} : { vectorStore: defineMem0VectorStore(vectorStore) }),
    ...(llm === undefined ? {} : { llm: defineMem0Llm(llm) }),
    ...(embedder === undefined
      ? {}
      : { embedder: defineMem0Embedder(embedder, "pico config memory.mem0.embedder") })
  };
}

function defineMem0VectorStore(input: Record<string, unknown>): PicoMem0VectorStoreConfig {
  const provider = requireString(input.provider, "pico config memory.mem0.vectorStore.provider");

  if (provider !== "qdrant") {
    throw new Error("pico config memory.mem0.vectorStore.provider must be qdrant");
  }

  return {
    provider,
    localBaseUrl: requireLocalBaseUrl(
      input.localBaseUrl,
      "pico config memory.mem0.vectorStore.localBaseUrl"
    ),
    collectionName: requireString(
      input.collectionName,
      "pico config memory.mem0.vectorStore.collectionName"
    )
  };
}

function defineMem0Llm(input: Record<string, unknown>): PicoMem0LlmConfig {
  const provider = requireString(input.provider, "pico config memory.mem0.llm.provider");

  if (provider === "ollama") {
    return {
      provider,
      localBaseUrl: requireLocalBaseUrl(
        input.localBaseUrl,
        "pico config memory.mem0.llm.localBaseUrl"
      ),
      model: requireString(input.model, "pico config memory.mem0.llm.model")
    };
  }

  if (provider === "pi_model") {
    return defineMem0PiModelLlm(input);
  }

  throw new Error("pico config memory.mem0.llm.provider must be ollama or pi_model");
}

function defineMem0PiModelLlm(input: Record<string, unknown>): PicoMem0PiModelLlmConfig {
  const piProvider = requireString(input.piProvider, "pico config memory.mem0.llm.piProvider");
  const api = requireString(input.api, "pico config memory.mem0.llm.api");

  if (piProvider !== "openai-codex") {
    throw new Error("pico config memory.mem0.llm.piProvider must be openai-codex");
  }

  if (api !== "openai-codex-responses") {
    throw new Error("pico config memory.mem0.llm.api must be openai-codex-responses");
  }

  return {
    provider: "pi_model",
    piProvider,
    api,
    model: requireString(input.model, "pico config memory.mem0.llm.model"),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config memory.mem0.llm.timeoutMs",
      maxNodeTimeoutMs
    )
  };
}

function defineMem0Embedder(
  input: Record<string, unknown>,
  label: "pico config memory.mem0.embedder"
): PicoMem0EmbedderConfig {
  const provider = requireString(input.provider, `${label}.provider`);

  if (provider !== "ollama" && provider !== "sidecar") {
    throw new Error(`${label}.provider must be ollama or sidecar`);
  }

  return {
    provider,
    localBaseUrl: requireLocalBaseUrl(input.localBaseUrl, `${label}.localBaseUrl`),
    model: requireString(input.model, `${label}.model`),
    ...optionalPositiveIntegerProperty(input, "embeddingDims", `${label}.embeddingDims`),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      `${label}.timeoutMs`,
      maxNodeTimeoutMs
    )
  };
}

function defineAuditSection(root: Record<string, unknown>): PicoConfig["audit"] {
  const audit = readOptionalRecord(root.audit, "pico config audit");
  const otel = readOptionalRecord(audit?.otel, "pico config audit.otel");

  return {
    otel: defineAuditOtelConfig(otel)
  };
}

function defineAuditOtelConfig(input: Record<string, unknown> | undefined): PicoAuditOtelConfig {
  if (input === undefined) {
    return {
      enabled: false
    };
  }

  const enabled = readOptionalBoolean(input.enabled, "pico config audit.otel.enabled") ?? false;
  const endpoint = readOptionalAuditOtelEndpoint(input.endpoint);

  if (enabled) {
    return {
      enabled,
      endpoint: requireString(endpoint, "pico config audit.otel.endpoint"),
      serviceName:
        readOptionalString(input.serviceName, "pico config audit.otel.serviceName") ?? "pico",
      ...optionalBoundedPositiveIntegerProperty(
        input,
        "timeoutMs",
        "pico config audit.otel.timeoutMs",
        maxNodeTimeoutMs
      )
    };
  }

  return {
    enabled,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...optionalStringProperty(input, "serviceName", "pico config audit.otel.serviceName"),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config audit.otel.timeoutMs",
      maxNodeTimeoutMs
    )
  };
}

function defineCameraSection(root: Record<string, unknown>): PicoConfig["camera"] {
  const camera = readOptionalRecord(root.camera, "pico config camera");
  const tapo = readOptionalRecord(camera?.tapo, "pico config camera.tapo");
  const personFollow = readOptionalRecord(camera?.personFollow, "pico config camera.personFollow");

  return {
    ...(tapo === undefined ? {} : { tapo: defineTapoConfig(tapo) }),
    personFollow: definePersonFollowConfig(personFollow)
  };
}

function defineVisionSection(root: Record<string, unknown>): PicoConfig["vision"] {
  const vision = readOptionalRecord(root.vision, "pico config vision");
  const ollama = readOptionalRecord(vision?.ollama, "pico config vision.ollama");
  const personDetection = readOptionalRecord(
    vision?.personDetection,
    "pico config vision.personDetection"
  );

  return {
    ...(ollama === undefined ? {} : { ollama: defineOllamaConfig(ollama) }),
    personDetection: definePersonDetectionConfig(personDetection)
  };
}

function defineVoiceSection(root: Record<string, unknown>): PicoConfig["voice"] {
  const voice = readOptionalRecord(root.voice, "pico config voice");
  const resident = readOptionalRecord(voice?.resident, "pico config voice.resident");
  const probes = readOptionalRecord(voice?.probes, "pico config voice.probes");
  const echoControl = readOptionalRecord(voice?.echoControl, "pico config voice.echoControl");

  return {
    resident: defineVoiceResidentConfig(resident),
    probes: defineVoiceProbeConfig(probes),
    echoControl: defineEchoControlConfig(echoControl),
    stt: defineVoiceSttConfig(voice),
    tts: defineVoiceTtsConfig(voice)
  };
}

function defineVoiceSttConfig(
  voice: Record<string, unknown> | undefined
): PicoConfig["voice"]["stt"] {
  const stt = readOptionalRecord(voice?.stt, "pico config voice.stt");
  const mlxWhisper = readOptionalRecord(stt?.mlxWhisper, "pico config voice.stt.mlxWhisper");

  return {
    ...(mlxWhisper === undefined ? {} : { mlxWhisper: defineMlxWhisperConfig(mlxWhisper) })
  };
}

function defineVoiceTtsConfig(
  voice: Record<string, unknown> | undefined
): PicoConfig["voice"]["tts"] {
  const tts = readOptionalRecord(voice?.tts, "pico config voice.tts");
  const aivis = readOptionalRecord(tts?.aivis, "pico config voice.tts.aivis");

  return {
    ...(aivis === undefined ? {} : { aivis: defineAivisConfig(aivis) })
  };
}

function defineVoiceResidentConfig(
  input: Record<string, unknown> | undefined
): PicoVoiceResidentConfig {
  if (input === undefined) {
    return emptyPicoConfig.voice.resident;
  }

  const enabled = readOptionalBoolean(input.enabled, "pico config voice.resident.enabled") ?? false;
  const audioInput = readOptionalRecord(input.audioInput, "pico config voice.resident.audioInput");
  const audioOutput = readOptionalRecord(
    input.audioOutput,
    "pico config voice.resident.audioOutput"
  );
  const utteranceWindow = readOptionalRecord(
    input.utteranceWindow,
    "pico config voice.resident.utteranceWindow"
  );

  requireResidentVoiceAudio(enabled, audioInput, audioOutput);

  return {
    enabled,
    ...(audioInput === undefined ? {} : { audioInput: defineResidentAudioInput(audioInput) }),
    ...(audioOutput === undefined ? {} : { audioOutput: defineResidentAudioOutput(audioOutput) }),
    singleInstanceLockPath:
      readOptionalString(
        input.singleInstanceLockPath,
        "pico config voice.resident.singleInstanceLockPath"
      ) ?? "tmp/pico-voice-resident.lock",
    minTriggerConfidence:
      readOptionalConfidenceThreshold(
        input.minTriggerConfidence,
        "pico config voice.resident.minTriggerConfidence"
      ) ?? 0.5,
    shutdownGraceMs:
      readOptionalBoundedPositiveInteger(
        input.shutdownGraceMs,
        "pico config voice.resident.shutdownGraceMs",
        maxNodeTimeoutMs
      ) ?? 5_000,
    utteranceWindow: defineVoiceUtteranceWindowConfig(utteranceWindow)
  };
}

function defineVoiceUtteranceWindowConfig(
  input: Record<string, unknown> | undefined
): PicoVoiceUtteranceWindowConfig {
  const defaults = emptyPicoConfig.voice.resident.utteranceWindow;

  if (input === undefined) {
    return defaults;
  }

  const config: PicoVoiceUtteranceWindowConfig = {
    minSpeechMs:
      readOptionalBoundedPositiveInteger(
        input.minSpeechMs,
        "pico config voice.resident.utteranceWindow.minSpeechMs",
        maxVoiceUtteranceWindowMs
      ) ?? defaults.minSpeechMs,
    silenceMs:
      readOptionalBoundedPositiveInteger(
        input.silenceMs,
        "pico config voice.resident.utteranceWindow.silenceMs",
        maxVoiceUtteranceWindowMs
      ) ?? defaults.silenceMs,
    maxUtteranceMs:
      readOptionalBoundedPositiveInteger(
        input.maxUtteranceMs,
        "pico config voice.resident.utteranceWindow.maxUtteranceMs",
        maxVoiceUtteranceWindowMs
      ) ?? defaults.maxUtteranceMs,
    minRmsDb:
      readOptionalRmsDatabase(
        input.minRmsDb,
        "pico config voice.resident.utteranceWindow.minRmsDb"
      ) ?? defaults.minRmsDb
  };

  if (config.maxUtteranceMs < config.minSpeechMs) {
    throw new Error(
      "pico config voice.resident.utteranceWindow.maxUtteranceMs must be >= minSpeechMs"
    );
  }

  return config;
}

function requireResidentVoiceAudio(
  enabled: boolean,
  audioInput: Record<string, unknown> | undefined,
  audioOutput: Record<string, unknown> | undefined
): void {
  if (!enabled) {
    return;
  }

  if (audioInput === undefined) {
    throw new Error("pico config voice.resident.audioInput is required when resident is enabled");
  }

  if (audioOutput === undefined) {
    throw new Error("pico config voice.resident.audioOutput is required when resident is enabled");
  }
}

function defineResidentAudioInput(input: Record<string, unknown>): PicoResidentAudioInputConfig {
  const provider = requireString(input.provider, "pico config voice.resident.audioInput.provider");

  if (provider === "alsa") {
    return {
      provider,
      device: requireString(input.device, "pico config voice.resident.audioInput.device")
    };
  }

  if (provider === "avfoundation") {
    return {
      provider,
      device: requireString(input.device, "pico config voice.resident.audioInput.device")
    };
  }

  throw new Error("pico config voice.resident.audioInput.provider must be alsa or avfoundation");
}

function defineResidentAudioOutput(input: Record<string, unknown>): PicoResidentAudioOutputConfig {
  const provider = requireString(input.provider, "pico config voice.resident.audioOutput.provider");

  if (provider === "alsa") {
    return {
      provider,
      device: requireString(input.device, "pico config voice.resident.audioOutput.device")
    };
  }

  if (provider === "afplay") {
    const route = requireString(input.route, "pico config voice.resident.audioOutput.route");

    if (route !== "system_default") {
      throw new Error("pico config voice.resident.audioOutput.route must be system_default");
    }

    return { provider, route };
  }

  throw new Error("pico config voice.resident.audioOutput.provider must be alsa or afplay");
}

function defineVoiceProbeConfig(input: Record<string, unknown> | undefined): PicoVoiceProbeConfig {
  if (input === undefined) {
    return emptyPicoConfig.voice.probes;
  }

  return {
    enabled: readOptionalBoolean(input.enabled, "pico config voice.probes.enabled") ?? true
  };
}

function defineEchoControlConfig(
  input: Record<string, unknown> | undefined
): PicoEchoControlConfig {
  if (input === undefined) {
    return emptyPicoConfig.voice.echoControl;
  }

  const resolved = readEchoControlConfigFields(input);

  if (resolved.enabled && resolved.mode === "platform_voice_processing") {
    throw new Error(
      "pico config voice.echoControl.mode platform_voice_processing is not implemented"
    );
  }

  return resolved.enabled && resolved.mode === "aec"
    ? defineAecEchoControlConfig(resolved)
    : resolved;
}

function readEchoControlConfigFields(input: Record<string, unknown>): PicoEchoControlConfig {
  const enabled =
    readOptionalBoolean(input.enabled, "pico config voice.echoControl.enabled") ?? false;
  const mode = readOptionalEchoControlMode(input.mode) ?? "half_duplex";
  const provider = readOptionalEchoControlProvider(input.provider);
  const providerEndpoint = readOptionalEchoControlProviderEndpoint(input.providerEndpoint);
  const config: PicoEchoControlConfig = {
    enabled,
    mode,
    sampleRateHz: readEchoControlSampleRate(input.sampleRateHz),
    channels: readEchoControlChannels(input.channels),
    frameMs: readEchoControlFrameMs(input.frameMs),
    tailMuteMs: readEchoControlTailMuteMs(input.tailMuteMs),
    diagnostics: readEchoControlDiagnostics(input.diagnostics)
  };

  return withOptionalEchoControlProvider(config, provider, providerEndpoint);
}

function readEchoControlSampleRate(value: unknown): number {
  return readOptionalPositiveInteger(value, "pico config voice.echoControl.sampleRateHz") ?? 16_000;
}

function readEchoControlChannels(value: unknown): number {
  return readOptionalPositiveInteger(value, "pico config voice.echoControl.channels") ?? 1;
}

function readEchoControlFrameMs(value: unknown): number {
  return readOptionalPositiveInteger(value, "pico config voice.echoControl.frameMs") ?? 10;
}

function readEchoControlTailMuteMs(value: unknown): number {
  return readOptionalNonNegativeInteger(value, "pico config voice.echoControl.tailMuteMs") ?? 700;
}

function readEchoControlDiagnostics(value: unknown): PicoEchoControlConfig["diagnostics"] {
  const diagnostics = readOptionalRecord(value, "pico config voice.echoControl.diagnostics");

  return {
    enabled:
      readOptionalBoolean(
        diagnostics?.enabled,
        "pico config voice.echoControl.diagnostics.enabled"
      ) ?? false
  };
}

function withOptionalEchoControlProvider(
  config: PicoEchoControlConfig,
  provider: PicoEchoControlProvider | undefined,
  providerEndpoint: string | undefined
): PicoEchoControlConfig {
  return {
    ...config,
    ...(provider === undefined ? {} : { provider }),
    ...(providerEndpoint === undefined ? {} : { providerEndpoint })
  };
}

function defineAecEchoControlConfig(input: PicoEchoControlConfig): PicoEchoControlConfig {
  return {
    ...input,
    provider: requireAecEchoControlProvider(input.provider),
    providerEndpoint: requireString(
      input.providerEndpoint,
      "pico config voice.echoControl.providerEndpoint"
    )
  };
}

function defineTapoConfig(input: Record<string, unknown>): PicoTapoConfig {
  if (input.stream !== undefined) {
    throw new Error(
      "pico config camera.tapo.stream is deprecated; use camera.tapo.streams.scene and/or camera.tapo.streams.detection"
    );
  }

  return {
    ...optionalStringProperty(input, "sourceId", "pico config camera.tapo.sourceId"),
    host: requireString(input.host, "pico config camera.tapo.host"),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "port",
      "pico config camera.tapo.port",
      maxTcpPort
    ),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "onvifPort",
      "pico config camera.tapo.onvifPort",
      maxTcpPort
    ),
    user: requireString(input.user, "pico config camera.tapo.user"),
    password: requireString(input.password, "pico config camera.tapo.password"),
    ...optionalTapoStreamsProperty(input.streams),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config camera.tapo.timeoutMs",
      maxNodeTimeoutMs
    ),
    ...optionalPositiveIntegerProperty(
      input,
      "maxFrameBytes",
      "pico config camera.tapo.maxFrameBytes"
    )
  };
}

function optionalTapoStreamsProperty(value: unknown): Pick<PicoTapoConfig, "streams"> {
  const streams = readOptionalRecord(value, "pico config camera.tapo.streams");

  if (streams === undefined) {
    return {};
  }

  const scene = readOptionalString(streams.scene, "pico config camera.tapo.streams.scene");
  const detection = readOptionalString(
    streams.detection,
    "pico config camera.tapo.streams.detection"
  );

  return {
    streams: {
      ...(scene === undefined ? {} : { scene }),
      ...(detection === undefined ? {} : { detection })
    }
  };
}

function definePersonFollowConfig(
  input: Record<string, unknown> | undefined
): PicoPersonFollowConfig {
  if (input === undefined) {
    return {
      enabled: false
    };
  }

  const enabled =
    readOptionalBoolean(input.enabled, "pico config camera.personFollow.enabled") ?? false;
  const sourceCameraId = readOptionalString(
    input.sourceCameraId,
    "pico config camera.personFollow.sourceCameraId"
  );
  const deadZone = readOptionalDeadZone(input.deadZone);
  const maxStep = readOptionalUnitPositiveNumber(
    input.maxStep,
    "pico config camera.personFollow.maxStep"
  );
  const speed = readOptionalUnitPositiveNumber(
    input.speed,
    "pico config camera.personFollow.speed"
  );
  const cooldownMs = readOptionalBoundedPositiveInteger(
    input.cooldownMs,
    "pico config camera.personFollow.cooldownMs",
    maxNodeTimeoutMs
  );
  const lostTargetTimeoutMs = readOptionalBoundedPositiveInteger(
    input.lostTargetTimeoutMs,
    "pico config camera.personFollow.lostTargetTimeoutMs",
    maxNodeTimeoutMs
  );

  if (!enabled) {
    return {
      enabled: false
    };
  }

  return {
    enabled: true,
    sourceCameraId: requireString(sourceCameraId, "pico config camera.personFollow.sourceCameraId"),
    deadZone: requireNumber(deadZone, "pico config camera.personFollow.deadZone"),
    maxStep: requireNumber(maxStep, "pico config camera.personFollow.maxStep"),
    speed: requireNumber(speed, "pico config camera.personFollow.speed"),
    cooldownMs: requireNumber(cooldownMs, "pico config camera.personFollow.cooldownMs"),
    lostTargetTimeoutMs: requireNumber(
      lostTargetTimeoutMs,
      "pico config camera.personFollow.lostTargetTimeoutMs"
    )
  };
}

function defineOllamaConfig(input: Record<string, unknown>): PicoOllamaConfig {
  const auth = readOptionalRecord(input.auth, "pico config vision.ollama.auth");
  const tunnel = readOptionalRecord(input.tunnel, "pico config vision.ollama.tunnel");

  return {
    ...optionalStringProperty(input, "endpointId", "pico config vision.ollama.endpointId"),
    localBaseUrl: requireLocalBaseUrl(input.localBaseUrl, "pico config vision.ollama.localBaseUrl"),
    ...(auth === undefined
      ? {}
      : {
          auth: {
            ...optionalHeaderNameProperty(auth, "headerName"),
            apiKey: requireString(auth.apiKey, "pico config vision.ollama.auth.apiKey")
          }
        }),
    ...(tunnel === undefined
      ? {}
      : {
          tunnel: {
            ...optionalProtectedTunnelKindProperty(tunnel),
            ...optionalStringProperty(
              tunnel,
              "sshTarget",
              "pico config vision.ollama.tunnel.sshTarget"
            )
          }
        }),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config vision.ollama.timeoutMs",
      maxNodeTimeoutMs
    ),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "maxImageEdgePixels",
      "pico config vision.ollama.maxImageEdgePixels",
      maxOllamaImageEdgePixels
    )
  };
}

function definePersonDetectionConfig(
  input: Record<string, unknown> | undefined
): PicoPersonDetectionConfig {
  if (input === undefined) {
    return {
      enabled: false
    };
  }

  const fields = readPersonDetectionFields(input);

  return fields.enabled
    ? defineEnabledPersonDetectionConfig(fields)
    : defineDisabledPersonDetectionConfig(fields);
}

function readPersonDetectionFields(input: Record<string, unknown>): OptionalPersonDetectionFields {
  const enabled =
    readOptionalBoolean(input.enabled, "pico config vision.personDetection.enabled") ?? false;

  return {
    enabled,
    sourceCameraId: readOptionalString(
      input.sourceCameraId,
      "pico config vision.personDetection.sourceCameraId"
    ),
    modelFamily: readOptionalPersonDetectionModelFamily(input.modelFamily),
    provider: readOptionalPersonDetectionProvider(input.provider),
    modelPath: readOptionalString(input.modelPath, "pico config vision.personDetection.modelPath"),
    inputWidth: readOptionalPositiveInteger(
      input.inputWidth,
      "pico config vision.personDetection.inputWidth"
    ),
    inputHeight: readOptionalPositiveInteger(
      input.inputHeight,
      "pico config vision.personDetection.inputHeight"
    ),
    outputLayout: readOptionalPersonDetectionOutputLayout(input.outputLayout),
    coordinateScale: readOptionalPersonDetectionCoordinateScale(input.coordinateScale),
    frameIntervalMs: readOptionalBoundedPositiveInteger(
      input.frameIntervalMs,
      "pico config vision.personDetection.frameIntervalMs",
      maxNodeTimeoutMs
    ),
    confidenceThreshold: readOptionalConfidenceThreshold(
      input.confidenceThreshold,
      "pico config vision.personDetection.confidenceThreshold"
    ),
    coremlFlags: readOptionalNonNegativeInteger(
      input.coremlFlags,
      "pico config vision.personDetection.coremlFlags"
    ),
    nmsIouThreshold: readOptionalUnitPositiveNumber(
      input.nmsIouThreshold,
      "pico config vision.personDetection.nmsIouThreshold"
    )
  };
}

function defineEnabledPersonDetectionConfig(
  input: OptionalPersonDetectionFields
): PicoPersonDetectionConfig {
  const resolvedProvider = requirePersonDetectionProvider(input.provider);
  if (resolvedProvider === "coreml" && input.outputLayout !== "yolox_coco_raw") {
    throw new Error(
      "pico config vision.personDetection.outputLayout must be yolox_coco_raw when provider is coreml"
    );
  }
  const resolvedNmsIouThreshold = resolvePersonDetectionNmsIouThreshold(
    resolvedProvider,
    input.outputLayout,
    input.nmsIouThreshold
  );

  return {
    enabled: true,
    sourceCameraId: requireString(
      input.sourceCameraId,
      "pico config vision.personDetection.sourceCameraId"
    ),
    modelFamily: requirePersonDetectionModelFamily(input.modelFamily),
    provider: resolvedProvider,
    modelPath: requireString(input.modelPath, "pico config vision.personDetection.modelPath"),
    inputWidth: requireNumber(input.inputWidth, "pico config vision.personDetection.inputWidth"),
    inputHeight: requireNumber(input.inputHeight, "pico config vision.personDetection.inputHeight"),
    ...(input.outputLayout === undefined ? {} : { outputLayout: input.outputLayout }),
    ...(input.coordinateScale === undefined ? {} : { coordinateScale: input.coordinateScale }),
    frameIntervalMs: requireNumber(
      input.frameIntervalMs,
      "pico config vision.personDetection.frameIntervalMs"
    ),
    confidenceThreshold: requireNumber(
      input.confidenceThreshold,
      "pico config vision.personDetection.confidenceThreshold"
    ),
    ...(resolvedProvider === "coreml" ? { coremlFlags: input.coremlFlags ?? 18 } : {}),
    ...(resolvedNmsIouThreshold === undefined ? {} : { nmsIouThreshold: resolvedNmsIouThreshold })
  };
}

function resolvePersonDetectionNmsIouThreshold(
  provider: PicoPersonDetectionProvider,
  outputLayout: PicoPersonDetectionOutputLayout | undefined,
  nmsIouThreshold: number | undefined
): number | undefined {
  return provider === "coreml" || outputLayout === "yolox_coco_raw"
    ? (nmsIouThreshold ?? 0.45)
    : nmsIouThreshold;
}

function defineDisabledPersonDetectionConfig(
  input: OptionalPersonDetectionFields
): PicoPersonDetectionConfig {
  return stripUndefinedProperties({
    enabled: false,
    sourceCameraId: input.sourceCameraId,
    modelFamily: input.modelFamily,
    provider: input.provider,
    modelPath: input.modelPath,
    inputWidth: input.inputWidth,
    inputHeight: input.inputHeight,
    outputLayout: input.outputLayout,
    coordinateScale: input.coordinateScale,
    frameIntervalMs: input.frameIntervalMs,
    confidenceThreshold: input.confidenceThreshold,
    coremlFlags: input.coremlFlags,
    nmsIouThreshold: input.nmsIouThreshold
  }) as PicoPersonDetectionConfig;
}

function defineMlxWhisperConfig(input: Record<string, unknown>): PicoMlxWhisperConfig {
  return {
    ...optionalStringProperty(input, "id", "pico config voice.stt.mlxWhisper.id"),
    localBaseUrl: requireLocalBaseUrl(
      input.localBaseUrl,
      "pico config voice.stt.mlxWhisper.localBaseUrl"
    ),
    ...optionalStringProperty(input, "modelRepo", "pico config voice.stt.mlxWhisper.modelRepo"),
    ...optionalStringProperty(input, "language", "pico config voice.stt.mlxWhisper.language"),
    ...optionalPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config voice.stt.mlxWhisper.timeoutMs"
    ),
    ...optionalPositiveNumberProperty(
      input,
      "warmupAudioSeconds",
      "pico config voice.stt.mlxWhisper.warmupAudioSeconds"
    ),
    samplePcm16lePath: requireString(
      input.samplePcm16lePath,
      "pico config voice.stt.mlxWhisper.samplePcm16lePath"
    ),
    ...optionalPositiveIntegerProperty(
      input,
      "sampleRateHz",
      "pico config voice.stt.mlxWhisper.sampleRateHz"
    ),
    ...optionalPositiveIntegerProperty(
      input,
      "channels",
      "pico config voice.stt.mlxWhisper.channels"
    )
  };
}

function defineAivisConfig(input: Record<string, unknown>): PicoAivisConfig {
  return {
    ...optionalStringProperty(input, "id", "pico config voice.tts.aivis.id"),
    localBaseUrl: requireLocalBaseUrl(
      input.localBaseUrl,
      "pico config voice.tts.aivis.localBaseUrl"
    ),
    speakerId: requireNonNegativeInteger(input.speakerId, "pico config voice.tts.aivis.speakerId"),
    ...optionalPositiveIntegerProperty(input, "timeoutMs", "pico config voice.tts.aivis.timeoutMs"),
    ...optionalStringProperty(input, "text", "pico config voice.tts.aivis.text")
  };
}

function resolveConfigPath(options: LoadPicoConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const path = options.path ?? defaultConfigPath;

  return isAbsolute(path) ? path : resolve(cwd, path);
}

function resolveConfigRelativeBaseDirectory(configPath: string): string {
  const configDirectory = dirname(configPath);

  return basename(configDirectory) === "config" ? dirname(configDirectory) : configDirectory;
}

function resolveConfigRelativePaths(config: PicoConfig, baseDirectory: string): PicoConfig {
  return deepFreeze({
    ...config,
    memory: {
      mem0: {
        ...config.memory.mem0,
        ...(config.memory.mem0.historyDbPath === undefined
          ? {}
          : {
              historyDbPath: resolveConfigRelativePath(
                baseDirectory,
                config.memory.mem0.historyDbPath
              )
            })
      }
    },
    vision: {
      ...config.vision,
      personDetection: {
        ...config.vision.personDetection,
        ...(config.vision.personDetection.modelPath === undefined
          ? {}
          : {
              modelPath: resolveConfigRelativePath(
                baseDirectory,
                config.vision.personDetection.modelPath
              )
            })
      }
    },
    voice: {
      ...config.voice,
      resident: {
        ...config.voice.resident,
        singleInstanceLockPath: resolveConfigRelativePath(
          baseDirectory,
          config.voice.resident.singleInstanceLockPath
        )
      },
      stt: {
        ...config.voice.stt,
        ...(config.voice.stt.mlxWhisper === undefined
          ? {}
          : {
              mlxWhisper: {
                ...config.voice.stt.mlxWhisper,
                samplePcm16lePath: resolveConfigRelativePath(
                  baseDirectory,
                  config.voice.stt.mlxWhisper.samplePcm16lePath
                )
              }
            })
      }
    }
  });
}

function resolveConfigRelativePath(baseDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function optionalStringProperty(
  input: Record<string, unknown>,
  key: string,
  label: string
): Record<string, string> {
  const value = readOptionalString(input[key], label);

  return value === undefined ? {} : { [key]: value };
}

function optionalBooleanProperty(
  input: Record<string, unknown>,
  key: string,
  label: string
): Record<string, boolean> {
  const value = readOptionalBoolean(input[key], label);

  return value === undefined ? {} : { [key]: value };
}

function optionalPositiveIntegerProperty(
  input: Record<string, unknown>,
  key: string,
  label: string
): Record<string, number> {
  const value = readOptionalPositiveInteger(input[key], label);

  return value === undefined ? {} : { [key]: value };
}

function optionalBoundedPositiveIntegerProperty(
  input: Record<string, unknown>,
  key: string,
  label: string,
  maximum: number
): Record<string, number> {
  const value = readOptionalBoundedPositiveInteger(input[key], label, maximum);

  return value === undefined ? {} : { [key]: value };
}

function optionalProtectedTunnelKindProperty(
  input: Record<string, unknown>
): Record<string, "tailscale_ssh" | "cloudflare_access_ssh"> {
  const value = readOptionalString(input.kind, "pico config vision.ollama.tunnel.kind");

  if (value === undefined) {
    return {};
  }

  if (value !== "tailscale_ssh" && value !== "cloudflare_access_ssh") {
    throw new Error("pico config vision.ollama.tunnel.kind must use a protected SSH tunnel");
  }

  return { kind: value };
}

function optionalHeaderNameProperty(
  input: Record<string, unknown>,
  key: string
): Record<string, string> {
  const value = readOptionalString(input[key], `pico config vision.ollama.auth.${key}`);

  if (value === undefined) {
    return {};
  }

  if (!isHttpHeaderName(value)) {
    throw new Error(`pico config vision.ollama.auth.${key} must be a valid HTTP header name`);
  }

  return { [key]: value };
}

function isHttpHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value);
}

function optionalPositiveNumberProperty(
  input: Record<string, unknown>,
  key: string,
  label: string
): Record<string, number> {
  const value = readOptionalPositiveNumber(input[key], label);

  return value === undefined ? {} : { [key]: value };
}

function requireString(value: unknown, label: string): string {
  const parsed = readOptionalString(value, label);

  if (parsed === undefined) {
    throw new Error(`${label} is required when ${parentLabel(label)} is set`);
  }

  return parsed;
}

function requireNumber(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`${label} is required when ${parentLabel(label)} is set`);
  }

  return value;
}

function requirePersonDetectionModelFamily(value: "pinto0309" | undefined): "pinto0309" {
  if (value === undefined) {
    throw new Error(
      "pico config vision.personDetection.modelFamily is required when vision.personDetection is set"
    );
  }

  return value;
}

function requirePersonDetectionProvider(
  value: PicoPersonDetectionProvider | undefined
): PicoPersonDetectionProvider {
  if (value === undefined) {
    throw new Error(
      "pico config vision.personDetection.provider is required when vision.personDetection is set"
    );
  }

  return value;
}

function requireLocalBaseUrl(value: unknown, label: string): string {
  const localBaseUrl = requireString(value, label);

  if (!URL.canParse(localBaseUrl)) {
    throw new Error(`${label} must be a valid URL`);
  }

  const parsedUrl = new URL(localBaseUrl);

  requireHttpUrl(parsedUrl, label);
  requireOriginUrl(parsedUrl, label);
  requireLocalTunnelUrl(parsedUrl, label);

  return localBaseUrl;
}

function readOptionalAuditOtelEndpoint(value: unknown): string | undefined {
  const endpoint = readOptionalString(value, "pico config audit.otel.endpoint");

  if (endpoint === undefined) {
    return undefined;
  }

  if (!URL.canParse(endpoint)) {
    throw new Error("pico config audit.otel.endpoint must be a valid URL");
  }

  const parsedUrl = new URL(endpoint);

  requireHttpUrl(parsedUrl, "pico config audit.otel.endpoint");
  requireAuditOtelEndpointShape(parsedUrl);

  return endpoint;
}

function readOptionalEchoControlProviderEndpoint(value: unknown): string | undefined {
  const endpoint = readOptionalString(value, "pico config voice.echoControl.providerEndpoint");

  if (endpoint === undefined) {
    return undefined;
  }

  if (!URL.canParse(endpoint)) {
    throw new Error("pico config voice.echoControl.providerEndpoint must be a valid URL");
  }

  const parsedUrl = new URL(endpoint);

  requireHttpUrl(parsedUrl, "pico config voice.echoControl.providerEndpoint");
  requireOriginUrl(parsedUrl, "pico config voice.echoControl.providerEndpoint");
  requireVoiceEchoControlLoopbackHost(parsedUrl.hostname);

  return endpoint;
}

function requireAuditOtelEndpointShape(parsedUrl: URL): void {
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new Error("pico config audit.otel.endpoint must not include credentials");
  }

  if (parsedUrl.pathname !== "/v1/logs") {
    throw new Error("pico config audit.otel.endpoint must end with /v1/logs");
  }

  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    throw new Error("pico config audit.otel.endpoint must not include query or fragment");
  }

  requireAuditOtelLoopbackHost(parsedUrl.hostname);
}

function requireAuditOtelLoopbackHost(hostname: string): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(hostname)) {
    throw new Error("pico config audit.otel.endpoint must use a local Collector URL");
  }
}

function requireVoiceEchoControlLoopbackHost(hostname: string): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(hostname)) {
    throw new Error("pico config voice.echoControl.providerEndpoint must use a local URL");
  }
}

function readOptionalString(value: unknown, label = "pico config value"): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

function readOptionalStringList(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list of strings`);
  }

  return value
    .map((item, index) => {
      const parsed = readOptionalString(item, `${label}.${index}`);

      if (parsed === undefined) {
        throw new Error(`${label} must be a list of non-empty strings`);
      }

      return parsed;
    })
    .filter((item, index, items) => items.indexOf(item) === index);
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function readOptionalDeadZone(value: unknown): number | undefined {
  const parsed = readOptionalNumber(value, "pico config camera.personFollow.deadZone");

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 0.5) {
    throw new Error("pico config camera.personFollow.deadZone must be >= 0 and < 0.5");
  }

  return parsed;
}

function readOptionalUnitPositiveNumber(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} must be > 0 and <= 1`);
  }

  return parsed;
}

function readOptionalPersonDetectionModelFamily(value: unknown): "pinto0309" | undefined {
  const parsed = readOptionalString(value, "pico config vision.personDetection.modelFamily");

  if (parsed === undefined) {
    return undefined;
  }

  if (parsed !== "pinto0309") {
    throw new Error("pico config vision.personDetection.modelFamily must be pinto0309");
  }

  return parsed;
}

function readOptionalPersonDetectionProvider(
  value: unknown
): PicoPersonDetectionProvider | undefined {
  const parsed = readOptionalString(value, "pico config vision.personDetection.provider");

  if (parsed === undefined) {
    return undefined;
  }

  if (
    parsed !== "onnxruntime" &&
    parsed !== "coreml" &&
    parsed !== "tflite" &&
    parsed !== "openvino"
  ) {
    throw new Error(
      "pico config vision.personDetection.provider must be onnxruntime, coreml, tflite, or openvino"
    );
  }

  return parsed;
}

function readOptionalPersonDetectionOutputLayout(
  value: unknown
): PicoPersonDetectionOutputLayout | undefined {
  const parsed = readOptionalString(value, "pico config vision.personDetection.outputLayout");

  if (parsed === undefined) {
    return undefined;
  }

  if (
    parsed !== "xyxy_score_class" &&
    parsed !== "cxcywh_score_class" &&
    parsed !== "yolox_coco_raw"
  ) {
    throw new Error(
      "pico config vision.personDetection.outputLayout must be xyxy_score_class, cxcywh_score_class, or yolox_coco_raw"
    );
  }

  return parsed;
}

function readOptionalPersonDetectionCoordinateScale(
  value: unknown
): PicoPersonDetectionCoordinateScale | undefined {
  const parsed = readOptionalString(value, "pico config vision.personDetection.coordinateScale");

  if (parsed === undefined) {
    return undefined;
  }

  if (parsed !== "pixel" && parsed !== "normalized") {
    throw new Error(
      "pico config vision.personDetection.coordinateScale must be pixel or normalized"
    );
  }

  return parsed;
}

function readOptionalEchoControlMode(value: unknown): PicoEchoControlMode | undefined {
  const parsed = readOptionalString(value, "pico config voice.echoControl.mode");

  if (parsed === undefined) {
    return undefined;
  }

  if (parsed !== "aec" && parsed !== "platform_voice_processing" && parsed !== "half_duplex") {
    throw new Error(
      "pico config voice.echoControl.mode must be aec, platform_voice_processing, or half_duplex"
    );
  }

  return parsed;
}

function readOptionalEchoControlProvider(value: unknown): PicoEchoControlProvider | undefined {
  const parsed = readOptionalString(value, "pico config voice.echoControl.provider");

  if (parsed === undefined) {
    return undefined;
  }

  if (
    parsed !== "web_rtc_aec3" &&
    parsed !== "platform_voice_processing" &&
    parsed !== "speexdsp" &&
    parsed !== "half_duplex"
  ) {
    throw new Error(
      "pico config voice.echoControl.provider must be web_rtc_aec3, platform_voice_processing, speexdsp, or half_duplex"
    );
  }

  return parsed;
}

function requireAecEchoControlProvider(
  value: PicoEchoControlProvider | undefined
): PicoEchoControlProvider {
  if (value === undefined) {
    throw new Error(
      "pico config voice.echoControl.provider is required when voice.echoControl is set"
    );
  }

  if (value !== "web_rtc_aec3" && value !== "speexdsp") {
    throw new Error(
      "pico config voice.echoControl.provider must be web_rtc_aec3 or speexdsp when voice.echoControl.mode is aec"
    );
  }

  return value;
}

function readOptionalConfidenceThreshold(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be >= 0 and <= 1`);
  }

  return parsed;
}

function readOptionalRmsDatabase(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isFinite(parsed) || parsed < -120 || parsed > 0) {
    throw new Error(`${label} must be >= -120 and <= 0`);
  }

  return parsed;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    throw new Error(`${label} is required when ${parentLabel(label)} is set`);
  }

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function readOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function readOptionalBoundedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number
): number | undefined {
  const parsed = readOptionalPositiveInteger(value, label);

  if (parsed !== undefined && parsed > maximum) {
    throw new Error(`${label} must be a positive integer <= ${maximum}`);
  }

  return parsed;
}

function readOptionalPositiveNumber(value: unknown, label: string): number | undefined {
  const parsed = readOptionalNumber(value, label);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return parsed;
}

function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`${label} must be a number`);
}

function requireHttpUrl(parsedUrl: URL, label: string): void {
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`${label} must use HTTP`);
  }
}

function requireOriginUrl(parsedUrl: URL, label: string): void {
  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw new Error(`${label} must be an origin URL`);
  }
}

function requireLocalTunnelUrl(parsedUrl: URL, label: string): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(parsedUrl.hostname)) {
    throw new Error(`${label} must use a local SSH tunnel URL`);
  }
}

function readOptionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireRecord(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be one config object`);
  }

  return value as Record<string, unknown>;
}

function parentLabel(label: string): string {
  return label
    .replace(/^pico config /u, "")
    .split(".")
    .slice(0, -1)
    .join(".");
}

function stripUndefinedProperties<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

function deepFreeze<T extends object>(value: T, seen = new WeakSet()): DeepReadonly<T> {
  if (seen.has(value)) {
    return value as DeepReadonly<T>;
  }

  seen.add(value);

  for (const property of Object.values(value)) {
    if (typeof property === "object" && property !== null && !Object.isFrozen(property)) {
      deepFreeze(property, seen);
    }
  }

  return Object.freeze(value) as DeepReadonly<T>;
}
