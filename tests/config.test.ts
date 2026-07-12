import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  definePicoConfig,
  emptyPicoConfig,
  loadPicoConfig,
  loadPicoConfigFromEnvironment
} from "../src/config/index.js";

function temporaryConfigFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-config-test-"));
  const path = join(directory, "pico.local.yaml");
  writeFileSync(path, content);

  return path;
}

function temporaryRepoConfigFile(content: string): {
  readonly root: string;
  readonly path: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pico-config-root-"));
  const directory = join(root, "config");
  const path = join(directory, "pico.local.yaml");

  mkdirSync(directory);
  writeFileSync(path, content);

  return { root, path };
}

describe("pico YAML config", () => {
  it("parses the startup-only Pico model selection", () => {
    expect(
      definePicoConfig({
        pico: {
          model: {
            provider: "openai-codex",
            id: "gpt-5.6-sol",
            thinkingLevel: "medium"
          }
        }
      }).pico
    ).toEqual({
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        thinkingLevel: "medium"
      }
    });
  });

  it("allows normal Pi config without a Pico model and rejects malformed selections", () => {
    expect(definePicoConfig({}).pico).toEqual({});
    expect(() =>
      definePicoConfig({
        pico: {
          model: {
            provider: "openai-codex",
            id: "gpt-5.6-sol",
            thinkingLevel: "automatic"
          }
        }
      })
    ).toThrow("pico config pico.model.thinkingLevel");
    expect(() =>
      definePicoConfig({
        pico: {
          model: {
            provider: "openai-codex",
            id: " ",
            thinkingLevel: "medium"
          }
        }
      })
    ).toThrow("pico config pico.model.id");
  });

  it("returns empty config when the local config file is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-config-missing-"));

    expect(loadPicoConfig({ cwd: directory })).toEqual(emptyPicoConfig);
  });

  it("rejects missing explicitly selected config files", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-config-explicit-missing-"));
    const path = join(directory, "missing.local.yaml");

    expect(() => loadPicoConfig({ path })).toThrow(`pico config file not found: ${path}`);
    expect(() => loadPicoConfigFromEnvironment({ PICO_CONFIG_PATH: path })).toThrow(
      `pico config file not found: ${path}`
    );
  });

  it("requires explicit voice audio providers when the resident runtime is enabled", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            enabled: true,
            audioOutput: {
              provider: "alsa",
              device: "hw:0,0"
            }
          }
        }
      })
    ).toThrow("pico config voice.resident.audioInput is required when resident is enabled");

    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            enabled: true,
            audioInput: {
              provider: "alsa",
              device: "hw:1,0"
            }
          }
        }
      })
    ).toThrow("pico config voice.resident.audioOutput is required when resident is enabled");
  });

  it("loads configured camera, vision, voice, memory, and person detection providers from YAML", () => {
    const path = temporaryConfigFile(`
session:
  enabled: true
  startTriggers:
    wakeNames:
      - ピコ
      - pico
    greetings:
      - おはよう
      - こんにちは
    candidateTimeoutMs: 12000
  ending:
    mode: timed
    durationMs: 90000
camera:
  tapo:
    sourceId: tapo-main
    host: 192.168.3.25
    port: 554
    onvifPort: 2020
    user: camera-user
    password: camera-password
    streams:
      scene: stream1
      detection: stream2
    timeoutMs: 15000
    maxFrameBytes: 1024
  personFollow:
    enabled: true
    sourceCameraId: tapo-main
    deadZone: 0.12
    maxStep: 0.3
    speed: 0.4
    cooldownMs: 500
    lostTargetTimeoutMs: 3000
vision:
  ollama:
    endpointId: windows-qwen
    localBaseUrl: http://127.0.0.1:11434
    auth:
      headerName: x-api-key
      apiKey: local-dev-key
    tunnel:
      kind: tailscale_ssh
      sshTarget: pico-vision-host
    timeoutMs: 12000
    maxImageEdgePixels: 512
  personDetection:
    enabled: true
    sourceCameraId: tapo-main
    modelFamily: pinto0309
    provider: onnxruntime
    modelPath: /opt/pico/models/pinto0309/yolox_nano_person.onnx
    inputWidth: 320
    inputHeight: 320
    outputLayout: cxcywh_score_class
    coordinateScale: normalized
    frameIntervalMs: 500
    confidenceThreshold: 0.55
voice:
  resident:
    enabled: true
    audioInput:
      provider: avfoundation
      device: ':0'
    audioOutput:
      provider: afplay
      route: system_default
    singleInstanceLockPath: tmp/pico-custom-resident.lock
    minTriggerConfidence: 0.72
    shutdownGraceMs: 3000
    activation:
      mode: push_to_talk
      provider: loopback_http
      host: 127.0.0.1
      port: 8781
      authTokenPath: tmp/pico-activation-token
      debounceMs: 800
      activationWindowMs: 8000
    vad:
      provider: ten_vad
      jsPath: vendors/ten-vad/ten_vad.js
      wasmPath: vendors/ten-vad/ten_vad.wasm
      hopSize: 160
      threshold: 0.5
    utteranceWindow:
      minSpeechMs: 300
      silenceMs: 700
      maxUtteranceMs: 5000
      minRmsDb: -55
  probes:
    enabled: true
  echoControl:
    enabled: true
    mode: aec
    provider: web_rtc_aec3
    providerEndpoint: http://127.0.0.1:8770
    sampleRateHz: 16000
    channels: 1
    frameMs: 10
    tailMuteMs: 700
    diagnostics:
      enabled: true
  stt:
    appleSpeech:
      id: local-apple-speech
      localBaseUrl: http://127.0.0.1:8766
      language: ja-JP
      timeoutMs: 30000
      warmupAudioSeconds: 0.25
      samplePcm16lePath: /tmp/pico-known-ja.pcm
      sampleRateHz: 16000
      channels: 1
  tts:
    aivis:
      id: local-aivis
      localBaseUrl: http://127.0.0.1:10101
      speakerId: 888753760
      timeoutMs: 30000
      text: こんにちは。
memory:
  mem0:
    enabled: true
    infer: false
    historyDbPath: /var/lib/pico/mem0-history.sqlite
    vectorStore:
      provider: qdrant
      localBaseUrl: http://127.0.0.1:6333
      collectionName: pico_long_memory
    llm:
      provider: pi_model
      piProvider: openai-codex
      api: openai-codex-responses
      model: gpt-5.4
      timeoutMs: 30000
    embedder:
      provider: sidecar
      localBaseUrl: http://127.0.0.1:18081
      model: jinaai/jina-embeddings-v5-text-small
      embeddingDims: 1024
      timeoutMs: 30000
audit:
  otel:
    enabled: true
    endpoint: http://127.0.0.1:4318/v1/logs
    serviceName: pico
    timeoutMs: 5000
`);

    expect(loadPicoConfig({ path })).toMatchObject({
      session: {
        enabled: true,
        startTriggers: {
          wakeNames: ["ピコ", "pico"],
          greetings: ["おはよう", "こんにちは"],
          candidateTimeoutMs: 12_000
        },
        ending: {
          mode: "timed",
          durationMs: 90_000
        }
      },
      camera: {
        tapo: {
          sourceId: "tapo-main",
          host: "192.168.3.25",
          port: 554,
          onvifPort: 2020,
          user: "camera-user",
          password: "camera-password",
          streams: {
            scene: "stream1",
            detection: "stream2"
          },
          timeoutMs: 15_000,
          maxFrameBytes: 1024
        },
        personFollow: {
          enabled: true,
          sourceCameraId: "tapo-main",
          deadZone: 0.12,
          maxStep: 0.3,
          speed: 0.4,
          cooldownMs: 500,
          lostTargetTimeoutMs: 3000
        }
      },
      vision: {
        ollama: {
          endpointId: "windows-qwen",
          localBaseUrl: "http://127.0.0.1:11434",
          auth: {
            headerName: "x-api-key",
            apiKey: "local-dev-key"
          },
          maxImageEdgePixels: 512
        },
        personDetection: {
          enabled: true,
          sourceCameraId: "tapo-main",
          modelFamily: "pinto0309",
          provider: "onnxruntime",
          modelPath: "/opt/pico/models/pinto0309/yolox_nano_person.onnx",
          inputWidth: 320,
          inputHeight: 320,
          outputLayout: "cxcywh_score_class",
          coordinateScale: "normalized",
          frameIntervalMs: 500,
          confidenceThreshold: 0.55
        }
      },
      voice: {
        resident: {
          enabled: true,
          audioInput: {
            provider: "avfoundation",
            device: ":0"
          },
          audioOutput: {
            provider: "afplay",
            route: "system_default"
          },
          singleInstanceLockPath: join(dirname(path), "tmp/pico-custom-resident.lock"),
          minTriggerConfidence: 0.72,
          shutdownGraceMs: 3000,
          activation: {
            mode: "push_to_talk",
            provider: "loopback_http",
            host: "127.0.0.1",
            port: 8781,
            authTokenPath: join(dirname(path), "tmp/pico-activation-token"),
            debounceMs: 800,
            activationWindowMs: 8000
          },
          vad: {
            provider: "ten_vad",
            jsPath: join(dirname(path), "vendors/ten-vad/ten_vad.js"),
            wasmPath: join(dirname(path), "vendors/ten-vad/ten_vad.wasm"),
            hopSize: 160,
            threshold: 0.5
          },
          utteranceWindow: {
            minSpeechMs: 300,
            silenceMs: 700,
            maxUtteranceMs: 5_000,
            minRmsDb: -55
          }
        },
        probes: {
          enabled: true
        },
        echoControl: {
          enabled: true,
          mode: "aec",
          provider: "web_rtc_aec3",
          providerEndpoint: "http://127.0.0.1:8770",
          sampleRateHz: 16_000,
          channels: 1,
          frameMs: 10,
          tailMuteMs: 700,
          diagnostics: {
            enabled: true
          }
        },
        stt: {
          appleSpeech: {
            id: "local-apple-speech",
            localBaseUrl: "http://127.0.0.1:8766",
            language: "ja-JP",
            timeoutMs: 30_000,
            warmupAudioSeconds: 0.25,
            samplePcm16lePath: "/tmp/pico-known-ja.pcm",
            sampleRateHz: 16_000,
            channels: 1
          }
        },
        tts: {
          aivis: {
            speakerId: 888_753_760,
            text: "こんにちは。"
          }
        }
      },
      memory: {
        mem0: {
          enabled: true,
          infer: false,
          historyDbPath: "/var/lib/pico/mem0-history.sqlite",
          vectorStore: {
            provider: "qdrant",
            localBaseUrl: "http://127.0.0.1:6333",
            collectionName: "pico_long_memory"
          },
          llm: {
            provider: "pi_model",
            piProvider: "openai-codex",
            api: "openai-codex-responses",
            model: "gpt-5.4",
            timeoutMs: 30_000
          },
          embedder: {
            provider: "sidecar",
            localBaseUrl: "http://127.0.0.1:18081",
            model: "jinaai/jina-embeddings-v5-text-small",
            embeddingDims: 1024,
            timeoutMs: 30_000
          }
        }
      },
      audit: {
        otel: {
          enabled: true,
          endpoint: "http://127.0.0.1:4318/v1/logs",
          serviceName: "pico",
          timeoutMs: 5000
        }
      }
    });
  });

  it("defaults session ending to one timed minute", () => {
    expect(definePicoConfig({})).toMatchObject({
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
      memory: {
        mem0: {
          enabled: false
        }
      },
      audit: {
        otel: {
          enabled: false
        }
      },
      voice: {
        resident: {
          enabled: false,
          singleInstanceLockPath: "tmp/pico-voice-resident.lock",
          minTriggerConfidence: 0.5,
          shutdownGraceMs: 5_000,
          activation: {
            mode: "wake_word"
          },
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
        }
      }
    });
  });

  it("defines explicit long-memory SQLite and Pi extraction config", () => {
    const config = definePicoConfig({
      memory: {
        longMemory: {
          enabled: true,
          databasePath: "/var/lib/pico/long-memory.sqlite",
          extraction: {
            provider: "pi_model",
            piProvider: "openai-codex",
            api: "openai-codex-responses",
            model: "gpt-5.4",
            thinkingLevel: "high",
            timeoutMs: 60_000
          }
        }
      }
    });

    expect(config.memory.longMemory).toEqual({
      enabled: true,
      databasePath: "/var/lib/pico/long-memory.sqlite",
      extraction: {
        provider: "pi_model",
        piProvider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.4",
        thinkingLevel: "high",
        timeoutMs: 60_000
      }
    });
    expect(Object.isFrozen(config.memory.longMemory)).toBe(true);
    expect(config.memory.longMemory.enabled).toBe(true);
    if (config.memory.longMemory.enabled) {
      expect(Object.isFrozen(config.memory.longMemory.extraction)).toBe(true);
    }
  });

  it("defaults long memory to disabled independently of Mem0", () => {
    expect(
      definePicoConfig({
        memory: {
          mem0: {
            enabled: false,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite"
          }
        }
      }).memory.longMemory
    ).toEqual({ enabled: false });
  });

  it.each([
    ["databasePath", "/var/lib/pico/long-memory.sqlite"],
    [
      "extraction",
      {
        provider: "pi_model",
        piProvider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.4",
        thinkingLevel: "high",
        timeoutMs: 60_000
      }
    ]
  ])("rejects long-memory %s when long memory is disabled", (field, value) => {
    expect(() =>
      definePicoConfig({
        memory: {
          longMemory: {
            enabled: false,
            [field]: value
          }
        }
      })
    ).toThrow(`pico config memory.longMemory has unknown field ${field}`);
  });

  it.each([
    [
      "database path",
      {
        enabled: true,
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.databasePath is required"
    ],
    [
      "extraction config",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite"
      },
      "pico config memory.longMemory.extraction is required"
    ],
    [
      "extraction provider",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "openai",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.provider must be pi_model"
    ],
    [
      "Pi provider",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.piProvider must be openai-codex"
    ],
    [
      "Pi API",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.api must be openai-codex-responses"
    ],
    [
      "model",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: " ",
          thinkingLevel: "high",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.model is required"
    ],
    [
      "thinking level",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.thinkingLevel is required"
    ],
    [
      "unsupported thinking level",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "automatic",
          timeoutMs: 60_000
        }
      },
      "pico config memory.longMemory.extraction.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max"
    ],
    [
      "timeout",
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 0
        }
      },
      "pico config memory.longMemory.extraction.timeoutMs must be a positive integer"
    ]
  ])("rejects incomplete or unsupported long-memory %s", (_name, longMemory, message) => {
    expect(() =>
      definePicoConfig({
        memory: {
          longMemory
        }
      })
    ).toThrow(message);
  });

  it("enforces Node timer bounds for long-memory extraction", () => {
    const longMemory = {
      enabled: true,
      databasePath: "/var/lib/pico/long-memory.sqlite",
      extraction: {
        provider: "pi_model",
        piProvider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.4",
        thinkingLevel: "high",
        timeoutMs: 2_147_483_647
      }
    };

    expect(definePicoConfig({ memory: { longMemory } }).memory.longMemory).toMatchObject({
      extraction: {
        timeoutMs: 2_147_483_647
      }
    });
    expect(() =>
      definePicoConfig({
        memory: {
          longMemory: {
            ...longMemory,
            extraction: {
              ...longMemory.extraction,
              timeoutMs: 2_147_483_648
            }
          }
        }
      })
    ).toThrow(
      "pico config memory.longMemory.extraction.timeoutMs must be a positive integer <= 2147483647"
    );
  });

  it.each([
    [
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
        },
        fallbackDatabasePath: "/tmp/long-memory.sqlite"
      },
      "pico config memory.longMemory has unknown field fallbackDatabasePath"
    ],
    [
      {
        enabled: true,
        databasePath: "/var/lib/pico/long-memory.sqlite",
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000,
          fallbackProvider: "ollama"
        }
      },
      "pico config memory.longMemory.extraction has unknown field fallbackProvider"
    ]
  ])("rejects unknown long-memory config fields", (longMemory, message) => {
    expect(() =>
      definePicoConfig({
        memory: {
          longMemory
        }
      })
    ).toThrow(message);
  });

  it("requires local voice echo control provider endpoints when AEC is enabled", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "aec",
            provider: "web_rtc_aec3",
            providerEndpoint: "https://aec.example.com"
          }
        }
      })
    ).toThrow("pico config voice.echoControl.providerEndpoint must use a local URL");
  });

  it("requires local STT and TTS provider URLs", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: "https://stt.example.com"
            }
          }
        }
      })
    ).toThrow("pico config voice.stt.appleSpeech.localBaseUrl must use a local SSH tunnel URL");

    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "https://tts.example.com",
              speakerId: 888_753_760
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.localBaseUrl must use a local SSH tunnel URL");
  });

  it("accepts minimal Apple Speech config without a smoke sample", () => {
    expect(
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: " http://127.0.0.1:8766 "
            }
          }
        }
      }).voice.stt.appleSpeech
    ).toEqual({
      localBaseUrl: "http://127.0.0.1:8766"
    });
  });

  it.each([
    "http://localhost:8766",
    "http://[::1]:8766",
    "https://127.0.0.1:8766"
  ])("rejects Apple Speech URLs the IPv4 HTTP sidecar cannot serve: %s", (localBaseUrl) => {
    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl
            }
          }
        }
      })
    ).toThrow("pico config voice.stt.appleSpeech.localBaseUrl must use an http://127.0.0.1 origin");
  });

  it.each([
    ["language", "en-US", "pico config voice.stt.appleSpeech.language must be ja-JP"],
    ["sampleRateHz", 48_000, "pico config voice.stt.appleSpeech.sampleRateHz must be 16000"],
    ["channels", 2, "pico config voice.stt.appleSpeech.channels must be 1"]
  ])("rejects unsupported Apple Speech %s", (key, value, message) => {
    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: "http://127.0.0.1:8766",
              [key]: value
            }
          }
        }
      })
    ).toThrow(message);
  });

  it.each([
    [
      "sampleRateHz",
      48_000,
      "pico config voice.echoControl.sampleRateHz must be 16000 for Apple Speech"
    ],
    ["channels", 2, "pico config voice.echoControl.channels must be 1 for Apple Speech"]
  ])("rejects Apple Speech with incompatible echo-control %s", (key, value, message) => {
    expect(() =>
      definePicoConfig({
        voice: {
          echoControl: {
            [key]: value
          },
          stt: {
            appleSpeech: {
              localBaseUrl: "http://127.0.0.1:8766"
            }
          }
        }
      })
    ).toThrow(message);
  });

  it("rejects the removed MLX Whisper config key with a migration error", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            mlxWhisper: {
              localBaseUrl: "http://127.0.0.1:8765"
            }
          }
        }
      })
    ).toThrow("pico config voice.stt.mlxWhisper was removed; migrate to voice.stt.appleSpeech");

    expect(() =>
      definePicoConfig({
        voice: {
          stt: {
            appleSpeech: {
              localBaseUrl: "http://127.0.0.1:8766"
            },
            mlxWhisper: {
              localBaseUrl: "http://127.0.0.1:8765"
            }
          }
        }
      })
    ).toThrow("pico config voice.stt.mlxWhisper was removed; migrate to voice.stt.appleSpeech");
  });

  it("rejects unbounded resident utterance window settings", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            utteranceWindow: {
              maxUtteranceMs: 60_001
            }
          }
        }
      })
    ).toThrow(
      "pico config voice.resident.utteranceWindow.maxUtteranceMs must be a positive integer <= 60000"
    );
  });

  it("rejects remote push-to-talk activation bind hosts", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            activation: {
              provider: "loopback_http",
              host: "127.0.0.1",
              port: 8781,
              authTokenPath: "/tmp/pico-activation-token"
            }
          }
        }
      })
    ).toThrow(
      "pico config voice.resident.activation.mode is required when activation is configured"
    );

    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            activation: {
              mode: "push_to_talk",
              provider: "loopback_http",
              host: "0.0.0.0",
              port: 8781,
              authTokenPath: "/tmp/pico-activation-token"
            }
          }
        }
      })
    ).toThrow("pico config voice.resident.activation.host must be 127.0.0.1 or ::1");
  });

  it("expands push-to-talk activation token paths under the user home directory", () => {
    const path = temporaryConfigFile(`
voice:
  resident:
    activation:
      mode: push_to_talk
      provider: loopback_http
      host: 127.0.0.1
      port: 8781
      authTokenPath: ~/.pico/resident-voice/activation-token
`);

    expect(loadPicoConfig({ path }).voice.resident.activation).toMatchObject({
      mode: "push_to_talk",
      authTokenPath: join(homedir(), ".pico/resident-voice/activation-token")
    });
  });

  it("rejects unsupported Mem0 embedder providers at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            embedder: {
              provider: "cloud-auto",
              localBaseUrl: "http://127.0.0.1:18081",
              model: "jinaai/jina-embeddings-v5-text-small",
              embeddingDims: 1024
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.embedder.provider must be ollama or sidecar");
  });

  it("rejects Mem0 embedder timeouts beyond Node timer bounds", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            embedder: {
              provider: "sidecar",
              localBaseUrl: "http://127.0.0.1:18081",
              model: "jinaai/jina-embeddings-v5-text-small",
              embeddingDims: 1024,
              timeoutMs: 2_147_483_648
            }
          }
        }
      })
    ).toThrow(
      "pico config memory.mem0.embedder.timeoutMs must be a positive integer <= 2147483647"
    );
  });

  it("rejects unsupported voice echo control providers", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "aec",
            provider: "cloud_aec",
            providerEndpoint: "http://127.0.0.1:8770"
          }
        }
      })
    ).toThrow(
      "pico config voice.echoControl.provider must be web_rtc_aec3, platform_voice_processing, speexdsp, or half_duplex"
    );
  });

  it("rejects non-AEC echo control providers in AEC mode", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "aec",
            provider: "half_duplex",
            providerEndpoint: "http://127.0.0.1:8770"
          }
        }
      })
    ).toThrow(
      "pico config voice.echoControl.provider must be web_rtc_aec3 or speexdsp when voice.echoControl.mode is aec"
    );
  });

  it("rejects platform voice processing until a provider boundary is implemented", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "platform_voice_processing"
          }
        }
      })
    ).toThrow("pico config voice.echoControl.mode platform_voice_processing is not implemented");
  });

  it("rejects non-local audit OTel Collector endpoints", () => {
    expect(() =>
      definePicoConfig({
        audit: {
          otel: {
            enabled: true,
            endpoint: "https://otel.example.com/v1/logs"
          }
        }
      })
    ).toThrow("pico config audit.otel.endpoint must use a local Collector URL");
  });

  it("uses PICO_CONFIG_PATH as the only config environment selector", () => {
    const path = temporaryConfigFile(`
camera:
  tapo:
    host: 192.168.3.25
    user: camera-user
    password: camera-password
`);

    const config = loadPicoConfigFromEnvironment({
      PICO_CONFIG_PATH: path,
      PICO_TAPO_HOST: "192.168.3.99",
      PICO_VISION_LOCAL_BASE_URL: "http://127.0.0.1:9999"
    });

    expect(config.camera.tapo?.host).toBe("192.168.3.25");
    expect(config.vision.ollama).toBeUndefined();
  });

  it("resolves local file paths relative to the repo root for config directory files", () => {
    const { root, path } = temporaryRepoConfigFile(`
memory:
  longMemory:
    enabled: true
    databasePath: .pico-local/mem0-history.sqlite
    extraction:
      provider: pi_model
      piProvider: openai-codex
      api: openai-codex-responses
      model: gpt-5.4
      thinkingLevel: high
      timeoutMs: 60000
  mem0:
    enabled: false
    historyDbPath: .pico-local/mem0-history.sqlite
vision:
  personDetection:
    enabled: false
    modelPath: models/person-detector.mlmodel
voice:
  resident:
    singleInstanceLockPath: tmp/pico-resident.lock
    vad:
      provider: ten_vad
      jsPath: vendors/ten-vad/ten_vad.js
      wasmPath: vendors/ten-vad/ten_vad.wasm
      hopSize: 160
      threshold: 0.5
  stt:
    appleSpeech:
      localBaseUrl: http://127.0.0.1:8766
      samplePcm16lePath: samples/warmup.pcm
`);

    const config = loadPicoConfig({ path });

    expect(config.memory.longMemory).toMatchObject({
      enabled: true,
      databasePath: join(root, ".pico-local/mem0-history.sqlite")
    });
    expect(config.memory.mem0.historyDbPath).toBe(join(root, ".pico-local/mem0-history.sqlite"));
    expect(config.vision.personDetection.modelPath).toBe(
      join(root, "models/person-detector.mlmodel")
    );
    expect(config.voice.resident.singleInstanceLockPath).toBe(join(root, "tmp/pico-resident.lock"));
    expect(config.voice.resident.vad).toEqual({
      provider: "ten_vad",
      jsPath: join(root, "vendors/ten-vad/ten_vad.js"),
      wasmPath: join(root, "vendors/ten-vad/ten_vad.wasm"),
      hopSize: 160,
      threshold: 0.5
    });
    expect(config.voice.stt.appleSpeech?.samplePcm16lePath).toBe(join(root, "samples/warmup.pcm"));
  });

  it("rejects ten_vad when echo-control frames do not match TEN frame requirements", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            vad: {
              provider: "ten_vad",
              jsPath: "vendors/ten-vad/ten_vad.js",
              wasmPath: "vendors/ten-vad/ten_vad.wasm",
              hopSize: 256
            }
          }
        }
      })
    ).toThrow("pico config voice.echoControl.frameMs must be 16 for ten_vad hopSize 256");

    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            vad: {
              provider: "ten_vad",
              jsPath: "vendors/ten-vad/ten_vad.js",
              wasmPath: "vendors/ten-vad/ten_vad.wasm",
              hopSize: 160
            }
          },
          echoControl: {
            sampleRateHz: 48_000
          }
        }
      })
    ).toThrow("pico config voice.echoControl.sampleRateHz must be 16000 for ten_vad");

    expect(() =>
      definePicoConfig({
        voice: {
          resident: {
            vad: {
              provider: "ten_vad",
              jsPath: "vendors/ten-vad/ten_vad.js",
              wasmPath: "vendors/ten-vad/ten_vad.wasm",
              hopSize: 160
            }
          },
          echoControl: {
            channels: 2
          }
        }
      })
    ).toThrow("pico config voice.echoControl.channels must be 1 for ten_vad");
  });

  it("rejects partial Tapo camera credentials at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.3.25",
            user: "camera-user"
          }
        }
      })
    ).toThrow("pico config camera.tapo.password is required when camera.tapo is set");
  });

  it("rejects deprecated singular Tapo stream config at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.3.25",
            user: "camera-user",
            password: "camera-password",
            stream: "stream2"
          }
        }
      })
    ).toThrow(
      "pico config camera.tapo.stream is deprecated; use camera.tapo.streams.scene and/or camera.tapo.streams.detection"
    );
  });

  it("defaults person follow to disabled", () => {
    expect(definePicoConfig({}).camera.personFollow).toEqual({
      enabled: false
    });
  });

  it("requires a source camera when person follow is enabled", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          personFollow: {
            enabled: true,
            deadZone: 0.12,
            maxStep: 0.3,
            speed: 0.4,
            cooldownMs: 500,
            lostTargetTimeoutMs: 3000
          }
        }
      })
    ).toThrow(
      "pico config camera.personFollow.sourceCameraId is required when camera.personFollow is set"
    );
  });

  it("rejects person follow dead zones outside the normalized frame range", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          personFollow: {
            enabled: true,
            sourceCameraId: "tapo-main",
            deadZone: 0.5,
            maxStep: 0.3,
            speed: 0.4,
            cooldownMs: 500,
            lostTargetTimeoutMs: 3000
          }
        }
      })
    ).toThrow("pico config camera.personFollow.deadZone must be >= 0 and < 0.5");
  });

  it("rejects invalid numeric values at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        voice: {
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: -1
            }
          }
        }
      })
    ).toThrow("pico config voice.tts.aivis.speakerId must be a non-negative integer");
  });

  it("rejects invalid timed session durations at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        session: {
          ending: {
            mode: "timed",
            durationMs: 0
          }
        }
      })
    ).toThrow("pico config session.ending.durationMs must be a positive integer");
  });

  it("rejects timed session durations beyond Node timer bounds", () => {
    expect(() =>
      definePicoConfig({
        session: {
          ending: {
            mode: "timed",
            durationMs: 2_147_483_648
          }
        }
      })
    ).toThrow("pico config session.ending.durationMs must be a positive integer <= 2147483647");
  });

  it("rejects hosted Mem0 model providers at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "http://127.0.0.1:6333",
              collectionName: "pico_long_memory"
            },
            llm: {
              provider: "openai",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "gpt-5-mini"
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.llm.provider must be ollama or pi_model");
  });

  it("rejects unsupported Pi Agent Mem0 LLM provider names", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "http://127.0.0.1:6333",
              collectionName: "pico_long_memory"
            },
            llm: {
              provider: "pi_model",
              piProvider: "openai",
              api: "openai-codex-responses",
              model: "gpt-5.4"
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.llm.piProvider must be openai-codex");
  });

  it("rejects unsupported Pi Agent Mem0 LLM API types", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "http://127.0.0.1:6333",
              collectionName: "pico_long_memory"
            },
            llm: {
              provider: "pi_model",
              piProvider: "openai-codex",
              api: "openai-responses",
              model: "gpt-5.4"
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.llm.api must be openai-codex-responses");
  });

  it("rejects Mem0 LLM timeoutMs above the Node timer limit", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "http://127.0.0.1:6333",
              collectionName: "pico_long_memory"
            },
            llm: {
              provider: "pi_model",
              piProvider: "openai-codex",
              api: "openai-codex-responses",
              model: "gpt-5.4",
              timeoutMs: 2_147_483_648
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.llm.timeoutMs must be a positive integer <= 2147483647");
  });

  it("rejects non-local Mem0 provider URLs at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "https://qdrant.example.com",
              collectionName: "pico_long_memory"
            },
            llm: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "qwen3.5:9b"
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow("pico config memory.mem0.vectorStore.localBaseUrl must use a local SSH tunnel URL");
  });

  it("rejects incomplete enabled Mem0 config at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        memory: {
          mem0: {
            enabled: true,
            historyDbPath: "/var/lib/pico/mem0-history.sqlite",
            vectorStore: {
              provider: "qdrant",
              localBaseUrl: "http://127.0.0.1:6333",
              collectionName: ""
            },
            llm: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "qwen3.5:9b"
            },
            embedder: {
              provider: "ollama",
              localBaseUrl: "http://127.0.0.1:11434",
              model: "nomic-embed-text"
            }
          }
        }
      })
    ).toThrow(
      "pico config memory.mem0.vectorStore.collectionName is required when memory.mem0.vectorStore is set"
    );
  });

  it("rejects Tapo timeout values beyond Node timer bounds", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.3.25",
            user: "camera-user",
            password: "camera-password",
            timeoutMs: 2_147_483_648
          }
        }
      })
    ).toThrow("pico config camera.tapo.timeoutMs must be a positive integer <= 2147483647");
  });

  it("rejects Tapo ports outside the TCP port range", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.3.25",
            port: 65_536,
            user: "camera-user",
            password: "camera-password"
          }
        }
      })
    ).toThrow("pico config camera.tapo.port must be a positive integer <= 65535");
  });

  it("rejects Tapo ONVIF ports outside the TCP port range", () => {
    expect(() =>
      definePicoConfig({
        camera: {
          tapo: {
            host: "192.168.3.25",
            onvifPort: 65_536,
            user: "camera-user",
            password: "camera-password"
          }
        }
      })
    ).toThrow("pico config camera.tapo.onvifPort must be a positive integer <= 65535");
  });

  it("rejects non-local Ollama endpoints at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://192.168.0.10:11434"
          }
        }
      })
    ).toThrow("pico config vision.ollama.localBaseUrl must use a local SSH tunnel URL");
  });

  it("rejects invalid Ollama image edge bounds at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            maxImageEdgePixels: 0
          }
        }
      })
    ).toThrow("pico config vision.ollama.maxImageEdgePixels must be a positive integer");

    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            maxImageEdgePixels: 4097
          }
        }
      })
    ).toThrow("pico config vision.ollama.maxImageEdgePixels must be a positive integer <= 4096");
  });

  it("rejects unprotected Ollama tunnel kinds at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            tunnel: {
              kind: "plain_ssh"
            }
          }
        }
      })
    ).toThrow("pico config vision.ollama.tunnel.kind must use a protected SSH tunnel");
  });

  it("defaults person detection to disabled", () => {
    expect(definePicoConfig({}).vision.personDetection).toEqual({
      enabled: false
    });
  });

  it("rejects non-pinto0309 person detection model families", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "generic-yolo",
            provider: "onnxruntime",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow("pico config vision.personDetection.modelFamily must be pinto0309");
  });

  it("rejects cloud person detection providers", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "cloud",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow(
      "pico config vision.personDetection.provider must be onnxruntime, coreml, tflite, or openvino"
    );
  });

  it("loads CoreML person detection defaults for pinto YOLOX raw output", () => {
    expect(
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "coreml",
            modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "yolox_coco_raw",
            coordinateScale: "pixel",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      }).vision.personDetection
    ).toMatchObject({
      enabled: true,
      provider: "coreml",
      outputLayout: "yolox_coco_raw",
      coremlFlags: 18,
      nmsIouThreshold: 0.45
    });
  });

  it("requires YOLOX raw output for CoreML person detection", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "coreml",
            modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "xyxy_score_class",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow(
      "pico config vision.personDetection.outputLayout must be yolox_coco_raw when provider is coreml"
    );
  });

  it("rejects invalid CoreML person detection flags and NMS thresholds", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "coreml",
            modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "yolox_coco_raw",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55,
            coremlFlags: -1
          }
        }
      })
    ).toThrow("pico config vision.personDetection.coremlFlags must be a non-negative integer");

    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "coreml",
            modelPath: "/opt/pico/models/pinto0309/yolox_nano_320x320.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "yolox_coco_raw",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55,
            nmsIouThreshold: 0
          }
        }
      })
    ).toThrow("pico config vision.personDetection.nmsIouThreshold must be > 0 and <= 1");
  });

  it("rejects invalid person detection thresholds", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "onnxruntime",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            frameIntervalMs: 500,
            confidenceThreshold: 1.1
          }
        }
      })
    ).toThrow("pico config vision.personDetection.confidenceThreshold must be >= 0 and <= 1");
  });

  it("rejects unsupported person detection ONNX output layouts", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "onnxruntime",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            outputLayout: "named_faces",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow(
      "pico config vision.personDetection.outputLayout must be xyxy_score_class, cxcywh_score_class, or yolox_coco_raw"
    );
  });

  it("rejects unsupported person detection coordinate scales", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            sourceCameraId: "tapo-main",
            modelFamily: "pinto0309",
            provider: "onnxruntime",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            coordinateScale: "identity_pixels",
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow("pico config vision.personDetection.coordinateScale must be pixel or normalized");
  });

  it("requires person detection source camera when enabled", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          personDetection: {
            enabled: true,
            modelFamily: "pinto0309",
            provider: "onnxruntime",
            modelPath: "/opt/pico/models/model.onnx",
            inputWidth: 320,
            inputHeight: 320,
            frameIntervalMs: 500,
            confidenceThreshold: 0.55
          }
        }
      })
    ).toThrow(
      "pico config vision.personDetection.sourceCameraId is required when vision.personDetection is set"
    );
  });

  it("rejects invalid Ollama auth header names at the config boundary", () => {
    expect(() =>
      definePicoConfig({
        vision: {
          ollama: {
            localBaseUrl: "http://127.0.0.1:11434",
            auth: {
              headerName: "x api key",
              apiKey: "local-dev-key"
            }
          }
        }
      })
    ).toThrow("pico config vision.ollama.auth.headerName must be a valid HTTP header name");
  });

  it("freezes loaded config so smoke callers cannot mutate shared settings", () => {
    const config = definePicoConfig({
      camera: {
        tapo: {
          host: "192.168.3.25",
          user: "camera-user",
          password: "camera-password"
        }
      }
    });

    const tapo = config.camera.tapo;

    if (tapo === undefined) {
      throw new Error("Expected Tapo config to be defined.");
    }

    expect(() => {
      Object.assign(tapo, { host: "192.168.3.99" });
    }).toThrow(TypeError);
    expect(config.camera.tapo?.host).toBe("192.168.3.25");
  });
});
