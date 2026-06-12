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

  it("loads configured camera, vision, and voice providers from YAML", () => {
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
    user: camera-user
    password: camera-password
    stream: stream2
    timeoutMs: 15000
    maxFrameBytes: 1024
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
          user: "camera-user",
          password: "camera-password"
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
      }
    });
  });

  it("defaults session ending to one timed minute", () => {
    expect(definePicoConfig({}).session).toEqual({
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
    });
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
