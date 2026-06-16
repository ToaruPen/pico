#!/usr/bin/env jiti
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  createHalfDuplexEchoControl,
  createHttpEchoControlProvider,
  defineVoicePcmFrame,
  type EchoControlProvider,
  type EchoControlProviderKind,
  type EchoControlResult
} from "../../src/modules/voice/echo-control.js";
import {
  createAivisSpeechTtsClient,
  createMlxWhisperSttClient,
  defineAivisSpeechService,
  defineMlxWhisperSidecar,
  type SttTranscriptionRequest,
  type TtsAudioChunk
} from "../../src/modules/voice/index.js";

export type VoiceEchoPickupFieldReport =
  | {
      readonly status: "passed";
      readonly details?: VoiceEchoPickupFieldDetails;
    }
  | {
      readonly status: "failed";
      readonly reason?: string;
      readonly details?: VoiceEchoPickupFieldDetails;
    }
  | {
      readonly status: "skipped";
      readonly reason?: string;
    };

export type VoiceEchoPickupAcceptance = "aec_pass" | "safety_pass" | "fail";

export type VoiceEchoPickupFieldDetails = {
  readonly acceptance: VoiceEchoPickupAcceptance;
  readonly provider: EchoControlProviderKind;
  readonly echoAction: "pass" | "suppress";
  readonly transcriptLength: number;
  readonly resumedTranscriptLength: number;
  readonly wouldTriggerSession: boolean;
};

export type VoiceEchoPickupClassificationInput = {
  readonly provider: EchoControlProviderKind;
  readonly echoAction: "pass" | "suppress";
  readonly transcriptText: string;
  readonly transcriptLength: number;
  readonly resumedTranscriptText: string;
  readonly resumedTranscriptLength: number;
  readonly triggerPhrases: readonly string[];
};

export type VoiceEchoPickupFieldPlan =
  | {
      readonly status: "run";
      readonly echoControl: PicoConfig["voice"]["echoControl"];
      readonly stt: NonNullable<PicoConfig["voice"]["stt"]["mlxWhisper"]>;
      readonly tts: NonNullable<PicoConfig["voice"]["tts"]["aivis"]>;
      readonly triggerPhrases: readonly string[];
    }
  | {
      readonly status: "skip";
      readonly reason: string;
    };

const missingProviderReason =
  "Set voice.echoControl, voice.stt.mlxWhisper, and voice.tts.aivis to run the voice echo pickup field test.";
const defaultMlxWhisperModelRepo = "mlx-community/whisper-large-v3-turbo";
const defaultLanguage = "ja";
const defaultTimeoutMs = 30_000;
const defaultWarmupAudioSeconds = 0.25;
const defaultText = "おはようピコ。これはエコー拾い込み確認です。";
const defaultArtifactDirectory = ".pico-local/field-voice";
const defaultMacMicrophoneDevice = ":0";
const defaultLinuxMicrophoneDevice = "default";
const defaultRecordSeconds = 4;
const defaultPlaybackDelayMs = 500;

export function buildVoiceEchoPickupFieldPlan(config: PicoConfig): VoiceEchoPickupFieldPlan {
  const echoControl = config.voice.echoControl;
  const stt = config.voice.stt.mlxWhisper;
  const tts = config.voice.tts.aivis;

  if (!echoControl.enabled || stt === undefined || tts === undefined) {
    return {
      status: "skip",
      reason: missingProviderReason
    };
  }

  return {
    status: "run",
    echoControl,
    stt,
    tts,
    triggerPhrases: [
      ...config.session.startTriggers.wakeNames,
      ...config.session.startTriggers.greetings
    ]
  };
}

export function voiceEchoPickupFieldExitCode(report: VoiceEchoPickupFieldReport): number {
  return report.status === "failed" ? 1 : 0;
}

export function classifyVoiceEchoPickupResult(
  input: VoiceEchoPickupClassificationInput
): VoiceEchoPickupFieldReport {
  const resumedWouldTrigger = includesTriggerPhrase(
    input.resumedTranscriptText,
    input.triggerPhrases
  );
  const wouldTriggerSession =
    resumedWouldTrigger ||
    (input.echoAction === "pass" &&
      includesTriggerPhrase(input.transcriptText, input.triggerPhrases));
  const details: VoiceEchoPickupFieldDetails = {
    acceptance: classifyVoiceEchoPickupAcceptance(
      input.provider,
      input.echoAction,
      wouldTriggerSession
    ),
    provider: input.provider,
    echoAction: input.echoAction,
    transcriptLength: input.transcriptLength,
    resumedTranscriptLength: input.resumedTranscriptLength,
    wouldTriggerSession
  };

  if (resumedWouldTrigger) {
    return {
      status: "failed",
      reason: "pico TTS pickup remained audible after echo-control resume",
      details
    };
  }

  if (wouldTriggerSession) {
    return {
      status: "failed",
      reason: "pico TTS pickup was allowed through echo control",
      details
    };
  }

  return {
    status: "passed",
    details
  };
}

export async function assertVoiceEchoPickupProviderReady(
  echoControl: EchoControlProvider
): Promise<void> {
  const metadata = echoControl.describe();
  const health = await echoControl.checkHealth();

  if (!health.ok) {
    throw new Error(`pico voice echo pickup AEC provider is unhealthy: ${health.message}`);
  }

  if (metadata.mode === "aec" && metadata.provider === "half_duplex") {
    throw new Error("pico voice echo pickup mode aec cannot use half_duplex provider");
  }
}

function classifyVoiceEchoPickupAcceptance(
  provider: EchoControlProviderKind,
  echoAction: "pass" | "suppress",
  wouldTriggerSession: boolean
): VoiceEchoPickupAcceptance {
  if (wouldTriggerSession) {
    return "fail";
  }

  return provider !== "half_duplex" && echoAction === "pass" ? "aec_pass" : "safety_pass";
}

async function runVoiceEchoPickupField(
  config: PicoConfig = loadPicoConfigFromEnvironment()
): Promise<VoiceEchoPickupFieldReport> {
  const plan = buildVoiceEchoPickupFieldPlan(config);

  if (plan.status === "skip") {
    return {
      status: "skipped",
      reason: plan.reason
    };
  }

  return executeVoiceEchoPickupField(plan);
}

async function executeVoiceEchoPickupField(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>
): Promise<VoiceEchoPickupFieldReport> {
  const echoControl = createEchoControlProvider(plan);
  await assertVoiceEchoPickupProviderReady(echoControl);
  const fieldCapture = await captureVoiceEchoPickup(plan, echoControl);
  const resumedTranscript = await transcribeResumeWindow(plan, fieldCapture.resumeAudio);

  return fieldCapture.echoResult.action === "suppress"
    ? classifyVoiceEchoPickupResult({
        provider: fieldCapture.echoResult.diagnostics.provider,
        echoAction: "suppress",
        transcriptText: "",
        transcriptLength: 0,
        resumedTranscriptText: resumedTranscript,
        resumedTranscriptLength: resumedTranscript.length,
        triggerPhrases: plan.triggerPhrases
      })
    : transcribeAllowedEchoFrame(
        plan,
        fieldCapture.echoResult.frame.audio,
        resumedTranscript,
        fieldCapture.echoResult.diagnostics.provider
      );
}

async function captureVoiceEchoPickup(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>,
  echoControl: EchoControlProvider
): Promise<{
  readonly echoResult: EchoControlResult;
  readonly resumeAudio: Uint8Array;
}> {
  const artifactDirectory = resolveFieldArtifactDirectory(
    process.env.PICO_FIELD_VOICE_ARTIFACT_DIR
  );
  await mkdir(artifactDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const ttsPath = join(artifactDirectory, `${timestamp}-tts.wav`);
  const micPath = join(artifactDirectory, `${timestamp}-mic.pcm`);
  const resumePath = join(artifactDirectory, `${timestamp}-resume.pcm`);
  const tts = await synthesizeFieldPrompt(plan);
  await writeFile(ttsPath, encodePcm16leWav(tts.audio, tts.sampleRateHz, tts.channels));

  const recordSeconds =
    readPositiveInteger(process.env.PICO_FIELD_RECORD_SECONDS, "PICO_FIELD_RECORD_SECONDS") ??
    defaultRecordSeconds;
  const playbackDelayMs =
    readPositiveInteger(process.env.PICO_FIELD_PLAYBACK_DELAY_MS, "PICO_FIELD_PLAYBACK_DELAY_MS") ??
    defaultPlaybackDelayMs;
  const microphoneInput = resolveMicrophoneInput();
  const playbackStartedAt = await recordMicrophoneWhilePlaying({
    micPath,
    recordSeconds,
    playbackDelayMs,
    microphoneInput,
    playbackCommand: resolvePlaybackCommand(ttsPath, microphoneInput),
    sampleRateHz: plan.echoControl.sampleRateHz,
    channels: plan.echoControl.channels
  });
  await delay(plan.echoControl.tailMuteMs);
  await recordMicrophone({
    micPath: resumePath,
    recordSeconds:
      readPositiveInteger(process.env.PICO_FIELD_RESUME_SECONDS, "PICO_FIELD_RESUME_SECONDS") ?? 2,
    microphoneInput,
    sampleRateHz: plan.echoControl.sampleRateHz,
    channels: plan.echoControl.channels
  });

  const microphoneAudio = new Uint8Array(await readFile(micPath));
  const resumeAudio = new Uint8Array(await readFile(resumePath));
  await echoControl.acceptFarEndReference(
    defineVoicePcmFrame({
      id: "field-tts",
      direction: "far_end",
      audio: tts.audio,
      encoding: "pcm16le",
      sampleRateHz: tts.sampleRateHz,
      channels: tts.channels,
      capturedAt: playbackStartedAt,
      durationMs: tts.durationMs
    })
  );
  const echoResult = await echoControl.processNearEnd(
    defineVoicePcmFrame({
      id: "field-mic",
      direction: "near_end",
      audio: microphoneAudio,
      encoding: "pcm16le",
      sampleRateHz: plan.echoControl.sampleRateHz,
      channels: plan.echoControl.channels,
      capturedAt: playbackStartedAt,
      durationMs: recordSeconds * 1000
    })
  );

  return {
    echoResult,
    resumeAudio
  };
}

async function transcribeAllowedEchoFrame(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>,
  audio: Uint8Array,
  resumedTranscript: string,
  provider: EchoControlProviderKind
): Promise<VoiceEchoPickupFieldReport> {
  const sttResult = await createFieldSttClient(plan).transcribe(
    buildSttRequest(audio, plan.echoControl)
  );

  if (!sttResult.ok) {
    return {
      status: "failed",
      reason: `pico voice echo pickup STT failed: ${sttResult.reason}: ${sttResult.message}`
    };
  }

  return classifyVoiceEchoPickupResult({
    provider,
    echoAction: "pass",
    transcriptText: sttResult.text,
    transcriptLength: sttResult.text.length,
    resumedTranscriptText: resumedTranscript,
    resumedTranscriptLength: resumedTranscript.length,
    triggerPhrases: plan.triggerPhrases
  });
}

function includesTriggerPhrase(text: string, triggerPhrases: readonly string[]): boolean {
  const normalized = text.toLowerCase();

  return triggerPhrases.some((phrase) => {
    const trigger = phrase.trim().toLowerCase();
    return trigger !== "" && normalized.includes(trigger);
  });
}

async function transcribeResumeWindow(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>,
  audio: Uint8Array
): Promise<string> {
  const result = await createFieldSttClient(plan).transcribe(
    buildSttRequest(audio, plan.echoControl)
  );

  if (!result.ok) {
    throw new Error(
      `pico voice echo pickup resume STT failed: ${result.reason}: ${result.message}`
    );
  }

  return result.text;
}

function createFieldSttClient(plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>) {
  return createMlxWhisperSttClient(
    defineMlxWhisperSidecar({
      id: plan.stt.id ?? "local-mlx-whisper",
      provider: "mlx-whisper",
      localBaseUrl: plan.stt.localBaseUrl,
      modelRepo: plan.stt.modelRepo ?? defaultMlxWhisperModelRepo,
      language: plan.stt.language ?? defaultLanguage,
      timeoutMs: plan.stt.timeoutMs ?? defaultTimeoutMs,
      warmup: {
        audioSeconds: plan.stt.warmupAudioSeconds ?? defaultWarmupAudioSeconds
      }
    })
  );
}

async function synthesizeFieldPrompt(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>
): Promise<{
  readonly audio: Uint8Array;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly durationMs: number;
}> {
  const result = await createAivisSpeechTtsClient(
    defineAivisSpeechService({
      id: plan.tts.id ?? "local-aivis",
      provider: "aivis-speech",
      localBaseUrl: plan.tts.localBaseUrl,
      speakerId: plan.tts.speakerId,
      timeoutMs: plan.tts.timeoutMs ?? defaultTimeoutMs
    })
  ).synthesize({
    text: process.env.PICO_FIELD_TTS_TEXT ?? plan.tts.text ?? defaultText
  });

  if (!result.ok) {
    throw new Error(
      `pico voice echo pickup TTS failed at sentence ${result.sentenceIndex}: ${result.reason}: ${result.message}`
    );
  }

  if (result.chunks.length === 0) {
    throw new Error("pico voice echo pickup TTS produced no audio");
  }

  const [first] = result.chunks as readonly [TtsAudioChunk, ...TtsAudioChunk[]];

  const audio = concatenateAudio(result.chunks.map((chunk) => chunk.audio));

  return {
    audio,
    sampleRateHz: first.sampleRateHz,
    channels: first.channels,
    durationMs: result.totalDurationMs
  };
}

function createEchoControlProvider(
  plan: Extract<VoiceEchoPickupFieldPlan, { readonly status: "run" }>
): EchoControlProvider {
  if (plan.echoControl.mode === "half_duplex") {
    return createHalfDuplexEchoControl({
      tailMuteMs: plan.echoControl.tailMuteMs
    });
  }

  if (plan.echoControl.provider === undefined || plan.echoControl.providerEndpoint === undefined) {
    throw new Error("pico voice echo pickup requires an explicit echo-control provider endpoint");
  }

  if (plan.echoControl.provider === "half_duplex") {
    throw new Error("pico voice echo pickup HTTP provider cannot be half_duplex");
  }

  return createHttpEchoControlProvider({
    provider: plan.echoControl.provider,
    mode: plan.echoControl.mode,
    providerEndpoint: plan.echoControl.providerEndpoint
  });
}

function buildSttRequest(
  audio: Uint8Array,
  echoControl: PicoConfig["voice"]["echoControl"]
): SttTranscriptionRequest {
  return {
    audio,
    encoding: "pcm16le",
    sampleRateHz: echoControl.sampleRateHz,
    channels: echoControl.channels
  };
}

async function recordMicrophoneWhilePlaying(input: {
  readonly micPath: string;
  readonly recordSeconds: number;
  readonly playbackDelayMs: number;
  readonly microphoneInput: MicrophoneInput;
  readonly playbackCommand: PlaybackCommand;
  readonly sampleRateHz: number;
  readonly channels: number;
}): Promise<string> {
  const ffmpeg = spawnMicrophoneRecorder(input);

  await delay(input.playbackDelayMs);
  const playbackStartedAt = new Date().toISOString();
  const playback = spawnSync(input.playbackCommand.command, input.playbackCommand.args, {
    encoding: "utf8"
  });

  if (playback.status !== 0) {
    await terminateProcess(ffmpeg);
    throw new Error(
      `pico voice echo pickup playback failed with ${input.playbackCommand.command}: ${playback.stderr.trim()}`
    );
  }

  await waitForProcess(ffmpeg, "pico voice echo pickup microphone recording failed");

  return playbackStartedAt;
}

async function recordMicrophone(input: {
  readonly micPath: string;
  readonly recordSeconds: number;
  readonly microphoneInput: MicrophoneInput;
  readonly sampleRateHz: number;
  readonly channels: number;
}): Promise<void> {
  await waitForProcess(
    spawnMicrophoneRecorder(input),
    "pico voice echo pickup resume microphone recording failed"
  );
}

function spawnMicrophoneRecorder(input: {
  readonly micPath: string;
  readonly recordSeconds: number;
  readonly microphoneInput: MicrophoneInput;
  readonly sampleRateHz: number;
  readonly channels: number;
}): ReturnType<typeof spawn> {
  return spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      input.microphoneInput.format,
      "-i",
      input.microphoneInput.device,
      "-t",
      String(input.recordSeconds),
      "-ac",
      String(input.channels),
      "-ar",
      String(input.sampleRateHz),
      "-f",
      "s16le",
      input.micPath
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

type MicrophoneInput = {
  readonly format: "alsa" | "avfoundation" | "pulse";
  readonly device: string;
};

type PlaybackCommand = {
  readonly command: "afplay" | "aplay" | "paplay";
  readonly args: readonly string[];
};

function resolveMicrophoneInput(): MicrophoneInput {
  if (process.platform === "darwin") {
    return {
      format: "avfoundation",
      device: process.env.PICO_FIELD_MIC_DEVICE ?? defaultMacMicrophoneDevice
    };
  }

  if (process.platform === "linux") {
    return {
      format: readLinuxMicrophoneFormat(process.env.PICO_FIELD_MIC_FORMAT),
      device: process.env.PICO_FIELD_MIC_DEVICE ?? defaultLinuxMicrophoneDevice
    };
  }

  throw new Error(`pico voice echo pickup unsupported platform: ${process.platform}`);
}

function resolvePlaybackCommand(
  ttsPath: string,
  microphoneInput: MicrophoneInput
): PlaybackCommand {
  if (process.platform === "darwin") {
    return {
      command: "afplay",
      args: [ttsPath]
    };
  }

  if (process.platform === "linux" && microphoneInput.format === "pulse") {
    return {
      command: "paplay",
      args: [ttsPath]
    };
  }

  if (process.platform === "linux") {
    return {
      command: "aplay",
      args: [ttsPath]
    };
  }

  throw new Error(`pico voice echo pickup unsupported platform: ${process.platform}`);
}

function readLinuxMicrophoneFormat(value: string | undefined): "alsa" | "pulse" {
  if (value === undefined || value === "alsa") {
    return "alsa";
  }

  if (value === "pulse") {
    return "pulse";
  }

  throw new Error("PICO_FIELD_MIC_FORMAT must be alsa or pulse");
}

function waitForProcess(process_: ReturnType<typeof spawn>, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    process_.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    process_.once("error", reject);
    process_.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${message}: ${stderr.trim()}`));
    });
  });
}

function terminateProcess(process_: ReturnType<typeof spawn>): Promise<void> {
  if (process_.exitCode !== null || process_.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    process_.once("close", () => {
      resolve();
    });

    if (!process_.kill("SIGTERM")) {
      resolve();
    }
  });
}

function encodePcm16leWav(audio: Uint8Array, sampleRateHz: number, channels: number): Buffer {
  const dataSize = audio.byteLength;
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(audio)]);
}

function concatenateAudio(chunks: readonly Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function readPositiveInteger(value: string | undefined, variableName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${variableName} must be a positive integer`);
  }

  return parsed;
}

function resolveFieldArtifactDirectory(value: string | undefined): string {
  const directory = resolve(value ?? defaultArtifactDirectory);
  const privateRoot = resolve(".pico-local");
  const relativePath = relative(privateRoot, directory);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return directory;
  }

  throw new Error("PICO_FIELD_VOICE_ARTIFACT_DIR must be inside .pico-local");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const report = await runVoiceEchoPickupField();
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
    process.exitCode = voiceEchoPickupFieldExitCode(report);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
