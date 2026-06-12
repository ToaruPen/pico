import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { parse } from "yaml";

export type PicoConfig = DeepReadonly<{
  session: PicoSessionConfig;
  camera: {
    tapo?: PicoTapoConfig;
  };
  vision: {
    ollama?: PicoOllamaConfig;
  };
  voice: {
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

export type PicoTapoConfig = {
  readonly sourceId?: string;
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly password: string;
  readonly stream?: string;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
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

export type LoadPicoConfigOptions = {
  readonly path?: string;
  readonly cwd?: string;
};

const defaultConfigPath = "config/pico.local.yaml";
const maxNodeTimeoutMs = 2_147_483_647;
const maxTcpPort = 65_535;

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
  camera: {},
  vision: {},
  voice: {
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

  return definePicoConfig(parsed);
}

export function definePicoConfig(input: unknown): PicoConfig {
  const root = input === null || input === undefined ? {} : requireRecord(input, "pico config");

  return deepFreeze({
    session: defineSessionSection(root),
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

function defineCameraSection(root: Record<string, unknown>): PicoConfig["camera"] {
  const camera = readOptionalRecord(root.camera, "pico config camera");
  const tapo = readOptionalRecord(camera?.tapo, "pico config camera.tapo");

  return {
    ...(tapo === undefined ? {} : { tapo: defineTapoConfig(tapo) })
  };
}

function defineVisionSection(root: Record<string, unknown>): PicoConfig["vision"] {
  const vision = readOptionalRecord(root.vision, "pico config vision");
  const ollama = readOptionalRecord(vision?.ollama, "pico config vision.ollama");

  return {
    ...(ollama === undefined ? {} : { ollama: defineOllamaConfig(ollama) })
  };
}

function defineVoiceSection(root: Record<string, unknown>): PicoConfig["voice"] {
  const voice = readOptionalRecord(root.voice, "pico config voice");
  const stt = readOptionalRecord(voice?.stt, "pico config voice.stt");
  const tts = readOptionalRecord(voice?.tts, "pico config voice.tts");
  const mlxWhisper = readOptionalRecord(stt?.mlxWhisper, "pico config voice.stt.mlxWhisper");
  const aivis = readOptionalRecord(tts?.aivis, "pico config voice.tts.aivis");

  return {
    stt: {
      ...(mlxWhisper === undefined ? {} : { mlxWhisper: defineMlxWhisperConfig(mlxWhisper) })
    },
    tts: {
      ...(aivis === undefined ? {} : { aivis: defineAivisConfig(aivis) })
    }
  };
}

function defineTapoConfig(input: Record<string, unknown>): PicoTapoConfig {
  return {
    ...optionalStringProperty(input, "sourceId", "pico config camera.tapo.sourceId"),
    host: requireString(input.host, "pico config camera.tapo.host"),
    ...optionalBoundedPositiveIntegerProperty(
      input,
      "port",
      "pico config camera.tapo.port",
      maxTcpPort
    ),
    user: requireString(input.user, "pico config camera.tapo.user"),
    password: requireString(input.password, "pico config camera.tapo.password"),
    ...optionalStringProperty(input, "stream", "pico config camera.tapo.stream"),
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

function defineOllamaConfig(input: Record<string, unknown>): PicoOllamaConfig {
  const auth = readOptionalRecord(input.auth, "pico config vision.ollama.auth");
  const tunnel = readOptionalRecord(input.tunnel, "pico config vision.ollama.tunnel");

  return {
    ...optionalStringProperty(input, "endpointId", "pico config vision.ollama.endpointId"),
    localBaseUrl: requireLocalTunnelBaseUrl(input.localBaseUrl),
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
    )
  };
}

function defineMlxWhisperConfig(input: Record<string, unknown>): PicoMlxWhisperConfig {
  return {
    ...optionalStringProperty(input, "id", "pico config voice.stt.mlxWhisper.id"),
    localBaseUrl: requireString(
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
    localBaseUrl: requireString(input.localBaseUrl, "pico config voice.tts.aivis.localBaseUrl"),
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

function requireLocalTunnelBaseUrl(value: unknown): string {
  const localBaseUrl = requireString(value, "pico config vision.ollama.localBaseUrl");

  if (!URL.canParse(localBaseUrl)) {
    throw new Error("pico config vision.ollama.localBaseUrl must be a valid URL");
  }

  const parsedUrl = new URL(localBaseUrl);

  requireHttpUrl(parsedUrl);
  requireOriginUrl(parsedUrl);
  requireLocalTunnelUrl(parsedUrl);

  return localBaseUrl;
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

function requireHttpUrl(parsedUrl: URL): void {
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("pico config vision.ollama.localBaseUrl must use HTTP");
  }
}

function requireOriginUrl(parsedUrl: URL): void {
  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw new Error("pico config vision.ollama.localBaseUrl must be an origin URL");
  }
}

function requireLocalTunnelUrl(parsedUrl: URL): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  if (!loopbackHosts.has(parsedUrl.hostname)) {
    throw new Error("pico config vision.ollama.localBaseUrl must use a local SSH tunnel URL");
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
