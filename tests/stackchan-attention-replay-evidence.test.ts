import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  normalizeStackChanAttentionReplayReport,
  reduceStackChanAttentionReplayEvidence,
  runStackChanAttentionReplay
} from "../scripts/field/stackchan-attention-replay.js";
import {
  buildStackChanAttentionReplayEvidence,
  captureStackChanAttentionReplayComparisonContract,
  captureStackChanAttentionReplayQualificationStart,
  executeStackChanAttentionReplayEvidenceCli,
  parseStackChanAttentionReplayEvidenceArguments,
  verifyStackChanAttentionReplayEvidence
} from "../scripts/field/stackchan-attention-replay-evidence.js";
import { parseJsonRejectingDuplicateKeys } from "../scripts/field/stackchan-attention-replay-schema.js";

const execFileAsync = promisify(execFile);
const picoWorktree = resolve(import.meta.dirname, "..");
const controllerSource = join(picoWorktree, "src/modules/stackchan/attention-controller.ts");
const targetCenterFilterSource = join(
  picoWorktree,
  "src/modules/stackchan/target-center-filter.ts"
);
const runtimeSource = join(picoWorktree, "src/runtime/stackchan-attention-runtime.ts");
const attentionDetectionSource = join(picoWorktree, "src/modules/vision/attention-detection.ts");
const replayProducerSource = join(picoWorktree, "scripts/field/stackchan-attention-replay.ts");
const attentionMetricsSource = join(picoWorktree, "scripts/field/stackchan-attention-metrics.ts");
const replayLanePolicySource = join(
  picoWorktree,
  "scripts/field/stackchan-attention-replay-lane-policy.ts"
);
const replayLanePolicyTestSource = join(
  picoWorktree,
  "tests/stackchan-attention-replay-lane-policy.test.ts"
);
const replayReportSchemaSource = join(
  picoWorktree,
  "scripts/field/stackchan-attention-replay-report.schema.json"
);
const replaySchemaSource = join(picoWorktree, "scripts/field/stackchan-attention-replay-schema.ts");
const replayEvidenceBuilderSource = join(
  picoWorktree,
  "scripts/field/stackchan-attention-replay-evidence.ts"
);
const replayGateTestSource = join(picoWorktree, "tests/stackchan-attention-replay-gate.test.ts");
const replayFieldTestSource = join(picoWorktree, "tests/stackchan-attention-replay-field.test.ts");
const replayEvidenceTestSource = join(
  picoWorktree,
  "tests/stackchan-attention-replay-evidence.test.ts"
);
const packageJsonSource = join(picoWorktree, "package.json");
const packageLockSource = join(picoWorktree, "package-lock.json");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

let suiteDirectory = "";
let qualifiedReportSource = "";
let historicalReportSource = "";
let gatewayWorktree = "";
let gatewayLaneSource = "";
let gatewayLaneTestSource = "";
let gatewayPackageInitSource = "";
let gatewayWifiPowerSaveSource = "";
let gatewayPyprojectSource = "";
let gatewayUvLockSource = "";

beforeAll(async () => {
  suiteDirectory = await mkdtemp(join(tmpdir(), "pico-replay-evidence-suite-"));
  gatewayWorktree = join(suiteDirectory, "gateway-worktree");
  gatewayLaneSource = join(gatewayWorktree, "gateway/stackchan_mcp/head_target_lane.py");
  gatewayLaneTestSource = join(gatewayWorktree, "gateway/tests/test_head_target_lane.py");
  gatewayPackageInitSource = join(gatewayWorktree, "gateway/stackchan_mcp/__init__.py");
  gatewayWifiPowerSaveSource = join(gatewayWorktree, "gateway/stackchan_mcp/wifi_power_save.py");
  gatewayPyprojectSource = join(gatewayWorktree, "gateway/pyproject.toml");
  gatewayUvLockSource = join(gatewayWorktree, "gateway/uv.lock");
  await Promise.all([
    writeFixtureSource(gatewayLaneSource, "class HeadTargetLane:\n    pass\n"),
    writeFixtureSource(gatewayLaneTestSource, "def test_head_target_lane():\n    pass\n"),
    writeFixtureSource(gatewayPackageInitSource, ""),
    writeFixtureSource(gatewayWifiPowerSaveSource, "def disable_wifi_power_save():\n    pass\n"),
    writeFixtureSource(
      gatewayPyprojectSource,
      '[project]\nname = "stackchan-mcp-test-fixture"\nversion = "0.0.0"\n'
    ),
    writeFixtureSource(gatewayUvLockSource, 'version = 1\nrequires-python = ">=3.10"\n')
  ]);
  qualifiedReportSource = join(suiteDirectory, "qualified.json");
  historicalReportSource = join(suiteDirectory, "historical.json");
  const qualified = await runStackChanAttentionReplay({
    reportOutput: qualifiedReportSource,
    repeat: 3,
    producerSourceHash: await roleSourceAggregate([
      ["pico-attention-controller", controllerSource],
      ["pico-target-center-filter", targetCenterFilterSource],
      ["pico-attention-runtime", runtimeSource],
      ["pico-attention-detection", attentionDetectionSource],
      ["replay-sut-lane-policy", replayLanePolicySource],
      ["gateway-head-target-lane", gatewayLaneSource]
    ])
  });
  const historical = normalizeStackChanAttentionReplayReport(qualified);
  await writeJson(historicalReportSource, historical);
}, 120_000);

afterAll(async () => {
  if (suiteDirectory !== "") {
    await rm(suiteDirectory, { recursive: true, force: true });
  }
});

describe("StackChan attention replay review evidence", { timeout: 30_000 }, () => {
  it("rejects duplicate JSON object keys before JSON.parse can collapse them", () => {
    expect(() =>
      parseJsonRejectingDuplicateKeys(
        '{"schemaVersion":999,"nested":{"value":1,"value":2},"schemaVersion":4}',
        "duplicate-key probe"
      )
    ).toThrow("duplicate JSON key");
  });

  it("treats escaped and literal spellings of the same JSON key as duplicates", () => {
    expect(() =>
      parseJsonRejectingDuplicateKeys('{"schemaVersion":4,"schema\\u0056ersion":4}', "escape probe")
    ).toThrow("duplicate JSON key");
  });

  it("builds and verifies a deterministic archive from explicit absolute inputs", async () => {
    await withEvidenceInputs(async (inputs) => {
      expect(
        parseStackChanAttentionReplayEvidenceArguments(evidenceCliArguments(inputs.options))
          .replayLanePolicySource
      ).toBe(inputs.options.replayLanePolicySource);
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).resolves.toBe(undefined);
      const readme = await readFile(join(result.stagingDirectory, "README.md"), "utf8");
      const qualified = JSON.parse(await readFile(qualifiedReportSource, "utf8")) as {
        comparisonSetHash: string;
        producerSourceHash: string;
      };
      const scope = JSON.parse(
        await readFile(join(result.stagingDirectory, "production-scope.json"), "utf8")
      ) as {
        allQualificationStartScopedProductionSourcesPreserved: boolean;
        externalComparisonContractPinRequired: boolean;
        candidateMutableArtifacts: string[];
      };
      expect(readme).toContain(qualified.comparisonSetHash);
      expect(readme).toContain(qualified.producerSourceHash);
      expect(scope.allQualificationStartScopedProductionSourcesPreserved).toBe(true);
      expect(scope.externalComparisonContractPinRequired).toBe(true);
      expect(scope.candidateMutableArtifacts).toEqual([
        "source/gate/stackchan-attention-replay-lane-policy.ts",
        "source/gate/tests/stackchan-attention-replay-lane-policy.test.ts",
        "source/gateway/head_target_lane.py",
        "source/gateway/tests/test_head_target_lane.py"
      ]);
      expect(
        await readFile(join(result.stagingDirectory, "inputs/comparison-contract.json"), "utf8")
      ).toBe(await readFile(inputs.options.comparisonContract, "utf8"));
      expect(await sha256(inputs.options.outputArchive)).toBe(result.archiveSha256);
      const producerManifest = JSON.parse(
        await readFile(join(result.stagingDirectory, "producer-source-manifest.json"), "utf8")
      ) as {
        algorithm: string;
        aggregateSha256: string;
        reportProducerSourceHash: string;
        inputs: Array<{ role: string; artifact: string }>;
      };
      expect(producerManifest.algorithm).toBe("sha256(role + NUL + raw bytes + NUL)");
      expect(producerManifest.inputs).toEqual([
        expect.objectContaining({
          role: "pico-attention-controller",
          artifact: "source/pico/attention-controller.ts"
        }),
        expect.objectContaining({
          role: "pico-target-center-filter",
          artifact: "source/pico/target-center-filter.ts"
        }),
        expect.objectContaining({
          role: "pico-attention-runtime",
          artifact: "source/pico/stackchan-attention-runtime.ts"
        }),
        expect.objectContaining({
          role: "pico-attention-detection",
          artifact: "source/pico/attention-detection.ts"
        }),
        expect.objectContaining({
          role: "replay-sut-lane-policy",
          artifact: "source/gate/stackchan-attention-replay-lane-policy.ts"
        }),
        expect.objectContaining({
          role: "gateway-head-target-lane",
          artifact: "source/gateway/head_target_lane.py"
        })
      ]);
      const expectedProducerAggregate = await roleSourceAggregate([
        ["pico-attention-controller", inputs.options.picoControllerSource],
        ["pico-target-center-filter", inputs.options.picoTargetCenterFilterSource],
        ["pico-attention-runtime", inputs.options.picoRuntimeSource],
        ["pico-attention-detection", inputs.options.picoAttentionDetectionSource],
        ["replay-sut-lane-policy", inputs.options.replayLanePolicySource],
        ["gateway-head-target-lane", inputs.options.gatewayLaneSource]
      ]);
      expect(producerManifest.aggregateSha256).toBe(expectedProducerAggregate);
      expect(producerManifest.reportProducerSourceHash).toBe(expectedProducerAggregate);
      expect(qualified.producerSourceHash).toBe(expectedProducerAggregate);
      const startAttestation = JSON.parse(
        await readFile(
          join(result.stagingDirectory, "inputs/qualification-start-attestation.json"),
          "utf8"
        )
      ) as {
        repositories: {
          pico: { sourceFiles: Array<{ relativePath: string }> };
          gateway: { sourceFiles: Array<{ relativePath: string }> };
        };
      };
      expect(
        startAttestation.repositories.pico.sourceFiles.map((file) => file.relativePath)
      ).toContain("scripts/field/stackchan-attention-replay-lane-policy.ts");
      expect(
        startAttestation.repositories.pico.sourceFiles.map((file) => file.relativePath)
      ).toContain("tests/stackchan-attention-replay-lane-policy.test.ts");
      expect(
        startAttestation.repositories.gateway.sourceFiles.map((file) => file.relativePath)
      ).toContain("gateway/stackchan_mcp/head_target_lane.py");
      expect(
        startAttestation.repositories.gateway.sourceFiles.map((file) => file.relativePath)
      ).toContain("gateway/tests/test_head_target_lane.py");
      expect(
        startAttestation.repositories.gateway.sourceFiles.map((file) => file.relativePath)
      ).toEqual(
        expect.arrayContaining([
          "gateway/stackchan_mcp/__init__.py",
          "gateway/stackchan_mcp/wifi_power_save.py",
          "gateway/pyproject.toml",
          "gateway/uv.lock"
        ])
      );
      await expect(
        readFile(
          join(
            result.stagingDirectory,
            "source/gate/tests/stackchan-attention-replay-lane-policy.test.ts"
          ),
          "utf8"
        )
      ).resolves.toBe(await readFile(inputs.options.replayLanePolicyTestSource, "utf8"));
      await expect(
        readFile(
          join(result.stagingDirectory, "source/gateway/tests/test_head_target_lane.py"),
          "utf8"
        )
      ).resolves.toBe(await readFile(inputs.options.gatewayLaneTestSource, "utf8"));
      for (const [artifact, source] of [
        ["source/gateway/stackchan_mcp/__init__.py", inputs.options.gatewayPackageInitSource],
        [
          "source/gateway/stackchan_mcp/wifi_power_save.py",
          inputs.options.gatewayWifiPowerSaveSource
        ],
        ["source/gateway/pyproject.toml", inputs.options.gatewayPyprojectSource],
        ["source/gateway/uv.lock", inputs.options.gatewayUvLockSource]
      ] as const) {
        await expect(readFile(join(result.stagingDirectory, artifact))).resolves.toEqual(
          await readFile(source)
        );
      }
      const reviewManifest = JSON.parse(
        await readFile(join(result.stagingDirectory, "review-manifest.json"), "utf8")
      ) as {
        externalTrustAnchors: {
          comparisonContractSha256: string;
        };
        contractHashes: {
          comparisonSetHash: string;
        };
        reports: {
          acceptanceVerdict: {
            acceptanceProfileVersion: number;
            acceptanceCheckCount: number;
          };
        };
        threatModel: {
          builderTrust: string;
          goal: string;
          excludedProtections: string[];
        };
      };
      expect(reviewManifest.contractHashes.comparisonSetHash).toBe(qualified.comparisonSetHash);
      expect(reviewManifest.reports.acceptanceVerdict.acceptanceProfileVersion).toBe(6);
      expect(reviewManifest.reports.acceptanceVerdict.acceptanceCheckCount).toBe(30);
      expect(reviewManifest.externalTrustAnchors.comparisonContractSha256).toBe(
        inputs.options.expectedComparisonContractSha256
      );
      expect(reviewManifest.threatModel).toEqual({
        builderTrust: "trusted-local-single-operator",
        goal: "deterministic-regression-and-false-pass-prevention-with-review-reproducibility",
        excludedProtections: ["malicious-candidate-author", "compromised-toolchain"]
      });
      expect(readme).toContain("trusted local single-operator builder");
      expect(readme).toContain("not protection from a malicious candidate author");
      expect(readme).toContain("not protection from a compromised toolchain");
      expect(readme).toContain("uv run pytest tests/test_head_target_lane.py");
      expect(readme).toContain(
        "uv run ruff check stackchan_mcp/head_target_lane.py tests/test_head_target_lane.py"
      );
      const gateManifest = JSON.parse(
        await readFile(join(result.stagingDirectory, "gate-producer-manifest.json"), "utf8")
      ) as {
        contractHashes: {
          metricImplementationHash: { report: string; computed: string };
          reportSchemaHash: { report: string; computed: string };
          eventSchemaHash: { report: string; computed: string };
        };
        snapshots: unknown[];
      };
      expect(gateManifest.contractHashes.metricImplementationHash.computed).toBe(
        gateManifest.contractHashes.metricImplementationHash.report
      );
      expect(gateManifest.contractHashes.reportSchemaHash.computed).toBe(
        gateManifest.contractHashes.reportSchemaHash.report
      );
      expect(gateManifest.contractHashes.eventSchemaHash.computed).toBe(
        gateManifest.contractHashes.eventSchemaHash.report
      );
      expect(gateManifest.snapshots).toHaveLength(14);
      expect(gateManifest.snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifact: "source/gate/stackchan-attention-metrics.ts" }),
          expect.objectContaining({ artifact: "source/gateway/stackchan_mcp/__init__.py" }),
          expect.objectContaining({
            artifact: "source/gateway/stackchan_mcp/wifi_power_save.py"
          }),
          expect.objectContaining({ artifact: "source/gateway/pyproject.toml" }),
          expect.objectContaining({ artifact: "source/gateway/uv.lock" })
        ])
      );
      expect(
        await readFile(
          join(result.stagingDirectory, "source/gate/stackchan-attention-replay-evidence.ts"),
          "utf8"
        )
      ).toBe(await readFile(replayEvidenceBuilderSource, "utf8"));
      expect(
        await readFile(join(result.stagingDirectory, "reports/qualified-fresh-rerun.json"), "utf8")
      ).toBe(
        await readFile(join(result.stagingDirectory, "reports/qualified-current.json"), "utf8")
      );
      const freshManifest = JSON.parse(
        await readFile(join(result.stagingDirectory, "review-manifest.json"), "utf8")
      ) as {
        schemaVersion: number;
        reports: {
          qualifiedFreshRerun: {
            requestedRepeat: number;
            candidateRawSha256: string;
            freshRawSha256: string;
            rawEqual: boolean;
            candidateCanonicalSha256: string;
            freshCanonicalSha256: string;
            canonicalEqual: boolean;
          };
        };
      };
      expect(freshManifest.schemaVersion).toBe(5);
      expect(freshManifest.reports.qualifiedFreshRerun.requestedRepeat).toBe(3);
      expect(freshManifest.reports.qualifiedFreshRerun.rawEqual).toBe(true);
      expect(freshManifest.reports.qualifiedFreshRerun.candidateRawSha256).toBe(
        freshManifest.reports.qualifiedFreshRerun.freshRawSha256
      );
      expect(freshManifest.reports.qualifiedFreshRerun.canonicalEqual).toBe(true);
      expect(freshManifest.reports.qualifiedFreshRerun.candidateCanonicalSha256).toBe(
        freshManifest.reports.qualifiedFreshRerun.freshCanonicalSha256
      );
      const second = await buildStackChanAttentionReplayEvidence({
        ...inputs.options,
        outputArchive: join(inputs.directory, "review-evidence-second.tar.gz"),
        stagingDirectory: join(inputs.directory, "review-evidence-second")
      });
      expect(second.archiveSha256).toBe(result.archiveSha256);
      await expect(execFileAsync("tar", ["-tzf", second.outputArchive])).resolves.toMatchObject({
        stderr: ""
      });
    });
  }, 120_000);

  it("rejects a self-consistent qualified report that differs from a fresh current run", async () => {
    await withEvidenceInputs(async (inputs) => {
      const tamperedPath = join(inputs.directory, "qualified-self-consistent-tamper.json");
      await writeJson(tamperedPath, await createSelfConsistentCenteredTamper());

      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          qualifiedReport: tamperedPath
        })
      ).rejects.toThrow("does not match fresh current producer");
    });
  });

  it("removes credentials and URL parameters from attested repository identities", async () => {
    await withEvidenceInputs(async (inputs) => {
      const picoRepository = resolve(inputs.options.picoControllerSource, "../../../..");
      await execFileAsync(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "https://reviewer:github_pat_secret@example.invalid/facility/pico.git?token=leak#fragment"
        ],
        { cwd: picoRepository }
      );
      const outputPath = join(inputs.directory, "credential-safe-attestation.json");

      await captureStackChanAttentionReplayQualificationStart({
        outputPath,
        qualificationId: "QualificationCredentialSafety",
        capturedAtUtc: "2026-08-05T00:00:00.000Z",
        picoWorktree: picoRepository,
        gatewayWorktree: resolve(inputs.options.gatewayLaneSource, "../../..")
      });

      const raw = await readFile(outputPath, "utf8");
      const attestation = JSON.parse(raw) as {
        repositories: { pico: { repositoryId: string } };
      };
      expect(raw).not.toContain("github_pat_secret");
      expect(raw).not.toContain("reviewer:");
      expect(raw).not.toContain("token=leak");
      expect(attestation.repositories.pico.repositoryId).toBe(
        "https://example.invalid/facility/pico.git"
      );
    });
  });

  it("rejects secret-bearing verification logs before copying them", async () => {
    await withEvidenceInputs(async (inputs) => {
      const githubToken = ["gh", "p_", "123456789012345678901234567890123456"].join("");
      await writeFile(
        inputs.options.focusedPicoLog,
        `{"authorization":"Bearer ${githubToken}"}\n` +
          "STACKCHAN_TOKEN: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n" +
          "api_key=AKIAIOSFODNN7EXAMPLE\n"
      );

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        "verification logs failed the required secretlint scan"
      );
    });
  });

  it("rejects historical reports whose comparison sets differ", async () => {
    await withEvidenceInputs(async (inputs) => {
      const after = JSON.parse(
        await readFile(inputs.options.normalizedAfterReport, "utf8")
      ) as Record<string, unknown>;
      after.comparisonSetHash = "f".repeat(64);
      await writeJson(inputs.options.normalizedAfterReport, after);

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        "historical comparisonSetHash mismatch"
      );
    });
  });

  it("rejects producer source content whose aggregate differs from the qualified report", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(inputs.options.picoControllerSource, "changed controller\n");
      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        /comparison contract immutable source mismatch|pico worktree does not match qualification-start attestation|producer source aggregate mismatch/u
      );
    });
  });

  it("rejects target filter source content whose aggregate differs from the qualified report", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(inputs.options.picoTargetCenterFilterSource, "changed target filter\n");
      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        /comparison contract immutable source mismatch|pico worktree does not match qualification-start attestation|producer source aggregate mismatch/u
      );
    });
  });

  it("rejects replay producer bytes that disagree with metricImplementationHash", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(inputs.options.replayProducerSource, "changed replay producer\n");

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        /comparison contract immutable gate source mismatch|pico worktree does not match qualification-start attestation|metricImplementationHash mismatch/u
      );
    });
  });

  it("rejects replay schema bytes that disagree with report schema hashes", async () => {
    await withEvidenceInputs(async (inputs) => {
      const schema = JSON.parse(
        await readFile(inputs.options.replayReportSchemaSource, "utf8")
      ) as Record<string, unknown>;
      schema.title = "changed replay report schema";
      await writeJson(inputs.options.replayReportSchemaSource, schema);

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        /comparison contract immutable gate source mismatch|pico worktree does not match qualification-start attestation|reportSchemaHash mismatch/u
      );
    });
  });

  it("detects embedded replay producer tampering even when SHA256SUMS is rewritten", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const artifact = "source/gate/stackchan-attention-replay.ts";
      const embeddedProducer = join(result.stagingDirectory, artifact);
      await writeFile(embeddedProducer, "changed embedded replay producer\n");
      await replaceSha256Sum(
        join(result.stagingDirectory, "SHA256SUMS"),
        artifact,
        await sha256(embeddedProducer)
      );

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow(
        /comparison contract immutable gate source mismatch|metricImplementationHash mismatch|embedded source does not match qualification-start attestation/u
      );
    });
  });

  it("detects embedded fresh-rerun tampering even when SHA256SUMS is rewritten", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const artifact = "reports/qualified-fresh-rerun.json";
      const embeddedFresh = join(result.stagingDirectory, artifact);
      await writeJson(embeddedFresh, await createSelfConsistentCenteredTamper());
      await replaceSha256Sum(
        join(result.stagingDirectory, "SHA256SUMS"),
        artifact,
        await sha256(embeddedFresh)
      );

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("qualified report raw bytes mismatch");
    });
  });

  it("rejects raw-byte differences between current and fresh qualified reports", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const artifact = "reports/qualified-current.json";
      const embeddedCurrent = join(result.stagingDirectory, artifact);
      await writeFile(embeddedCurrent, `${await readFile(embeddedCurrent, "utf8")}\n`);
      await replaceSha256Sum(
        join(result.stagingDirectory, "SHA256SUMS"),
        artifact,
        await sha256(embeddedCurrent)
      );

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("qualified report raw bytes mismatch");
    });
  });

  it("recomputes and rejects an acceptance verdict whose manifest and checksums were rewritten", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const verdictArtifact = "reports/acceptance-verdict.json";
      const verdictPath = join(result.stagingDirectory, verdictArtifact);
      const verdict = JSON.parse(await readFile(verdictPath, "utf8")) as {
        status: "accepted" | "rejected";
        checks: {
          status: "passed" | "failed";
          failureReason: string | null;
        }[];
      };
      const firstCheck = verdict.checks[0];
      if (firstCheck === undefined) {
        throw new Error("test acceptance verdict has no checks");
      }
      if (firstCheck.status === "passed") {
        firstCheck.status = "failed";
        firstCheck.failureReason = "threshold-not-met";
      } else {
        firstCheck.status = "passed";
        // eslint-disable-next-line unicorn/no-null -- The serialized verdict contract uses null.
        firstCheck.failureReason = null;
      }
      verdict.status = verdict.checks.every((check) => check.status === "passed")
        ? "accepted"
        : "rejected";
      await writeJson(verdictPath, verdict);

      const manifestArtifact = "review-manifest.json";
      const manifestPath = join(result.stagingDirectory, manifestArtifact);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const verdictBytes = await readFile(verdictPath);
      const verdictSha256 = await sha256(verdictPath);
      expect(
        rewriteArtifactDescriptors(
          manifest,
          verdictArtifact,
          verdictSha256,
          verdictBytes.byteLength
        )
      ).toBeGreaterThan(0);
      await writeJson(manifestPath, manifest);

      const sumsPath = join(result.stagingDirectory, "SHA256SUMS");
      await replaceSha256Sum(sumsPath, verdictArtifact, verdictSha256);
      await replaceSha256Sum(sumsPath, manifestArtifact, await sha256(manifestPath));

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("acceptance verdict does not match pairwise recomputation");
    });
  });

  it("detects review manifest tampering even when SHA256SUMS is rewritten", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const artifact = "review-manifest.json";
      const manifestPath = join(result.stagingDirectory, artifact);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        reports: {
          qualifiedFreshRerun: {
            canonicalEqual: boolean;
          };
        };
      };
      manifest.reports.qualifiedFreshRerun.canonicalEqual = false;
      await writeJson(manifestPath, manifest);
      await replaceSha256Sum(
        join(result.stagingDirectory, "SHA256SUMS"),
        artifact,
        await sha256(manifestPath)
      );

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("review manifest mismatch");
    });
  });

  it("detects production scope tampering even when its manifest binding and sums are rewritten", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const scopeArtifact = "production-scope.json";
      const scopePath = join(result.stagingDirectory, scopeArtifact);
      const scope = JSON.parse(await readFile(scopePath, "utf8")) as {
        repositories: {
          pico: {
            headRevision: string;
            gitObservation: {
              diffNames: {
                sha256: string;
              };
            };
          };
        };
      };
      scope.repositories.pico.headRevision = "f".repeat(40);
      scope.repositories.pico.gitObservation.diffNames.sha256 = "e".repeat(64);
      await writeJson(scopePath, scope);

      const manifestArtifact = "review-manifest.json";
      const manifestPath = join(result.stagingDirectory, manifestArtifact);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        productionScopeSha256: string;
      };
      manifest.productionScopeSha256 = await sha256(scopePath);
      await writeJson(manifestPath, manifest);

      const sumsPath = join(result.stagingDirectory, "SHA256SUMS");
      await replaceSha256Sum(sumsPath, scopeArtifact, await sha256(scopePath));
      await replaceSha256Sum(sumsPath, manifestArtifact, await sha256(manifestPath));

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("production scope mismatch");
    });
  });

  it("verifies a clean extraction in a fresh Node process after source worktrees are removed", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const extractionDirectory = join(inputs.directory, "clean-extraction");
      await mkdir(extractionDirectory);
      await execFileAsync("tar", ["-xzf", result.outputArchive, "-C", extractionDirectory]);
      const canonicalExtractionDirectory = await realpath(extractionDirectory);
      await rm(join(inputs.directory, "pico"), { recursive: true, force: true });
      await rm(join(inputs.directory, "gateway"), { recursive: true, force: true });

      const execution = await execFileAsync(
        process.execPath,
        [
          join(canonicalExtractionDirectory, "verify-evidence.mjs"),
          "verify",
          "--evidence-dir",
          canonicalExtractionDirectory,
          "--expected-start-attestation-sha256",
          inputs.options.expectedStartAttestationSha256,
          "--expected-comparison-baseline-sha256",
          inputs.options.expectedComparisonBaselineSha256,
          "--expected-comparison-contract-sha256",
          inputs.options.expectedComparisonContractSha256
        ],
        {
          cwd: canonicalExtractionDirectory,
          env: {
            PATH: process.env.PATH ?? ""
          }
        }
      );
      expect(execution.stderr).toBe("");
      expect(JSON.parse(execution.stdout)).toMatchObject({ status: "passed" });
    });
  }, 30_000);

  it("requires the externally pinned start-attestation digest during verification", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          "0".repeat(64),
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("qualification-start attestation does not match external SHA-256");
    });
  }, 15_000);

  it("requires the externally pinned comparison-baseline digest", async () => {
    await withEvidenceInputs(async (inputs) => {
      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          expectedComparisonBaselineSha256: "0".repeat(64)
        })
      ).rejects.toThrow("comparison baseline does not match external SHA-256");

      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          "0".repeat(64),
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("comparison baseline does not match external SHA-256");
    });
  }, 15_000);

  it("requires the externally pinned comparison-contract digest", async () => {
    await withEvidenceInputs(async (inputs) => {
      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          expectedComparisonContractSha256: "0".repeat(64)
        })
      ).rejects.toThrow("comparison contract does not match external SHA-256");

      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          "0".repeat(64)
        )
      ).rejects.toThrow("comparison contract does not match external SHA-256");
    });
  }, 15_000);

  it("rejects a production source that changed after qualification started", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(inputs.options.gatewayLaneSource, "changed gateway lane\n");

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        "comparison contract baseline mutable source mismatch"
      );
    });
  });

  it("rejects a self-consistent start attestation rewrite against the external pin", async () => {
    await withEvidenceInputs(async (inputs) => {
      const attestation = JSON.parse(
        await readFile(inputs.options.qualificationStartAttestation, "utf8")
      ) as {
        repositories: {
          gateway: {
            branch: string;
          };
        };
      };
      attestation.repositories.gateway.branch = "codex/forged-scope";
      await writeJson(inputs.options.qualificationStartAttestation, attestation);

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        "qualification-start attestation does not match external SHA-256"
      );
    });
  });

  it("detects an artifact changed after the manifest was written", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      await writeFile(join(result.stagingDirectory, "README.md"), "tampered\n");

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          inputs.options.expectedComparisonContractSha256
        )
      ).rejects.toThrow("SHA256SUMS mismatch");
    });
  });

  it("requires every CLI path to be explicit and absolute", () => {
    expect(() =>
      parseStackChanAttentionReplayEvidenceArguments(["--output-archive", "relative.tar.gz"])
    ).toThrow("--output-archive must be an absolute path");
  });

  it("captures qualification-start evidence through the explicit CLI subcommand", async () => {
    await withEvidenceInputs(async (inputs) => {
      const outputPath = join(inputs.directory, "cli-qualification-start.json");
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await executeStackChanAttentionReplayEvidenceCli(
        qualificationStartCliArguments({
          outputPath,
          qualificationId: "cli-test-qualification",
          capturedAtUtc: "2026-07-30T03:04:05.678Z",
          picoWorktree: join(inputs.directory, "pico"),
          gatewayWorktree: join(inputs.directory, "gateway")
        }),
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line)
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      const result = JSON.parse(stdout[0] ?? "{}") as {
        outputPath: string;
        attestationSha256: string;
      };
      expect(result).toEqual({
        outputPath,
        attestationSha256: await sha256(outputPath)
      });
    });
  });

  it("rejects an unknown or incomplete CLI subcommand with bounded JSON", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeStackChanAttentionReplayEvidenceCli(["capture-start"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['{"status":"failed","code":"invalid_arguments"}']);
  });

  it("reports capture-start execution failures with bounded JSON", async () => {
    await withEvidenceInputs(async (inputs) => {
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await executeStackChanAttentionReplayEvidenceCli(
        qualificationStartCliArguments({
          outputPath: inputs.options.qualificationStartAttestation,
          qualificationId: "cli-test-qualification",
          capturedAtUtc: "2026-07-30T03:04:05.678Z",
          picoWorktree: join(inputs.directory, "pico"),
          gatewayWorktree: join(inputs.directory, "gateway")
        }),
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line)
        }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(['{"status":"failed","code":"execution_failed"}']);
    });
  });

  it("computes the fixed six-role producer source hash through the explicit CLI subcommand", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeStackChanAttentionReplayEvidenceCli(
      producerHashCliArguments({
        picoControllerSource: controllerSource,
        picoTargetCenterFilterSource: targetCenterFilterSource,
        picoRuntimeSource: runtimeSource,
        picoAttentionDetectionSource: attentionDetectionSource,
        replayLanePolicySource,
        gatewayLaneSource
      }),
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      producerSourceHash: await roleSourceAggregate([
        ["pico-attention-controller", controllerSource],
        ["pico-target-center-filter", targetCenterFilterSource],
        ["pico-attention-runtime", runtimeSource],
        ["pico-attention-detection", attentionDetectionSource],
        ["replay-sut-lane-policy", replayLanePolicySource],
        ["gateway-head-target-lane", gatewayLaneSource]
      ])
    });
  });

  it("rejects invalid producer-hash paths with bounded JSON", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const arguments_ = producerHashCliArguments({
      picoControllerSource: controllerSource,
      picoTargetCenterFilterSource: targetCenterFilterSource,
      picoRuntimeSource: runtimeSource,
      picoAttentionDetectionSource: attentionDetectionSource,
      replayLanePolicySource,
      gatewayLaneSource
    });
    arguments_[2] = "relative-controller.ts";

    const exitCode = await executeStackChanAttentionReplayEvidenceCli(arguments_, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['{"status":"failed","code":"invalid_arguments"}']);
  });

  it("reports producer-hash read failures with bounded JSON", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeStackChanAttentionReplayEvidenceCli(
      producerHashCliArguments({
        picoControllerSource: join(tmpdir(), "missing-attention-controller.ts"),
        picoTargetCenterFilterSource: targetCenterFilterSource,
        picoRuntimeSource: runtimeSource,
        picoAttentionDetectionSource: attentionDetectionSource,
        replayLanePolicySource,
        gatewayLaneSource
      }),
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['{"status":"failed","code":"execution_failed"}']);
  });

  it("captures the cross-qualification comparison contract through the explicit CLI subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-replay-comparison-contract-"));
    const outputPath = join(directory, "comparison-contract.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await executeStackChanAttentionReplayEvidenceCli(
        comparisonContractCliArguments({
          outputPath,
          qualificationId: "Qualification006",
          capturedAtUtc: "2026-07-30T04:05:06.789Z",
          picoControllerSource: controllerSource,
          picoTargetCenterFilterSource: targetCenterFilterSource,
          picoRuntimeSource: runtimeSource,
          picoAttentionDetectionSource: attentionDetectionSource,
          replayLanePolicySource,
          replayLanePolicyTestSource,
          gatewayLaneSource,
          gatewayLaneTestSource,
          gatewayPackageInitSource,
          gatewayWifiPowerSaveSource,
          gatewayPyprojectSource,
          gatewayUvLockSource,
          replayProducerSource,
          attentionMetricsSource,
          replayEvidenceBuilderSource,
          replayReportSchemaSource,
          replaySchemaSource,
          replayGateTestSource,
          replayFieldTestSource,
          replayEvidenceTestSource,
          packageJsonSource,
          packageLockSource
        }),
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line)
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
        outputPath,
        comparisonContractSha256: await sha256(outputPath)
      });
      const contract = JSON.parse(await readFile(outputPath, "utf8")) as {
        schemaVersion: number;
        qualificationId: string;
        producerSources: Array<{ role: string; artifact: string; sha256: string; bytes: number }>;
        gateSources: Array<{ artifact: string; sha256: string; bytes: number }>;
        candidateMutableTestSources: Array<{
          artifact: string;
          sha256: string;
          bytes: number;
        }>;
      };
      expect(contract.schemaVersion).toBe(1);
      expect(contract.qualificationId).toBe("Qualification006");
      expect(contract.producerSources.map(({ role, artifact }) => ({ role, artifact }))).toEqual([
        {
          role: "pico-attention-controller",
          artifact: "source/pico/attention-controller.ts"
        },
        {
          role: "pico-target-center-filter",
          artifact: "source/pico/target-center-filter.ts"
        },
        {
          role: "pico-attention-runtime",
          artifact: "source/pico/stackchan-attention-runtime.ts"
        },
        {
          role: "pico-attention-detection",
          artifact: "source/pico/attention-detection.ts"
        },
        {
          role: "replay-sut-lane-policy",
          artifact: "source/gate/stackchan-attention-replay-lane-policy.ts"
        },
        {
          role: "gateway-head-target-lane",
          artifact: "source/gateway/head_target_lane.py"
        }
      ]);
      expect(contract.gateSources.map((source) => source.artifact)).toEqual([
        "source/gate/stackchan-attention-replay.ts",
        "source/gate/stackchan-attention-metrics.ts",
        "source/gate/stackchan-attention-replay-evidence.ts",
        "source/gate/stackchan-attention-replay-report.schema.json",
        "source/gate/stackchan-attention-replay-schema.ts",
        "source/gate/tests/stackchan-attention-replay-gate.test.ts",
        "source/gate/tests/stackchan-attention-replay-field.test.ts",
        "source/gate/tests/stackchan-attention-replay-evidence.test.ts",
        "source/gate/package.json",
        "source/gate/package-lock.json",
        "source/gateway/stackchan_mcp/__init__.py",
        "source/gateway/stackchan_mcp/wifi_power_save.py",
        "source/gateway/pyproject.toml",
        "source/gateway/uv.lock"
      ]);
      expect(contract.candidateMutableTestSources.map((source) => source.artifact)).toEqual([
        "source/gate/tests/stackchan-attention-replay-lane-policy.test.ts",
        "source/gateway/tests/test_head_target_lane.py"
      ]);
      expect(contract.producerSources.every((source) => HASH_PATTERN.test(source.sha256))).toBe(
        true
      );
      expect(contract.gateSources.every((source) => HASH_PATTERN.test(source.sha256))).toBe(true);
      expect(
        contract.candidateMutableTestSources.every((source) => HASH_PATTERN.test(source.sha256))
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistently repinned immutable producer source mismatch", async () => {
    await withEvidenceInputs(async (inputs) => {
      const contract = JSON.parse(await readFile(inputs.options.comparisonContract, "utf8")) as {
        producerSources: Array<{ role: string; sha256: string }>;
      };
      const immutable = contract.producerSources.find(
        (source) => source.role === "pico-attention-controller"
      );
      if (immutable === undefined) {
        throw new Error("comparison contract immutable producer is missing");
      }
      immutable.sha256 = "0".repeat(64);
      await writeJson(inputs.options.comparisonContract, contract);

      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          expectedComparisonContractSha256: await sha256(inputs.options.comparisonContract)
        })
      ).rejects.toThrow("comparison contract immutable source mismatch");
    });
  });

  it("requires all four mutable artifacts to match in the baseline qualification", async () => {
    await withEvidenceInputs(async (inputs) => {
      const contract = JSON.parse(await readFile(inputs.options.comparisonContract, "utf8")) as {
        candidateMutableTestSources: Array<{ artifact: string; sha256: string }>;
      };
      contract.candidateMutableTestSources[0] = {
        ...(contract.candidateMutableTestSources[0] ?? {
          artifact: "source/gate/tests/stackchan-attention-replay-lane-policy.test.ts",
          sha256: ""
        }),
        sha256: "0".repeat(64)
      };
      await writeJson(inputs.options.comparisonContract, contract);

      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          expectedComparisonContractSha256: await sha256(inputs.options.comparisonContract)
        })
      ).rejects.toThrow("comparison contract baseline mutable source mismatch");
    });
  });

  it("allows only replay policy and Gateway bytes to differ from the comparison contract", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(
        inputs.options.replayLanePolicySource,
        `${await readFile(inputs.options.replayLanePolicySource, "utf8")}\n// Qualification007 candidate.\n`
      );
      await writeFile(
        inputs.options.gatewayLaneSource,
        `${await readFile(inputs.options.gatewayLaneSource, "utf8")}\n# Qualification007 candidate.\n`
      );
      await writeFile(
        inputs.options.replayLanePolicyTestSource,
        `${await readFile(inputs.options.replayLanePolicyTestSource, "utf8")}\n// Qualification007 candidate test.\n`
      );
      await writeFile(
        inputs.options.gatewayLaneTestSource,
        `${await readFile(inputs.options.gatewayLaneTestSource, "utf8")}\n# Qualification007 candidate test.\n`
      );
      const candidateStartPath = join(inputs.directory, "candidate-start.json");
      const candidateStart = await captureStackChanAttentionReplayQualificationStart({
        outputPath: candidateStartPath,
        qualificationId: "Qualification007",
        capturedAtUtc: "2026-07-30T05:06:07.890Z",
        picoWorktree: join(inputs.directory, "pico"),
        gatewayWorktree: join(inputs.directory, "gateway")
      });
      const candidateReport = join(inputs.directory, "candidate-qualified.json");
      const candidateProducerSourceHash = await roleSourceAggregate([
        ["pico-attention-controller", inputs.options.picoControllerSource],
        ["pico-target-center-filter", inputs.options.picoTargetCenterFilterSource],
        ["pico-attention-runtime", inputs.options.picoRuntimeSource],
        ["pico-attention-detection", inputs.options.picoAttentionDetectionSource],
        ["replay-sut-lane-policy", inputs.options.replayLanePolicySource],
        ["gateway-head-target-lane", inputs.options.gatewayLaneSource]
      ]);
      await runStackChanAttentionReplay({
        reportOutput: candidateReport,
        repeat: 3,
        producerSourceHash: candidateProducerSourceHash
      });

      const result = await buildStackChanAttentionReplayEvidence({
        ...inputs.options,
        qualifiedReport: candidateReport,
        qualificationStartAttestation: candidateStartPath,
        expectedStartAttestationSha256: candidateStart.attestationSha256
      });
      expect(result).toMatchObject({
        outputArchive: inputs.options.outputArchive,
        stagingDirectory: inputs.options.stagingDirectory
      });
      const reviewManifest = JSON.parse(
        await readFile(join(result.stagingDirectory, "review-manifest.json"), "utf8")
      ) as {
        reports: {
          comparisonBaseline: { producerSourceHash: string };
          qualified: { producerSourceHash: string };
          qualifiedFreshRerun: { producerSourceHash: string };
        };
      };
      expect(reviewManifest.reports.comparisonBaseline.producerSourceHash).not.toBe(
        candidateProducerSourceHash
      );
      expect(reviewManifest.reports.qualified.producerSourceHash).toBe(candidateProducerSourceHash);
      expect(reviewManifest.reports.qualifiedFreshRerun.producerSourceHash).toBe(
        candidateProducerSourceHash
      );
    });
  });

  it("rejects a candidate raw schema-byte change even when the parsed schema is unchanged", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(
        inputs.options.replayReportSchemaSource,
        `${await readFile(inputs.options.replayReportSchemaSource, "utf8")}\n`
      );

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        "comparison contract immutable gate source mismatch"
      );
    });
  });

  it("rejects an omitted immutable Gateway lane dependency from a repinned comparison contract", async () => {
    await withEvidenceInputs(async (inputs) => {
      const contract = JSON.parse(await readFile(inputs.options.comparisonContract, "utf8")) as {
        gateSources: Array<{ artifact: string }>;
      };
      contract.gateSources = contract.gateSources.filter(
        (source) => source.artifact !== "source/gateway/stackchan_mcp/wifi_power_save.py"
      );
      await writeJson(inputs.options.comparisonContract, contract);

      await expect(
        buildStackChanAttentionReplayEvidence({
          ...inputs.options,
          expectedComparisonContractSha256: await sha256(inputs.options.comparisonContract)
        })
      ).rejects.toThrow("comparison contract gate source roster mismatch");
    });
  });

  it("rejects mutation of an immutable Gateway lane dependency", async () => {
    await withEvidenceInputs(async (inputs) => {
      await writeFile(inputs.options.gatewayWifiPowerSaveSource, "changed Wi-Fi dependency\n");

      await expect(buildStackChanAttentionReplayEvidence(inputs.options)).rejects.toThrow(
        /comparison contract immutable gate source mismatch|gateway worktree does not match qualification-start attestation/u
      );
    });
  });

  it("rejects a repinned embedded immutable-source tamper before portable verification", async () => {
    await withEvidenceInputs(async (inputs) => {
      const result = await buildStackChanAttentionReplayEvidence(inputs.options);
      const artifact = "inputs/comparison-contract.json";
      const contractPath = join(result.stagingDirectory, artifact);
      const contract = JSON.parse(await readFile(contractPath, "utf8")) as {
        producerSources: Array<{ role: string; sha256: string }>;
      };
      const immutable = contract.producerSources.find(
        (source) => source.role === "pico-attention-runtime"
      );
      if (immutable === undefined) {
        throw new Error("embedded immutable producer is missing");
      }
      immutable.sha256 = "0".repeat(64);
      await writeJson(contractPath, contract);
      const repinnedSha256 = await sha256(contractPath);
      await replaceSha256Sum(join(result.stagingDirectory, "SHA256SUMS"), artifact, repinnedSha256);

      await expect(
        verifyStackChanAttentionReplayEvidence(
          result.stagingDirectory,
          inputs.options.expectedStartAttestationSha256,
          inputs.options.expectedComparisonBaselineSha256,
          repinnedSha256
        )
      ).rejects.toThrow("comparison contract immutable source mismatch");
    });
  });
});

type EvidenceOptions = Parameters<typeof buildStackChanAttentionReplayEvidence>[0] & {
  readonly comparisonBaselineReport: string;
  readonly comparisonContract: string;
  readonly expectedComparisonContractSha256: string;
  readonly replayLanePolicySource: string;
  readonly replayLanePolicyTestSource: string;
  readonly gatewayLaneTestSource: string;
  readonly gatewayPackageInitSource: string;
  readonly gatewayWifiPowerSaveSource: string;
  readonly gatewayPyprojectSource: string;
  readonly gatewayUvLockSource: string;
};

async function withEvidenceInputs(
  callback: (inputs: {
    readonly directory: string;
    readonly options: EvidenceOptions;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-replay-evidence-case-"));
  try {
    const picoRepository = join(directory, "pico");
    const gatewayRepository = join(directory, "gateway");
    const copiedController = join(picoRepository, "src/modules/stackchan/attention-controller.ts");
    const copiedTargetCenterFilter = join(
      picoRepository,
      "src/modules/stackchan/target-center-filter.ts"
    );
    const copiedRuntime = join(picoRepository, "src/runtime/stackchan-attention-runtime.ts");
    const copiedAttentionDetection = join(
      picoRepository,
      "src/modules/vision/attention-detection.ts"
    );
    const copiedGatewayLane = join(gatewayRepository, "gateway/stackchan_mcp/head_target_lane.py");
    const copiedReplayProducer = join(
      picoRepository,
      "scripts/field/stackchan-attention-replay.ts"
    );
    const copiedAttentionMetrics = join(
      picoRepository,
      "scripts/field/stackchan-attention-metrics.ts"
    );
    const copiedReplayLanePolicy = join(
      picoRepository,
      "scripts/field/stackchan-attention-replay-lane-policy.ts"
    );
    const copiedReplayLanePolicyTest = join(
      picoRepository,
      "tests/stackchan-attention-replay-lane-policy.test.ts"
    );
    const copiedGatewayLaneTest = join(gatewayRepository, "gateway/tests/test_head_target_lane.py");
    const copiedGatewayPackageInit = join(gatewayRepository, "gateway/stackchan_mcp/__init__.py");
    const copiedGatewayWifiPowerSave = join(
      gatewayRepository,
      "gateway/stackchan_mcp/wifi_power_save.py"
    );
    const copiedGatewayPyproject = join(gatewayRepository, "gateway/pyproject.toml");
    const copiedGatewayUvLock = join(gatewayRepository, "gateway/uv.lock");
    const copiedReplayEvidenceBuilder = join(
      picoRepository,
      "scripts/field/stackchan-attention-replay-evidence.ts"
    );
    const copiedReplayReportSchema = join(
      picoRepository,
      "scripts/field/stackchan-attention-replay-report.schema.json"
    );
    const copiedReplaySchema = join(
      picoRepository,
      "scripts/field/stackchan-attention-replay-schema.ts"
    );
    const copiedReplayGateTest = join(
      picoRepository,
      "tests/stackchan-attention-replay-gate.test.ts"
    );
    const copiedReplayFieldTest = join(
      picoRepository,
      "tests/stackchan-attention-replay-field.test.ts"
    );
    const copiedReplayEvidenceTest = join(
      picoRepository,
      "tests/stackchan-attention-replay-evidence.test.ts"
    );
    const copiedPackageJson = join(picoRepository, "package.json");
    const copiedPackageLock = join(picoRepository, "package-lock.json");
    await copyWithParents(controllerSource, copiedController);
    await copyWithParents(targetCenterFilterSource, copiedTargetCenterFilter);
    await copyWithParents(runtimeSource, copiedRuntime);
    await copyWithParents(attentionDetectionSource, copiedAttentionDetection);
    await copyWithParents(gatewayLaneSource, copiedGatewayLane);
    await copyWithParents(replayProducerSource, copiedReplayProducer);
    await copyWithParents(attentionMetricsSource, copiedAttentionMetrics);
    await copyWithParents(replayLanePolicySource, copiedReplayLanePolicy);
    await copyWithParents(replayLanePolicyTestSource, copiedReplayLanePolicyTest);
    await copyWithParents(gatewayLaneTestSource, copiedGatewayLaneTest);
    await copyWithParents(gatewayPackageInitSource, copiedGatewayPackageInit);
    await copyWithParents(gatewayWifiPowerSaveSource, copiedGatewayWifiPowerSave);
    await copyWithParents(gatewayPyprojectSource, copiedGatewayPyproject);
    await copyWithParents(gatewayUvLockSource, copiedGatewayUvLock);
    await copyWithParents(replayEvidenceBuilderSource, copiedReplayEvidenceBuilder);
    await copyWithParents(replayReportSchemaSource, copiedReplayReportSchema);
    await copyWithParents(replaySchemaSource, copiedReplaySchema);
    await copyWithParents(replayGateTestSource, copiedReplayGateTest);
    await copyWithParents(replayFieldTestSource, copiedReplayFieldTest);
    await copyWithParents(replayEvidenceTestSource, copiedReplayEvidenceTest);
    await copyWithParents(packageJsonSource, copiedPackageJson);
    await copyWithParents(packageLockSource, copiedPackageLock);
    const picoRevision = await initializeRepository(picoRepository, "codex/pico-evidence");
    const gatewayRevision = await initializeRepository(gatewayRepository, "codex/gateway-evidence");

    const comparisonBaseline = join(directory, "comparison-baseline.json");
    const normalizedBefore = join(directory, "normalized-before.json");
    const normalizedAfter = join(directory, "normalized-after.json");
    await copyFile(qualifiedReportSource, comparisonBaseline);
    await copyFile(historicalReportSource, normalizedBefore);
    await copyFile(historicalReportSource, normalizedAfter);
    const logsDirectory = join(directory, "input-logs");
    await mkdir(logsDirectory);
    const focusedPicoLog = join(logsDirectory, "focused-pico.log");
    const fullPicoLog = join(logsDirectory, "full-pico.log");
    const gatewayLog = join(logsDirectory, "gateway.log");
    const secretlintLog = join(logsDirectory, "secretlint.log");
    const diffCheckLog = join(logsDirectory, "diff-check.log");
    await Promise.all([
      writeFile(focusedPicoLog, "focused tests passed\n"),
      writeFile(fullPicoLog, "full Pico gates passed\n"),
      writeFile(gatewayLog, "Gateway tests passed\n"),
      writeFile(secretlintLog, "secretlint passed\n"),
      writeFile(diffCheckLog, "git diff --check passed\n")
    ]);

    expect(picoRevision).toMatch(/^[a-f0-9]{40}$/u);
    expect(gatewayRevision).toMatch(/^[a-f0-9]{40}$/u);
    const qualificationStartAttestation = join(directory, "qualification-start-attestation.json");
    const qualificationStart = await captureStackChanAttentionReplayQualificationStart({
      outputPath: qualificationStartAttestation,
      qualificationId: "Qualification006",
      capturedAtUtc: "2026-07-30T01:55:34.916Z",
      picoWorktree: picoRepository,
      gatewayWorktree: gatewayRepository
    });
    const comparisonContract = join(directory, "comparison-contract.json");
    const capturedComparisonContract = await captureStackChanAttentionReplayComparisonContract({
      outputPath: comparisonContract,
      qualificationId: "Qualification006",
      capturedAtUtc: "2026-07-30T01:55:34.916Z",
      picoControllerSource: copiedController,
      picoTargetCenterFilterSource: copiedTargetCenterFilter,
      picoRuntimeSource: copiedRuntime,
      picoAttentionDetectionSource: copiedAttentionDetection,
      replayLanePolicySource: copiedReplayLanePolicy,
      replayLanePolicyTestSource: copiedReplayLanePolicyTest,
      gatewayLaneSource: copiedGatewayLane,
      gatewayLaneTestSource: copiedGatewayLaneTest,
      gatewayPackageInitSource: copiedGatewayPackageInit,
      gatewayWifiPowerSaveSource: copiedGatewayWifiPowerSave,
      gatewayPyprojectSource: copiedGatewayPyproject,
      gatewayUvLockSource: copiedGatewayUvLock,
      replayProducerSource: copiedReplayProducer,
      attentionMetricsSource: copiedAttentionMetrics,
      replayEvidenceBuilderSource: copiedReplayEvidenceBuilder,
      replayReportSchemaSource: copiedReplayReportSchema,
      replaySchemaSource: copiedReplaySchema,
      replayGateTestSource: copiedReplayGateTest,
      replayFieldTestSource: copiedReplayFieldTest,
      replayEvidenceTestSource: copiedReplayEvidenceTest,
      packageJsonSource: copiedPackageJson,
      packageLockSource: copiedPackageLock
    });

    await callback({
      directory,
      options: {
        outputArchive: join(directory, "review-evidence.tar.gz"),
        stagingDirectory: join(directory, "review-evidence"),
        qualifiedReport: qualifiedReportSource,
        comparisonBaselineReport: comparisonBaseline,
        comparisonContract,
        expectedComparisonContractSha256: capturedComparisonContract.comparisonContractSha256,
        normalizedBeforeReport: normalizedBefore,
        normalizedAfterReport: normalizedAfter,
        picoControllerSource: copiedController,
        picoTargetCenterFilterSource: copiedTargetCenterFilter,
        picoRuntimeSource: copiedRuntime,
        picoAttentionDetectionSource: copiedAttentionDetection,
        gatewayLaneSource: copiedGatewayLane,
        gatewayPackageInitSource: copiedGatewayPackageInit,
        gatewayWifiPowerSaveSource: copiedGatewayWifiPowerSave,
        gatewayPyprojectSource: copiedGatewayPyproject,
        gatewayUvLockSource: copiedGatewayUvLock,
        replayProducerSource: copiedReplayProducer,
        attentionMetricsSource: copiedAttentionMetrics,
        replayLanePolicySource: copiedReplayLanePolicy,
        replayLanePolicyTestSource: copiedReplayLanePolicyTest,
        gatewayLaneTestSource: copiedGatewayLaneTest,
        replayEvidenceBuilderSource: copiedReplayEvidenceBuilder,
        replayReportSchemaSource: copiedReplayReportSchema,
        replaySchemaSource: copiedReplaySchema,
        replayGateTestSource: copiedReplayGateTest,
        replayFieldTestSource: copiedReplayFieldTest,
        replayEvidenceTestSource: copiedReplayEvidenceTest,
        focusedPicoLog,
        fullPicoLog,
        gatewayLog,
        secretlintLog,
        diffCheckLog,
        qualificationStartAttestation,
        expectedStartAttestationSha256: qualificationStart.attestationSha256,
        expectedComparisonBaselineSha256: await sha256(comparisonBaseline)
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function initializeRepository(directory: string, branch: string): Promise<string> {
  await execFileAsync("git", ["init", "-b", branch], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Replay Evidence Test"], {
    cwd: directory
  });
  await execFileAsync("git", ["config", "user.email", "replay-evidence@example.invalid"], {
    cwd: directory
  });
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "establish qualification scope"], {
    cwd: directory
  });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
  const revision = stdout.trim();
  await execFileAsync("git", ["remote", "add", "origin", `https://example.invalid/${branch}.git`], {
    cwd: directory
  });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", revision], {
    cwd: directory
  });
  return revision;
}

async function createSelfConsistentCenteredTamper(): Promise<
  ReturnType<typeof reduceStackChanAttentionReplayEvidence>
> {
  const report = JSON.parse(await readFile(qualifiedReportSource, "utf8")) as Awaited<
    ReturnType<typeof runStackChanAttentionReplay>
  >;
  const rawRun = report.scenarios.map((scenario) => ({
    canonicalInput: scenario.canonicalInput,
    events: scenario.events.map((event) =>
      scenario.id === "slow-continuous-tracking" && !event.stop
        ? {
            ...event,
            centered: true,
            decision: event.decision ? { ...event.decision, centered: true } : event.decision
          }
        : event
    )
  }));
  return reduceStackChanAttentionReplayEvidence(
    [structuredClone(rawRun), structuredClone(rawRun), structuredClone(rawRun)],
    3,
    {
      evidenceKind: "qualified",
      runtimeEvidenceSource: "recorded-final-events",
      producerSourceHash: report.producerSourceHash
    }
  );
}

async function copyWithParents(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function evidenceCliArguments(options: EvidenceOptions): string[] {
  return [
    "--output-archive",
    options.outputArchive,
    "--staging-dir",
    options.stagingDirectory,
    "--comparison-baseline-report",
    options.comparisonBaselineReport,
    "--expected-comparison-baseline-sha256",
    options.expectedComparisonBaselineSha256,
    "--comparison-contract",
    options.comparisonContract,
    "--expected-comparison-contract-sha256",
    options.expectedComparisonContractSha256,
    "--qualified-report",
    options.qualifiedReport,
    "--normalized-before-report",
    options.normalizedBeforeReport,
    "--normalized-after-report",
    options.normalizedAfterReport,
    "--pico-controller-source",
    options.picoControllerSource,
    "--pico-target-center-filter-source",
    options.picoTargetCenterFilterSource,
    "--pico-runtime-source",
    options.picoRuntimeSource,
    "--pico-attention-detection-source",
    options.picoAttentionDetectionSource,
    "--gateway-lane-source",
    options.gatewayLaneSource,
    "--gateway-lane-test-source",
    options.gatewayLaneTestSource,
    "--gateway-package-init-source",
    options.gatewayPackageInitSource,
    "--gateway-wifi-power-save-source",
    options.gatewayWifiPowerSaveSource,
    "--gateway-pyproject-source",
    options.gatewayPyprojectSource,
    "--gateway-uv-lock-source",
    options.gatewayUvLockSource,
    "--replay-producer-source",
    options.replayProducerSource,
    "--attention-metrics-source",
    options.attentionMetricsSource,
    "--replay-lane-policy-source",
    options.replayLanePolicySource,
    "--replay-lane-policy-test-source",
    options.replayLanePolicyTestSource,
    "--replay-evidence-builder-source",
    options.replayEvidenceBuilderSource,
    "--replay-report-schema-source",
    options.replayReportSchemaSource,
    "--replay-schema-source",
    options.replaySchemaSource,
    "--replay-gate-test-source",
    options.replayGateTestSource,
    "--replay-field-test-source",
    options.replayFieldTestSource,
    "--replay-evidence-test-source",
    options.replayEvidenceTestSource,
    "--focused-pico-log",
    options.focusedPicoLog,
    "--full-pico-log",
    options.fullPicoLog,
    "--gateway-log",
    options.gatewayLog,
    "--secretlint-log",
    options.secretlintLog,
    "--diff-check-log",
    options.diffCheckLog,
    "--qualification-start-attestation",
    options.qualificationStartAttestation,
    "--expected-start-attestation-sha256",
    options.expectedStartAttestationSha256
  ];
}

function qualificationStartCliArguments(
  options: Parameters<typeof captureStackChanAttentionReplayQualificationStart>[0]
): string[] {
  return [
    "capture-start",
    "--output-path",
    options.outputPath,
    "--qualification-id",
    options.qualificationId,
    "--captured-at-utc",
    options.capturedAtUtc,
    "--pico-worktree",
    options.picoWorktree,
    "--gateway-worktree",
    options.gatewayWorktree
  ];
}

function producerHashCliArguments(options: {
  readonly picoControllerSource: string;
  readonly picoTargetCenterFilterSource: string;
  readonly picoRuntimeSource: string;
  readonly picoAttentionDetectionSource: string;
  readonly replayLanePolicySource: string;
  readonly gatewayLaneSource: string;
}): string[] {
  return [
    "producer-hash",
    "--pico-controller-source",
    options.picoControllerSource,
    "--pico-target-center-filter-source",
    options.picoTargetCenterFilterSource,
    "--pico-runtime-source",
    options.picoRuntimeSource,
    "--pico-attention-detection-source",
    options.picoAttentionDetectionSource,
    "--replay-lane-policy-source",
    options.replayLanePolicySource,
    "--gateway-lane-source",
    options.gatewayLaneSource
  ];
}

function comparisonContractCliArguments(options: {
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
}): string[] {
  return [
    "capture-comparison-contract",
    "--output-path",
    options.outputPath,
    "--qualification-id",
    options.qualificationId,
    "--captured-at-utc",
    options.capturedAtUtc,
    "--pico-controller-source",
    options.picoControllerSource,
    "--pico-target-center-filter-source",
    options.picoTargetCenterFilterSource,
    "--pico-runtime-source",
    options.picoRuntimeSource,
    "--pico-attention-detection-source",
    options.picoAttentionDetectionSource,
    "--replay-lane-policy-source",
    options.replayLanePolicySource,
    "--replay-lane-policy-test-source",
    options.replayLanePolicyTestSource,
    "--gateway-lane-source",
    options.gatewayLaneSource,
    "--gateway-lane-test-source",
    options.gatewayLaneTestSource,
    "--gateway-package-init-source",
    options.gatewayPackageInitSource,
    "--gateway-wifi-power-save-source",
    options.gatewayWifiPowerSaveSource,
    "--gateway-pyproject-source",
    options.gatewayPyprojectSource,
    "--gateway-uv-lock-source",
    options.gatewayUvLockSource,
    "--replay-producer-source",
    options.replayProducerSource,
    "--attention-metrics-source",
    options.attentionMetricsSource,
    "--replay-evidence-builder-source",
    options.replayEvidenceBuilderSource,
    "--replay-report-schema-source",
    options.replayReportSchemaSource,
    "--replay-schema-source",
    options.replaySchemaSource,
    "--replay-gate-test-source",
    options.replayGateTestSource,
    "--replay-field-test-source",
    options.replayFieldTestSource,
    "--replay-evidence-test-source",
    options.replayEvidenceTestSource,
    "--package-json-source",
    options.packageJsonSource,
    "--package-lock-source",
    options.packageLockSource
  ];
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function writeFixtureSource(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function roleSourceAggregate(
  sources: readonly (readonly [role: string, path: string])[]
): Promise<string> {
  const hash = createHash("sha256");
  for (const [role, path] of sources) {
    hash.update(role);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function replaceSha256Sum(
  sumsPath: string,
  artifact: string,
  replacementHash: string
): Promise<void> {
  const lines = (await readFile(sumsPath, "utf8")).split("\n");
  const suffix = `  ${artifact}`;
  const index = lines.findIndex((line) => line.endsWith(suffix));
  if (index < 0) {
    throw new Error("test artifact is absent from SHA256SUMS");
  }
  lines[index] = `${replacementHash}${suffix}`;
  await writeFile(sumsPath, lines.join("\n"));
}

function rewriteArtifactDescriptors(
  value: unknown,
  artifact: string,
  sha256: string,
  bytes: number
): number {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).reduce<number>(
      (count, item) => count + rewriteArtifactDescriptors(item, artifact, sha256, bytes),
      0
    );
  }
  if (value === null || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  if (record.artifact === artifact) {
    record.sha256 = sha256;
    record.bytes = bytes;
    count += 1;
  }
  return Object.values(record).reduce<number>(
    (total, item) => total + rewriteArtifactDescriptors(item, artifact, sha256, bytes),
    count
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
