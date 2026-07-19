import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { parse } from "yaml";

export type PicoConfig = DeepReadonly<{
  pico: {
    model?: PicoAgentModelConfig;
  };
  session: PicoSessionConfig;
  telemetry: {
    otel: PicoTelemetryOtelConfig;
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
      appleSpeech?: PicoAppleSpeechConfig;
    };
    tts: {
      aivis?: PicoAivisConfig;
    };
  };
}>;

export type PicoAgentModelConfig = {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type PicoSessionConfig = {
  readonly enabled: boolean;
  readonly ending: {
    readonly mode: "timed";
    readonly durationMs: number;
  };
};

export type PicoTelemetryOtelConfig = {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly serviceName?: string;
  readonly timeoutMs?: number;
  readonly metricExportIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
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
  readonly shutdownGraceMs: number;
  readonly control?: PicoResidentControlConfig;
  readonly vad: PicoVoiceResidentVadConfig;
};

export type PicoResidentControlConfig = {
  readonly provider: "loopback_http";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly authTokenPath: string;
  readonly keyboard: {
    readonly provider: "macos";
    readonly talkKey: PicoMacKey;
    readonly cancelKey: PicoMacKey;
  };
};

const picoMacKeys = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "Space",
  "Tab",
  "Return",
  "Escape",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "LeftArrow",
  "RightArrow",
  "UpArrow",
  "DownArrow",
  "Minus",
  "Equal",
  "LeftBracket",
  "RightBracket",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Grave"
] as const;

export type PicoMacKey = (typeof picoMacKeys)[number];

export type PicoVoiceResidentVadConfig =
  | {
      readonly provider: "energy";
      readonly minRmsDb: number;
    }
  | {
      readonly provider: "ten_vad";
      readonly jsPath: string;
      readonly wasmPath: string;
      readonly hopSize: 160 | 256;
      readonly threshold: number;
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
      readonly provider: "ffplay";
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

export type PicoAppleSpeechConfig = {
  readonly id?: string;
  readonly localBaseUrl: string;
  readonly language?: "ja-JP";
  readonly timeoutMs?: number;
  readonly warmupAudioSeconds?: number;
  readonly samplePcm16lePath?: string;
  readonly sampleRateHz?: 16_000;
  readonly channels?: 1;
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
const maxTcpPort = 65_535;
const maxOllamaImageEdgePixels = 4096;
const picoThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const emptyPicoConfig: PicoConfig = deepFreeze({
  pico: {},
  session: {
    enabled: true,
    ending: {
      mode: "timed",
      durationMs: 60_000
    }
  },
  telemetry: {
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
      shutdownGraceMs: 5_000,
      vad: {
        provider: "energy",
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
  rejectRemovedAuditOtel(root);
  requireKnownConfigFields(root, "pico config", [
    "pico",
    "session",
    "telemetry",
    "camera",
    "vision",
    "voice"
  ]);

  return deepFreeze({
    pico: definePicoSection(root),
    session: defineSessionSection(root),
    telemetry: defineTelemetrySection(root),
    camera: defineCameraSection(root),
    vision: defineVisionSection(root),
    voice: defineVoiceSection(root)
  });
}

function definePicoSection(root: Record<string, unknown>): PicoConfig["pico"] {
  const pico = readOptionalRecord(root.pico, "pico config pico");

  if (pico === undefined) {
    return {};
  }

  requireKnownConfigFields(pico, "pico config pico", ["model"]);
  const model = readOptionalRecord(pico.model, "pico config pico.model");

  if (model === undefined) {
    return {};
  }

  requireKnownConfigFields(model, "pico config pico.model", ["provider", "id", "thinkingLevel"]);

  return {
    model: {
      provider: requireString(model.provider, "pico config pico.model.provider"),
      id: requireString(model.id, "pico config pico.model.id"),
      thinkingLevel: requireThinkingLevel(
        model.thinkingLevel,
        "pico config pico.model.thinkingLevel"
      )
    }
  };
}

function defineSessionSection(root: Record<string, unknown>): PicoConfig["session"] {
  const session = readOptionalRecord(root.session, "pico config session");

  if (session !== undefined) {
    requireKnownConfigFields(session, "pico config session", ["enabled", "ending"]);
  }

  return {
    enabled: defineSessionEnabled(session),
    ending: defineSessionEnding(readOptionalRecord(session?.ending, "pico config session.ending"))
  };
}

function defineSessionEnabled(input: Record<string, unknown> | undefined): boolean {
  return readOptionalBoolean(input?.enabled, "pico config session.enabled") ?? true;
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

function requireThinkingLevel(
  value: unknown,
  label: string
): PicoAgentModelConfig["thinkingLevel"] {
  const thinkingLevel = requireString(value, label);

  if (!picoThinkingLevels.has(thinkingLevel)) {
    throw new Error(`${label} must be off, minimal, low, medium, high, xhigh, or max`);
  }

  return thinkingLevel as PicoAgentModelConfig["thinkingLevel"];
}

function rejectRemovedAuditOtel(root: Record<string, unknown>): void {
  const audit = readOptionalRecord(root.audit, "pico config audit");

  if (audit?.otel !== undefined) {
    throw new Error("pico config audit.otel was removed; use telemetry.otel");
  }
}

function defineTelemetrySection(root: Record<string, unknown>): PicoConfig["telemetry"] {
  const telemetry = readOptionalRecord(root.telemetry, "pico config telemetry");

  if (telemetry !== undefined) {
    requireKnownConfigFields(telemetry, "pico config telemetry", ["otel"]);
  }

  const otel = readOptionalRecord(telemetry?.otel, "pico config telemetry.otel");

  return {
    otel: defineTelemetryOtelConfig(otel)
  };
}

// Enabled and disabled forms deliberately validate the same explicit fields but return distinct shapes.
// eslint-disable-next-line complexity
function defineTelemetryOtelConfig(
  input: Record<string, unknown> | undefined
): PicoTelemetryOtelConfig {
  if (input === undefined) {
    return {
      enabled: false
    };
  }

  requireKnownConfigFields(input, "pico config telemetry.otel", [
    "enabled",
    "baseUrl",
    "serviceName",
    "timeoutMs",
    "metricExportIntervalMs",
    "shutdownTimeoutMs"
  ]);
  const enabled = readOptionalBoolean(input.enabled, "pico config telemetry.otel.enabled") ?? false;
  const baseUrl = readOptionalTelemetryOtelBaseUrl(input.baseUrl);
  const timeoutMs =
    readOptionalBoundedPositiveInteger(
      input.timeoutMs,
      "pico config telemetry.otel.timeoutMs",
      maxNodeTimeoutMs
    ) ?? 10_000;
  const metricExportIntervalMs =
    readOptionalBoundedPositiveInteger(
      input.metricExportIntervalMs,
      "pico config telemetry.otel.metricExportIntervalMs",
      maxNodeTimeoutMs
    ) ?? 15_000;

  if (metricExportIntervalMs <= timeoutMs) {
    throw new Error("pico config telemetry.otel.metricExportIntervalMs must exceed timeoutMs");
  }

  if (enabled) {
    return {
      enabled,
      baseUrl: requireString(baseUrl, "pico config telemetry.otel.baseUrl"),
      serviceName:
        readOptionalString(input.serviceName, "pico config telemetry.otel.serviceName") ?? "pico",
      timeoutMs,
      metricExportIntervalMs,
      shutdownTimeoutMs:
        readOptionalBoundedPositiveInteger(
          input.shutdownTimeoutMs,
          "pico config telemetry.otel.shutdownTimeoutMs",
          maxNodeTimeoutMs
        ) ?? 5_000
    };
  }

  return {
    enabled,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...optionalStringProperty(input, "serviceName", "pico config telemetry.otel.serviceName"),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config telemetry.otel.timeoutMs",
      maxNodeTimeoutMs
    ),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "metricExportIntervalMs",
      "pico config telemetry.otel.metricExportIntervalMs",
      maxNodeTimeoutMs
    ),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "shutdownTimeoutMs",
      "pico config telemetry.otel.shutdownTimeoutMs",
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
  const voiceConfig: PicoConfig["voice"] = {
    resident: defineVoiceResidentConfig(resident),
    probes: defineVoiceProbeConfig(probes),
    echoControl: defineEchoControlConfig(echoControl),
    stt: defineVoiceSttConfig(voice),
    tts: defineVoiceTtsConfig(voice)
  };

  requireAppleSpeechFrameContract(voiceConfig);
  requireVoiceResidentVadFrameContract(voiceConfig);

  return voiceConfig;
}

function defineVoiceSttConfig(
  voice: Record<string, unknown> | undefined
): PicoConfig["voice"]["stt"] {
  const stt = readOptionalRecord(voice?.stt, "pico config voice.stt");
  if (stt !== undefined && Object.hasOwn(stt, "mlxWhisper")) {
    throw new Error(
      "pico config voice.stt.mlxWhisper was removed; migrate to voice.stt.appleSpeech"
    );
  }
  const appleSpeech = readOptionalRecord(stt?.appleSpeech, "pico config voice.stt.appleSpeech");

  return {
    ...(appleSpeech === undefined ? {} : { appleSpeech: defineAppleSpeechConfig(appleSpeech) })
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
  requireKnownConfigFields(input, "pico config voice.resident", [
    "enabled",
    "audioInput",
    "audioOutput",
    "singleInstanceLockPath",
    "shutdownGraceMs",
    "control",
    "vad"
  ]);
  const vad = readOptionalRecord(input.vad, "pico config voice.resident.vad");
  const control = readOptionalRecord(input.control, "pico config voice.resident.control");

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
    shutdownGraceMs:
      readOptionalBoundedPositiveInteger(
        input.shutdownGraceMs,
        "pico config voice.resident.shutdownGraceMs",
        maxNodeTimeoutMs
      ) ?? 5_000,
    ...(control === undefined ? {} : { control: defineResidentControlConfig(control) }),
    vad: defineVoiceResidentVadConfig(vad)
  };
}

function defineResidentControlConfig(input: Record<string, unknown>): PicoResidentControlConfig {
  requireKnownConfigFields(input, "pico config voice.resident.control", [
    "provider",
    "host",
    "port",
    "authTokenPath",
    "keyboard"
  ]);
  const provider = requireString(input.provider, "pico config voice.resident.control.provider");

  if (provider !== "loopback_http") {
    throw new Error("pico config voice.resident.control.provider must be loopback_http");
  }

  const keyboard = requireRecord(input.keyboard, "pico config voice.resident.control.keyboard");
  requireKnownConfigFields(keyboard, "pico config voice.resident.control.keyboard", [
    "provider",
    "talkKey",
    "cancelKey"
  ]);
  const keyboardProvider = requireString(
    keyboard.provider,
    "pico config voice.resident.control.keyboard.provider"
  );

  if (keyboardProvider !== "macos") {
    throw new Error("pico config voice.resident.control.keyboard.provider must be macos");
  }

  const talkKey = requirePicoMacKey(
    keyboard.talkKey,
    "pico config voice.resident.control.keyboard.talkKey"
  );
  const cancelKey = requirePicoMacKey(
    keyboard.cancelKey,
    "pico config voice.resident.control.keyboard.cancelKey"
  );

  if (talkKey === cancelKey) {
    throw new Error("pico config voice.resident.control keyboard keys must be different");
  }

  return {
    provider,
    host: requireLoopbackControlHost(input.host),
    port: requireTcpPort(input.port, "pico config voice.resident.control.port"),
    authTokenPath: requireString(
      input.authTokenPath,
      "pico config voice.resident.control.authTokenPath"
    ),
    keyboard: {
      provider: keyboardProvider,
      talkKey,
      cancelKey
    }
  };
}

function requireLoopbackControlHost(value: unknown): "127.0.0.1" | "::1" {
  const host = requireString(value, "pico config voice.resident.control.host");

  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("pico config voice.resident.control.host must be 127.0.0.1 or ::1");
  }

  return host;
}

function requirePicoMacKey(value: unknown, label: string): PicoMacKey {
  const key = requireString(value, label);

  if (!new Set<string>(picoMacKeys).has(key)) {
    throw new Error(`${label} is invalid`);
  }

  return key as PicoMacKey;
}

function requireTcpPort(value: unknown, label: string): number {
  const port = requireNonNegativeInteger(value, label);

  if (port < 1 || port > maxTcpPort) {
    throw new Error(`${label} must be between 1 and ${maxTcpPort}`);
  }

  return port;
}

function defineVoiceResidentVadConfig(
  input: Record<string, unknown> | undefined
): PicoVoiceResidentVadConfig {
  if (input === undefined) {
    return {
      provider: "energy",
      minRmsDb: -55
    };
  }

  const provider =
    readOptionalString(input.provider, "pico config voice.resident.vad.provider") ?? "energy";

  if (provider === "energy") {
    return {
      provider,
      minRmsDb:
        readOptionalRmsDatabase(input.minRmsDb, "pico config voice.resident.vad.minRmsDb") ?? -55
    };
  }

  if (provider === "ten_vad") {
    return {
      provider,
      jsPath: requireString(input.jsPath, "pico config voice.resident.vad.jsPath"),
      wasmPath: requireString(input.wasmPath, "pico config voice.resident.vad.wasmPath"),
      hopSize: requireTenVadHopSize(input.hopSize, "pico config voice.resident.vad.hopSize"),
      threshold:
        readOptionalConfidenceThreshold(
          input.threshold,
          "pico config voice.resident.vad.threshold"
        ) ?? 0.5
    };
  }

  throw new Error("pico config voice.resident.vad.provider must be energy or ten_vad");
}

function requireVoiceResidentVadFrameContract(voice: PicoConfig["voice"]): void {
  const vad = voice.resident.vad;

  if (vad.provider !== "ten_vad") {
    return;
  }

  if (voice.echoControl.sampleRateHz !== 16_000) {
    throw new Error("pico config voice.echoControl.sampleRateHz must be 16000 for ten_vad");
  }

  if (voice.echoControl.channels !== 1) {
    throw new Error("pico config voice.echoControl.channels must be 1 for ten_vad");
  }

  const requiredFrameMs = vad.hopSize === 160 ? 10 : 16;

  if (voice.echoControl.frameMs !== requiredFrameMs) {
    throw new Error(
      `pico config voice.echoControl.frameMs must be ${String(requiredFrameMs)} for ten_vad hopSize ${String(vad.hopSize)}`
    );
  }
}

function requireAppleSpeechFrameContract(voice: PicoConfig["voice"]): void {
  if (voice.stt.appleSpeech === undefined) {
    return;
  }

  if (voice.echoControl.sampleRateHz !== 16_000) {
    throw new Error("pico config voice.echoControl.sampleRateHz must be 16000 for Apple Speech");
  }

  if (voice.echoControl.channels !== 1) {
    throw new Error("pico config voice.echoControl.channels must be 1 for Apple Speech");
  }
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

  if (provider === "ffplay") {
    const route = requireString(input.route, "pico config voice.resident.audioOutput.route");

    if (route !== "system_default") {
      throw new Error("pico config voice.resident.audioOutput.route must be system_default");
    }

    return { provider, route };
  }

  throw new Error("pico config voice.resident.audioOutput.provider must be alsa or ffplay");
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

function defineAppleSpeechConfig(input: Record<string, unknown>): PicoAppleSpeechConfig {
  const language = readOptionalAppleSpeechLanguage(input.language);
  const sampleRateHz = readOptionalAppleSpeechSampleRate(input.sampleRateHz);
  const channels = readOptionalAppleSpeechChannels(input.channels);

  return {
    ...optionalStringProperty(input, "id", "pico config voice.stt.appleSpeech.id"),
    localBaseUrl: requireAppleSpeechBaseUrl(
      input.localBaseUrl,
      "pico config voice.stt.appleSpeech.localBaseUrl"
    ),
    ...(language === undefined ? {} : { language }),
    ...optionalPositiveIntegerProperty(
      input,
      "timeoutMs",
      "pico config voice.stt.appleSpeech.timeoutMs"
    ),
    ...optionalPositiveNumberProperty(
      input,
      "warmupAudioSeconds",
      "pico config voice.stt.appleSpeech.warmupAudioSeconds"
    ),
    ...optionalStringProperty(
      input,
      "samplePcm16lePath",
      "pico config voice.stt.appleSpeech.samplePcm16lePath"
    ),
    ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
    ...(channels === undefined ? {} : { channels })
  };
}

function readOptionalAppleSpeechLanguage(value: unknown): "ja-JP" | undefined {
  const language = readOptionalString(value, "pico config voice.stt.appleSpeech.language");

  if (language !== undefined && language !== "ja-JP") {
    throw new Error("pico config voice.stt.appleSpeech.language must be ja-JP");
  }

  return language;
}

function readOptionalAppleSpeechSampleRate(value: unknown): 16_000 | undefined {
  const sampleRateHz = readOptionalPositiveInteger(
    value,
    "pico config voice.stt.appleSpeech.sampleRateHz"
  );

  if (sampleRateHz !== undefined && sampleRateHz !== 16_000) {
    throw new Error("pico config voice.stt.appleSpeech.sampleRateHz must be 16000");
  }

  return sampleRateHz;
}

function readOptionalAppleSpeechChannels(value: unknown): 1 | undefined {
  const channels = readOptionalPositiveInteger(value, "pico config voice.stt.appleSpeech.channels");

  if (channels !== undefined && channels !== 1) {
    throw new Error("pico config voice.stt.appleSpeech.channels must be 1");
  }

  return channels;
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
        ),
        ...(config.voice.resident.control === undefined
          ? {}
          : {
              control: {
                ...config.voice.resident.control,
                authTokenPath: resolveConfigHomeOrRelativePath(
                  baseDirectory,
                  config.voice.resident.control.authTokenPath
                )
              }
            }),
        vad:
          config.voice.resident.vad.provider === "ten_vad"
            ? {
                ...config.voice.resident.vad,
                jsPath: resolveConfigRelativePath(baseDirectory, config.voice.resident.vad.jsPath),
                wasmPath: resolveConfigRelativePath(
                  baseDirectory,
                  config.voice.resident.vad.wasmPath
                )
              }
            : config.voice.resident.vad
      },
      stt: {
        ...config.voice.stt,
        ...(config.voice.stt.appleSpeech === undefined
          ? {}
          : {
              appleSpeech: {
                ...config.voice.stt.appleSpeech,
                ...(config.voice.stt.appleSpeech.samplePcm16lePath === undefined
                  ? {}
                  : {
                      samplePcm16lePath: resolveConfigRelativePath(
                        baseDirectory,
                        config.voice.stt.appleSpeech.samplePcm16lePath
                      )
                    })
              }
            })
      }
    }
  });
}

function resolveConfigRelativePath(baseDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function resolveConfigHomeOrRelativePath(baseDirectory: string, path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return resolveConfigRelativePath(baseDirectory, path);
}

function optionalStringProperty(
  input: Record<string, unknown>,
  key: string,
  label: string
): Record<string, string> {
  const value = readOptionalString(input[key], label);

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

function requireAppleSpeechBaseUrl(value: unknown, label: string): string {
  const localBaseUrl = requireLocalBaseUrl(value, label);
  const parsedUrl = new URL(localBaseUrl);

  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use an http://127.0.0.1 origin`);
  }

  return localBaseUrl;
}

function readOptionalTelemetryOtelBaseUrl(value: unknown): string | undefined {
  const baseUrl = readOptionalString(value, "pico config telemetry.otel.baseUrl");

  if (baseUrl === undefined) {
    return undefined;
  }

  if (!URL.canParse(baseUrl)) {
    throw new Error("pico config telemetry.otel.baseUrl must be a valid URL");
  }

  const parsedUrl = new URL(baseUrl);

  requireHttpUrl(parsedUrl, "pico config telemetry.otel.baseUrl");
  requireOriginUrl(parsedUrl, "pico config telemetry.otel.baseUrl");
  requireTelemetryOtelLoopbackHost(parsedUrl.hostname);

  return baseUrl;
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

function requireTelemetryOtelLoopbackHost(hostname: string): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(hostname)) {
    throw new Error("pico config telemetry.otel.baseUrl must use a local Collector URL");
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

function requireTenVadHopSize(value: unknown, label: string): 160 | 256 {
  const parsed = readOptionalNumber(value, label);

  if (parsed === 160 || parsed === 256) {
    return parsed;
  }

  throw new Error(`${label} must be 160 or 256`);
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

function requireKnownConfigFields(
  input: Record<string, unknown>,
  label: string,
  knownFields: readonly string[]
): void {
  const known = new Set(knownFields);

  for (const field of Object.keys(input)) {
    if (!known.has(field)) {
      throw new Error(`${label} has unknown field ${field}`);
    }
  }
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
