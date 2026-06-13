#!/usr/bin/env jiti
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  openLongMemoryStore,
  openSessionMemoryCandidateStore,
  type SessionMemoryCutoffInput
} from "../../src/modules/long-memory/index.js";
import { type CameraVlmSceneSmokeReport, runCameraVlmSceneSmoke } from "./camera-vlm-scene.js";
import { type Mem0RuntimeSmokeReport, runMem0RuntimeSmoke } from "./mem0-runtime.js";
import {
  type OllamaVlmSmokeReport,
  runOllamaVlmConnectivitySmoke
} from "./ollama-vlm-connectivity.js";
import { type PersonDetectionSmokeReport, runPersonDetectionSmoke } from "./person-detection.js";
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
  | "tapo_snapshot"
  | "tapo_ptz"
  | "person_detection"
  | "ollama_vlm"
  | "camera_vlm_scene"
  | "mem0_runtime"
  | "memory_candidate"
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
  readonly runPiRuntimeCommand?: (env: NodeJS.ProcessEnv) => PiRuntimeSmokeCommandResult;
  readonly runVoiceProviderSmoke?: (config: PicoConfig) => Promise<VoiceSmokeReport>;
  readonly runTapoRtspSnapshotSmoke?: (config: PicoConfig) => Promise<TapoRtspSmokeReport>;
  readonly runTapoPersonFollowSmoke?: (
    config: PicoConfig,
    env: NodeJS.ProcessEnv
  ) => Promise<TapoPersonFollowSmokeReport>;
  readonly runPersonDetectionSmoke?: (config: PicoConfig) => Promise<PersonDetectionSmokeReport>;
  readonly runOllamaVlmConnectivitySmoke?: (config: PicoConfig) => Promise<OllamaVlmSmokeReport>;
  readonly runCameraVlmSceneSmoke?: (config: PicoConfig) => Promise<CameraVlmSceneSmokeReport>;
  readonly runMem0RuntimeSmoke?: (config: PicoConfig) => Promise<Mem0RuntimeSmokeReport>;
  readonly createAuditOtelExporter?: (
    config: Required<PicoConfig["audit"]["otel"]>
  ) => OpenTelemetryAuditExporter;
};

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const missingPiCredentialsPattern = /requires configured Pi Agent model credentials/i;
const completedSession = {
  sessionId: "milestone-session-2026-06-10",
  cutoffAt: "2026-06-10T18:30:00.000Z",
  sourceEntryIds: ["milestone-memory-1", "milestone-memory-2"],
  entries: [
    {
      id: "milestone-memory-1",
      role: "staff",
      content: "雨の日は工作セットを早めに準備すると活動へ入りやすい。"
    },
    {
      id: "milestone-memory-2",
      role: "assistant",
      content: "次の雨の日も工作セットを先に準備する候補として扱う。"
    }
  ],
  requestedBy: "pico"
} as const satisfies SessionMemoryCutoffInput;

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
    sections.push(...(await runMemoryAndAuditSections()));

    return {
      status: summarizeStatus(sections),
      sections
    };
  }

  sections.push(
    ...(await runVoiceSections(dependencies.runVoiceProviderSmoke ?? runVoiceProviderSmoke, config))
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
  sections.push(
    await captureSection("mem0_runtime", "mem0-oss", async () =>
      toSection(
        "mem0_runtime",
        await (dependencies.runMem0RuntimeSmoke ?? runMem0RuntimeSmoke)(config)
      )
    )
  );
  sections.push(...(await runMemoryAndAuditSections(config, dependencies)));

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
    failedSection("voice_stt", "mlx-whisper", reason),
    failedSection("voice_tts", "aivis-speech", reason),
    failedSection("tapo_snapshot", "tapo-rtsp", reason),
    failedSection("tapo_ptz", "tapo-onvif-ptz", reason),
    failedSection("person_detection", "tapo-rtsp+onnxruntime", reason),
    failedSection("ollama_vlm", "ollama", reason),
    failedSection("camera_vlm_scene", "tapo-rtsp+ollama", reason),
    failedSection("mem0_runtime", "mem0-oss", reason)
  ];
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
      failedSection("voice_stt", "mlx-whisper", errorMessage(error)),
      failedSection("voice_tts", "aivis-speech", errorMessage(error))
    ];
  }
}

async function runMemoryAndAuditSections(
  config?: PicoConfig,
  dependencies: Pick<PicoMilestoneSmokeDependencies, "createAuditOtelExporter"> = {}
): Promise<readonly PicoMilestoneSmokeSectionReport[]> {
  const directory = await mkdtemp(join(tmpdir(), "pico-milestone-smoke-"));
  const path = join(directory, "long-memory.sqlite");

  try {
    const audit = createStructuredAuditLog();
    const candidates = openSessionMemoryCandidateStore(path, {
      audit,
      now: () => "2026-06-10T18:31:00.000Z",
      processSession: () =>
        Promise.resolve([
          {
            title: "雨の日の工作準備",
            body: "雨の日は工作セットを早めに準備すると活動へ入りやすい。",
            category: "care_continuity"
          }
        ])
    });

    try {
      candidates.enqueueSessionCutoff(completedSession);
      await candidates.processNextJob();
      const promoted = candidates.promoteReviewed(1, {
        reviewedBy: "milestone-smoke",
        reviewedAt: "2026-06-10T18:35:00.000Z",
        note: "Milestone smoke reviewed memory candidate."
      });
      const auditEntries = audit.entries();
      const otelRecords = auditEntries.map(toOpenTelemetryLogRecord);
      const firstOtelRecord = validateAuditOtelRecords(auditEntries.length, otelRecords);
      const auditOtelSection = await buildAuditOtelSection(
        config,
        dependencies,
        auditEntries,
        otelRecords,
        firstOtelRecord
      );
      assertPromotedMemorySearch(path);

      return [
        {
          name: "memory_candidate",
          status: "passed",
          provider: "sqlite",
          details: {
            promotedMemoryId: promoted.id,
            category: promoted.category
          }
        },
        auditOtelSection
      ];
    } finally {
      candidates.close();
    }
  } catch (error) {
    return [
      failedSection("memory_candidate", "sqlite", errorMessage(error)),
      failedSection("audit_otel", "structured-audit", errorMessage(error))
    ];
  } finally {
    await rm(directory, { recursive: true, force: true });
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

  try {
    for (const event of auditEntries) {
      await exporter.export(event);
    }
  } finally {
    await exporter.shutdown();
  }

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
    assertMemoryWriteOtelRecord(record);
  }

  return firstRecord;
}

function assertMemoryWriteOtelRecord(record: OpenTelemetryAuditLogRecord): void {
  if (record.attributes["pico.audit.category"] !== "memory_write") {
    throw new Error("pico milestone smoke emitted an unexpected audit OTel category");
  }

  if (typeof record.attributes["event.name"] !== "string") {
    throw new Error("pico milestone smoke did not emit an audit event.name attribute");
  }
}

function assertPromotedMemorySearch(path: string): void {
  const memory = openLongMemoryStore(path);

  try {
    if (memory.search("工作準備").length === 0) {
      throw new Error("pico milestone smoke could not find promoted long memory");
    }
  } finally {
    memory.close();
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

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runPicoMilestoneSmokeSuite();
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = picoMilestoneSmokeExitCode(report);
}
