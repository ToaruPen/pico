import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  type PicoMilestoneSmokeDependencies,
  type PicoMilestoneSmokeReport,
  type PicoMilestoneSmokeSectionName,
  type PiRuntimeSmokeCommandResult,
  picoMilestoneSmokeExitCode,
  runPicoMilestoneSmokeSuite
} from "../scripts/smoke/milestone-suite.js";
import type { PicoConfig } from "../src/config/index.js";

const piPassed = {
  status: 0,
  stdout: '{"loaded":true,"identity":"pico"}',
  stderr: ""
} as const satisfies PiRuntimeSmokeCommandResult;

const residentAudioInputSkipped = {
  status: "skipped",
  provider: "resident-audio-input",
  reason: "Resident audio input is not configured."
} as const;

function configuredSectionDependencies(): PicoMilestoneSmokeDependencies {
  return {
    runPiRuntimeCommand: () => piPassed,
    runVoiceProviderSmoke: () =>
      Promise.resolve({
        stt: {
          status: "skipped",
          provider: "apple-speech",
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
    runResidentAudioInputSmoke: () => Promise.resolve(residentAudioInputSkipped),
    runTapoRtspSnapshotSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "tapo-rtsp",
        reason: "Tapo camera config is not configured."
      }),
    runTapoPersonFollowSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "tapo-onvif-ptz",
        reason: "Live PTZ nudge is not enabled."
      }),
    runPersonDetectionSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "tapo-rtsp+onnxruntime",
        reason: "Person detection config is not configured."
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
        reason: "Camera config is not configured."
      }),
    runEmbeddingSidecarSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "embedding-sidecar",
        reason: "Embedding sidecar is not configured."
      }),
    runMem0RuntimeSmoke: () =>
      Promise.resolve({
        status: "skipped",
        provider: "mem0-oss",
        reason: "Mem0 runtime is not configured."
      })
  };
}

function expectMilestoneSectionNames(report: PicoMilestoneSmokeReport): void {
  expect(report.sections.map((section) => section.name)).toEqual([
    "pi_runtime",
    "voice_stt",
    "voice_tts",
    "resident_audio_input",
    "tapo_snapshot",
    "tapo_ptz",
    "person_detection",
    "ollama_vlm",
    "camera_vlm_scene",
    "embedding_sidecar",
    "mem0_runtime",
    "memory_mem0",
    "audit_otel"
  ]);
}

function expectMemoryAndAuditEvidence(report: PicoMilestoneSmokeReport): void {
  const memorySection = requireSection(report, "memory_mem0");
  const auditSection = requireSection(report, "audit_otel");

  expect(memorySection.status).toBe("passed");
  expect(memorySection.details?.memoryId).toBe("milestone-mem0-1");
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
  const isolatedConfigDirectory = mkdtempSync(join(tmpdir(), "pico-milestone-empty-config-"));
  const isolatedConfigPath = join(isolatedConfigDirectory, "pico.local.yaml");

  writeFileSync(isolatedConfigPath, "{}\n");

  afterAll(() => {
    rmSync(isolatedConfigDirectory, { recursive: true });
  });

  it("reports all milestone sections with deterministic memory and audit evidence", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
      configuredSectionDependencies()
    );

    expect(report.status).toBe("skipped");
    expect(picoMilestoneSmokeExitCode(report)).toBe(0);
    expectMilestoneSectionNames(report);
    expectMemoryAndAuditEvidence(report);
  });

  it("returns a failing process code when any milestone section fails", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
      {
        runPiRuntimeCommand: () => piPassed,
        runVoiceProviderSmoke: () =>
          Promise.resolve({
            stt: {
              status: "skipped",
              provider: "apple-speech"
            },
            tts: {
              status: "skipped",
              provider: "aivis-speech"
            }
          }),
        runResidentAudioInputSmoke: () => Promise.resolve(residentAudioInputSkipped),
        runTapoRtspSnapshotSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp"
          }),
        runTapoPersonFollowSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-onvif-ptz"
          }),
        runPersonDetectionSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp+onnxruntime"
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
            reason: "Camera config is not configured."
          }),
        runMem0RuntimeSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "mem0-oss",
            reason: "Mem0 runtime is not configured."
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
      PICO_CONFIG_PATH: isolatedConfigPath,
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

  it("loads YAML config once and passes it to provider smoke sections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-config-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
camera:
  tapo:
    host: 192.168.10.25
    user: camera-user
    password: camera-passphrase
vision:
  ollama:
    localBaseUrl: http://127.0.0.1:11434
`
    );

    const observedConfigs: PicoConfig[] = [];
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        runVoiceProviderSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            stt: {
              status: "skipped",
              provider: "apple-speech"
            },
            tts: {
              status: "skipped",
              provider: "aivis-speech"
            }
          });
        },
        runResidentAudioInputSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "resident-audio-input",
            reason: "Resident audio input is not configured."
          });
        },
        runTapoRtspSnapshotSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp"
          });
        },
        runTapoPersonFollowSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "tapo-onvif-ptz"
          });
        },
        runPersonDetectionSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp+onnxruntime",
            reason: "Person detection config is not configured."
          });
        },
        runOllamaVlmConnectivitySmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "ollama"
          });
        },
        runCameraVlmSceneSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp+ollama",
            reason: "Camera config is not configured."
          });
        },
        runMem0RuntimeSmoke: (config) => {
          observedConfigs.push(config);

          return Promise.resolve({
            status: "skipped",
            provider: "mem0-oss",
            reason: "Mem0 runtime is not configured."
          });
        }
      }
    );

    expect(report.status).toBe("skipped");
    expect(observedConfigs).toHaveLength(8);
    expect(new Set(observedConfigs).size).toBe(1);
    expect(observedConfigs[0]?.camera.tapo?.host).toBe("192.168.10.25");
    expect(observedConfigs[0]?.vision.ollama?.localBaseUrl).toBe("http://127.0.0.1:11434");
  });

  it("reports config load failures without bypassing the milestone report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-invalid-config-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
vision:
  ollama:
    localBaseUrl: http://192.168.0.10:11434
`
    );

    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        runPiRuntimeCommand: () => piPassed
      }
    );

    expect(report.status).toBe("failed");
    expect(requireSection(report, "pi_runtime").status).toBe("passed");
    expect(requireSection(report, "ollama_vlm")).toEqual({
      name: "ollama_vlm",
      status: "failed",
      provider: "ollama",
      reason:
        "pico config load failed: pico config vision.ollama.localBaseUrl must use a local SSH tunnel URL"
    });
    expectMemoryAndAuditEvidence(report);
  });

  it("reports audit OTel config load failures as audit_otel failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-invalid-audit-config-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
audit:
  otel:
    enabled: true
    endpoint: https://otel.example.com/v1/logs
`
    );

    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        runPiRuntimeCommand: () => piPassed
      }
    );

    const reason =
      "pico config load failed: pico config audit.otel.endpoint must use a local Collector URL";
    expect(report.status).toBe("failed");
    expect(requireSection(report, "memory_mem0").status).toBe("passed");
    expect(requireSection(report, "audit_otel")).toEqual({
      name: "audit_otel",
      status: "failed",
      provider: "structured-audit+otel",
      reason
    });
  });

  it("maps a passing Mem0 runtime smoke section into the milestone report", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
      {
        ...configuredSectionDependencies(),
        runMem0RuntimeSmoke: () =>
          Promise.resolve({
            status: "passed",
            provider: "mem0-oss",
            details: {
              scopeId: "pico-smoke-test",
              memoryCount: 1,
              searchResultCount: 1,
              auditEventCount: 3,
              otelRecordCount: 3
            }
          })
      }
    );

    expect(requireSection(report, "mem0_runtime")).toEqual({
      name: "mem0_runtime",
      status: "passed",
      provider: "mem0-oss",
      details: {
        scopeId: "pico-smoke-test",
        memoryCount: 1,
        searchResultCount: 1,
        auditEventCount: 3,
        otelRecordCount: 3
      }
    });
  });

  it("maps a failed Mem0 runtime smoke section into the milestone report status", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
      {
        ...configuredSectionDependencies(),
        runMem0RuntimeSmoke: () =>
          Promise.resolve({
            status: "failed",
            provider: "mem0-oss",
            reason: "qdrant unavailable"
          })
      }
    );

    expect(report.status).toBe("failed");
    expect(requireSection(report, "mem0_runtime")).toEqual({
      name: "mem0_runtime",
      status: "failed",
      provider: "mem0-oss",
      reason: "qdrant unavailable"
    });
  });

  it("normalizes thrown Pi runtime errors into a failed section", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
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
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
      configuredSectionDependencies()
    );
    const auditSection = requireSection(report, "audit_otel");

    expect(auditSection.details).toMatchObject({
      category: "memory_write",
      eventName: "long_memory.mem0.added",
      eventCount: 2,
      otelRecordCount: 2
    });
  });

  it("exports audit records to the configured OTel Collector path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-audit-otel-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
audit:
  otel:
    enabled: true
    endpoint: http://127.0.0.1:4318/v1/logs
    serviceName: pico-test
    timeoutMs: 500
`
    );
    const exportedEvents: string[] = [];
    let shutdownCalled = false;

    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        createAuditOtelExporter: (config) => {
          expect(config).toMatchObject({
            endpoint: "http://127.0.0.1:4318/v1/logs",
            serviceName: "pico-test",
            timeoutMs: 500
          });

          return {
            export: (event) => {
              exportedEvents.push(event.name);

              return Promise.resolve();
            },
            shutdown: () => {
              shutdownCalled = true;

              return Promise.resolve();
            }
          };
        }
      }
    );
    const auditSection = requireSection(report, "audit_otel");

    expect(auditSection.status).toBe("passed");
    expect(auditSection.provider).toBe("structured-audit+otel");
    expect(auditSection.details).toMatchObject({
      eventCount: 2,
      exportedOtelRecordCount: 2
    });
    expect(exportedEvents).toEqual(["long_memory.mem0.added", "long_memory.mem0.searched"]);
    expect(shutdownCalled).toBe(true);
  });

  it("keeps the memory candidate section passed when OTel export fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-audit-otel-failure-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
audit:
  otel:
    enabled: true
    endpoint: http://127.0.0.1:4318/v1/logs
`
    );

    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        createAuditOtelExporter: () => ({
          export: () => Promise.reject(new Error("collector unavailable")),
          shutdown: () => Promise.resolve()
        })
      }
    );

    expect(report.status).toBe("failed");
    expect(requireSection(report, "memory_mem0")).toMatchObject({
      status: "passed",
      provider: "mem0-oss",
      details: {
        memoryId: "milestone-mem0-1",
        category: "facility_knowledge"
      }
    });
    expect(requireSection(report, "audit_otel")).toEqual({
      name: "audit_otel",
      status: "failed",
      provider: "structured-audit+otel",
      reason: "collector unavailable"
    });
  });

  it("preserves audit OTel export failures when shutdown also fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-milestone-audit-otel-dual-failure-"));
    const configPath = join(directory, "pico.local.yaml");
    writeFileSync(
      configPath,
      `
audit:
  otel:
    enabled: true
    endpoint: http://127.0.0.1:4318/v1/logs
`
    );

    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: configPath },
      {
        ...configuredSectionDependencies(),
        createAuditOtelExporter: () => ({
          export: () => Promise.reject(new Error("collector unavailable")),
          shutdown: () => Promise.reject(new Error("shutdown failed"))
        })
      }
    );

    expect(report.status).toBe("failed");
    expect(requireSection(report, "memory_mem0").status).toBe("passed");
    expect(requireSection(report, "audit_otel")).toEqual({
      name: "audit_otel",
      status: "failed",
      provider: "structured-audit+otel",
      reason: "collector unavailable; shutdown also failed: shutdown failed"
    });
  });

  it("classifies missing Pi Agent model credentials as an actionable skip", async () => {
    const report = await runPicoMilestoneSmokeSuite(
      { PICO_CONFIG_PATH: isolatedConfigPath },
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
              provider: "apple-speech"
            },
            tts: {
              status: "skipped",
              provider: "aivis-speech"
            }
          }),
        runResidentAudioInputSmoke: () => Promise.resolve(residentAudioInputSkipped),
        runTapoRtspSnapshotSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-rtsp"
          }),
        runTapoPersonFollowSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "tapo-onvif-ptz"
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
            reason: "Camera config is not configured."
          }),
        runMem0RuntimeSmoke: () =>
          Promise.resolve({
            status: "skipped",
            provider: "mem0-oss",
            reason: "Mem0 runtime is not configured."
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
