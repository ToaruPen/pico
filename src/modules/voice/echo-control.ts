import type { StructuredAuditLog } from "../audit/index.js";

export type VoiceFrameDirection = "near_end" | "far_end";

export type VoicePcmFrame = {
  readonly id: string;
  readonly direction: VoiceFrameDirection;
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly capturedAt: string;
  readonly durationMs: number;
};

export type EchoControlResult =
  | {
      readonly action: "pass";
      readonly reason: "no_far_end_tail" | "aec_processed";
      readonly frame: VoicePcmFrame;
      readonly diagnostics: EchoControlDiagnostics;
    }
  | {
      readonly action: "suppress";
      readonly reason: "far_end_tail_mute";
      readonly diagnostics: EchoControlDiagnostics;
    };

export type EchoControlDiagnostics = {
  readonly provider: EchoControlProviderKind;
  readonly residualEchoProbability: number;
  readonly voiceActivity: boolean;
};

export type EchoControlProviderKind =
  | "half_duplex"
  | "web_rtc_aec3"
  | "platform_voice_processing"
  | "speexdsp";

export type EchoControlProviderMetadata = {
  readonly provider: EchoControlProviderKind;
  readonly mode: "aec" | "platform_voice_processing" | "half_duplex";
};

export type EchoControlProviderHealth =
  | {
      readonly ok: true;
      readonly provider: EchoControlProviderKind;
      readonly mode: EchoControlProviderMetadata["mode"];
      readonly engine: string;
    }
  | {
      readonly ok: false;
      readonly provider: EchoControlProviderKind;
      readonly mode: EchoControlProviderMetadata["mode"];
      readonly reason: "unavailable" | "invalid_response";
      readonly message: string;
    };

export type EchoControlProvider = {
  readonly describe: () => EchoControlProviderMetadata;
  readonly checkHealth: () => Promise<EchoControlProviderHealth>;
  readonly acceptFarEndReference: (frame: VoicePcmFrame) => Promise<void>;
  readonly processNearEnd: (frame: VoicePcmFrame) => Promise<EchoControlResult>;
  readonly flush: () => Promise<void>;
};

export type HalfDuplexEchoControlOptions = {
  readonly tailMuteMs: number;
  readonly audit?: StructuredAuditLog;
};

export type HttpEchoControlProviderOptions = {
  readonly provider: Exclude<EchoControlProviderKind, "half_duplex">;
  readonly mode: "aec" | "platform_voice_processing";
  readonly providerEndpoint: string;
  readonly fetchImplementation?: typeof fetch;
};

type HttpEchoControlResponse =
  | {
      readonly action: "pass";
      readonly reason: "aec_processed";
      readonly audioBase64: string;
      readonly diagnostics: HttpEchoControlDiagnostics;
    }
  | {
      readonly action: "suppress";
      readonly reason: "provider_suppressed";
      readonly diagnostics: HttpEchoControlDiagnostics;
    };

type HttpEchoControlDiagnostics = {
  readonly residualEchoProbability: number;
  readonly voiceActivity: boolean;
};

export function createHalfDuplexEchoControl(
  options: HalfDuplexEchoControlOptions
): EchoControlProvider {
  const tailMuteMs = requireNonNegativeInteger(options.tailMuteMs, "pico voice tailMuteMs");
  let mutedUntil = 0;

  return {
    describe() {
      return {
        provider: "half_duplex",
        mode: "half_duplex"
      };
    },
    checkHealth() {
      return Promise.resolve({
        ok: true,
        provider: "half_duplex",
        mode: "half_duplex",
        engine: "half-duplex-safety"
      });
    },
    acceptFarEndReference(frame) {
      const farEnd = defineVoicePcmFrame(frame);
      requireVoiceFrameDirection(farEnd, "far_end");
      mutedUntil = Date.parse(farEnd.capturedAt) + farEnd.durationMs + tailMuteMs;
      recordVoiceAudit(options.audit, "voice.listen.suspended_for_tts", {
        "pico.voice.echo_control.provider": "half_duplex",
        "pico.voice.frame.duration_ms": farEnd.durationMs,
        "pico.voice.frame.sample_rate_hz": farEnd.sampleRateHz,
        "pico.voice.frame.channels": farEnd.channels
      });
      return Promise.resolve();
    },
    processNearEnd(frame) {
      const nearEnd = defineVoicePcmFrame(frame);
      requireVoiceFrameDirection(nearEnd, "near_end");
      const capturedAtMs = Date.parse(nearEnd.capturedAt);

      if (capturedAtMs < mutedUntil) {
        return Promise.resolve({
          action: "suppress",
          reason: "far_end_tail_mute",
          diagnostics: {
            provider: "half_duplex",
            residualEchoProbability: 1,
            voiceActivity: false
          }
        });
      }

      recordResumeIfNeeded(options.audit);

      return Promise.resolve({
        action: "pass",
        reason: "no_far_end_tail",
        frame: nearEnd,
        diagnostics: {
          provider: "half_duplex",
          residualEchoProbability: 0,
          voiceActivity: true
        }
      });
    },
    flush() {
      recordResumeIfNeeded(options.audit);
      return Promise.resolve();
    }
  };

  function recordResumeIfNeeded(audit: StructuredAuditLog | undefined): void {
    if (mutedUntil === 0) {
      return;
    }

    mutedUntil = 0;
    recordVoiceAudit(audit, "voice.listen.resumed", {
      "pico.voice.echo_control.provider": "half_duplex",
      "pico.voice.echo_control.tail_mute_ms": tailMuteMs
    });
  }
}

export function createHttpEchoControlProvider(
  options: HttpEchoControlProviderOptions
): EchoControlProvider {
  const providerEndpoint = requireLocalProviderEndpoint(options.providerEndpoint);
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    describe() {
      return {
        provider: options.provider,
        mode: options.mode
      };
    },
    async checkHealth() {
      return getEchoControlHealth(providerEndpoint, {
        provider: options.provider,
        mode: options.mode,
        fetchImplementation
      });
    },
    async acceptFarEndReference(frame) {
      const farEnd = defineVoicePcmFrame(frame);
      requireVoiceFrameDirection(farEnd, "far_end");
      await postEchoControlFrame(providerEndpoint, "/v1/echo-control/far-end", farEnd, {
        provider: options.provider,
        mode: options.mode,
        fetchImplementation
      });
    },
    async processNearEnd(frame) {
      const nearEnd = defineVoicePcmFrame(frame);
      requireVoiceFrameDirection(nearEnd, "near_end");
      const response = await postEchoControlFrame(
        providerEndpoint,
        "/v1/echo-control/near-end",
        nearEnd,
        {
          provider: options.provider,
          mode: options.mode,
          fetchImplementation
        }
      );

      if (response.action === "suppress") {
        return {
          action: "suppress",
          reason: "far_end_tail_mute",
          diagnostics: {
            provider: options.provider,
            residualEchoProbability: response.diagnostics.residualEchoProbability,
            voiceActivity: response.diagnostics.voiceActivity
          }
        };
      }

      return {
        action: "pass",
        reason: "aec_processed",
        frame: {
          ...nearEnd,
          audio: requireAudioBase64(response.audioBase64)
        },
        diagnostics: {
          provider: options.provider,
          residualEchoProbability: response.diagnostics.residualEchoProbability,
          voiceActivity: response.diagnostics.voiceActivity
        }
      };
    },
    flush() {
      return Promise.resolve();
    }
  };
}

export function defineVoicePcmFrame(input: VoicePcmFrame): VoicePcmFrame {
  return Object.freeze({
    id: requireText(input.id, "pico voice frame id is required"),
    direction: requireVoiceFrameDirection(input, input.direction),
    audio: requirePcm16le(input.audio),
    encoding: requirePcm16leEncoding(input.encoding),
    sampleRateHz: requirePositiveInteger(input.sampleRateHz, "pico voice frame sampleRateHz"),
    channels: requirePositiveInteger(input.channels, "pico voice frame channels"),
    capturedAt: requireIsoText(input.capturedAt, "pico voice frame capturedAt is required"),
    durationMs: requirePositiveInteger(input.durationMs, "pico voice frame durationMs")
  });
}

async function getEchoControlHealth(
  providerEndpoint: string,
  options: {
    readonly provider: Exclude<EchoControlProviderKind, "half_duplex">;
    readonly mode: "aec" | "platform_voice_processing";
    readonly fetchImplementation: typeof fetch;
  }
): Promise<EchoControlProviderHealth> {
  const response = await options.fetchImplementation(
    new URL("/v1/echo-control/health", providerEndpoint),
    {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `pico echo-control provider health request failed with status ${response.status}`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("pico echo-control provider health response is malformed");
  }

  return parseHttpEchoControlHealthResponse(body, {
    provider: options.provider,
    mode: options.mode
  });
}

async function postEchoControlFrame(
  providerEndpoint: string,
  path: "/v1/echo-control/far-end" | "/v1/echo-control/near-end",
  frame: VoicePcmFrame,
  options: {
    readonly provider: Exclude<EchoControlProviderKind, "half_duplex">;
    readonly mode: "aec" | "platform_voice_processing";
    readonly fetchImplementation: typeof fetch;
  }
): Promise<HttpEchoControlResponse> {
  const response = await options.fetchImplementation(new URL(path, providerEndpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      provider: options.provider,
      mode: options.mode,
      frame: {
        id: frame.id,
        direction: frame.direction,
        encoding: frame.encoding,
        sampleRateHz: frame.sampleRateHz,
        channels: frame.channels,
        capturedAt: frame.capturedAt,
        durationMs: frame.durationMs,
        audioBase64: Buffer.from(frame.audio).toString("base64")
      }
    })
  });

  if (!response.ok) {
    throw new Error(`pico echo-control provider request failed with status ${response.status}`);
  }

  return parseHttpEchoControlResponse((await response.json()) as unknown);
}

function parseHttpEchoControlHealthResponse(
  input: unknown,
  expected: {
    readonly provider: Exclude<EchoControlProviderKind, "half_duplex">;
    readonly mode: "aec" | "platform_voice_processing";
  }
): EchoControlProviderHealth {
  const response = requireRecord(input, "pico echo-control provider health response is malformed");

  if (response.provider !== expected.provider || response.mode !== expected.mode) {
    throw new Error("pico echo-control provider health response is malformed");
  }

  if (response.ok === false) {
    return {
      ok: false,
      provider: expected.provider,
      mode: expected.mode,
      reason: requireEchoControlHealthFailureReason(response.reason),
      message: requireText(
        response.message,
        "pico echo-control provider health response is malformed"
      )
    };
  }

  if (response.ok !== true) {
    throw new Error("pico echo-control provider health response is malformed");
  }

  return {
    ok: true,
    provider: expected.provider,
    mode: expected.mode,
    engine: requireText(response.engine, "pico echo-control provider health response is malformed")
  };
}

function requireEchoControlHealthFailureReason(value: unknown): "unavailable" | "invalid_response" {
  if (value !== "unavailable" && value !== "invalid_response") {
    throw new Error("pico echo-control provider health response is malformed");
  }

  return value;
}

function parseHttpEchoControlResponse(input: unknown): HttpEchoControlResponse {
  const response = requireRecord(input, "pico echo-control provider response is malformed");
  const diagnostics = requireRecord(
    response.diagnostics,
    "pico echo-control provider diagnostics are malformed"
  );
  const action = requireEchoControlAction(response.action);

  const parsedDiagnostics = {
    residualEchoProbability: requireUnitNumber(
      diagnostics.residualEchoProbability,
      "pico echo-control provider residualEchoProbability is malformed"
    ),
    voiceActivity: requireBoolean(
      diagnostics.voiceActivity,
      "pico echo-control provider voiceActivity is malformed"
    )
  };

  if (action === "pass") {
    return {
      action,
      reason: "aec_processed",
      audioBase64: requireText(
        response.audioBase64,
        "pico echo-control provider audioBase64 is required"
      ),
      diagnostics: parsedDiagnostics
    };
  }

  return {
    action,
    reason: "provider_suppressed",
    diagnostics: parsedDiagnostics
  };
}

function recordVoiceAudit(
  audit: StructuredAuditLog | undefined,
  name: "voice.listen.suspended_for_tts" | "voice.listen.resumed",
  attributes: Readonly<Record<string, string | number | boolean>>
): void {
  audit?.record({
    category: "transport_event",
    name,
    severity: "info",
    occurredAt: new Date().toISOString(),
    summary:
      name === "voice.listen.suspended_for_tts"
        ? "Voice listening was suspended while pico output audio was active."
        : "Voice listening resumed after pico output audio suppression ended.",
    attributes
  });
}

function requireVoiceFrameDirection(
  frame: { readonly direction: unknown },
  direction: VoiceFrameDirection
): VoiceFrameDirection {
  if (frame.direction !== direction) {
    throw new Error(`pico voice frame direction must be ${direction}`);
  }

  return direction;
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value.trim();
}

function requireIsoText(value: unknown, message: string): string {
  const text = requireText(value, message);
  const timestamp = Date.parse(text);

  if (Number.isNaN(timestamp)) {
    throw new Error(message);
  }

  return text;
}

function requirePcm16le(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error("pico voice frame pcm16le is required");
  }

  return value;
}

function requireAudioBase64(value: unknown): Uint8Array {
  const text = requireText(value, "pico echo-control provider audioBase64 is required");
  const audio = Buffer.from(text, "base64");

  if (audio.byteLength === 0) {
    throw new Error("pico echo-control provider audioBase64 is required");
  }

  return new Uint8Array(audio);
}

function requirePcm16leEncoding(value: unknown): "pcm16le" {
  if (value !== "pcm16le") {
    throw new Error("pico voice frame encoding must be pcm16le");
  }

  return value;
}

function requireEchoControlAction(value: unknown): "pass" | "suppress" {
  if (value !== "pass" && value !== "suppress") {
    throw new Error("pico echo-control provider action is malformed");
  }

  return value;
}

function requireUnitNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(message);
  }

  return value;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${message} must be a positive integer`);
  }

  return value;
}

function requireLocalProviderEndpoint(value: unknown): string {
  const endpoint = requireText(value, "pico echo-control providerEndpoint is required");

  if (!URL.canParse(endpoint)) {
    throw new Error("pico echo-control providerEndpoint must be a valid URL");
  }

  const parsed = new URL(endpoint);

  requireProviderEndpointOrigin(parsed);
  requireProviderEndpointLocalHost(parsed.hostname);

  return endpoint;
}

function requireProviderEndpointOrigin(parsed: URL): void {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("pico echo-control providerEndpoint must use HTTP");
  }

  if (
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("pico echo-control providerEndpoint must be an origin URL");
  }
}

function requireProviderEndpointLocalHost(hostname: string): void {
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopbackHosts.has(hostname)) {
    throw new Error("pico echo-control providerEndpoint must use a local URL");
  }
}

function requireNonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${message} must be a non-negative integer`);
  }

  return value;
}
