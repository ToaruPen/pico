# Pico YAML Config Design

## Goal

Pico should load local provider settings from one repository-local YAML config file instead of spreading `PICO_*` environment parsing across smoke scripts.

## Scope

- Add a tracked example file at `config/pico.example.yaml`.
- Support an ignored local file at `config/pico.local.yaml`.
- Let `PICO_CONFIG_PATH` point to another config file when needed.
- Load Tapo RTSP, Ollama VLM, mlx-whisper STT, and Aivis Speech TTS smoke settings through one central config boundary.
- Keep missing optional provider settings as explicit skipped smoke sections.

## Non-Goals

- No hot reload.
- No provider fallback chain.
- No custom policy engine.
- No secret manager integration in this slice.
- No change to Pi Agent authentication storage.

## Architecture

`src/config/index.ts` owns YAML parsing and validation. Callers receive an immutable `PicoConfig` object and must not parse YAML or read provider-specific `PICO_*` keys directly.

Smoke scripts keep accepting an explicit `NodeJS.ProcessEnv` argument for tests and process launch boundaries, but provider plans are built from `PicoConfig`. `PICO_CONFIG_PATH` is the only environment variable used to locate the local config file. If the default repo-local config file is absent, the loader returns an empty config so optional provider smoke sections continue to skip. If an explicit path is selected through `PICO_CONFIG_PATH` or loader options and that file is missing, config load fails fast.

## State Boundary

1. State being changed: Pico runtime and smoke provider settings for camera, voice, and vision.
2. Lifecycle boundary: `startup-only-immutable`; config is loaded once for each smoke command invocation.
3. Mutation path inventory: config-file load, `PICO_CONFIG_PATH`, and test fixtures. API, admin jobs, background workers, config watchers, migrations, and rollback mutation paths are not applicable.
4. Consumer/invariant inventory: config loader validation, smoke plan builders, README examples, `config/pico.example.yaml`, and smoke tests.
5. Central enforcement point: `loadPicoConfig()` parses YAML and `definePicoConfig()` validates and freezes the settings object.
6. Forbidden paths: provider-specific env parsing in smoke scripts, direct YAML parsing outside `src/config/index.ts`, hidden provider fallback chains, and test-only monkeypatching of shared config state.
7. Required tests: missing config returns empty settings; valid YAML maps to immutable provider settings; invalid numeric values fail at config load; partial Tapo credentials fail at config load; Tapo, voice, vision, and milestone smoke plans consume the config object.

## Config Shape

```yaml
camera:
  tapo:
    sourceId: tapo-rtsp
    host: 192.168.3.25
    port: 554
    user: camera-user
    password: camera-password
    stream: stream2
    timeoutMs: 15000
    maxFrameBytes: 5242880

vision:
  ollama:
    endpointId: windows-ollama-qwen3-5
    localBaseUrl: http://127.0.0.1:11434
    tunnel:
      kind: tailscale_ssh
      sshTarget: pico-vision-host
    timeoutMs: 15000

voice:
  stt:
    mlxWhisper:
      id: local-mlx-whisper
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
      text: こんにちは。picoの音声スモークです。
```

## Error Handling

Invalid configured values fail fast with field-specific errors. Missing optional provider sections do not fail; they produce skipped smoke plans. Partial provider sections fail because they are actionable configuration mistakes.

## Testing

Tests cover the loader, validation, smoke plan construction from config, skipped behavior when config is absent, and full quality gates with `just check`.
