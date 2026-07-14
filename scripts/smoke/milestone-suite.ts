#!/usr/bin/env jiti
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import {
  type AuditEvent,
  createStructuredAuditLog,
  type OpenTelemetryAuditLogRecord,
  toOpenTelemetryLogRecord
} from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryAuditExporter,
  type OpenTelemetryAuditExporter
} from "../../src/modules/audit/otel.js";
import { type CameraVlmSceneSmokeReport, runCameraVlmSceneSmoke } from "./camera-vlm-scene.js";
import {
  type OllamaVlmSmokeReport,
  runOllamaVlmConnectivitySmoke
} from "./ollama-vlm-connectivity.js";
import { type PersonDetectionSmokeReport, runPersonDetectionSmoke } from "./person-detection.js";
import {
  type ResidentAudioInputSmokeReport,
  runResidentAudioInputSmoke
} from "./resident-audio-input.js";
import {
  runTapoPersonFollowSmoke,
  type TapoPersonFollowSmokeReport
} from "./tapo-person-follow-nudge.js";
import { runTapoRtspSnapshotSmoke, type TapoRtspSmokeReport } from "./tapo-rtsp-snapshot.js";
import { runVoiceProviderSmoke, type VoiceSmokeReport } from "./voice-providers.js";

export type PicoMilestoneSmokeStatus = "passed" | "failed" | "skipped";

export type PicoMilestoneSmokeSectionName =
  | "pi_runtime"
  | "voice_stt"
  | "voice_tts"
  | "resident_audio_input"
  | "tapo_snapshot"
  | "tapo_ptz"
  | "person_detection"
  | "ollama_vlm"
  | "camera_vlm_scene"
  | "audit_otel";

export type PicoMilestoneSmokeSectionReport = {
  readonly name: PicoMilestoneSmokeSectionName;
  readonly status: PicoMilestoneSmokeStatus;
  readonly provider: string;
  readonly reason?: string;
  readonly details?: Record<string, unknown>;
};

export type PicoMilestoneSmokeReport = {
  readonly status: PicoMilestoneSmokeStatus;
  readonly sections: readonly PicoMilestoneSmokeSectionReport[];
};

export type PiRuntimeSmokeCommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type PicoMilestoneSmokeDependencies = {
  readonly now?: () => string;
  readonly runPiRuntimeCommand?: (env: NodeJS.ProcessEnv) => PiRuntimeSmokeCommandResult;
  readonly runVoiceProviderSmoke?: (config: PicoConfig) => Promise<VoiceSmokeReport>;
  readonly runResidentAudioInputSmoke?: (
    config: PicoConfig
  ) => Promise<ResidentAudioInputSmokeReport>;
  readonly runTapoRtspSnapshotSmoke?: (config: PicoConfig) => Promise<TapoRtspSmokeReport>;
  readonly runTapoPersonFollowSmoke?: (
    config: PicoConfig,
    env: NodeJS.ProcessEnv
  ) => Promise<TapoPersonFollowSmokeReport>;
  readonly runPersonDetectionSmoke?: (config: PicoConfig) => Promise<PersonDetectionSmokeReport>;
  readonly runOllamaVlmConnectivitySmoke?: (config: PicoConfig) => Promise<OllamaVlmSmokeReport>;
  readonly runCameraVlmSceneSmoke?: (config: PicoConfig) => Promise<CameraVlmSceneSmokeReport>;
  readonly createAuditOtelExporter?: (
    config: Required<PicoConfig["audit"]["otel"]>
  ) => OpenTelemetryAuditExporter;
};

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const missingPiCredentialsPattern = /requires configured Pi Agent model credentials/i;
export async function runPicoMilestoneSmokeSuite(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PicoMilestoneSmokeDependencies = {}
): Promise<PicoMilestoneSmokeReport> {
  const sections: PicoMilestoneSmokeSectionReport[] = [];

  sections.push(runPiRuntimeSection(dependencies.runPiRuntimeCommand ?? runPiRuntimeCommand, env));

  let config: PicoConfig;

  try {
    config = loadPicoConfigFromEnvironment(env);
  } catch (error) {
    sections.push(...failedConfigProviderSections(error));
    sections.push(auditConfigAwareSection(await runAuditSection(), error));

    return {
      status: summarizeStatus(sections),
      sections
    };
  }

  sections.push(
    ...(await runVoiceSections(dependencies.runVoiceProviderSmoke ?? runVoiceProviderSmoke, config))
  );
  sections.push(
    await captureSection("resident_audio_input", "resident-audio-input", async () =>
      toSection(
        "resident_audio_input",
        await (dependencies.runResidentAudioInputSmoke ?? runResidentAudioInputSmoke)(config)
      )
    )
  );
  sections.push(
    await captureSection("tapo_snapshot", "tapo-rtsp", async () =>
      toSection(
        "tapo_snapshot",
        await (dependencies.runTapoRtspSnapshotSmoke ?? runTapoRtspSnapshotSmoke)(config)
      )
    )
  );
  sections.push(
    await captureSection("tapo_ptz", "tapo-onvif-ptz", async () =>
      toSection(
        "tapo_ptz",
        await (dependencies.runTapoPersonFollowSmoke ?? runTapoPersonFollowSmoke)(config, env)
      )
    )
  );
  sections.push(
    await captureSection("person_detection", "tapo-rtsp+onnxruntime", async () =>
      toSection(
        "person_detection",
        await (dependencies.runPersonDetectionSmoke ?? runPersonDetectionSmoke)(config)
      )
    )
  );
  sections.push(
    await captureSection("ollama_vlm", "ollama", async () =>
      toSection(
        "ollama_vlm",
        await (dependencies.runOllamaVlmConnectivitySmoke ?? runOllamaVlmConnectivitySmoke)(config)
      )
    )
  );
  sections.push(
    await captureSection("camera_vlm_scene", "tapo-rtsp+ollama", async () =>
      toSection(
        "camera_vlm_scene",
        await (dependencies.runCameraVlmSceneSmoke ?? runCameraVlmSceneSmoke)(config)
      )
    )
  );
  sections.push(await runAuditSection(config, dependencies));

  return {
    status: summarizeStatus(sections),
    sections
  };
}

export function picoMilestoneSmokeExitCode(report: PicoMilestoneSmokeReport): number {
  return report.status === "failed" ? 1 : 0;
}

function runPiRuntimeCommand(env: NodeJS.ProcessEnv): PiRuntimeSmokeCommandResult {
  const result = spawnSync("npm", ["run", "smoke:pi-runtime", "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
    timeout: 70_000
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function runPiRuntimeSection(
  runCommand: (env: NodeJS.ProcessEnv) => PiRuntimeSmokeCommandResult,
  env: NodeJS.ProcessEnv
): PicoMilestoneSmokeSectionReport {
  try {
    return mapPiRuntimeCommandResult(runCommand(env));
  } catch (error) {
    return failedSection("pi_runtime", "pi", errorMessage(error));
  }
}

function mapPiRuntimeCommandResult(
  result: PiRuntimeSmokeCommandResult
): PicoMilestoneSmokeSectionReport {
  const output = [result.stdout, result.stderr].filter((value) => value !== "").join("\n");

  if (result.status === 0 && isPicoRuntimeLoaded(result.stdout)) {
    return {
      name: "pi_runtime",
      status: "passed",
      provider: "pi",
      details: {
        identity: "pico"
      }
    };
  }

  if (result.status === 2 && missingPiCredentialsPattern.test(output)) {
    return {
      name: "pi_runtime",
      status: "skipped",
      provider: "pi",
      reason: output
    };
  }

  return {
    name: "pi_runtime",
    status: "failed",
    provider: "pi",
    reason:
      output === "" ? `pico Pi runtime smoke exited with status ${String(result.status)}` : output
  };
}

function isPicoRuntimeLoaded(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as { readonly loaded?: unknown; readonly identity?: unknown };

    return parsed.loaded === true && parsed.identity === "pico";
  } catch {
    return false;
  }
}

function failedConfigProviderSections(error: unknown): readonly PicoMilestoneSmokeSectionReport[] {
  const reason = `pico config load failed: ${errorMessage(error)}`;

  return [
    failedSection("voice_stt", "apple-speech", reason),
    failedSection("voice_tts", "aivis-speech", reason),
    failedSection("resident_audio_input", "resident-audio-input", reason),
    failedSection("tapo_snapshot", "tapo-rtsp", reason),
    failedSection("tapo_ptz", "tapo-onvif-ptz", reason),
    failedSection("person_detection", "tapo-rtsp+onnxruntime", reason),
    failedSection("ollama_vlm", "ollama", reason),
    failedSection("camera_vlm_scene", "tapo-rtsp+ollama", reason)
  ];
}

function auditConfigAwareSection(
  section: PicoMilestoneSmokeSectionReport,
  error: unknown
): PicoMilestoneSmokeSectionReport {
  if (!isAuditOtelConfigError(error)) {
    return section;
  }

  const reason = `pico config load failed: ${errorMessage(error)}`;

  return failedSection("audit_otel", "structured-audit+otel", reason);
}

function isAuditOtelConfigError(error: unknown): boolean {
  return errorMessage(error).includes("pico config audit.otel.");
}

async function runVoiceSections(
  runVoice: (config: PicoConfig) => Promise<VoiceSmokeReport>,
  config: PicoConfig
): Promise<readonly PicoMilestoneSmokeSectionReport[]> {
  try {
    const report = await runVoice(config);

    return [toSection("voice_stt", report.stt), toSection("voice_tts", report.tts)];
  } catch (error) {
    return [
      failedSection("voice_stt", "apple-speech", errorMessage(error)),
      failedSection("voice_tts", "aivis-speech", errorMessage(error))
    ];
  }
}

async function runAuditSection(
  config?: PicoConfig,
  dependencies: Pick<PicoMilestoneSmokeDependencies, "createAuditOtelExporter" | "now"> = {}
): Promise<PicoMilestoneSmokeSectionReport> {
  try {
    const audit = createStructuredAuditLog();
    audit.record({
      category: "session_lifecycle",
      name: "session.started",
      severity: "info",
      occurredAt: dependencies.now?.() ?? new Date().toISOString(),
      summary: "Pico interaction session started.",
      attributes: { source: "milestone_smoke" }
    });
    const auditEntries = audit.entries();
    return await captureSection("audit_otel", auditOtelProviderName(config), async () => {
      const otelRecords = auditEntries.map(toOpenTelemetryLogRecord);
      const firstOtelRecord = validateAuditOtelRecords(auditEntries.length, otelRecords);

      return buildAuditOtelSection(
        config,
        dependencies,
        auditEntries,
        otelRecords,
        firstOtelRecord
      );
    });
  } catch (error) {
    return failedSection("audit_otel", "structured-audit", errorMessage(error));
  }
}

async function buildAuditOtelSection(
  config: PicoConfig | undefined,
  dependencies: Pick<PicoMilestoneSmokeDependencies, "createAuditOtelExporter">,
  auditEntries: readonly AuditEvent[],
  otelRecords: readonly OpenTelemetryAuditLogRecord[],
  firstOtelRecord: OpenTelemetryAuditLogRecord
): Promise<PicoMilestoneSmokeSectionReport> {
  const baseDetails = {
    category: firstOtelRecord.attributes["pico.audit.category"],
    eventName: firstOtelRecord.attributes["event.name"],
    eventCount: auditEntries.length,
    otelRecordCount: otelRecords.length
  };
  const otelConfig = config?.audit.otel;

  if (otelConfig?.enabled !== true) {
    return passedStructuredAuditSection(baseDetails);
  }

  return exportAuditOtelSection(otelConfig, dependencies, auditEntries, baseDetails);
}

function passedStructuredAuditSection(
  details: Record<string, unknown>
): PicoMilestoneSmokeSectionReport {
  return {
    name: "audit_otel",
    status: "passed",
    provider: "structured-audit",
    details
  };
}

function auditOtelProviderName(
  config: PicoConfig | undefined
): "structured-audit" | "structured-audit+otel" {
  return config?.audit.otel.enabled === true ? "structured-audit+otel" : "structured-audit";
}

async function exportAuditOtelSection(
  otelConfig: PicoConfig["audit"]["otel"],
  dependencies: Pick<PicoMilestoneSmokeDependencies, "createAuditOtelExporter">,
  auditEntries: readonly AuditEvent[],
  baseDetails: Record<string, unknown>
): Promise<PicoMilestoneSmokeSectionReport> {
  const requiredOtelConfig = {
    enabled: true,
    endpoint: requireAuditOtelEndpoint(otelConfig.endpoint),
    serviceName: otelConfig.serviceName ?? "pico",
    timeoutMs: otelConfig.timeoutMs ?? 10_000
  } as const;
  const exporter =
    dependencies.createAuditOtelExporter?.(requiredOtelConfig) ??
    createOpenTelemetryAuditExporter(requiredOtelConfig);

  await exportAuditEvents(exporter, auditEntries);

  return {
    name: "audit_otel",
    status: "passed",
    provider: "structured-audit+otel",
    details: {
      ...baseDetails,
      endpoint: requiredOtelConfig.endpoint,
      exportedOtelRecordCount: auditEntries.length
    }
  };
}

async function exportAuditEvents(
  exporter: OpenTelemetryAuditExporter,
  auditEntries: readonly AuditEvent[]
): Promise<void> {
  let primaryError: Error | undefined;

  try {
    for (const event of auditEntries) {
      await exporter.export(event);
    }
  } catch (error) {
    primaryError = toError(error);
  }

  const shutdownError = await shutdownAuditExporterSafely(exporter);

  if (primaryError !== undefined) {
    if (shutdownError !== undefined) {
      throw errorWithSecondary(primaryError, "shutdown", shutdownError);
    }

    throw primaryError;
  }

  if (shutdownError !== undefined) {
    throw shutdownError;
  }
}

async function shutdownAuditExporterSafely(
  exporter: OpenTelemetryAuditExporter
): Promise<Error | undefined> {
  try {
    await exporter.shutdown();

    return undefined;
  } catch (error) {
    return toError(error);
  }
}

function requireAuditOtelEndpoint(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("pico milestone smoke audit OTel endpoint is required");
  }

  return value;
}

function validateAuditOtelRecords(
  eventCount: number,
  records: readonly OpenTelemetryAuditLogRecord[]
): OpenTelemetryAuditLogRecord {
  const firstRecord = records[0];

  if (eventCount === 0 || firstRecord === undefined) {
    throw new Error("pico milestone smoke did not emit any audit OTel records");
  }

  if (records.length !== eventCount) {
    throw new Error("pico milestone smoke emitted mismatched audit OTel record counts");
  }

  for (const record of records) {
    assertAuditOtelRecord(record);
  }

  return firstRecord;
}

function assertAuditOtelRecord(record: OpenTelemetryAuditLogRecord): void {
  if (record.attributes["pico.audit.category"] !== "session_lifecycle") {
    throw new Error("pico milestone smoke emitted an unexpected audit OTel category");
  }

  if (typeof record.attributes["event.name"] !== "string") {
    throw new Error("pico milestone smoke did not emit an audit event.name attribute");
  }
}

async function captureSection(
  name: PicoMilestoneSmokeSectionName,
  provider: string,
  run: () => Promise<PicoMilestoneSmokeSectionReport>
): Promise<PicoMilestoneSmokeSectionReport> {
  try {
    return await run();
  } catch (error) {
    return failedSection(name, provider, errorMessage(error));
  }
}

function toSection(
  name: PicoMilestoneSmokeSectionName,
  report: {
    readonly status: PicoMilestoneSmokeStatus;
    readonly provider: string;
    readonly reason?: string;
    readonly details?: Record<string, unknown>;
  }
): PicoMilestoneSmokeSectionReport {
  return {
    name,
    status: report.status,
    provider: report.provider,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    ...(report.details === undefined ? {} : { details: report.details })
  };
}

function failedSection(
  name: PicoMilestoneSmokeSectionName,
  provider: string,
  reason: string
): PicoMilestoneSmokeSectionReport {
  return {
    name,
    status: "failed",
    provider,
    reason
  };
}

function summarizeStatus(
  sections: readonly PicoMilestoneSmokeSectionReport[]
): PicoMilestoneSmokeStatus {
  if (sections.some((section) => section.status === "failed")) {
    return "failed";
  }

  if (sections.some((section) => section.status === "skipped")) {
    return "skipped";
  }

  return "passed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorWithSecondary(primary: Error, label: string, secondary: Error): Error {
  return new Error(`${primary.message}; ${label} also failed: ${secondary.message}`, {
    cause: primary
  });
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runPicoMilestoneSmokeSuite();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = picoMilestoneSmokeExitCode(report);
}
