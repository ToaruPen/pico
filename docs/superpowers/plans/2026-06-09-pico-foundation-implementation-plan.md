# Pico Foundation Implementation Plan

> Historical record: memory-related ownership in this document was superseded
> by [Pi 所有 memory 責務境界設計](../specs/2026-07-13-pi-owned-memory-boundary-design.md).
> Current Pico has no short-term or durable-memory implementation.

Date: 2026-06-10
Status: Historical

> This plan records the foundation decisions made in June 2026. The current
> STT provider contract is defined by
> [Apple Speech STT Migration Design](../specs/2026-07-11-apple-speech-stt-migration-design.md),
> which supersedes the MLX Whisper selection below.

## Goal

Build `pico` as a Pi Agent-centered domain extension for one resident AI
support staff member in an after-school care facility.

This plan describes the implementation baseline and next build steps at the
time it was written. Later specifications supersede provider decisions where
they say so explicitly.

## Current Baseline

The repository already contains:

- Pi package metadata in `package.json`.
- Strict TypeScript configuration in `tsconfig.json`.
- Type-aware ESLint configuration in `eslint.config.ts`.
- Biome formatting configuration in `biome.json`.
- ast-grep project rules in `sgconfig.yml`, `rules/`, and `rule-tests/`.
- Vitest tests in `tests/`.
- Task entrypoints in `Justfile`.
- Agent-facing guidance in `AGENTS.md`.
- Tool reference in `TOOLS.md`.

Verification command:

```bash
just check
```

## Module Layout

All modules use folder-per-module layout:

```text
src/modules/
  audit/index.ts
  camera/index.ts
  channels/index.ts
  context/index.ts
  future.ts
  handoff/index.ts
  local-models/index.ts
  long-memory/index.ts
  memory/index.ts
  transport/index.ts
  vision/index.ts
  voice/index.ts
```

Module imports should target the folder-per-module paths directly.

## Implemented Foundation

- `src/index.ts` exports the current extension shape.
- `src/identity/` defines the provisional `pico` identity and system prompt.
- `src/orchestrator/` defines module contracts and registry behavior.
- First-slice runtime modules expose metadata for:
  - context
  - memory
  - local models
  - handoff
  - audit
  - transport
- Planned modules expose metadata for:
  - long memory
  - voice
  - vision
  - camera
  - channels

## Fixed Decisions

- `pico` remains one Pi Agent package, not many separate plugins.
- Production architecture does not use test-double modules, compatibility
  shims, or automatic provider switching.
- Vision provider is `Qwen/Qwen3.5-9B` through Ollama `qwen3.5:9b`.
- The vision model runs on a protected Windows GPU host.
- The `pico` host reaches the Windows vision host through Tailscale or
  Cloudflare-protected SSH tunneling.
- STT starts from `mlx-whisper`.
- TTS starts from Aivis Speech.
- Camera starts from RTSP snapshots; ONVIF is only for bounded PTZ work.

## Next Implementation Slice

1. Replace the provisional extension object with the real Pi Agent extension
   registration API once the exact Pi package API is confirmed locally.
2. Add a `vision` contract for bounded scene description.
3. Add a Windows Ollama connectivity check through the protected SSH tunnel.
4. Add a Qwen vision client that returns structured scene output only.
5. Add camera snapshot input after the vision client boundary is stable.
6. Add durable SQLite only when long-memory or audit writes become real.

## Reusable Assets From Wooly-Fluffy Archived

Use these as implementation and test references. Do not copy stale product
shape, daemon lifecycle, UI assumptions, or compatibility behavior.

The archived files named below are author-local references from Wooly-Fluffy
archived and are not included in this repository.

### Vision / VLM

Source implementation references:

- `daemon/src/daemon/adapters/camera/vlm_protocol.py`
- `daemon/src/daemon/adapters/camera/vlm_adapter.py`
- `daemon/src/daemon/adapters/camera/adapter.py`

Source test references:

- `tests/adapters/camera/test_vlm_adapter.py`
- `tests/adapters/camera/test_adapter.py`

Reusable ideas:

- `VLMDescriber`-style narrow contract.
- Base64 image payload construction.
- HTTP response validation with explicit malformed-response errors.
- Async client lifecycle and connection reuse.
- Scene description availability reasons.
- Single in-flight scene description behavior.
- Scene description sanitization before publishing or recording.

Adaptation for `pico`:

- Implement in TypeScript under `src/modules/vision/`.
- Target Ollama `/api/chat`, not llama-server `/v1/chat/completions`.
- Use selected provider `Qwen/Qwen3.5-9B` through Ollama `qwen3.5:9b`.
- Connect through a protected Tailscale or Cloudflare SSH tunnel to the Windows
  GPU host.
- Return structured scene output only.

Do not carry forward:

- llama-server-specific request shape.
- YOLO/person detection gates.
- motion-followup behavior.
- Python daemon event bus wiring.

### TTS / Aivis Speech

Source implementation references:

- `daemon/src/daemon/adapters/tts/base.py`
- `daemon/src/daemon/adapters/tts/aivispeech.py`
- `daemon/src/daemon/adapters/tts/segmenter.py`
- `daemon/src/daemon/adapters/tts/sentence_queue.py`
- `daemon/src/daemon/adapters/tts/orchestrator.py`

Source test references:

- `tests/adapters/tts/test_aivispeech.py`
- `tests/adapters/tts/test_segmenter.py`
- `tests/adapters/tts/test_sentence_queue.py`
- `tests/adapters/tts/test_orchestrator.py`

Reusable ideas:

- Aivis `/audio_query` then `/synthesis` sequence.
- Voice fingerprint and synthesis parameter mapping.
- Japanese sentence segmentation.
- Per-sentence synthesis queue.
- Timeout and cancellation behavior.
- WAV decode into PCM audio metadata.
- Tests for request payloads, sentence order, HTTP failures, and segmentation.

Adaptation for `pico`:

- Implement in TypeScript under `src/modules/voice/tts/` when voice work starts.
- Use Web API `fetch` or a narrow HTTP client boundary.
- Keep Aivis as the single configured TTS provider.

Do not carry forward:

- Playback controller coupling until audio output runtime is selected.
- Daemon pipeline events.
- Any compatibility provider paths.

### STT / mlx-whisper (historical)

Source implementation references:

- `daemon/src/daemon/adapters/stt/base.py`
- `daemon/src/daemon/adapters/stt/mlx_whisper.py`
- `daemon/src/daemon/adapters/stt/factory.py`

Source test references:

- `tests/adapters/stt/test_base.py`
- `tests/adapters/stt/test_mlx_whisper.py`
- `tests/adapters/stt/test_mlx_whisper_helpers.py`
- `tests/adapters/stt/test_factory.py`
- `tests/integration/test_stt.py`

Reusable ideas:

- `SpeechToTextAdapter` contract.
- Warmup request behavior.
- PCM16LE to float32 conversion.
- Mono downmixing.
- 16 kHz resampling.
- Timeout handling.
- Mapping mlx-whisper segments to text, duration, language, and confidence.
- Tests for warmup, normalization, timeout, model-load errors, and empty audio.

Adaptation for `pico`:

- Keep `mlx-whisper` behind a Python sidecar or process boundary.
- Define a TypeScript client contract in `src/modules/voice/stt/`.
- Use explicit provider selection; no provider switching.

Do not carry forward:

- Apple SpeechAnalyzer provider unless selected later.
- Factory logic that supports multiple STT providers.

### Camera / RTSP

Source implementation references:

- `daemon/src/daemon/adapters/camera/adapter.py`
- `daemon/src/daemon/adapters/camera/onvif_client.py`
- `daemon/src/daemon/adapters/camera/ptz_control.py`

Source test references:

- `tests/adapters/camera/test_adapter.py`
- `tests/adapters/camera/test_onvif_client.py`
- `tests/adapters/camera/test_ptz_control.py`
- `tests/adapters/camera/test_live_snapshot_yolo_validation.py`

Reusable ideas:

- RTSP URL construction and credential encoding.
- LAN/private-address validation.
- Single in-flight frame grab.
- Clear unavailable reasons for disabled camera, privacy mode, disconnected
  camera, and frame grab failure.
- ONVIF-only PTZ direction mapping when PTZ becomes real.

Adaptation for `pico`:

- Start with `src/modules/camera/snapshot.ts`.
- Return one JPEG frame for the vision module.
- Add ONVIF only after snapshot + vision is stable.

Do not carry forward:

- Tapo cloud control.
- YOLO runtime.
- realtime focus mode.
- PTZ until a bounded PTZ slice is explicitly selected.

## Acceptance Criteria

- `just check` passes.
- Module imports use folder-per-module paths.
- `vision` metadata names Qwen3.5-9B and protected Windows host transport.
- Source and tests use folder-per-module import paths.
- No automatic provider switching is introduced.
- No custom policy engine is introduced.
