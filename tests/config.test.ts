import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("pico YAML config", () => {
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
    stream: stream2
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
  stt:
    mlxWhisper:
      id: local-mlx
      localBaseUrl: http://127.0.0.1:8765
      modelRepo: mlx-community/whisper-large-v3-turbo
      language: ja
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
      provider: ollama
      localBaseUrl: http://127.0.0.1:11434
      model: qwen3.5:9b
    embedder:
      provider: ollama
      localBaseUrl: http://127.0.0.1:11434
      model: nomic-embed-text
      embeddingDims: 768
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
          onvifPort: 2020,
          user: "camera-user",
          password: "camera-password"
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
          }
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
        stt: {
          mlxWhisper: {
            samplePcm16lePath: "/tmp/pico-known-ja.pcm",
            sampleRateHz: 16_000
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
            provider: "ollama",
            localBaseUrl: "http://127.0.0.1:11434",
            model: "qwen3.5:9b"
          },
          embedder: {
            provider: "ollama",
            localBaseUrl: "http://127.0.0.1:11434",
            model: "nomic-embed-text",
            embeddingDims: 768
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
      }
    });
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
    ).toThrow("pico config memory.mem0.llm.provider must be ollama");
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
