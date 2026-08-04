#!/usr/bin/env jiti
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import type { BuildOptions, BuildResult } from "esbuild";

import {
  evaluateStackChanAttentionReplayAcceptance,
  hashStackChanAttentionReplayProducerSources,
  STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES,
  type StackChanAttentionReplayAcceptanceVerdict,
  type StackChanAttentionReplayContractSourceHashes,
  type StackChanAttentionReplayProducerSourceRole,
  type StackChanAttentionReplayReport,
  validateStackChanAttentionReplayReport,
  verifyQualifiedReplayAgainstFreshCurrentProducer
} from "./stackchan-attention-replay.js";
import {
  parseJsonRejectingDuplicateKeys,
  stackChanAttentionReplayEventSchemaHash,
  stackChanAttentionReplaySchemaHash
} from "./stackchan-attention-replay-schema.js";

const execFileAsync = promisify(execFile);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SECRETLINT_EXECUTABLE = join(PROJECT_ROOT, "node_modules/.bin/secretlint");
const SECRETLINT_CONFIG = join(PROJECT_ROOT, ".secretlintrc.json");
const START_SCOPE_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 5;

const sourceArtifacts = {
  picoController: "source/pico/attention-controller.ts",
  picoTargetCenterFilter: "source/pico/target-center-filter.ts",
  picoRuntime: "source/pico/stackchan-attention-runtime.ts",
  picoAttentionDetection: "source/pico/attention-detection.ts",
  replayLanePolicy: "source/gate/stackchan-attention-replay-lane-policy.ts",
  replayLanePolicyTest: "source/gate/tests/stackchan-attention-replay-lane-policy.test.ts",
  gatewayLane: "source/gateway/head_target_lane.py",
  gatewayLaneTest: "source/gateway/tests/test_head_target_lane.py"
} as const;

const candidateMutableArtifacts = [
  sourceArtifacts.replayLanePolicy,
  sourceArtifacts.replayLanePolicyTest,
  sourceArtifacts.gatewayLane,
  sourceArtifacts.gatewayLaneTest
] as const;

const gateArtifacts = {
  replayProducer: "source/gate/stackchan-attention-replay.ts",
  attentionMetrics: "source/gate/stackchan-attention-metrics.ts",
  replayEvidenceBuilder: "source/gate/stackchan-attention-replay-evidence.ts",
  replayReportSchema: "source/gate/stackchan-attention-replay-report.schema.json",
  replaySchema: "source/gate/stackchan-attention-replay-schema.ts",
  replayGateTest: "source/gate/tests/stackchan-attention-replay-gate.test.ts",
  replayFieldTest: "source/gate/tests/stackchan-attention-replay-field.test.ts",
  replayEvidenceTest: "source/gate/tests/stackchan-attention-replay-evidence.test.ts",
  packageJson: "source/gate/package.json",
  packageLock: "source/gate/package-lock.json",
  gatewayPackageInit: "source/gateway/stackchan_mcp/__init__.py",
  gatewayWifiPowerSave: "source/gateway/stackchan_mcp/wifi_power_save.py",
  gatewayPyproject: "source/gateway/pyproject.toml",
  gatewayUvLock: "source/gateway/uv.lock"
} as const;

const reportArtifacts = {
  comparisonBaseline: "reports/comparison-baseline.json",
  acceptanceVerdict: "reports/acceptance-verdict.json",
  qualified: "reports/qualified-current.json",
  qualifiedFreshRerun: "reports/qualified-fresh-rerun.json",
  normalizedBefore: "reports/normalized-before.json",
  normalizedAfter: "reports/normalized-after.json"
} as const;

const portableArtifacts = {
  verifier: "verify-evidence.mjs",
  replayReportSchema: "stackchan-attention-replay-report.schema.json"
} as const;

const logArtifacts = {
  focusedPico: "logs/focused-pico.log",
  fullPico: "logs/full-pico.log",
  gateway: "logs/gateway.log",
  secretlint: "logs/secretlint.log",
  diffCheck: "logs/diff-check.log"
} as const;

const inputArtifacts = {
  qualificationStartAttestation: "inputs/qualification-start-attestation.json",
  comparisonContract: "inputs/comparison-contract.json"
} as const;

const gitInspectionArtifacts = {
  pico: "observations/pico-git-inspection.json",
  gateway: "observations/gateway-git-inspection.json"
} as const;

const productionRelativePaths = {
  picoController: "src/modules/stackchan/attention-controller.ts",
  picoTargetCenterFilter: "src/modules/stackchan/target-center-filter.ts",
  picoRuntime: "src/runtime/stackchan-attention-runtime.ts",
  picoAttentionDetection: "src/modules/vision/attention-detection.ts",
  gatewayLane: "gateway/stackchan_mcp/head_target_lane.py",
  gatewayLaneTest: "gateway/tests/test_head_target_lane.py",
  gatewayPackageInit: "gateway/stackchan_mcp/__init__.py",
  gatewayWifiPowerSave: "gateway/stackchan_mcp/wifi_power_save.py",
  gatewayPyproject: "gateway/pyproject.toml",
  gatewayUvLock: "gateway/uv.lock"
} as const;

const gateRelativePaths = {
  replayProducer: "scripts/field/stackchan-attention-replay.ts",
  attentionMetrics: "scripts/field/stackchan-attention-metrics.ts",
  replayLanePolicy: "scripts/field/stackchan-attention-replay-lane-policy.ts",
  replayLanePolicyTest: "tests/stackchan-attention-replay-lane-policy.test.ts",
  replayEvidenceBuilder: "scripts/field/stackchan-attention-replay-evidence.ts",
  replayReportSchema: "scripts/field/stackchan-attention-replay-report.schema.json",
  replaySchema: "scripts/field/stackchan-attention-replay-schema.ts",
  replayGateTest: "tests/stackchan-attention-replay-gate.test.ts",
  replayFieldTest: "tests/stackchan-attention-replay-field.test.ts",
  replayEvidenceTest: "tests/stackchan-attention-replay-evidence.test.ts",
  packageJson: "package.json",
  packageLock: "package-lock.json"
} as const;

const attestedSourcePaths = {
  pico: [
    productionRelativePaths.picoController,
    productionRelativePaths.picoTargetCenterFilter,
    productionRelativePaths.picoRuntime,
    productionRelativePaths.picoAttentionDetection,
    ...Object.values(gateRelativePaths)
  ],
  gateway: [
    productionRelativePaths.gatewayLane,
    productionRelativePaths.gatewayLaneTest,
    productionRelativePaths.gatewayPackageInit,
    productionRelativePaths.gatewayWifiPowerSave,
    productionRelativePaths.gatewayPyproject,
    productionRelativePaths.gatewayUvLock
  ]
} as const;

export type StackChanAttentionReplayEvidenceOptions = {
  readonly outputArchive: string;
  readonly stagingDirectory: string;
  readonly comparisonBaselineReport: string;
  readonly expectedComparisonBaselineSha256: string;
  readonly comparisonContract: string;
  readonly expectedComparisonContractSha256: string;
  readonly qualifiedReport: string;
  readonly normalizedBeforeReport: string;
  readonly normalizedAfterReport: string;
  readonly picoControllerSource: string;
  readonly picoTargetCenterFilterSource: string;
  readonly picoRuntimeSource: string;
  readonly picoAttentionDetectionSource: string;
  readonly gatewayLaneSource: string;
  readonly gatewayLaneTestSource: string;
  readonly gatewayPackageInitSource: string;
  readonly gatewayWifiPowerSaveSource: string;
  readonly gatewayPyprojectSource: string;
  readonly gatewayUvLockSource: string;
  readonly replayProducerSource: string;
  readonly attentionMetricsSource: string;
  readonly replayLanePolicySource: string;
  readonly replayLanePolicyTestSource: string;
  readonly replayEvidenceBuilderSource: string;
  readonly replayReportSchemaSource: string;
  readonly replaySchemaSource: string;
  readonly replayGateTestSource: string;
  readonly replayFieldTestSource: string;
  readonly replayEvidenceTestSource: string;
  readonly focusedPicoLog: string;
  readonly fullPicoLog: string;
  readonly gatewayLog: string;
  readonly secretlintLog: string;
  readonly diffCheckLog: string;
  readonly qualificationStartAttestation: string;
  readonly expectedStartAttestationSha256: string;
};

export type StackChanAttentionReplayEvidenceBuildResult = {
  readonly outputArchive: string;
  readonly stagingDirectory: string;
  readonly archiveSha256: string;
};

export type StackChanAttentionReplayQualificationStartOptions = {
  readonly outputPath: string;
  readonly qualificationId: string;
  readonly capturedAtUtc: string;
  readonly picoWorktree: string;
  readonly gatewayWorktree: string;
};

export type StackChanAttentionReplayQualificationStartResult = {
  readonly outputPath: string;
  readonly attestationSha256: string;
};

export type StackChanAttentionReplayComparisonContractOptions = {
  readonly outputPath: string;
  readonly qualificationId: string;
  readonly capturedAtUtc: string;
  readonly picoControllerSource: string;
  readonly picoTargetCenterFilterSource: string;
  readonly picoRuntimeSource: string;
  readonly picoAttentionDetectionSource: string;
  readonly replayLanePolicySource: string;
  readonly replayLanePolicyTestSource: string;
  readonly gatewayLaneSource: string;
  readonly gatewayLaneTestSource: string;
  readonly gatewayPackageInitSource: string;
  readonly gatewayWifiPowerSaveSource: string;
  readonly gatewayPyprojectSource: string;
  readonly gatewayUvLockSource: string;
  readonly replayProducerSource: string;
  readonly attentionMetricsSource: string;
  readonly replayEvidenceBuilderSource: string;
  readonly replayReportSchemaSource: string;
  readonly replaySchemaSource: string;
  readonly replayGateTestSource: string;
  readonly replayFieldTestSource: string;
  readonly replayEvidenceTestSource: string;
  readonly packageJsonSource: string;
  readonly packageLockSource: string;
};

export type StackChanAttentionReplayComparisonContractResult = {
  readonly outputPath: string;
  readonly comparisonContractSha256: string;
};

export type StackChanAttentionReplayEvidenceCliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

type RepositoryKey = "pico" | "gateway";

type AttestedSourceFile = {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly trackedState: "tracked" | "untracked";
};

type AttestedGitValue = {
  readonly sha256: string;
  readonly bytes: number;
};

type AttestedUntrackedFile = {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
};

type AttestedRepository = {
  readonly repository: RepositoryKey;
  readonly repositoryId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly headRevision: string;
  readonly originMainRevision: string;
  readonly mergeBaseRevision: string;
  readonly qualificationBaseRevision: string;
  readonly gitObservation: {
    readonly porcelainV1Z: AttestedGitValue;
    readonly binaryDiff: AttestedGitValue;
    readonly diffNames: AttestedGitValue;
    readonly untrackedManifest: AttestedGitValue & {
      readonly files: readonly AttestedUntrackedFile[];
    };
  };
  readonly sourceFiles: readonly AttestedSourceFile[];
};

type QualificationStartAttestation = {
  readonly schemaVersion: 1;
  readonly qualificationId: string;
  readonly capturedAtUtc: string;
  readonly hashAlgorithm: "sha256";
  readonly repositories: {
    readonly pico: AttestedRepository;
    readonly gateway: AttestedRepository;
  };
};

type StartRepositoryScope = {
  readonly worktree: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly productionHashes: Readonly<Record<string, string>>;
};

type QualificationStartScope = {
  readonly schemaVersion: 1;
  readonly repositories: {
    readonly pico: StartRepositoryScope;
    readonly gateway: StartRepositoryScope;
  };
};

type ProductionFileScope = {
  readonly relativePath: string;
  readonly artifact: string;
  readonly startSha256: string;
  readonly currentSha256: string;
  readonly preserved: boolean;
};

type RepositoryScope = {
  readonly repositoryId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly qualificationBaseRevision: string;
  readonly headRevision: string;
  readonly originMainRevision: string;
  readonly mergeBaseRevision: string;
  readonly productionFiles: readonly ProductionFileScope[];
  readonly gitObservation: AttestedRepository["gitObservation"];
};

type RepositoryInspection = {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly repository: RepositoryKey;
  readonly attestation: AttestedRepository;
};

type CopiedArtifact = {
  readonly artifact: string;
  readonly sha256: string;
  readonly bytes: number;
};

type ComparisonContract = {
  readonly schemaVersion: 1;
  readonly qualificationId: string;
  readonly capturedAtUtc: string;
  readonly hashAlgorithm: "sha256";
  readonly producerSources: readonly (CopiedArtifact & {
    readonly role: StackChanAttentionReplayProducerSourceRole;
  })[];
  readonly candidateMutableTestSources: readonly CopiedArtifact[];
  readonly gateSources: readonly CopiedArtifact[];
};

type ComparisonContractSourcePaths = Omit<
  StackChanAttentionReplayComparisonContractOptions,
  "outputPath" | "qualificationId" | "capturedAtUtc"
>;

type GateContractHashes = {
  readonly metricImplementationHash: {
    readonly report: string;
    readonly computed: string;
  };
  readonly reportSchemaHash: {
    readonly report: string;
    readonly computed: string;
  };
  readonly eventSchemaHash: {
    readonly report: string;
    readonly computed: string;
  };
};

type QualifiedReportVerification = Awaited<
  ReturnType<typeof verifyQualifiedReplayAgainstFreshCurrentProducer>
>;

type EmbeddedQualifiedReports = {
  readonly comparisonBaseline: StackChanAttentionReplayReport;
  readonly acceptanceVerdict: StackChanAttentionReplayAcceptanceVerdict;
  readonly qualified: StackChanAttentionReplayReport;
  readonly freshVerification: QualifiedReportVerification;
};

type EmbeddedHistoricalReports = {
  readonly before: StackChanAttentionReplayReport;
  readonly after: StackChanAttentionReplayReport;
};

const cliOptionNames = {
  "--output-archive": "outputArchive",
  "--staging-dir": "stagingDirectory",
  "--comparison-baseline-report": "comparisonBaselineReport",
  "--expected-comparison-baseline-sha256": "expectedComparisonBaselineSha256",
  "--comparison-contract": "comparisonContract",
  "--expected-comparison-contract-sha256": "expectedComparisonContractSha256",
  "--qualified-report": "qualifiedReport",
  "--normalized-before-report": "normalizedBeforeReport",
  "--normalized-after-report": "normalizedAfterReport",
  "--pico-controller-source": "picoControllerSource",
  "--pico-target-center-filter-source": "picoTargetCenterFilterSource",
  "--pico-runtime-source": "picoRuntimeSource",
  "--pico-attention-detection-source": "picoAttentionDetectionSource",
  "--gateway-lane-source": "gatewayLaneSource",
  "--gateway-lane-test-source": "gatewayLaneTestSource",
  "--gateway-package-init-source": "gatewayPackageInitSource",
  "--gateway-wifi-power-save-source": "gatewayWifiPowerSaveSource",
  "--gateway-pyproject-source": "gatewayPyprojectSource",
  "--gateway-uv-lock-source": "gatewayUvLockSource",
  "--replay-producer-source": "replayProducerSource",
  "--attention-metrics-source": "attentionMetricsSource",
  "--replay-lane-policy-source": "replayLanePolicySource",
  "--replay-lane-policy-test-source": "replayLanePolicyTestSource",
  "--replay-evidence-builder-source": "replayEvidenceBuilderSource",
  "--replay-report-schema-source": "replayReportSchemaSource",
  "--replay-schema-source": "replaySchemaSource",
  "--replay-gate-test-source": "replayGateTestSource",
  "--replay-field-test-source": "replayFieldTestSource",
  "--replay-evidence-test-source": "replayEvidenceTestSource",
  "--focused-pico-log": "focusedPicoLog",
  "--full-pico-log": "fullPicoLog",
  "--gateway-log": "gatewayLog",
  "--secretlint-log": "secretlintLog",
  "--diff-check-log": "diffCheckLog",
  "--qualification-start-attestation": "qualificationStartAttestation",
  "--expected-start-attestation-sha256": "expectedStartAttestationSha256"
} as const satisfies Readonly<Record<string, keyof StackChanAttentionReplayEvidenceOptions>>;

type StackChanAttentionReplayEvidenceCliCommand =
  | {
      readonly command: "build";
      readonly options: StackChanAttentionReplayEvidenceOptions;
    }
  | {
      readonly command: "capture-start";
      readonly options: StackChanAttentionReplayQualificationStartOptions;
    }
  | {
      readonly command: "capture-comparison-contract";
      readonly options: StackChanAttentionReplayComparisonContractOptions;
    }
  | {
      readonly command: "producer-hash";
      readonly options: StackChanAttentionReplayProducerHashOptions;
    }
  | {
      readonly command: "verify";
      readonly options: ReturnType<typeof parsePortableVerificationArguments>;
    };

type StackChanAttentionReplayProducerHashOptions = {
  readonly picoControllerSource: string;
  readonly picoTargetCenterFilterSource: string;
  readonly picoRuntimeSource: string;
  readonly picoAttentionDetectionSource: string;
  readonly replayLanePolicySource: string;
  readonly gatewayLaneSource: string;
};

export function parseStackChanAttentionReplayEvidenceArguments(
  arguments_: readonly string[]
): StackChanAttentionReplayEvidenceOptions {
  const values = new Map<keyof StackChanAttentionReplayEvidenceOptions, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error("attention replay evidence arguments must be flag/value pairs");
    }
    const key = requireCliOptionKey(flag);
    if (values.has(key)) {
      throw new Error(`duplicate attention replay evidence argument: ${flag}`);
    }
    validateEvidenceCliValue(key, value, flag);
    values.set(key, value);
  }
  const result = {} as Record<keyof StackChanAttentionReplayEvidenceOptions, string>;
  for (const [flag, key] of Object.entries(cliOptionNames) as [
    keyof typeof cliOptionNames,
    keyof StackChanAttentionReplayEvidenceOptions
  ][]) {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`missing attention replay evidence argument: ${flag}`);
    }
    result[key] = value;
  }
  return result;
}

function validateEvidenceCliValue(
  key: keyof StackChanAttentionReplayEvidenceOptions,
  value: string,
  flag: string
): void {
  if (
    key === "expectedStartAttestationSha256" ||
    key === "expectedComparisonBaselineSha256" ||
    key === "expectedComparisonContractSha256"
  ) {
    requireHash(value, flag);
    return;
  }
  if (!isAbsolute(value)) {
    throw new Error(`${flag} must be an absolute path`);
  }
}

export async function captureStackChanAttentionReplayQualificationStart(
  options: StackChanAttentionReplayQualificationStartOptions
): Promise<StackChanAttentionReplayQualificationStartResult> {
  if (!isAbsolute(options.outputPath) || resolve(options.outputPath) !== options.outputPath) {
    throw new Error("qualification start outputPath must be a normalized absolute path");
  }
  if (options.qualificationId.trim() === "") {
    throw new Error("qualification start qualificationId is invalid");
  }
  if (
    Number.isNaN(Date.parse(options.capturedAtUtc)) ||
    new Date(options.capturedAtUtc).toISOString() !== options.capturedAtUtc
  ) {
    throw new Error("qualification start capturedAtUtc must be canonical ISO-8601 UTC");
  }
  await requireAbsent(options.outputPath, "qualification start outputPath");
  await requireCanonicalDirectory(dirname(options.outputPath), "qualification start output parent");
  const picoWorktree = await requireCanonicalDirectory(
    options.picoWorktree,
    "qualification start Pico worktree"
  );
  const gatewayWorktree = await requireCanonicalDirectory(
    options.gatewayWorktree,
    "qualification start Gateway worktree"
  );
  if (
    isPathWithin(options.outputPath, picoWorktree) ||
    isPathWithin(options.outputPath, gatewayWorktree)
  ) {
    throw new Error("qualification start output must be outside source worktrees");
  }
  const attestation: QualificationStartAttestation = {
    schemaVersion: START_SCOPE_SCHEMA_VERSION,
    qualificationId: options.qualificationId,
    capturedAtUtc: options.capturedAtUtc,
    hashAlgorithm: "sha256",
    repositories: {
      pico: await inspectAttestedRepository("pico", picoWorktree, attestedSourcePaths.pico),
      gateway: await inspectAttestedRepository(
        "gateway",
        gatewayWorktree,
        attestedSourcePaths.gateway
      )
    }
  };
  await writeJson(options.outputPath, attestation);
  return {
    outputPath: options.outputPath,
    attestationSha256: await sha256File(options.outputPath)
  };
}

export async function captureStackChanAttentionReplayComparisonContract(
  options: StackChanAttentionReplayComparisonContractOptions
): Promise<StackChanAttentionReplayComparisonContractResult> {
  if (!isAbsolute(options.outputPath) || resolve(options.outputPath) !== options.outputPath) {
    throw new Error("comparison contract outputPath must be a normalized absolute path");
  }
  if (options.qualificationId.trim() === "") {
    throw new Error("comparison contract qualificationId is invalid");
  }
  requireCanonicalUtc(options.capturedAtUtc, "comparison contract capturedAtUtc");
  await requireAbsent(options.outputPath, "comparison contract outputPath");
  await requireCanonicalDirectory(dirname(options.outputPath), "comparison contract output parent");
  const paths = await canonicalComparisonContractInputPaths(options);
  if (new Set(Object.values(paths)).size !== Object.values(paths).length) {
    throw new Error("comparison contract source paths must be distinct");
  }
  if (Object.values(paths).includes(options.outputPath)) {
    throw new Error("comparison contract output overlaps a source path");
  }
  const contract: ComparisonContract = {
    schemaVersion: 1,
    qualificationId: options.qualificationId,
    capturedAtUtc: options.capturedAtUtc,
    hashAlgorithm: "sha256",
    producerSources: await describeComparisonProducerSources(paths),
    candidateMutableTestSources: await describeCandidateMutableTestSources(paths),
    gateSources: await describeComparisonGateSources(paths)
  };
  await writeJson(options.outputPath, contract);
  return {
    outputPath: options.outputPath,
    comparisonContractSha256: await sha256File(options.outputPath)
  };
}

function requireCliOptionKey(flag: string): keyof StackChanAttentionReplayEvidenceOptions {
  if (!Object.hasOwn(cliOptionNames, flag)) {
    throw new Error(`unknown attention replay evidence argument: ${flag}`);
  }
  return cliOptionNames[flag as keyof typeof cliOptionNames];
}

export async function executeStackChanAttentionReplayEvidenceCli(
  arguments_: readonly string[],
  io: StackChanAttentionReplayEvidenceCliIo = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  }
): Promise<number> {
  let command: StackChanAttentionReplayEvidenceCliCommand;
  try {
    command = parseStackChanAttentionReplayEvidenceCliCommand(arguments_);
  } catch {
    io.stderr('{"status":"failed","code":"invalid_arguments"}');
    return 1;
  }
  try {
    if (command.command === "verify") {
      await verifyStackChanAttentionReplayEvidence(
        command.options.evidenceDirectory,
        command.options.expectedStartAttestationSha256,
        command.options.expectedComparisonBaselineSha256,
        command.options.expectedComparisonContractSha256
      );
      io.stdout(JSON.stringify({ status: "passed" }));
      return 0;
    }
    if (command.command === "capture-start") {
      const result = await captureStackChanAttentionReplayQualificationStart(command.options);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    if (command.command === "capture-comparison-contract") {
      const result = await captureStackChanAttentionReplayComparisonContract(command.options);
      io.stdout(JSON.stringify(result));
      return 0;
    }
    if (command.command === "producer-hash") {
      const result = await hashProducerSourceOptions(command.options);
      io.stdout(JSON.stringify({ producerSourceHash: result }));
      return 0;
    }
    const result = await buildStackChanAttentionReplayEvidence(command.options);
    io.stdout(
      JSON.stringify({
        status: "passed",
        outputArchive: result.outputArchive,
        archiveSha256: result.archiveSha256
      })
    );
    return 0;
  } catch {
    io.stderr('{"status":"failed","code":"execution_failed"}');
    return 1;
  }
}

function parseStackChanAttentionReplayEvidenceCliCommand(
  arguments_: readonly string[]
): StackChanAttentionReplayEvidenceCliCommand {
  const [command, ...options] = arguments_;
  if (command === "build") {
    return {
      command,
      options: parseStackChanAttentionReplayEvidenceArguments(options)
    };
  }
  if (command === "capture-start") {
    return {
      command,
      options: parseQualificationStartArguments(options)
    };
  }
  if (command === "capture-comparison-contract") {
    return {
      command,
      options: parseComparisonContractArguments(options)
    };
  }
  if (command === "producer-hash") {
    return {
      command,
      options: parseProducerHashArguments(options)
    };
  }
  if (command === "verify") {
    return {
      command,
      options: parsePortableVerificationArguments(options)
    };
  }
  throw new Error("attention replay evidence command is invalid");
}

function parseComparisonContractArguments(
  arguments_: readonly string[]
): StackChanAttentionReplayComparisonContractOptions {
  const allowed: ReadonlyMap<string, string> = new Map([
    ["--output-path", "outputPath"],
    ["--qualification-id", "qualificationId"],
    ["--captured-at-utc", "capturedAtUtc"],
    ["--pico-controller-source", "picoControllerSource"],
    ["--pico-target-center-filter-source", "picoTargetCenterFilterSource"],
    ["--pico-runtime-source", "picoRuntimeSource"],
    ["--pico-attention-detection-source", "picoAttentionDetectionSource"],
    ["--replay-lane-policy-source", "replayLanePolicySource"],
    ["--replay-lane-policy-test-source", "replayLanePolicyTestSource"],
    ["--gateway-lane-source", "gatewayLaneSource"],
    ["--gateway-lane-test-source", "gatewayLaneTestSource"],
    ["--gateway-package-init-source", "gatewayPackageInitSource"],
    ["--gateway-wifi-power-save-source", "gatewayWifiPowerSaveSource"],
    ["--gateway-pyproject-source", "gatewayPyprojectSource"],
    ["--gateway-uv-lock-source", "gatewayUvLockSource"],
    ["--replay-producer-source", "replayProducerSource"],
    ["--attention-metrics-source", "attentionMetricsSource"],
    ["--replay-evidence-builder-source", "replayEvidenceBuilderSource"],
    ["--replay-report-schema-source", "replayReportSchemaSource"],
    ["--replay-schema-source", "replaySchemaSource"],
    ["--replay-gate-test-source", "replayGateTestSource"],
    ["--replay-field-test-source", "replayFieldTestSource"],
    ["--replay-evidence-test-source", "replayEvidenceTestSource"],
    ["--package-json-source", "packageJsonSource"],
    ["--package-lock-source", "packageLockSource"]
  ] as const);
  const values = parseExactCliPairs(arguments_, allowed, "comparison contract");
  if (values.size !== allowed.size) {
    throw new Error("comparison contract arguments are incomplete");
  }
  const sourcePath = (key: string, flag: string): string =>
    requireNormalizedAbsolutePath(values.get(key), flag);
  return {
    outputPath: sourcePath("outputPath", "--output-path"),
    qualificationId: requireNonemptyString(values.get("qualificationId"), "--qualification-id"),
    capturedAtUtc: requireCanonicalUtc(values.get("capturedAtUtc"), "--captured-at-utc"),
    picoControllerSource: sourcePath("picoControllerSource", "--pico-controller-source"),
    picoTargetCenterFilterSource: sourcePath(
      "picoTargetCenterFilterSource",
      "--pico-target-center-filter-source"
    ),
    picoRuntimeSource: sourcePath("picoRuntimeSource", "--pico-runtime-source"),
    picoAttentionDetectionSource: sourcePath(
      "picoAttentionDetectionSource",
      "--pico-attention-detection-source"
    ),
    replayLanePolicySource: sourcePath("replayLanePolicySource", "--replay-lane-policy-source"),
    replayLanePolicyTestSource: sourcePath(
      "replayLanePolicyTestSource",
      "--replay-lane-policy-test-source"
    ),
    gatewayLaneSource: sourcePath("gatewayLaneSource", "--gateway-lane-source"),
    gatewayLaneTestSource: sourcePath("gatewayLaneTestSource", "--gateway-lane-test-source"),
    gatewayPackageInitSource: sourcePath(
      "gatewayPackageInitSource",
      "--gateway-package-init-source"
    ),
    gatewayWifiPowerSaveSource: sourcePath(
      "gatewayWifiPowerSaveSource",
      "--gateway-wifi-power-save-source"
    ),
    gatewayPyprojectSource: sourcePath("gatewayPyprojectSource", "--gateway-pyproject-source"),
    gatewayUvLockSource: sourcePath("gatewayUvLockSource", "--gateway-uv-lock-source"),
    replayProducerSource: sourcePath("replayProducerSource", "--replay-producer-source"),
    attentionMetricsSource: sourcePath("attentionMetricsSource", "--attention-metrics-source"),
    replayEvidenceBuilderSource: sourcePath(
      "replayEvidenceBuilderSource",
      "--replay-evidence-builder-source"
    ),
    replayReportSchemaSource: sourcePath(
      "replayReportSchemaSource",
      "--replay-report-schema-source"
    ),
    replaySchemaSource: sourcePath("replaySchemaSource", "--replay-schema-source"),
    replayGateTestSource: sourcePath("replayGateTestSource", "--replay-gate-test-source"),
    replayFieldTestSource: sourcePath("replayFieldTestSource", "--replay-field-test-source"),
    replayEvidenceTestSource: sourcePath(
      "replayEvidenceTestSource",
      "--replay-evidence-test-source"
    ),
    packageJsonSource: sourcePath("packageJsonSource", "--package-json-source"),
    packageLockSource: sourcePath("packageLockSource", "--package-lock-source")
  };
}

function parseProducerHashArguments(
  arguments_: readonly string[]
): StackChanAttentionReplayProducerHashOptions {
  const allowed: ReadonlyMap<string, string> = new Map([
    ["--pico-controller-source", "picoControllerSource"],
    ["--pico-target-center-filter-source", "picoTargetCenterFilterSource"],
    ["--pico-runtime-source", "picoRuntimeSource"],
    ["--pico-attention-detection-source", "picoAttentionDetectionSource"],
    ["--replay-lane-policy-source", "replayLanePolicySource"],
    ["--gateway-lane-source", "gatewayLaneSource"]
  ] as const);
  const values = parseExactCliPairs(arguments_, allowed, "producer hash");
  if (values.size !== allowed.size) {
    throw new Error("producer hash arguments are incomplete");
  }
  return {
    picoControllerSource: requireNormalizedAbsolutePath(
      values.get("picoControllerSource"),
      "--pico-controller-source"
    ),
    picoTargetCenterFilterSource: requireNormalizedAbsolutePath(
      values.get("picoTargetCenterFilterSource"),
      "--pico-target-center-filter-source"
    ),
    picoRuntimeSource: requireNormalizedAbsolutePath(
      values.get("picoRuntimeSource"),
      "--pico-runtime-source"
    ),
    picoAttentionDetectionSource: requireNormalizedAbsolutePath(
      values.get("picoAttentionDetectionSource"),
      "--pico-attention-detection-source"
    ),
    replayLanePolicySource: requireNormalizedAbsolutePath(
      values.get("replayLanePolicySource"),
      "--replay-lane-policy-source"
    ),
    gatewayLaneSource: requireNormalizedAbsolutePath(
      values.get("gatewayLaneSource"),
      "--gateway-lane-source"
    )
  };
}

function parseQualificationStartArguments(
  arguments_: readonly string[]
): StackChanAttentionReplayQualificationStartOptions {
  const allowed: ReadonlyMap<string, string> = new Map([
    ["--output-path", "outputPath"],
    ["--qualification-id", "qualificationId"],
    ["--captured-at-utc", "capturedAtUtc"],
    ["--pico-worktree", "picoWorktree"],
    ["--gateway-worktree", "gatewayWorktree"]
  ] as const);
  const values = parseExactCliPairs(arguments_, allowed, "qualification start");
  if (values.size !== allowed.size) {
    throw new Error("qualification start arguments are incomplete");
  }
  return {
    outputPath: requireNormalizedAbsolutePath(values.get("outputPath"), "--output-path"),
    qualificationId: requireNonemptyString(values.get("qualificationId"), "--qualification-id"),
    capturedAtUtc: requireCanonicalUtc(values.get("capturedAtUtc"), "--captured-at-utc"),
    picoWorktree: requireNormalizedAbsolutePath(values.get("picoWorktree"), "--pico-worktree"),
    gatewayWorktree: requireNormalizedAbsolutePath(
      values.get("gatewayWorktree"),
      "--gateway-worktree"
    )
  };
}

async function hashProducerSourceOptions(
  options: StackChanAttentionReplayProducerHashOptions
): Promise<string> {
  return hashProducerSources([
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[0],
      path: options.picoControllerSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[1],
      path: options.picoTargetCenterFilterSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[2],
      path: options.picoRuntimeSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[3],
      path: options.picoAttentionDetectionSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[4],
      path: options.replayLanePolicySource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[5],
      path: options.gatewayLaneSource
    }
  ]);
}

function parsePortableVerificationArguments(arguments_: readonly string[]): {
  readonly evidenceDirectory: string;
  readonly expectedStartAttestationSha256: string;
  readonly expectedComparisonBaselineSha256: string;
  readonly expectedComparisonContractSha256: string;
} {
  const allowed: ReadonlyMap<string, string> = new Map([
    ["--evidence-dir", "evidenceDirectory"],
    ["--expected-start-attestation-sha256", "expectedStartAttestationSha256"],
    ["--expected-comparison-baseline-sha256", "expectedComparisonBaselineSha256"],
    ["--expected-comparison-contract-sha256", "expectedComparisonContractSha256"]
  ] as const);
  const values = parseExactCliPairs(arguments_, allowed, "portable evidence verification");
  const evidenceDirectory = values.get("evidenceDirectory");
  const expectedStartAttestationSha256 = values.get("expectedStartAttestationSha256");
  const expectedComparisonBaselineSha256 = values.get("expectedComparisonBaselineSha256");
  const expectedComparisonContractSha256 = values.get("expectedComparisonContractSha256");
  if (
    evidenceDirectory === undefined ||
    !isAbsolute(evidenceDirectory) ||
    resolve(evidenceDirectory) !== evidenceDirectory
  ) {
    throw new Error("--evidence-dir must be a normalized absolute path");
  }
  requireHash(expectedStartAttestationSha256, "--expected-start-attestation-sha256");
  requireHash(expectedComparisonBaselineSha256, "--expected-comparison-baseline-sha256");
  requireHash(expectedComparisonContractSha256, "--expected-comparison-contract-sha256");
  if (values.size !== allowed.size) {
    throw new Error("portable evidence verification arguments are incomplete");
  }
  return {
    evidenceDirectory,
    expectedStartAttestationSha256,
    expectedComparisonBaselineSha256,
    expectedComparisonContractSha256
  };
}

function parseExactCliPairs(
  arguments_: readonly string[],
  allowed: ReadonlyMap<string, string>,
  label: string
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    const key = flag === undefined ? undefined : allowed.get(flag);
    if (key === undefined || value === undefined) {
      throw new Error(`${label} arguments are invalid`);
    }
    if (values.has(key)) {
      throw new Error(`duplicate ${label} argument: ${String(flag)}`);
    }
    values.set(key, value);
  }
  return values;
}

export async function buildStackChanAttentionReplayEvidence(
  options: StackChanAttentionReplayEvidenceOptions
): Promise<StackChanAttentionReplayEvidenceBuildResult> {
  await validateOutputPaths(options);
  const inputs = await validateInputPaths(options);
  const comparisonContract = await readComparisonContract(
    inputs.comparisonContract,
    inputs.expectedComparisonContractSha256
  );
  await requireExternalFileHash(
    inputs.comparisonBaselineReport,
    inputs.expectedComparisonBaselineSha256,
    "comparison baseline"
  );
  const comparisonBaseline = await readReplayReport(inputs.comparisonBaselineReport, "qualified");
  const qualified = await readReplayReport(inputs.qualifiedReport, "qualified");
  const before = await readReplayReport(inputs.normalizedBeforeReport, "historical-normalized");
  const after = await readReplayReport(inputs.normalizedAfterReport, "historical-normalized");
  if (before.comparisonSetHash !== after.comparisonSetHash) {
    throw new Error("historical comparisonSetHash mismatch");
  }
  if (qualified.status !== "passed") {
    throw new Error("qualified replay report did not pass");
  }
  if (typeof qualified.producerSourceHash !== "string") {
    throw new Error("qualified replay report producerSourceHash is missing");
  }
  const qualifiedProducerSourceHash = qualified.producerSourceHash;

  const startAttestation = await readQualificationStartAttestation(
    inputs.qualificationStartAttestation,
    inputs.expectedStartAttestationSha256
  );
  await assertComparisonContractMatchesSources(
    comparisonContract,
    comparisonContractPathsFromEvidenceInputs(inputs),
    startAttestation.qualificationId
  );
  const startScope = startScopeFromAttestation(startAttestation);
  await assertWorktreesMatchStartAttestation(startAttestation);
  await validateScopePaths(startScope, inputs);
  const sourceHashes = {
    picoController: await sha256File(inputs.picoControllerSource),
    picoTargetCenterFilter: await sha256File(inputs.picoTargetCenterFilterSource),
    picoRuntime: await sha256File(inputs.picoRuntimeSource),
    picoAttentionDetection: await sha256File(inputs.picoAttentionDetectionSource),
    replayLanePolicy: await sha256File(inputs.replayLanePolicySource),
    gatewayLane: await sha256File(inputs.gatewayLaneSource)
  };
  assertStartHashes(startScope, sourceHashes);
  const producerAggregate = await hashProducerSources([
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[0],
      path: inputs.picoControllerSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[1],
      path: inputs.picoTargetCenterFilterSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[2],
      path: inputs.picoRuntimeSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[3],
      path: inputs.picoAttentionDetectionSource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[4],
      path: inputs.replayLanePolicySource
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[5],
      path: inputs.gatewayLaneSource
    }
  ]);
  if (producerAggregate !== qualifiedProducerSourceHash) {
    throw new Error("producer source aggregate mismatch");
  }
  const gateContractHashes = await verifyGateContractHashes(qualified, inputs);
  const candidateContractSourceHashes = {
    metricImplementationHash: gateContractHashes.metricImplementationHash.computed,
    producerSourceHash: producerAggregate
  } satisfies StackChanAttentionReplayContractSourceHashes;
  if (typeof comparisonBaseline.producerSourceHash !== "string") {
    throw new Error("comparison baseline producerSourceHash is missing");
  }
  const baselineContractSourceHashes = {
    metricImplementationHash: gateContractHashes.metricImplementationHash.computed,
    producerSourceHash: comparisonBaseline.producerSourceHash
  } satisfies StackChanAttentionReplayContractSourceHashes;
  validateStackChanAttentionReplayReport(
    before,
    "historical-normalized",
    candidateContractSourceHashes
  );
  validateStackChanAttentionReplayReport(
    after,
    "historical-normalized",
    candidateContractSourceHashes
  );
  validateStackChanAttentionReplayReport(
    comparisonBaseline,
    "qualified",
    baselineContractSourceHashes
  );
  validateStackChanAttentionReplayReport(qualified, "qualified", candidateContractSourceHashes);
  const acceptanceVerdict = evaluateAcceptanceForDistinctProducerHashes(
    comparisonBaseline,
    qualified,
    candidateContractSourceHashes
  );
  const freshVerification = await verifyQualifiedReplayAgainstFreshCurrentProducer(
    qualified,
    candidateContractSourceHashes
  );

  const repositoryFiles = {
    pico: [
      {
        relativePath: productionRelativePaths.picoController,
        artifact: sourceArtifacts.picoController,
        currentSha256: sourceHashes.picoController
      },
      {
        relativePath: productionRelativePaths.picoTargetCenterFilter,
        artifact: sourceArtifacts.picoTargetCenterFilter,
        currentSha256: sourceHashes.picoTargetCenterFilter
      },
      {
        relativePath: productionRelativePaths.picoRuntime,
        artifact: sourceArtifacts.picoRuntime,
        currentSha256: sourceHashes.picoRuntime
      },
      {
        relativePath: productionRelativePaths.picoAttentionDetection,
        artifact: sourceArtifacts.picoAttentionDetection,
        currentSha256: sourceHashes.picoAttentionDetection
      }
    ],
    gateway: [
      {
        relativePath: productionRelativePaths.gatewayLane,
        artifact: sourceArtifacts.gatewayLane,
        currentSha256: sourceHashes.gatewayLane
      }
    ]
  } as const;
  const repositoryInspections: Readonly<Record<RepositoryKey, RepositoryInspection>> = {
    pico: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      repository: "pico",
      attestation: startAttestation.repositories.pico
    },
    gateway: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      repository: "gateway",
      attestation: startAttestation.repositories.gateway
    }
  };
  const repositoryScopes = {
    pico: createRepositoryScope(
      "pico",
      startScope.repositories.pico,
      repositoryFiles.pico,
      startAttestation.repositories.pico
    ),
    gateway: createRepositoryScope(
      "gateway",
      startScope.repositories.gateway,
      repositoryFiles.gateway,
      startAttestation.repositories.gateway
    )
  };

  await mkdir(options.stagingDirectory);
  try {
    const copiedArtifacts = await copyInputArtifacts(options);
    await writeJson(
      join(options.stagingDirectory, reportArtifacts.acceptanceVerdict),
      acceptanceVerdict
    );
    await writeJson(
      join(options.stagingDirectory, reportArtifacts.qualifiedFreshRerun),
      freshVerification.freshReport
    );
    await writeRepositoryInspections(options.stagingDirectory, repositoryInspections);
    await writePortableVerifier(options.stagingDirectory, inputs.replayEvidenceBuilderSource);
    const artifacts = {
      ...copiedArtifacts,
      ...(await describeArtifacts(options.stagingDirectory, [
        reportArtifacts.acceptanceVerdict,
        reportArtifacts.qualifiedFreshRerun,
        ...Object.values(gitInspectionArtifacts),
        ...Object.values(portableArtifacts)
      ]))
    };
    const producerManifest = createProducerSourceManifest(
      producerAggregate,
      qualifiedProducerSourceHash,
      artifacts
    );
    await writeJson(
      join(options.stagingDirectory, "producer-source-manifest.json"),
      producerManifest
    );
    await writeJson(
      join(options.stagingDirectory, "gate-producer-manifest.json"),
      createGateProducerManifest(gateContractHashes, artifacts)
    );
    const productionScope = createProductionScope(repositoryScopes, artifacts);
    await writeJson(join(options.stagingDirectory, "production-scope.json"), productionScope);
    const reviewManifest = createReviewManifest(
      qualified,
      comparisonBaseline,
      acceptanceVerdict,
      before,
      after,
      artifacts,
      producerAggregate,
      productionScope,
      freshVerification
    );
    await writeJson(join(options.stagingDirectory, "review-manifest.json"), reviewManifest);
    await writeFile(
      join(options.stagingDirectory, "README.md"),
      createReadme(
        qualified,
        comparisonBaseline,
        acceptanceVerdict,
        before,
        after,
        repositoryScopes,
        artifacts
      )
    );
    await writeSha256Sums(options.stagingDirectory);
    await verifyStackChanAttentionReplayEvidence(
      options.stagingDirectory,
      options.expectedStartAttestationSha256,
      options.expectedComparisonBaselineSha256,
      options.expectedComparisonContractSha256
    );
    await writeDeterministicTarGzip(options.stagingDirectory, options.outputArchive);
    return {
      outputArchive: options.outputArchive,
      stagingDirectory: options.stagingDirectory,
      archiveSha256: await sha256File(options.outputArchive)
    };
  } catch (error) {
    await rm(options.stagingDirectory, { recursive: true, force: true });
    await rm(options.outputArchive, { force: true });
    throw error;
  }
}

export async function verifyStackChanAttentionReplayEvidence(
  stagingDirectory: string,
  expectedStartAttestationSha256: string,
  expectedComparisonBaselineSha256: string,
  expectedComparisonContractSha256: string
): Promise<void> {
  const canonicalDirectory = await requireCanonicalDirectory(stagingDirectory, "staging directory");
  const sumsPath = join(canonicalDirectory, "SHA256SUMS");
  const sums = await readFile(sumsPath, "utf8");
  const expected = parseSha256Sums(sums);
  const actualFiles = (await listFiles(canonicalDirectory))
    .filter((path) => path !== "SHA256SUMS")
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("SHA256SUMS artifact roster mismatch");
  }
  await verifyArtifactChecksums(canonicalDirectory, expectedFiles, expected);
  const comparisonContract = await readComparisonContract(
    join(canonicalDirectory, inputArtifacts.comparisonContract),
    expectedComparisonContractSha256
  );
  const startAttestation = await readQualificationStartAttestation(
    join(canonicalDirectory, inputArtifacts.qualificationStartAttestation),
    expectedStartAttestationSha256
  );
  await assertComparisonContractMatchesSources(
    comparisonContract,
    comparisonContractPathsFromArchive(canonicalDirectory),
    startAttestation.qualificationId
  );
  await requireExternalFileHash(
    join(canonicalDirectory, reportArtifacts.comparisonBaseline),
    expectedComparisonBaselineSha256,
    "comparison baseline"
  );
  const producerAggregate = await hashProducerSources([
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[0],
      path: join(canonicalDirectory, sourceArtifacts.picoController)
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[1],
      path: join(canonicalDirectory, sourceArtifacts.picoTargetCenterFilter)
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[2],
      path: join(canonicalDirectory, sourceArtifacts.picoRuntime)
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[3],
      path: join(canonicalDirectory, sourceArtifacts.picoAttentionDetection)
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[4],
      path: join(canonicalDirectory, sourceArtifacts.replayLanePolicy)
    },
    {
      role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[5],
      path: join(canonicalDirectory, sourceArtifacts.gatewayLane)
    }
  ]);
  const contractSourceHashes = {
    metricImplementationHash: await sha256File(
      join(canonicalDirectory, gateArtifacts.replayProducer)
    ),
    producerSourceHash: producerAggregate
  } satisfies StackChanAttentionReplayContractSourceHashes;
  const { comparisonBaseline, acceptanceVerdict, qualified, freshVerification } =
    await verifyEmbeddedQualifiedReports(canonicalDirectory, contractSourceHashes);
  const { before, after } = await verifyEmbeddedHistoricalReports(
    canonicalDirectory,
    contractSourceHashes
  );
  if (typeof qualified.producerSourceHash !== "string") {
    throw new Error("embedded qualified producerSourceHash is missing");
  }
  if (producerAggregate !== qualified.producerSourceHash) {
    throw new Error("embedded producer source aggregate mismatch");
  }
  const productionArtifactRecord = await describeArtifacts(canonicalDirectory, [
    ...Object.values(sourceArtifacts)
  ]);
  const expectedProducerManifest = `${JSON.stringify(
    createProducerSourceManifest(
      producerAggregate,
      qualified.producerSourceHash,
      productionArtifactRecord
    ),
    undefined,
    2
  )}\n`;
  const actualProducerManifest = await readFile(
    join(canonicalDirectory, "producer-source-manifest.json"),
    "utf8"
  );
  if (actualProducerManifest !== expectedProducerManifest) {
    throw new Error("producer source manifest mismatch");
  }
  const contractHashes = await verifyGateContractHashes(qualified, {
    replayProducerSource: join(canonicalDirectory, gateArtifacts.replayProducer),
    replayReportSchemaSource: join(canonicalDirectory, gateArtifacts.replayReportSchema)
  });
  const gateArtifactRecord = await describeGateArtifacts(canonicalDirectory);
  const expectedManifest = `${JSON.stringify(
    createGateProducerManifest(contractHashes, gateArtifactRecord),
    undefined,
    2
  )}\n`;
  const actualManifest = await readFile(
    join(canonicalDirectory, "gate-producer-manifest.json"),
    "utf8"
  );
  if (actualManifest !== expectedManifest) {
    throw new Error("gate producer manifest mismatch");
  }
  const executingBuilderHash = await sha256File(fileURLToPath(import.meta.url));
  const allowedVerifierHashes = new Set([
    requireArtifact(gateArtifactRecord, gateArtifacts.replayEvidenceBuilder).sha256,
    requireArtifact(gateArtifactRecord, portableArtifacts.verifier).sha256
  ]);
  if (!allowedVerifierHashes.has(executingBuilderHash)) {
    throw new Error("embedded replay evidence builder does not match executing verifier");
  }
  if (
    (await readFile(join(canonicalDirectory, portableArtifacts.replayReportSchema))).compare(
      await readFile(join(canonicalDirectory, gateArtifacts.replayReportSchema))
    ) !== 0
  ) {
    throw new Error("portable replay report schema does not match gate schema");
  }

  await assertEmbeddedSourcesMatchAttestation(startAttestation, canonicalDirectory);
  const startScope = startScopeFromAttestation(startAttestation);
  const sourceHashes = {
    picoController: await sha256File(join(canonicalDirectory, sourceArtifacts.picoController)),
    picoTargetCenterFilter: await sha256File(
      join(canonicalDirectory, sourceArtifacts.picoTargetCenterFilter)
    ),
    picoRuntime: await sha256File(join(canonicalDirectory, sourceArtifacts.picoRuntime)),
    picoAttentionDetection: await sha256File(
      join(canonicalDirectory, sourceArtifacts.picoAttentionDetection)
    ),
    replayLanePolicy: await sha256File(join(canonicalDirectory, sourceArtifacts.replayLanePolicy)),
    gatewayLane: await sha256File(join(canonicalDirectory, sourceArtifacts.gatewayLane))
  };
  assertStartHashes(startScope, sourceHashes);
  const repositoryInspections = {
    pico: await readRepositoryInspection(
      join(canonicalDirectory, gitInspectionArtifacts.pico),
      "pico",
      startAttestation.repositories.pico
    ),
    gateway: await readRepositoryInspection(
      join(canonicalDirectory, gitInspectionArtifacts.gateway),
      "gateway",
      startAttestation.repositories.gateway
    )
  };
  const repositoryScopes = {
    pico: createRepositoryScope(
      "pico",
      startScope.repositories.pico,
      [
        {
          relativePath: productionRelativePaths.picoController,
          artifact: sourceArtifacts.picoController,
          currentSha256: sourceHashes.picoController
        },
        {
          relativePath: productionRelativePaths.picoTargetCenterFilter,
          artifact: sourceArtifacts.picoTargetCenterFilter,
          currentSha256: sourceHashes.picoTargetCenterFilter
        },
        {
          relativePath: productionRelativePaths.picoRuntime,
          artifact: sourceArtifacts.picoRuntime,
          currentSha256: sourceHashes.picoRuntime
        },
        {
          relativePath: productionRelativePaths.picoAttentionDetection,
          artifact: sourceArtifacts.picoAttentionDetection,
          currentSha256: sourceHashes.picoAttentionDetection
        }
      ],
      repositoryInspections.pico.attestation
    ),
    gateway: createRepositoryScope(
      "gateway",
      startScope.repositories.gateway,
      [
        {
          relativePath: productionRelativePaths.gatewayLane,
          artifact: sourceArtifacts.gatewayLane,
          currentSha256: sourceHashes.gatewayLane
        }
      ],
      repositoryInspections.gateway.attestation
    )
  };
  const reviewArtifactRecord = await describeReviewArtifacts(canonicalDirectory);
  const productionScope = createProductionScope(repositoryScopes, reviewArtifactRecord);
  await assertJsonArtifactMatches(
    join(canonicalDirectory, "production-scope.json"),
    productionScope,
    "production scope"
  );
  const reviewManifest = createReviewManifest(
    qualified,
    comparisonBaseline,
    acceptanceVerdict,
    before,
    after,
    reviewArtifactRecord,
    producerAggregate,
    productionScope,
    freshVerification
  );
  await assertJsonArtifactMatches(
    join(canonicalDirectory, "review-manifest.json"),
    reviewManifest,
    "review manifest"
  );
}

async function assertJsonArtifactMatches(
  path: string,
  expected: Readonly<Record<string, unknown>>,
  label: string
): Promise<void> {
  const expectedJson = `${JSON.stringify(expected, undefined, 2)}\n`;
  if ((await readFile(path, "utf8")) !== expectedJson) {
    throw new Error(`${label} mismatch`);
  }
}

async function verifyArtifactChecksums(
  canonicalDirectory: string,
  expectedFiles: readonly string[],
  expected: ReadonlyMap<string, string>
): Promise<void> {
  for (const artifact of expectedFiles) {
    const actualHash = await sha256File(join(canonicalDirectory, artifact));
    if (actualHash !== expected.get(artifact)) {
      throw new Error(`SHA256SUMS mismatch: ${artifact}`);
    }
  }
}

async function verifyEmbeddedQualifiedReports(
  canonicalDirectory: string,
  candidateContractSourceHashes: StackChanAttentionReplayContractSourceHashes
): Promise<EmbeddedQualifiedReports> {
  const comparisonBaseline = await readReplayReport(
    join(canonicalDirectory, reportArtifacts.comparisonBaseline),
    "qualified"
  );
  const qualifiedPath = join(canonicalDirectory, reportArtifacts.qualified);
  const qualifiedFreshRerunPath = join(canonicalDirectory, reportArtifacts.qualifiedFreshRerun);
  const [qualifiedBytes, qualifiedFreshRerunBytes] = await Promise.all([
    readFile(qualifiedPath),
    readFile(qualifiedFreshRerunPath)
  ]);
  if (!qualifiedBytes.equals(qualifiedFreshRerunBytes)) {
    throw new Error("qualified report raw bytes mismatch");
  }
  const qualified = await readReplayReport(qualifiedPath, "qualified");
  validateStackChanAttentionReplayReport(qualified, "qualified", candidateContractSourceHashes);
  const qualifiedVerification = await verifyQualifiedReplayAgainstFreshCurrentProducer(
    qualified,
    candidateContractSourceHashes
  );
  const qualifiedFreshRerun = await readReplayReport(qualifiedFreshRerunPath, "qualified");
  const rerunVerification = await verifyQualifiedReplayAgainstFreshCurrentProducer(
    qualifiedFreshRerun,
    candidateContractSourceHashes
  );
  if (
    qualifiedVerification.candidateCanonicalSha256 !== rerunVerification.candidateCanonicalSha256 ||
    qualifiedVerification.freshCanonicalSha256 !== rerunVerification.freshCanonicalSha256
  ) {
    throw new Error("embedded qualified fresh rerun mismatch");
  }
  if (typeof comparisonBaseline.producerSourceHash !== "string") {
    throw new Error("embedded comparison baseline producerSourceHash is missing");
  }
  validateStackChanAttentionReplayReport(comparisonBaseline, "qualified", {
    metricImplementationHash: candidateContractSourceHashes.metricImplementationHash,
    producerSourceHash: comparisonBaseline.producerSourceHash
  });
  const expectedAcceptanceVerdict = evaluateAcceptanceForDistinctProducerHashes(
    comparisonBaseline,
    qualified,
    candidateContractSourceHashes
  );
  const acceptanceVerdictValue = await readCanonicalJson(
    join(canonicalDirectory, reportArtifacts.acceptanceVerdict),
    "acceptance verdict"
  );
  const expectedAcceptanceVerdictBytes = `${JSON.stringify(
    expectedAcceptanceVerdict,
    undefined,
    2
  )}\n`;
  if (
    `${JSON.stringify(acceptanceVerdictValue, undefined, 2)}\n` !== expectedAcceptanceVerdictBytes
  ) {
    throw new Error("acceptance verdict does not match pairwise recomputation");
  }
  return {
    comparisonBaseline,
    acceptanceVerdict: expectedAcceptanceVerdict,
    qualified,
    freshVerification: qualifiedVerification
  };
}

async function verifyEmbeddedHistoricalReports(
  canonicalDirectory: string,
  contractSourceHashes: StackChanAttentionReplayContractSourceHashes
): Promise<EmbeddedHistoricalReports> {
  const before = await readReplayReport(
    join(canonicalDirectory, reportArtifacts.normalizedBefore),
    "historical-normalized"
  );
  const after = await readReplayReport(
    join(canonicalDirectory, reportArtifacts.normalizedAfter),
    "historical-normalized"
  );
  validateStackChanAttentionReplayReport(before, "historical-normalized", contractSourceHashes);
  validateStackChanAttentionReplayReport(after, "historical-normalized", contractSourceHashes);
  if (before.comparisonSetHash !== after.comparisonSetHash) {
    throw new Error("embedded historical comparisonSetHash mismatch");
  }
  return { before, after };
}

function evaluateAcceptanceForDistinctProducerHashes(
  baseline: StackChanAttentionReplayReport,
  candidate: StackChanAttentionReplayReport,
  candidateContractSourceHashes: StackChanAttentionReplayContractSourceHashes
): StackChanAttentionReplayAcceptanceVerdict {
  const comparableBaseline = {
    ...baseline,
    producerSourceHash: candidateContractSourceHashes.producerSourceHash
  };
  const verdict = evaluateStackChanAttentionReplayAcceptance(
    comparableBaseline,
    candidate,
    candidateContractSourceHashes
  );
  return {
    ...verdict,
    baselineCanonicalReportHash: canonicalSha256(baseline)
  };
}

async function validateOutputPaths(
  options: StackChanAttentionReplayEvidenceOptions
): Promise<void> {
  for (const [name, path] of [
    ["--output-archive", options.outputArchive],
    ["--staging-dir", options.stagingDirectory]
  ] as const) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error(`${name} must be a normalized absolute path`);
    }
    await requireAbsent(path, name);
  }
  if (!options.outputArchive.endsWith(".tar.gz")) {
    throw new Error("--output-archive must end with .tar.gz");
  }
  const outputParent = await requireCanonicalDirectory(
    dirname(options.outputArchive),
    "output archive parent"
  );
  const stagingParent = await requireCanonicalDirectory(
    dirname(options.stagingDirectory),
    "staging directory parent"
  );
  if (
    outputParent !== stagingParent &&
    pathsOverlap(options.outputArchive, options.stagingDirectory)
  ) {
    throw new Error("output archive and staging directory overlap");
  }
}

async function validateInputPaths(
  options: StackChanAttentionReplayEvidenceOptions
): Promise<StackChanAttentionReplayEvidenceOptions> {
  const entries = Object.entries(options).filter(
    ([key]) =>
      key !== "outputArchive" &&
      key !== "stagingDirectory" &&
      key !== "expectedStartAttestationSha256" &&
      key !== "expectedComparisonBaselineSha256" &&
      key !== "expectedComparisonContractSha256"
  ) as [keyof StackChanAttentionReplayEvidenceOptions, string][];
  const canonical = new Map<keyof StackChanAttentionReplayEvidenceOptions, string>();
  for (const [key, path] of entries) {
    canonical.set(key, await requireCanonicalFile(path, key));
  }
  const inputPaths = [...canonical.values()];
  if (new Set(inputPaths).size !== inputPaths.length) {
    throw new Error("attention replay evidence input paths must be distinct");
  }
  for (const inputPath of inputPaths) {
    if (
      pathsOverlap(inputPath, options.outputArchive) ||
      pathsOverlap(inputPath, options.stagingDirectory)
    ) {
      throw new Error("attention replay evidence input and output paths overlap");
    }
  }
  return { ...options, ...Object.fromEntries(canonical) };
}

async function readCanonicalJson(path: string, label: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  const value = parseJsonRejectingDuplicateKeys(raw, label);
  if (raw !== `${JSON.stringify(value, undefined, 2)}\n`) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
}

async function requireExternalFileHash(
  path: string,
  expectedSha256: string,
  label: string
): Promise<void> {
  requireHash(expectedSha256, `expected ${label} SHA-256`);
  if ((await sha256File(path)) !== expectedSha256) {
    throw new Error(`${label} does not match external SHA-256`);
  }
}

async function readReplayReport(
  path: string,
  evidenceKind: "qualified" | "historical-normalized"
): Promise<StackChanAttentionReplayReport> {
  const value = await readCanonicalJson(path, `${evidenceKind} report`);
  if (!isRecord(value) || value.schemaVersion !== 7) {
    throw new Error(`${evidenceKind} report schemaVersion mismatch`);
  }
  if (value.evidenceKind !== evidenceKind) {
    throw new Error(`${evidenceKind} report evidenceKind mismatch`);
  }
  return value as StackChanAttentionReplayReport;
}

async function readComparisonContract(
  path: string,
  expectedSha256: string
): Promise<ComparisonContract> {
  await requireExternalFileHash(path, expectedSha256, "comparison contract");
  const value = requireRecord(
    await readCanonicalJson(path, "comparison contract"),
    "comparison contract"
  );
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "qualificationId",
      "capturedAtUtc",
      "hashAlgorithm",
      "producerSources",
      "candidateMutableTestSources",
      "gateSources"
    ],
    "comparison contract"
  );
  if (value.schemaVersion !== 1 || value.hashAlgorithm !== "sha256") {
    throw new Error("comparison contract header mismatch");
  }
  const producerSources = requireArray(
    value.producerSources,
    "comparison contract.producerSources"
  ).map((source, index) => parseComparisonProducerSource(source, index));
  const candidateMutableTestSources = requireArray(
    value.candidateMutableTestSources,
    "comparison contract.candidateMutableTestSources"
  ).map((source, index) =>
    parseComparisonSource(source, index, "comparison contract.candidateMutableTestSources")
  );
  const gateSources = requireArray(value.gateSources, "comparison contract.gateSources").map(
    (source, index) => parseComparisonSource(source, index, "comparison contract.gateSources")
  );
  const producerArtifacts = [
    sourceArtifacts.picoController,
    sourceArtifacts.picoTargetCenterFilter,
    sourceArtifacts.picoRuntime,
    sourceArtifacts.picoAttentionDetection,
    sourceArtifacts.replayLanePolicy,
    sourceArtifacts.gatewayLane
  ] as const;
  const expectedProducerRoster = STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES.map(
    (role, index) => ({
      role,
      artifact: producerArtifacts[index]
    })
  );
  if (
    JSON.stringify(producerSources.map(({ role, artifact }) => ({ role, artifact }))) !==
    JSON.stringify(expectedProducerRoster)
  ) {
    throw new Error("comparison contract producer source roster mismatch");
  }
  if (
    JSON.stringify(candidateMutableTestSources.map((source) => source.artifact)) !==
    JSON.stringify([sourceArtifacts.replayLanePolicyTest, sourceArtifacts.gatewayLaneTest])
  ) {
    throw new Error("comparison contract candidate mutable test source roster mismatch");
  }
  if (
    JSON.stringify(gateSources.map((source) => source.artifact)) !==
    JSON.stringify(Object.values(gateArtifacts))
  ) {
    throw new Error("comparison contract gate source roster mismatch");
  }
  return {
    schemaVersion: 1,
    qualificationId: requireNonemptyString(
      value.qualificationId,
      "comparison contract.qualificationId"
    ),
    capturedAtUtc: requireCanonicalUtc(value.capturedAtUtc, "comparison contract.capturedAtUtc"),
    hashAlgorithm: "sha256",
    producerSources,
    candidateMutableTestSources,
    gateSources
  };
}

function parseComparisonProducerSource(
  value: unknown,
  index: number
): ComparisonContract["producerSources"][number] {
  const path = `comparison contract.producerSources[${index}]`;
  const source = requireRecord(value, path);
  assertExactKeys(source, ["role", "artifact", "sha256", "bytes"], path);
  const role = source.role;
  if (
    !STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES.includes(
      role as StackChanAttentionReplayProducerSourceRole
    )
  ) {
    throw new Error(`${path}.role mismatch`);
  }
  return {
    role: role as StackChanAttentionReplayProducerSourceRole,
    ...parseComparisonSourceDescriptor(source, path)
  };
}

function parseComparisonSource(
  value: unknown,
  index: number,
  group: "comparison contract.candidateMutableTestSources" | "comparison contract.gateSources"
): CopiedArtifact {
  const path = `${group}[${index}]`;
  const source = requireRecord(value, path);
  assertExactKeys(source, ["artifact", "sha256", "bytes"], path);
  return parseComparisonSourceDescriptor(source, path);
}

function parseComparisonSourceDescriptor(
  source: Readonly<Record<string, unknown>>,
  path: string
): CopiedArtifact {
  const artifact = requireNonemptyString(source.artifact, `${path}.artifact`);
  if (!isSafeArtifactPath(artifact)) {
    throw new Error(`${path}.artifact is unsafe`);
  }
  requireHash(source.sha256, `${path}.sha256`);
  return {
    artifact,
    sha256: source.sha256,
    bytes: requireNonnegativeInteger(source.bytes, `${path}.bytes`)
  };
}

async function readQualificationStartAttestation(
  path: string,
  expectedSha256: string
): Promise<QualificationStartAttestation> {
  requireHash(expectedSha256, "expected qualification-start attestation SHA-256");
  const raw = await readFile(path);
  if (sha256Bytes(raw) !== expectedSha256) {
    throw new Error("qualification-start attestation does not match external SHA-256");
  }
  const value = parseJsonRejectingDuplicateKeys(raw.toString("utf8"), "qualification start");
  if (raw.toString("utf8") !== `${JSON.stringify(value, undefined, 2)}\n`) {
    throw new Error("qualification start attestation must use canonical JSON bytes");
  }
  const attestation = requireRecord(value, "qualification start attestation");
  assertExactKeys(
    attestation,
    ["schemaVersion", "qualificationId", "capturedAtUtc", "hashAlgorithm", "repositories"],
    "qualification start attestation"
  );
  if (attestation.schemaVersion !== START_SCOPE_SCHEMA_VERSION) {
    throw new Error("qualification start attestation schemaVersion mismatch");
  }
  if (attestation.hashAlgorithm !== "sha256") {
    throw new Error("qualification start attestation hashAlgorithm mismatch");
  }
  const qualificationId = requireNonemptyString(
    attestation.qualificationId,
    "qualification start attestation.qualificationId"
  );
  const capturedAtUtc = requireCanonicalUtc(
    attestation.capturedAtUtc,
    "qualification start attestation.capturedAtUtc"
  );
  const repositories = requireRecord(
    attestation.repositories,
    "qualification start attestation.repositories"
  );
  assertExactKeys(
    repositories,
    ["pico", "gateway"],
    "qualification start attestation.repositories"
  );
  return {
    schemaVersion: START_SCOPE_SCHEMA_VERSION,
    qualificationId,
    capturedAtUtc,
    hashAlgorithm: "sha256",
    repositories: {
      pico: parseAttestedRepository(repositories.pico, "pico"),
      gateway: parseAttestedRepository(repositories.gateway, "gateway")
    }
  };
}

function parseAttestedRepository(value: unknown, key: RepositoryKey): AttestedRepository {
  const path = `qualification start attestation.repositories.${key}`;
  const repository = requireRecord(value, path);
  assertExactKeys(
    repository,
    [
      "repository",
      "repositoryId",
      "worktree",
      "branch",
      "headRevision",
      "originMainRevision",
      "mergeBaseRevision",
      "qualificationBaseRevision",
      "gitObservation",
      "sourceFiles"
    ],
    path
  );
  if (repository.repository !== key) {
    throw new Error(`${path}.repository mismatch`);
  }
  const sourceFiles = requireArray(repository.sourceFiles, `${path}.sourceFiles`).map(
    (candidate, index) => parseAttestedSourceFile(candidate, `${path}.sourceFiles[${index}]`)
  );
  const expectedSourcePaths = [...attestedSourcePaths[key]].sort();
  if (
    JSON.stringify(sourceFiles.map((file) => file.relativePath)) !==
    JSON.stringify(expectedSourcePaths)
  ) {
    throw new Error(`${path}.sourceFiles roster mismatch`);
  }
  return {
    repository: key,
    repositoryId: requireNonemptyString(repository.repositoryId, `${path}.repositoryId`),
    worktree: requireNormalizedAbsolutePath(repository.worktree, `${path}.worktree`),
    branch: requireNonemptyString(repository.branch, `${path}.branch`),
    headRevision: requireCommit(repository.headRevision, `${path}.headRevision`),
    originMainRevision: requireCommit(repository.originMainRevision, `${path}.originMainRevision`),
    mergeBaseRevision: requireCommit(repository.mergeBaseRevision, `${path}.mergeBaseRevision`),
    qualificationBaseRevision: requireCommit(
      repository.qualificationBaseRevision,
      `${path}.qualificationBaseRevision`
    ),
    gitObservation: parseAttestedGitObservation(
      repository.gitObservation,
      `${path}.gitObservation`
    ),
    sourceFiles
  };
}

function parseAttestedSourceFile(value: unknown, path: string): AttestedSourceFile {
  const file = requireRecord(value, path);
  assertExactKeys(file, ["relativePath", "sha256", "bytes", "trackedState"], path);
  const relativePath = requireNonemptyString(file.relativePath, `${path}.relativePath`);
  if (!isSafeArtifactPath(relativePath)) {
    throw new Error(`${path}.relativePath is unsafe`);
  }
  requireHash(file.sha256, `${path}.sha256`);
  const bytes = requireNonnegativeInteger(file.bytes, `${path}.bytes`);
  if (file.trackedState !== "tracked" && file.trackedState !== "untracked") {
    throw new Error(`${path}.trackedState is invalid`);
  }
  return {
    relativePath,
    sha256: file.sha256,
    bytes,
    trackedState: file.trackedState
  };
}

function parseAttestedGitObservation(
  value: unknown,
  path: string
): AttestedRepository["gitObservation"] {
  const observation = requireRecord(value, path);
  assertExactKeys(
    observation,
    ["porcelainV1Z", "binaryDiff", "diffNames", "untrackedManifest"],
    path
  );
  const untrackedManifest = requireRecord(
    observation.untrackedManifest,
    `${path}.untrackedManifest`
  );
  assertExactKeys(untrackedManifest, ["sha256", "bytes", "files"], `${path}.untrackedManifest`);
  const files = requireArray(untrackedManifest.files, `${path}.untrackedManifest.files`).map(
    (candidate, index) =>
      parseAttestedUntrackedFile(candidate, `${path}.untrackedManifest.files[${index}]`)
  );
  if (
    JSON.stringify(files.map((file) => file.relativePath)) !==
    JSON.stringify(files.map((file) => file.relativePath).sort())
  ) {
    throw new Error(`${path}.untrackedManifest.files must be sorted`);
  }
  return {
    porcelainV1Z: parseAttestedGitValue(observation.porcelainV1Z, `${path}.porcelainV1Z`),
    binaryDiff: parseAttestedGitValue(observation.binaryDiff, `${path}.binaryDiff`),
    diffNames: parseAttestedGitValue(observation.diffNames, `${path}.diffNames`),
    untrackedManifest: {
      ...parseAttestedGitValue(untrackedManifest, `${path}.untrackedManifest`, ["files"]),
      files
    }
  };
}

function parseAttestedGitValue(
  value: unknown,
  path: string,
  additionalKeys: readonly string[] = []
): AttestedGitValue {
  const record = requireRecord(value, path);
  assertExactKeys(record, ["sha256", "bytes", ...additionalKeys], path);
  requireHash(record.sha256, `${path}.sha256`);
  return {
    sha256: record.sha256,
    bytes: requireNonnegativeInteger(record.bytes, `${path}.bytes`)
  };
}

function parseAttestedUntrackedFile(value: unknown, path: string): AttestedUntrackedFile {
  const file = requireRecord(value, path);
  assertExactKeys(file, ["relativePath", "sha256", "bytes", "mode"], path);
  const relativePath = requireNonemptyString(file.relativePath, `${path}.relativePath`);
  if (!isSafeArtifactPath(relativePath)) {
    throw new Error(`${path}.relativePath is unsafe`);
  }
  requireHash(file.sha256, `${path}.sha256`);
  const mode = requireNonnegativeInteger(file.mode, `${path}.mode`);
  if (mode > 0o777) {
    throw new Error(`${path}.mode is invalid`);
  }
  return {
    relativePath,
    sha256: file.sha256,
    bytes: requireNonnegativeInteger(file.bytes, `${path}.bytes`),
    mode
  };
}

function startScopeFromAttestation(
  attestation: QualificationStartAttestation
): QualificationStartScope {
  const createRepository = (repository: AttestedRepository): StartRepositoryScope => ({
    worktree: repository.worktree,
    branch: repository.branch,
    baseRevision: repository.qualificationBaseRevision,
    productionHashes: Object.fromEntries(
      repository.sourceFiles.map((file) => [file.relativePath, file.sha256])
    )
  });
  return {
    schemaVersion: START_SCOPE_SCHEMA_VERSION,
    repositories: {
      pico: createRepository(attestation.repositories.pico),
      gateway: createRepository(attestation.repositories.gateway)
    }
  };
}

async function assertWorktreesMatchStartAttestation(
  attestation: QualificationStartAttestation
): Promise<void> {
  const current = {
    pico: await inspectAttestedRepository(
      "pico",
      attestation.repositories.pico.worktree,
      attestedSourcePaths.pico
    ),
    gateway: await inspectAttestedRepository(
      "gateway",
      attestation.repositories.gateway.worktree,
      attestedSourcePaths.gateway
    )
  };
  for (const key of ["pico", "gateway"] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(attestation.repositories[key])) {
      throw new Error(`${key} worktree does not match qualification-start attestation`);
    }
  }
}

async function readRepositoryInspection(
  path: string,
  key: RepositoryKey,
  start: AttestedRepository
): Promise<RepositoryInspection> {
  const value = await readCanonicalJson(path, `${key} Git inspection`);
  const inspection = requireRecord(value, `${key} Git inspection`);
  assertExactKeys(
    inspection,
    ["schemaVersion", "repository", "attestation"],
    `${key} Git inspection`
  );
  if (inspection.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`${key} Git inspection schemaVersion mismatch`);
  }
  if (inspection.repository !== key) {
    throw new Error(`${key} Git inspection repository mismatch`);
  }
  const parsed = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: key,
    attestation: parseAttestedRepository(inspection.attestation, key)
  } satisfies RepositoryInspection;
  if (JSON.stringify(parsed.attestation) !== JSON.stringify(start)) {
    throw new Error(`${key} Git inspection does not match qualification-start attestation`);
  }
  return parsed;
}

function requireNormalizedAbsolutePath(value: unknown, path: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${path} must be a normalized absolute path`);
  }
  return value;
}

function requireNonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} is invalid`);
  }
  return value;
}

function requireCommit(value: unknown, path: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${path} is invalid`);
  }
  return value;
}

async function validateScopePaths(
  scope: QualificationStartScope,
  inputs: StackChanAttentionReplayEvidenceOptions
): Promise<void> {
  const picoWorktree = await requireCanonicalDirectory(
    scope.repositories.pico.worktree,
    "Pico worktree"
  );
  const gatewayWorktree = await requireCanonicalDirectory(
    scope.repositories.gateway.worktree,
    "Gateway worktree"
  );
  const expectedPaths = [
    [inputs.picoControllerSource, join(picoWorktree, productionRelativePaths.picoController)],
    [
      inputs.picoTargetCenterFilterSource,
      join(picoWorktree, productionRelativePaths.picoTargetCenterFilter)
    ],
    [inputs.picoRuntimeSource, join(picoWorktree, productionRelativePaths.picoRuntime)],
    [
      inputs.picoAttentionDetectionSource,
      join(picoWorktree, productionRelativePaths.picoAttentionDetection)
    ],
    [inputs.gatewayLaneSource, join(gatewayWorktree, productionRelativePaths.gatewayLane)],
    [inputs.gatewayLaneTestSource, join(gatewayWorktree, productionRelativePaths.gatewayLaneTest)],
    [
      inputs.gatewayPackageInitSource,
      join(gatewayWorktree, productionRelativePaths.gatewayPackageInit)
    ],
    [
      inputs.gatewayWifiPowerSaveSource,
      join(gatewayWorktree, productionRelativePaths.gatewayWifiPowerSave)
    ],
    [
      inputs.gatewayPyprojectSource,
      join(gatewayWorktree, productionRelativePaths.gatewayPyproject)
    ],
    [inputs.gatewayUvLockSource, join(gatewayWorktree, productionRelativePaths.gatewayUvLock)],
    [
      inputs.replayProducerSource,
      join(picoWorktree, "scripts/field/stackchan-attention-replay.ts")
    ],
    [inputs.attentionMetricsSource, join(picoWorktree, gateRelativePaths.attentionMetrics)],
    [inputs.replayLanePolicySource, join(picoWorktree, gateRelativePaths.replayLanePolicy)],
    [inputs.replayLanePolicyTestSource, join(picoWorktree, gateRelativePaths.replayLanePolicyTest)],
    [
      inputs.replayEvidenceBuilderSource,
      join(picoWorktree, "scripts/field/stackchan-attention-replay-evidence.ts")
    ],
    [
      inputs.replayReportSchemaSource,
      join(picoWorktree, "scripts/field/stackchan-attention-replay-report.schema.json")
    ],
    [
      inputs.replaySchemaSource,
      join(picoWorktree, "scripts/field/stackchan-attention-replay-schema.ts")
    ],
    [
      inputs.replayGateTestSource,
      join(picoWorktree, "tests/stackchan-attention-replay-gate.test.ts")
    ],
    [
      inputs.replayFieldTestSource,
      join(picoWorktree, "tests/stackchan-attention-replay-field.test.ts")
    ],
    [
      inputs.replayEvidenceTestSource,
      join(picoWorktree, "tests/stackchan-attention-replay-evidence.test.ts")
    ]
  ] as const;
  for (const [actual, expected] of expectedPaths) {
    if (actual !== expected) {
      throw new Error(`production source path ambiguity: expected ${expected}`);
    }
  }
  for (const output of [inputs.outputArchive, inputs.stagingDirectory]) {
    if (isPathWithin(output, picoWorktree) || isPathWithin(output, gatewayWorktree)) {
      throw new Error("evidence outputs must be outside production worktrees");
    }
  }
}

async function verifyGateContractHashes(
  report: StackChanAttentionReplayReport,
  inputs: Pick<
    StackChanAttentionReplayEvidenceOptions,
    "replayProducerSource" | "replayReportSchemaSource"
  >
): Promise<GateContractHashes> {
  const metricImplementationHash = await sha256File(inputs.replayProducerSource);
  if (metricImplementationHash !== report.metricImplementationHash) {
    throw new Error("gate producer metricImplementationHash mismatch");
  }
  const schemaValue = parseJsonRejectingDuplicateKeys(
    await readFile(inputs.replayReportSchemaSource, "utf8"),
    "gate producer report schema"
  );
  if (!isRecord(schemaValue)) {
    throw new Error("gate producer report schema must be an object");
  }
  const reportSchemaHash = stackChanAttentionReplaySchemaHash(schemaValue);
  if (reportSchemaHash !== report.reportSchemaHash) {
    throw new Error("gate producer reportSchemaHash mismatch");
  }
  const eventSchemaHash = stackChanAttentionReplayEventSchemaHash(schemaValue);
  if (eventSchemaHash !== report.eventSchemaHash) {
    throw new Error("gate producer eventSchemaHash mismatch");
  }
  return {
    metricImplementationHash: {
      report: report.metricImplementationHash,
      computed: metricImplementationHash
    },
    reportSchemaHash: {
      report: report.reportSchemaHash,
      computed: reportSchemaHash
    },
    eventSchemaHash: {
      report: report.eventSchemaHash,
      computed: eventSchemaHash
    }
  };
}

async function describeGateArtifacts(
  stagingDirectory: string
): Promise<Readonly<Record<string, CopiedArtifact>>> {
  return describeArtifacts(stagingDirectory, [
    ...Object.values(gateArtifacts),
    ...Object.values(portableArtifacts)
  ]);
}

async function describeReviewArtifacts(
  stagingDirectory: string
): Promise<Readonly<Record<string, CopiedArtifact>>> {
  return describeArtifacts(stagingDirectory, [
    ...Object.values(reportArtifacts),
    ...Object.values(logArtifacts),
    ...Object.values(inputArtifacts),
    ...Object.values(gitInspectionArtifacts)
  ]);
}

async function describeArtifacts(
  stagingDirectory: string,
  artifacts: readonly string[]
): Promise<Readonly<Record<string, CopiedArtifact>>> {
  const result: Record<string, CopiedArtifact> = {};
  for (const artifact of artifacts) {
    const path = join(stagingDirectory, artifact);
    result[artifact] = {
      artifact,
      sha256: await sha256File(path),
      bytes: (await stat(path)).size
    };
  }
  return result;
}

function assertStartHashes(
  scope: QualificationStartScope,
  hashes: {
    readonly picoController: string;
    readonly picoTargetCenterFilter: string;
    readonly picoRuntime: string;
    readonly picoAttentionDetection: string;
    readonly replayLanePolicy: string;
    readonly gatewayLane: string;
  }
): void {
  const pairs = [
    [
      scope.repositories.pico.productionHashes[productionRelativePaths.picoController],
      hashes.picoController
    ],
    [
      scope.repositories.pico.productionHashes[productionRelativePaths.picoTargetCenterFilter],
      hashes.picoTargetCenterFilter
    ],
    [
      scope.repositories.pico.productionHashes[productionRelativePaths.picoRuntime],
      hashes.picoRuntime
    ],
    [
      scope.repositories.pico.productionHashes[productionRelativePaths.picoAttentionDetection],
      hashes.picoAttentionDetection
    ],
    [
      scope.repositories.pico.productionHashes[gateRelativePaths.replayLanePolicy],
      hashes.replayLanePolicy
    ],
    [
      scope.repositories.gateway.productionHashes[productionRelativePaths.gatewayLane],
      hashes.gatewayLane
    ]
  ] as const;
  if (pairs.some(([start, current]) => start !== current)) {
    throw new Error("qualification-start source hash mismatch");
  }
}

async function assertEmbeddedSourcesMatchAttestation(
  attestation: QualificationStartAttestation,
  stagingDirectory: string
): Promise<void> {
  const picoArtifacts: Readonly<Record<string, string>> = {
    [productionRelativePaths.picoController]: sourceArtifacts.picoController,
    [productionRelativePaths.picoTargetCenterFilter]: sourceArtifacts.picoTargetCenterFilter,
    [productionRelativePaths.picoRuntime]: sourceArtifacts.picoRuntime,
    [productionRelativePaths.picoAttentionDetection]: sourceArtifacts.picoAttentionDetection,
    [gateRelativePaths.replayProducer]: gateArtifacts.replayProducer,
    [gateRelativePaths.attentionMetrics]: gateArtifacts.attentionMetrics,
    [gateRelativePaths.replayLanePolicy]: sourceArtifacts.replayLanePolicy,
    [gateRelativePaths.replayLanePolicyTest]: sourceArtifacts.replayLanePolicyTest,
    [gateRelativePaths.replayEvidenceBuilder]: gateArtifacts.replayEvidenceBuilder,
    [gateRelativePaths.replayReportSchema]: gateArtifacts.replayReportSchema,
    [gateRelativePaths.replaySchema]: gateArtifacts.replaySchema,
    [gateRelativePaths.replayGateTest]: gateArtifacts.replayGateTest,
    [gateRelativePaths.replayFieldTest]: gateArtifacts.replayFieldTest,
    [gateRelativePaths.replayEvidenceTest]: gateArtifacts.replayEvidenceTest,
    [gateRelativePaths.packageJson]: gateArtifacts.packageJson,
    [gateRelativePaths.packageLock]: gateArtifacts.packageLock
  };
  const gatewayArtifacts: Readonly<Record<string, string>> = {
    [productionRelativePaths.gatewayLane]: sourceArtifacts.gatewayLane,
    [productionRelativePaths.gatewayLaneTest]: sourceArtifacts.gatewayLaneTest,
    [productionRelativePaths.gatewayPackageInit]: gateArtifacts.gatewayPackageInit,
    [productionRelativePaths.gatewayWifiPowerSave]: gateArtifacts.gatewayWifiPowerSave,
    [productionRelativePaths.gatewayPyproject]: gateArtifacts.gatewayPyproject,
    [productionRelativePaths.gatewayUvLock]: gateArtifacts.gatewayUvLock
  };
  for (const [repository, artifacts] of [
    [attestation.repositories.pico, picoArtifacts],
    [attestation.repositories.gateway, gatewayArtifacts]
  ] as const) {
    for (const source of repository.sourceFiles) {
      const artifact = artifacts[source.relativePath];
      if (artifact === undefined) {
        throw new Error(`${repository.repository} attested source artifact mapping is missing`);
      }
      const path = join(stagingDirectory, artifact);
      const fileStatus = await stat(path);
      if (fileStatus.size !== source.bytes || (await sha256File(path)) !== source.sha256) {
        throw new Error(
          `${repository.repository} embedded source does not match qualification-start attestation`
        );
      }
    }
  }
}

async function inspectAttestedRepository(
  key: RepositoryKey,
  worktree: string,
  sourcePaths: readonly string[]
): Promise<AttestedRepository> {
  const headRevision = await gitOutput(worktree, ["rev-parse", "HEAD"]);
  const originMainRevision = await gitOutput(worktree, ["rev-parse", "origin/main"]);
  const porcelainV1Z = await gitRawOutput(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  const binaryDiff = await gitRawOutput(worktree, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-renames",
    headRevision,
    "--"
  ]);
  const diffNames = await gitRawOutput(worktree, [
    "diff",
    "--name-only",
    "--no-renames",
    headRevision,
    "--"
  ]);
  const untrackedPaths = (
    await gitRawOutput(worktree, ["ls-files", "--others", "-z", "--exclude-standard"])
  )
    .split("\0")
    .filter((path) => path !== "")
    .sort();
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (relativePath): Promise<AttestedUntrackedFile> => {
      if (!isSafeArtifactPath(relativePath)) {
        throw new Error(`${key} has unsafe untracked path: ${relativePath}`);
      }
      const path = join(worktree, relativePath);
      const fileStatus = await lstat(path);
      if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
        throw new Error(`${key} untracked path must be a regular file: ${relativePath}`);
      }
      return {
        relativePath,
        sha256: await sha256File(path),
        bytes: fileStatus.size,
        mode: fileStatus.mode & 0o777
      };
    })
  );
  const untrackedManifestBytes = Buffer.from(`${JSON.stringify(untrackedFiles, undefined, 2)}\n`);
  return {
    repository: key,
    repositoryId: sanitizeRepositoryId(await gitOutput(worktree, ["remote", "get-url", "origin"])),
    worktree,
    branch: await gitOutput(worktree, ["branch", "--show-current"]),
    headRevision,
    originMainRevision,
    mergeBaseRevision: await gitOutput(worktree, ["merge-base", headRevision, originMainRevision]),
    qualificationBaseRevision: headRevision,
    gitObservation: {
      porcelainV1Z: describeBytes(Buffer.from(porcelainV1Z)),
      binaryDiff: describeBytes(Buffer.from(binaryDiff)),
      diffNames: describeBytes(Buffer.from(diffNames)),
      untrackedManifest: {
        ...describeBytes(untrackedManifestBytes),
        files: untrackedFiles
      }
    },
    sourceFiles: await Promise.all(
      [...sourcePaths].sort().map((relativePath) => attestSourceFile(worktree, relativePath))
    )
  };
}

function sanitizeRepositoryId(remote: string): string {
  if (!remote.includes("://")) {
    return remote;
  }
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error("origin remote URL is invalid");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function attestSourceFile(
  worktree: string,
  relativePath: string
): Promise<AttestedSourceFile> {
  if (!isSafeArtifactPath(relativePath)) {
    throw new Error(`unsafe attested source path: ${relativePath}`);
  }
  const path = join(worktree, relativePath);
  const fileStatus = await lstat(path);
  if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
    throw new Error(`attested source must be a regular file: ${relativePath}`);
  }
  const tracked = await gitOutput(worktree, ["ls-files", "--cached", "--", relativePath]);
  return {
    relativePath,
    sha256: await sha256File(path),
    bytes: fileStatus.size,
    trackedState: tracked === relativePath ? "tracked" : "untracked"
  };
}

function describeBytes(value: Buffer): AttestedGitValue {
  return {
    sha256: sha256Bytes(value),
    bytes: value.byteLength
  };
}

function createRepositoryScope(
  key: RepositoryKey,
  start: StartRepositoryScope,
  files: readonly {
    readonly relativePath: string;
    readonly artifact: string;
    readonly currentSha256: string;
  }[],
  attestation: AttestedRepository
): RepositoryScope {
  if (
    attestation.repository !== key ||
    attestation.worktree !== start.worktree ||
    attestation.branch !== start.branch ||
    attestation.qualificationBaseRevision !== start.baseRevision
  ) {
    throw new Error(`${key} repository attestation does not match qualification start`);
  }
  const productionFiles = files.map((file): ProductionFileScope => {
    const startSha256 = start.productionHashes[file.relativePath];
    if (startSha256 === undefined) {
      throw new Error(`${key} start production hash is missing`);
    }
    const preserved = startSha256 === file.currentSha256;
    if (!preserved) {
      throw new Error(`${key} qualification-start hash mismatch`);
    }
    return {
      ...file,
      startSha256,
      preserved
    };
  });
  return {
    repositoryId: attestation.repositoryId,
    worktree: start.worktree,
    branch: start.branch,
    qualificationBaseRevision: start.baseRevision,
    headRevision: attestation.headRevision,
    originMainRevision: attestation.originMainRevision,
    mergeBaseRevision: attestation.mergeBaseRevision,
    productionFiles,
    gitObservation: attestation.gitObservation
  };
}

async function copyInputArtifacts(
  options: StackChanAttentionReplayEvidenceOptions
): Promise<Readonly<Record<string, CopiedArtifact>>> {
  const copies = {
    [sourceArtifacts.picoController]: options.picoControllerSource,
    [sourceArtifacts.picoTargetCenterFilter]: options.picoTargetCenterFilterSource,
    [sourceArtifacts.picoRuntime]: options.picoRuntimeSource,
    [sourceArtifacts.picoAttentionDetection]: options.picoAttentionDetectionSource,
    [sourceArtifacts.replayLanePolicy]: options.replayLanePolicySource,
    [sourceArtifacts.replayLanePolicyTest]: options.replayLanePolicyTestSource,
    [sourceArtifacts.gatewayLane]: options.gatewayLaneSource,
    [sourceArtifacts.gatewayLaneTest]: options.gatewayLaneTestSource,
    [gateArtifacts.gatewayPackageInit]: options.gatewayPackageInitSource,
    [gateArtifacts.gatewayWifiPowerSave]: options.gatewayWifiPowerSaveSource,
    [gateArtifacts.gatewayPyproject]: options.gatewayPyprojectSource,
    [gateArtifacts.gatewayUvLock]: options.gatewayUvLockSource,
    [gateArtifacts.replayProducer]: options.replayProducerSource,
    [gateArtifacts.attentionMetrics]: options.attentionMetricsSource,
    [gateArtifacts.replayEvidenceBuilder]: options.replayEvidenceBuilderSource,
    [gateArtifacts.replayReportSchema]: options.replayReportSchemaSource,
    [gateArtifacts.replaySchema]: options.replaySchemaSource,
    [gateArtifacts.replayGateTest]: options.replayGateTestSource,
    [gateArtifacts.replayFieldTest]: options.replayFieldTestSource,
    [gateArtifacts.replayEvidenceTest]: options.replayEvidenceTestSource,
    [gateArtifacts.packageJson]: join(
      dirname(dirname(dirname(options.replayProducerSource))),
      "package.json"
    ),
    [gateArtifacts.packageLock]: join(
      dirname(dirname(dirname(options.replayProducerSource))),
      "package-lock.json"
    ),
    [reportArtifacts.comparisonBaseline]: options.comparisonBaselineReport,
    [reportArtifacts.qualified]: options.qualifiedReport,
    [reportArtifacts.normalizedBefore]: options.normalizedBeforeReport,
    [reportArtifacts.normalizedAfter]: options.normalizedAfterReport,
    [logArtifacts.focusedPico]: options.focusedPicoLog,
    [logArtifacts.fullPico]: options.fullPicoLog,
    [logArtifacts.gateway]: options.gatewayLog,
    [logArtifacts.secretlint]: options.secretlintLog,
    [logArtifacts.diffCheck]: options.diffCheckLog,
    [inputArtifacts.qualificationStartAttestation]: options.qualificationStartAttestation,
    [inputArtifacts.comparisonContract]: options.comparisonContract
  } as const;
  await assertCredentialFreeLogs(
    Object.entries(copies)
      .filter(([artifact]) => artifact.startsWith("logs/"))
      .map(([, source]) => source)
  );
  const results: Record<string, CopiedArtifact> = {};
  for (const [artifact, source] of Object.entries(copies).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const destination = join(options.stagingDirectory, artifact);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const sourceHash = await sha256File(source);
    const copiedHash = await sha256File(destination);
    if (sourceHash !== copiedHash) {
      throw new Error(`copied artifact hash mismatch: ${artifact}`);
    }
    results[artifact] = {
      artifact,
      sha256: copiedHash,
      bytes: (await stat(destination)).size
    };
  }
  return results;
}

async function assertCredentialFreeLogs(sources: readonly string[]): Promise<void> {
  try {
    await execFileAsync(
      SECRETLINT_EXECUTABLE,
      [
        "--no-color",
        "--no-terminalLink",
        "--no-gitignore",
        "--no-glob",
        "--secretlintrc",
        SECRETLINT_CONFIG,
        ...sources
      ],
      { cwd: PROJECT_ROOT }
    );
  } catch {
    throw new Error("verification logs failed the required secretlint scan");
  }
}

async function writeRepositoryInspections(
  stagingDirectory: string,
  inspections: Readonly<Record<RepositoryKey, RepositoryInspection>>
): Promise<void> {
  for (const key of ["pico", "gateway"] as const) {
    const path = join(stagingDirectory, gitInspectionArtifacts[key]);
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, inspections[key]);
  }
}

async function writePortableVerifier(
  stagingDirectory: string,
  evidenceBuilderSource: string
): Promise<void> {
  const esbuildModuleName = "esbuild";
  const esbuild = (await import(esbuildModuleName)) as {
    readonly build: (options: BuildOptions) => Promise<BuildResult>;
  };
  await esbuild.build({
    entryPoints: [evidenceBuilderSource],
    outfile: join(stagingDirectory, portableArtifacts.verifier),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "bundle",
    legalComments: "none",
    logLevel: "silent"
  });
  const sourceSchema = join(
    dirname(evidenceBuilderSource),
    basename(gateArtifacts.replayReportSchema)
  );
  const portableSchema = join(stagingDirectory, portableArtifacts.replayReportSchema);
  await copyFile(sourceSchema, portableSchema);
  if ((await readFile(sourceSchema)).compare(await readFile(portableSchema)) !== 0) {
    throw new Error("portable replay report schema copy mismatch");
  }
}

function createProducerSourceManifest(
  aggregateSha256: string,
  reportProducerSourceHash: string,
  artifacts: Readonly<Record<string, CopiedArtifact>>
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    algorithm: "sha256(role + NUL + raw bytes + NUL)",
    order: [...STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES],
    aggregateSha256,
    reportProducerSourceHash,
    inputs: [
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[0],
        ...requireArtifact(artifacts, sourceArtifacts.picoController)
      },
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[1],
        ...requireArtifact(artifacts, sourceArtifacts.picoTargetCenterFilter)
      },
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[2],
        ...requireArtifact(artifacts, sourceArtifacts.picoRuntime)
      },
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[3],
        ...requireArtifact(artifacts, sourceArtifacts.picoAttentionDetection)
      },
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[4],
        ...requireArtifact(artifacts, sourceArtifacts.replayLanePolicy)
      },
      {
        role: STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[5],
        ...requireArtifact(artifacts, sourceArtifacts.gatewayLane)
      }
    ]
  };
}

function createGateProducerManifest(
  contractHashes: GateContractHashes,
  artifacts: Readonly<Record<string, CopiedArtifact>>
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    contractHashes,
    portableVerification: {
      verifier: requireArtifact(artifacts, portableArtifacts.verifier),
      reportSchema: requireArtifact(artifacts, portableArtifacts.replayReportSchema),
      runtime: "Node.js >=24",
      externalDependencies: []
    },
    snapshots: [
      requireArtifact(artifacts, gateArtifacts.replayProducer),
      requireArtifact(artifacts, gateArtifacts.attentionMetrics),
      requireArtifact(artifacts, gateArtifacts.replayEvidenceBuilder),
      requireArtifact(artifacts, gateArtifacts.replayReportSchema),
      requireArtifact(artifacts, gateArtifacts.replaySchema),
      requireArtifact(artifacts, gateArtifacts.replayGateTest),
      requireArtifact(artifacts, gateArtifacts.replayFieldTest),
      requireArtifact(artifacts, gateArtifacts.replayEvidenceTest),
      requireArtifact(artifacts, gateArtifacts.packageJson),
      requireArtifact(artifacts, gateArtifacts.packageLock),
      requireArtifact(artifacts, gateArtifacts.gatewayPackageInit),
      requireArtifact(artifacts, gateArtifacts.gatewayWifiPowerSave),
      requireArtifact(artifacts, gateArtifacts.gatewayPyproject),
      requireArtifact(artifacts, gateArtifacts.gatewayUvLock)
    ]
  };
}

function createLogHashRecord(
  artifacts: Readonly<Record<string, CopiedArtifact>>
): Readonly<Record<string, CopiedArtifact>> {
  return {
    focusedPico: requireArtifact(artifacts, logArtifacts.focusedPico),
    fullPico: requireArtifact(artifacts, logArtifacts.fullPico),
    gateway: requireArtifact(artifacts, logArtifacts.gateway),
    secretlint: requireArtifact(artifacts, logArtifacts.secretlint),
    diffCheck: requireArtifact(artifacts, logArtifacts.diffCheck)
  };
}

function createProductionScope(
  repositoryScopes: { readonly pico: RepositoryScope; readonly gateway: RepositoryScope },
  artifacts: Readonly<Record<string, CopiedArtifact>>
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repositories: repositoryScopes,
    gitInspectionArtifacts: {
      pico: requireArtifact(artifacts, gitInspectionArtifacts.pico),
      gateway: requireArtifact(artifacts, gitInspectionArtifacts.gateway)
    },
    verificationLogs: createLogHashRecord(artifacts),
    qualificationStartAttestation: requireArtifact(
      artifacts,
      inputArtifacts.qualificationStartAttestation
    ),
    comparisonContract: requireArtifact(artifacts, inputArtifacts.comparisonContract),
    comparisonBaseline: requireArtifact(artifacts, reportArtifacts.comparisonBaseline),
    candidateMutableArtifacts: [...candidateMutableArtifacts],
    externalStartAttestationPinRequired: true,
    externalComparisonBaselinePinRequired: true,
    externalComparisonContractPinRequired: true,
    allQualificationStartScopedProductionSourcesPreserved: true
  };
}

function createReviewManifest(
  qualified: StackChanAttentionReplayReport,
  comparisonBaseline: StackChanAttentionReplayReport,
  acceptanceVerdict: StackChanAttentionReplayAcceptanceVerdict,
  before: StackChanAttentionReplayReport,
  after: StackChanAttentionReplayReport,
  artifacts: Readonly<Record<string, CopiedArtifact>>,
  producerAggregate: string,
  productionScope: Readonly<Record<string, unknown>>,
  freshVerification: QualifiedReportVerification
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    instruction: "face-follow-replay-gate-qualification",
    externalTrustAnchors: {
      qualificationStartAttestationSha256: requireArtifact(
        artifacts,
        inputArtifacts.qualificationStartAttestation
      ).sha256,
      comparisonBaselineSha256: requireArtifact(artifacts, reportArtifacts.comparisonBaseline)
        .sha256,
      comparisonContractSha256: requireArtifact(artifacts, inputArtifacts.comparisonContract).sha256
    },
    reports: {
      comparisonBaseline: {
        ...requireArtifact(artifacts, reportArtifacts.comparisonBaseline),
        schemaVersion: comparisonBaseline.schemaVersion,
        evidenceKind: comparisonBaseline.evidenceKind,
        status: comparisonBaseline.status,
        comparisonSetHash: comparisonBaseline.comparisonSetHash,
        producerSourceHash: comparisonBaseline.producerSourceHash
      },
      acceptanceVerdict: {
        ...requireArtifact(artifacts, reportArtifacts.acceptanceVerdict),
        verdictVersion: acceptanceVerdict.verdictVersion,
        status: acceptanceVerdict.status,
        acceptanceProfileVersion: acceptanceVerdict.acceptanceProfileVersion,
        acceptanceCheckCount: acceptanceVerdict.checks.length,
        acceptanceProfileHash: acceptanceVerdict.acceptanceProfileHash,
        baselineCanonicalReportHash: acceptanceVerdict.baselineCanonicalReportHash,
        candidateCanonicalReportHash: acceptanceVerdict.candidateCanonicalReportHash
      },
      qualified: {
        ...requireArtifact(artifacts, reportArtifacts.qualified),
        schemaVersion: qualified.schemaVersion,
        evidenceKind: qualified.evidenceKind,
        status: qualified.status,
        comparisonSetHash: qualified.comparisonSetHash,
        producerSourceHash: qualified.producerSourceHash
      },
      qualifiedFreshRerun: {
        ...requireArtifact(artifacts, reportArtifacts.qualifiedFreshRerun),
        requestedRepeat: 3,
        producerSourceHash: freshVerification.freshReport.producerSourceHash,
        candidateRawSha256: requireArtifact(artifacts, reportArtifacts.qualified).sha256,
        freshRawSha256: requireArtifact(artifacts, reportArtifacts.qualifiedFreshRerun).sha256,
        rawEqual:
          requireArtifact(artifacts, reportArtifacts.qualified).sha256 ===
          requireArtifact(artifacts, reportArtifacts.qualifiedFreshRerun).sha256,
        candidateCanonicalSha256: freshVerification.candidateCanonicalSha256,
        freshCanonicalSha256: freshVerification.freshCanonicalSha256,
        canonicalEqual:
          freshVerification.candidateCanonicalSha256 === freshVerification.freshCanonicalSha256
      },
      normalizedBefore: {
        ...requireArtifact(artifacts, reportArtifacts.normalizedBefore),
        schemaVersion: before.schemaVersion,
        evidenceKind: before.evidenceKind,
        status: before.status,
        comparisonSetHash: before.comparisonSetHash
      },
      normalizedAfter: {
        ...requireArtifact(artifacts, reportArtifacts.normalizedAfter),
        schemaVersion: after.schemaVersion,
        evidenceKind: after.evidenceKind,
        status: after.status,
        comparisonSetHash: after.comparisonSetHash
      }
    },
    contractHashes: {
      reportSchemaHash: qualified.reportSchemaHash,
      eventSchemaHash: qualified.eventSchemaHash,
      metricDefinitionHash: qualified.metricDefinitionHash,
      metricImplementationHash: qualified.metricImplementationHash,
      acceptanceProfileHash: qualified.acceptanceProfileHash,
      fixtureHash: qualified.fixtureHash,
      scenarioInputHash: qualified.scenarioInputHash,
      comparisonSetHash: qualified.comparisonSetHash
    },
    producerSourceHash: producerAggregate,
    threatModel: {
      builderTrust: "trusted-local-single-operator",
      goal: "deterministic-regression-and-false-pass-prevention-with-review-reproducibility",
      excludedProtections: ["malicious-candidate-author", "compromised-toolchain"]
    },
    gatewayLaneVerification: {
      commands: [
        "uv run pytest tests/test_head_target_lane.py",
        "uv run ruff check stackchan_mcp/head_target_lane.py tests/test_head_target_lane.py"
      ],
      log: requireArtifact(artifacts, logArtifacts.gateway)
    },
    productionScopeSha256: sha256Bytes(
      Buffer.from(`${JSON.stringify(productionScope, undefined, 2)}\n`)
    ),
    verificationLogs: createLogHashRecord(artifacts)
  };
}

function createReadme(
  qualified: StackChanAttentionReplayReport,
  comparisonBaseline: StackChanAttentionReplayReport,
  acceptanceVerdict: StackChanAttentionReplayAcceptanceVerdict,
  before: StackChanAttentionReplayReport,
  after: StackChanAttentionReplayReport,
  repositories: { readonly pico: RepositoryScope; readonly gateway: RepositoryScope },
  artifacts: Readonly<Record<string, CopiedArtifact>>
): string {
  const sourceLines = [
    ...repositories.pico.productionFiles,
    ...repositories.gateway.productionFiles
  ]
    .map(
      (file) =>
        `- \`${file.relativePath}\`: \`${file.currentSha256}\` (preserved: ${String(file.preserved)})`
    )
    .join("\n");
  const logLines = Object.entries(createLogHashRecord(artifacts))
    .map(([name, artifact]) => `- ${name}: \`${artifact.sha256}\``)
    .join("\n");
  const freshRerun = requireArtifact(artifacts, reportArtifacts.qualifiedFreshRerun);
  const startAttestation = requireArtifact(artifacts, inputArtifacts.qualificationStartAttestation);
  const comparisonBaselineArtifact = requireArtifact(artifacts, reportArtifacts.comparisonBaseline);
  const comparisonContract = requireArtifact(artifacts, inputArtifacts.comparisonContract);
  return `# StackChan replay qualification evidence

This archive was generated from validated replay reports and exact source snapshots.
Review the machine-readable manifests before returning \`APPROVE\` or \`REQUEST_CHANGES\`.

## Threat model

The builder is a trusted local single-operator builder. The goal is deterministic regression
and false-pass prevention with review reproducibility.
This evidence is not protection from a malicious candidate author.
This evidence is not protection from a compromised toolchain.

## Report contract

- Qualified schema version: \`${qualified.schemaVersion}\`
- Qualified evidence kind: \`${qualified.evidenceKind}\`
- Qualified status: \`${qualified.status}\`
- Qualified comparison set: \`${qualified.comparisonSetHash}\`
- Qualified producer source: \`${String(qualified.producerSourceHash)}\`
- Comparison baseline producer source: \`${String(comparisonBaseline.producerSourceHash)}\`
- Pairwise acceptance verdict: \`${acceptanceVerdict.status}\`
- Pairwise baseline canonical report: \`${acceptanceVerdict.baselineCanonicalReportHash}\`
- Pairwise candidate canonical report: \`${acceptanceVerdict.candidateCanonicalReportHash}\`
- Fresh current-producer rerun: \`${freshRerun.sha256}\`
- Qualified full-report equality: \`passed\`
- Historical comparison set: \`${before.comparisonSetHash}\`
- Historical before status: \`${before.status}\`
- Historical after status: \`${after.status}\`

## Repository scope

- Pico branch: \`${repositories.pico.branch}\`
- Pico qualification base: \`${repositories.pico.qualificationBaseRevision}\`
- Pico HEAD: \`${repositories.pico.headRevision}\`
- Pico origin/main: \`${repositories.pico.originMainRevision}\`
- Pico merge-base: \`${repositories.pico.mergeBaseRevision}\`
- Gateway branch: \`${repositories.gateway.branch}\`
- Gateway qualification base: \`${repositories.gateway.qualificationBaseRevision}\`
- Gateway HEAD: \`${repositories.gateway.headRevision}\`
- Gateway origin/main: \`${repositories.gateway.originMainRevision}\`
- Gateway merge-base: \`${repositories.gateway.mergeBaseRevision}\`

${sourceLines}

## Candidate mutable allowlist

Only these four implementation-and-test artifacts may differ from the externally pinned
comparison contract:

${candidateMutableArtifacts.map((artifact) => `- \`${artifact}\``).join("\n")}

## Gateway focused lane verification

The trusted local orchestrator executes these fixed commands from the Gateway \`gateway/\`
project directory:

\`uv run pytest tests/test_head_target_lane.py\`

\`uv run ruff check stackchan_mcp/head_target_lane.py tests/test_head_target_lane.py\`

The direct immutable dependency/config closure for this lane is copied under
\`source/gateway/\`. Command output remains an explicit input at
\`${logArtifacts.gateway}\` and is checksum-bound by \`SHA256SUMS\` and the manifests.

## External trust anchor

- Qualification-start attestation: \`${startAttestation.sha256}\`
- Comparison baseline: \`${comparisonBaselineArtifact.sha256}\`
- Comparison contract: \`${comparisonContract.sha256}\`

Pass all three SHA-256 values from the out-of-archive review request to the portable verifier.
The archive copies are not substitutes for the external pins.

Run the dependency-free verifier from the extracted archive:

\`node verify-evidence.mjs verify --evidence-dir "$PWD" --expected-start-attestation-sha256 ${startAttestation.sha256} --expected-comparison-baseline-sha256 ${comparisonBaselineArtifact.sha256} --expected-comparison-contract-sha256 ${comparisonContract.sha256}\`

## Verification log hashes

${logLines}

All displayed hashes and statuses above are derived from validated input reports,
externally pinned qualification-start data, copied bytes, or build-time Git inspection.
Verify every artifact with \`SHA256SUMS\`.
`;
}

async function writeSha256Sums(stagingDirectory: string): Promise<void> {
  const files = (await listFiles(stagingDirectory)).sort();
  const lines: string[] = [];
  for (const artifact of files) {
    if (artifact.includes("\n") || artifact.includes("\r")) {
      throw new Error("artifact path contains a line break");
    }
    lines.push(`${await sha256File(join(stagingDirectory, artifact))}  ${artifact}`);
  }
  await writeFile(join(stagingDirectory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function parseSha256Sums(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of value.split("\n")) {
    if (line === "") {
      continue;
    }
    const { hash, artifact } = parseSha256SumLine(line);
    if (result.has(artifact)) {
      throw new Error("SHA256SUMS contains a duplicate artifact");
    }
    result.set(artifact, hash);
  }
  if (result.size === 0) {
    throw new Error("SHA256SUMS is empty");
  }
  return result;
}

function parseSha256SumLine(line: string): { readonly hash: string; readonly artifact: string } {
  const match = /^(?<hash>[a-f0-9]{64}) {2}(?<artifact>[^\r\n]+)$/u.exec(line);
  const hash = match?.groups?.hash;
  const artifact = match?.groups?.artifact;
  if (hash === undefined || artifact === undefined || !isSafeArtifactPath(artifact)) {
    throw new Error("SHA256SUMS is invalid");
  }
  return { hash, artifact };
}

async function writeDeterministicTarGzip(
  stagingDirectory: string,
  outputArchive: string
): Promise<void> {
  const chunks: Buffer[] = [];
  for (const artifact of (await listFiles(stagingDirectory)).sort()) {
    const content = await readFile(join(stagingDirectory, artifact));
    chunks.push(createTarHeader(artifact, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(outputArchive, gzipSync(Buffer.concat(chunks), { level: 9 }));
}

async function canonicalComparisonContractInputPaths(
  options: StackChanAttentionReplayComparisonContractOptions
): Promise<ComparisonContractSourcePaths> {
  const result = {} as Record<keyof ComparisonContractSourcePaths, string>;
  for (const key of [
    "picoControllerSource",
    "picoTargetCenterFilterSource",
    "picoRuntimeSource",
    "picoAttentionDetectionSource",
    "replayLanePolicySource",
    "replayLanePolicyTestSource",
    "gatewayLaneSource",
    "gatewayLaneTestSource",
    "gatewayPackageInitSource",
    "gatewayWifiPowerSaveSource",
    "gatewayPyprojectSource",
    "gatewayUvLockSource",
    "replayProducerSource",
    "attentionMetricsSource",
    "replayEvidenceBuilderSource",
    "replayReportSchemaSource",
    "replaySchemaSource",
    "replayGateTestSource",
    "replayFieldTestSource",
    "replayEvidenceTestSource",
    "packageJsonSource",
    "packageLockSource"
  ] as const) {
    result[key] = await requireCanonicalFile(options[key], key);
  }
  return result;
}

async function describeComparisonProducerSources(
  paths: ComparisonContractSourcePaths
): Promise<ComparisonContract["producerSources"]> {
  return Promise.all([
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[0],
      sourceArtifacts.picoController,
      paths.picoControllerSource
    ),
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[1],
      sourceArtifacts.picoTargetCenterFilter,
      paths.picoTargetCenterFilterSource
    ),
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[2],
      sourceArtifacts.picoRuntime,
      paths.picoRuntimeSource
    ),
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[3],
      sourceArtifacts.picoAttentionDetection,
      paths.picoAttentionDetectionSource
    ),
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[4],
      sourceArtifacts.replayLanePolicy,
      paths.replayLanePolicySource
    ),
    describeComparisonProducerSource(
      STACKCHAN_ATTENTION_REPLAY_PRODUCER_SOURCE_ROLES[5],
      sourceArtifacts.gatewayLane,
      paths.gatewayLaneSource
    )
  ]);
}

async function describeComparisonProducerSource(
  role: StackChanAttentionReplayProducerSourceRole,
  artifact: string,
  path: string
): Promise<ComparisonContract["producerSources"][number]> {
  return {
    role,
    ...(await describeSourcePath(artifact, path))
  };
}

async function describeCandidateMutableTestSources(
  paths: ComparisonContractSourcePaths
): Promise<ComparisonContract["candidateMutableTestSources"]> {
  return Promise.all([
    describeSourcePath(sourceArtifacts.replayLanePolicyTest, paths.replayLanePolicyTestSource),
    describeSourcePath(sourceArtifacts.gatewayLaneTest, paths.gatewayLaneTestSource)
  ]);
}

async function describeComparisonGateSources(
  paths: ComparisonContractSourcePaths
): Promise<ComparisonContract["gateSources"]> {
  return Promise.all([
    describeSourcePath(gateArtifacts.replayProducer, paths.replayProducerSource),
    describeSourcePath(gateArtifacts.attentionMetrics, paths.attentionMetricsSource),
    describeSourcePath(gateArtifacts.replayEvidenceBuilder, paths.replayEvidenceBuilderSource),
    describeSourcePath(gateArtifacts.replayReportSchema, paths.replayReportSchemaSource),
    describeSourcePath(gateArtifacts.replaySchema, paths.replaySchemaSource),
    describeSourcePath(gateArtifacts.replayGateTest, paths.replayGateTestSource),
    describeSourcePath(gateArtifacts.replayFieldTest, paths.replayFieldTestSource),
    describeSourcePath(gateArtifacts.replayEvidenceTest, paths.replayEvidenceTestSource),
    describeSourcePath(gateArtifacts.packageJson, paths.packageJsonSource),
    describeSourcePath(gateArtifacts.packageLock, paths.packageLockSource),
    describeSourcePath(gateArtifacts.gatewayPackageInit, paths.gatewayPackageInitSource),
    describeSourcePath(gateArtifacts.gatewayWifiPowerSave, paths.gatewayWifiPowerSaveSource),
    describeSourcePath(gateArtifacts.gatewayPyproject, paths.gatewayPyprojectSource),
    describeSourcePath(gateArtifacts.gatewayUvLock, paths.gatewayUvLockSource)
  ]);
}

async function describeSourcePath(artifact: string, path: string): Promise<CopiedArtifact> {
  return {
    artifact,
    sha256: await sha256File(path),
    bytes: (await stat(path)).size
  };
}

function comparisonContractPathsFromEvidenceInputs(
  inputs: StackChanAttentionReplayEvidenceOptions
): ComparisonContractSourcePaths {
  const packageRoot = dirname(dirname(dirname(inputs.replayProducerSource)));
  return {
    picoControllerSource: inputs.picoControllerSource,
    picoTargetCenterFilterSource: inputs.picoTargetCenterFilterSource,
    picoRuntimeSource: inputs.picoRuntimeSource,
    picoAttentionDetectionSource: inputs.picoAttentionDetectionSource,
    replayLanePolicySource: inputs.replayLanePolicySource,
    replayLanePolicyTestSource: inputs.replayLanePolicyTestSource,
    gatewayLaneSource: inputs.gatewayLaneSource,
    gatewayLaneTestSource: inputs.gatewayLaneTestSource,
    gatewayPackageInitSource: inputs.gatewayPackageInitSource,
    gatewayWifiPowerSaveSource: inputs.gatewayWifiPowerSaveSource,
    gatewayPyprojectSource: inputs.gatewayPyprojectSource,
    gatewayUvLockSource: inputs.gatewayUvLockSource,
    replayProducerSource: inputs.replayProducerSource,
    attentionMetricsSource: inputs.attentionMetricsSource,
    replayEvidenceBuilderSource: inputs.replayEvidenceBuilderSource,
    replayReportSchemaSource: inputs.replayReportSchemaSource,
    replaySchemaSource: inputs.replaySchemaSource,
    replayGateTestSource: inputs.replayGateTestSource,
    replayFieldTestSource: inputs.replayFieldTestSource,
    replayEvidenceTestSource: inputs.replayEvidenceTestSource,
    packageJsonSource: join(packageRoot, "package.json"),
    packageLockSource: join(packageRoot, "package-lock.json")
  };
}

function comparisonContractPathsFromArchive(
  canonicalDirectory: string
): ComparisonContractSourcePaths {
  return {
    picoControllerSource: join(canonicalDirectory, sourceArtifacts.picoController),
    picoTargetCenterFilterSource: join(canonicalDirectory, sourceArtifacts.picoTargetCenterFilter),
    picoRuntimeSource: join(canonicalDirectory, sourceArtifacts.picoRuntime),
    picoAttentionDetectionSource: join(canonicalDirectory, sourceArtifacts.picoAttentionDetection),
    replayLanePolicySource: join(canonicalDirectory, sourceArtifacts.replayLanePolicy),
    replayLanePolicyTestSource: join(canonicalDirectory, sourceArtifacts.replayLanePolicyTest),
    gatewayLaneSource: join(canonicalDirectory, sourceArtifacts.gatewayLane),
    gatewayLaneTestSource: join(canonicalDirectory, sourceArtifacts.gatewayLaneTest),
    gatewayPackageInitSource: join(canonicalDirectory, gateArtifacts.gatewayPackageInit),
    gatewayWifiPowerSaveSource: join(canonicalDirectory, gateArtifacts.gatewayWifiPowerSave),
    gatewayPyprojectSource: join(canonicalDirectory, gateArtifacts.gatewayPyproject),
    gatewayUvLockSource: join(canonicalDirectory, gateArtifacts.gatewayUvLock),
    replayProducerSource: join(canonicalDirectory, gateArtifacts.replayProducer),
    attentionMetricsSource: join(canonicalDirectory, gateArtifacts.attentionMetrics),
    replayEvidenceBuilderSource: join(canonicalDirectory, gateArtifacts.replayEvidenceBuilder),
    replayReportSchemaSource: join(canonicalDirectory, gateArtifacts.replayReportSchema),
    replaySchemaSource: join(canonicalDirectory, gateArtifacts.replaySchema),
    replayGateTestSource: join(canonicalDirectory, gateArtifacts.replayGateTest),
    replayFieldTestSource: join(canonicalDirectory, gateArtifacts.replayFieldTest),
    replayEvidenceTestSource: join(canonicalDirectory, gateArtifacts.replayEvidenceTest),
    packageJsonSource: join(canonicalDirectory, gateArtifacts.packageJson),
    packageLockSource: join(canonicalDirectory, gateArtifacts.packageLock)
  };
}

async function assertComparisonContractMatchesSources(
  contract: ComparisonContract,
  paths: ComparisonContractSourcePaths,
  qualificationId: string
): Promise<void> {
  const currentProducerSources = await describeComparisonProducerSources(paths);
  for (const index of [0, 1, 2, 3] as const) {
    if (
      JSON.stringify(contract.producerSources[index]) !==
      JSON.stringify(currentProducerSources[index])
    ) {
      throw new Error("comparison contract immutable source mismatch");
    }
  }
  if (qualificationId === contract.qualificationId) {
    const currentCandidateMutableTestSources = await describeCandidateMutableTestSources(paths);
    if (
      JSON.stringify(contract.producerSources.slice(4)) !==
        JSON.stringify(currentProducerSources.slice(4)) ||
      JSON.stringify(contract.candidateMutableTestSources) !==
        JSON.stringify(currentCandidateMutableTestSources)
    ) {
      throw new Error("comparison contract baseline mutable source mismatch");
    }
  }
  const currentGateSources = await describeComparisonGateSources(paths);
  if (JSON.stringify(contract.gateSources) !== JSON.stringify(currentGateSources)) {
    throw new Error("comparison contract immutable gate source mismatch");
  }
}

function createTarHeader(artifact: string, size: number): Buffer {
  if (Buffer.byteLength(artifact) > 100 || !isSafeArtifactPath(artifact)) {
    throw new Error(`artifact path cannot be represented safely in tar: ${artifact}`);
  }
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, artifact);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    throw new Error(`tar field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) {
    throw new Error("tar numeric field overflow");
  }
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

async function hashProducerSources(
  sources: readonly {
    readonly role: StackChanAttentionReplayProducerSourceRole;
    readonly path: string;
  }[]
): Promise<string> {
  return hashStackChanAttentionReplayProducerSources(
    await Promise.all(
      sources.map(async ({ role, path }) => ({
        role,
        bytes: await readFile(path)
      }))
    )
  );
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const artifact = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (!isSafeArtifactPath(artifact)) {
      throw new Error(`unsafe artifact path: ${artifact}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await listFiles(directory, artifact)));
    } else if (entry.isFile()) {
      result.push(artifact);
    } else {
      throw new Error(`unsupported artifact type: ${artifact}`);
    }
  }
  return result;
}

async function gitOutput(worktree: string, arguments_: readonly string[]): Promise<string> {
  return (await gitRawOutput(worktree, arguments_)).trimEnd();
}

async function gitRawOutput(worktree: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

async function requireCanonicalFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return path;
}

async function requireCanonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return path;
}

async function requireAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(path: string, parent: string): boolean {
  const relation = relative(parent, path);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`);
}

function isSafeArtifactPath(path: string): boolean {
  return (
    path !== "" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function requireArtifact(
  artifacts: Readonly<Record<string, CopiedArtifact>>,
  artifact: string
): CopiedArtifact {
  const value = artifacts[artifact];
  if (value === undefined) {
    throw new Error(`copied artifact is missing: ${artifact}`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireCanonicalUtc(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${path} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && Boolean(value) && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string
): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${path} keys mismatch`);
  }
}

function requireHash(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isDirectExecution(): boolean {
  return (
    process.argv[1] !== undefined &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  );
}

if (isDirectExecution()) {
  process.exitCode = await executeStackChanAttentionReplayEvidenceCli(process.argv.slice(2));
}
