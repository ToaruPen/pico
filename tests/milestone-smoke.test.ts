import { describe, expect, it } from "vitest";

import {
  type PicoMilestoneSmokeDependencies,
  type PicoMilestoneSmokeReport,
  type PicoMilestoneSmokeSectionName,
  type PiRuntimeSmokeCommandResult,
  picoMilestoneSmokeExitCode,
  runPicoMilestoneSmokeSuite
} from "../scripts/smoke/milestone-suite.js";

const piPassed = {
  status: 0,
  stdout: '{"loaded":true,"identity":"pico"}',
  stderr: ""
} as const satisfies PiRuntimeSmokeCommandResult;

function configuredSectionDependencies(): PicoMilestoneSmokeDependencies {
  return {
    runPiRuntimeCommand: () => piPassed,
    runVoiceProviderSmoke: () =>
      Promise.resolve({
        stt: {
          status: "skipped",
          provider: "mlx-whisper",
          reason: "STT sidecar is not configured."
        },
        tts: {
          status: "passed",
          provider: "aivis-speech",
          details: {
            totalAudioBytes: 1200
          }
        }
      }),
    runTapoRtspSnapshotSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "tapo-rtsp",
        reason: "Tapo camera env is not configured."
      }),
    runOllamaVlmConnectivitySmoke: () =>
      Promise.resolve({
        status: "passed",
        provider: "ollama",
        details: {
          endpointId: "windows-ollama-qwen3-5",
          model: "qwen3.5:9b",
          checkedUrl: "http://127.0.0.1:11434/api/tags",
          modelCount: 1
        }
      }),
    runCameraVlmSceneSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "tapo-rtsp+ollama",
        reason: "Camera env is not configured."
      })
  };
}

function expectMilestoneSectionNames(report: PicoMilestoneSmokeReport): void {
  expect(report.sections.map((section) => section.name)).toEqual([
    "pi_runtime",
    "voice_stt",
    "voice_tts",
    "tapo_snapshot",
    "ollama_vlm",
    "camera_vlm_scene",
    "memory_candidate",
    "audit_otel"
  ]);
}

function expectMemoryAndAuditEvidence(report: PicoMilestoneSmokeReport): void {
  const memorySection = requireSection(report, "memory_candidate");
  const auditSection = requireSection(report, "audit_otel");

  expect(memorySection.status).toBe("passed");
  expect(memorySection.details?.promotedMemoryId).toBe(1);
  expect(auditSection.status).toBe("passed");
  expect(auditSection.details?.category).toBe("memory_write");
  expect(typeof auditSection.details?.otelRecordCount).toBe("number");
}

function requireSection(
  report: PicoMilestoneSmokeReport,
  name: PicoMilestoneSmokeSectionName
): PicoMilestoneSmokeReport["sections"][number] {
  const section = report.sections.find((current) => current.name === name);

  if (section === undefined) {
    throw new Error(`Expected ${name} section.`);
  }

  return section;
}

describe("pico milestone smoke suite", () => {
  it("reports all milestone sections with deterministic memory and audit evidence", async () => {
    const report = await runPicoMilestoneSmokeSuite({}, configuredSectionDependencies());

    expect(report.status).toBe("skipped");
    expect(picoMilestoneSmokeExitCode(report)).toBe(0);
    expectMilestoneSectionNames(report);
    expectMemoryAndAuditEvidence(report);
  });

  it("returns a failing process code when any milestone section fails", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      {},
      {
        runPiRuntimeCommand: () => piPassed,
        runVoiceProviderSmoke: () =>
          Promise.resolve({
            stt: {
              status: "skipped",
              provider: "mlx-whisper"
            },
            tts: {
              status: "skipped",
              provider: "aivis-speech"
            }
          }),
        runTapoRtspSnapshotSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp"
          }),
        runOllamaVlmConnectivitySmoke: () =>
          Promise.resolve({
            status: "failed",
            provider: "ollama",
            reason: "qwen3.5:9b is not available."
          }),
        runCameraVlmSceneSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp+ollama",
            reason: "Camera env is not configured."
          })
      }
    );

    expect(report.status).toBe("failed");
    expect(picoMilestoneSmokeExitCode(report)).toBe(1);
    expect(report.sections).toContainEqual({
      name: "ollama_vlm",
      status: "failed",
      provider: "ollama",
      reason: "qwen3.5:9b is not available."
    });
  });

  it("passes the suite environment into the Pi runtime command", async () => {
    const suiteEnvironment = {
      PICO_PI_AGENT_TOKEN: "configured-for-test"
    } as NodeJS.ProcessEnv;
    let observedEnvironment: NodeJS.ProcessEnv | undefined;

    const report = await runPicoMilestoneSmokeSuite(suiteEnvironment, {
      ...configuredSectionDependencies(),
      runPiRuntimeCommand: (env) => {
        observedEnvironment = env;

        return piPassed;
      }
    });

    expect(observedEnvironment).toBe(suiteEnvironment);
    expect(report.sections[0]?.status).toBe("passed");
  });

  it("normalizes thrown Pi runtime errors into a failed section", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      {},
      {
        ...configuredSectionDependencies(),
        runPiRuntimeCommand: () => {
          throw new Error("Pi runtime command crashed.");
        }
      }
    );

    expect(report.sections[0]).toEqual({
      name: "pi_runtime",
      status: "failed",
      provider: "pi",
      reason: "Pi runtime command crashed."
    });
    expect(report.status).toBe("failed");
    expect(picoMilestoneSmokeExitCode(report)).toBe(1);
  });

  it("reports audit OTel evidence from mapped audit records", async () => {
    const report = await runPicoMilestoneSmokeSuite({}, configuredSectionDependencies());
    const auditSection = requireSection(report, "audit_otel");

    expect(auditSection.details).toMatchObject({
      category: "memory_write",
      eventName: "long_memory.candidate_job.enqueued",
      eventCount: 4,
      otelRecordCount: 4
    });
  });

  it("classifies missing Pi Agent model credentials as an actionable skip", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      {},
      {
        runPiRuntimeCommand: () => ({
          status: 2,
          stdout: "",
          stderr:
            "pico Pi runtime smoke requires configured Pi Agent model credentials. Authenticate Pi Agent."
        }),
        runVoiceProviderSmoke: () =>
          Promise.resolve({
            stt: {
              status: "skipped",
              provider: "mlx-whisper"
            },
            tts: {
              status: "skipped",
              provider: "aivis-speech"
            }
          }),
        runTapoRtspSnapshotSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp"
          }),
        runOllamaVlmConnectivitySmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "ollama"
          }),
        runCameraVlmSceneSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp+ollama",
            reason: "Camera env is not configured."
          })
      }
    );

    expect(report.sections[0]).toEqual({
      name: "pi_runtime",
      status: "skipped",
      provider: "pi",
      reason:
        "pico Pi runtime smoke requires configured Pi Agent model credentials. Authenticate Pi Agent."
    });
    expect(picoMilestoneSmokeExitCode(report)).toBe(0);
  });
});
