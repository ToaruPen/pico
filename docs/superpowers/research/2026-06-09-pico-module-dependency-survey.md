# Pico Module Dependency Survey

Date: 2026-06-10
Revised: 2026-07-11
Status: Current

## Purpose

This document records the current dependency decisions for `pico`. It contains
only active decisions and relevant source references.

## Current Choices

| Module | Choice | Notes |
| --- | --- | --- |
| Pi integration | Single Pi package with one TypeScript extension | Keep one agent identity and modular internals. |
| identity | Local prompt/profile files | Final name and personality can change later. |
| orchestrator | Thin TypeScript registry | Route modules without a broad control plane. |
| context | Structured local files first | Add storage only when real context data exists. |
| memory | In-process short-term memory first | Active interaction continuity only. |
| long_memory | Mem0 OSS + Qdrant + configured Pi extraction worker | Mem0 is the durable source of truth and retrieval owner. |
| local_models | Selected provider boundary | Model access is explicit, not automatically switched. |
| STT | Apple Speech | Current Japanese STT through a loopback Swift sidecar on macOS 26. |
| TTS | Aivis Speech | Current local Japanese TTS baseline. |
| vision | Qwen/Qwen3.5-9B via remote Windows Ollama | Use Ollama `qwen3.5:9b` on a protected Windows GPU host. |
| camera | RTSP snapshot first | Add ONVIF only for bounded PTZ work. |
| channels | Local sink first | LINE/OpenClaw integration is later work. |
| audit | Structured local logs first | Add append-only SQLite when writes become real. |
| transport | Tailscale or Cloudflare-protected SSH tunnel | Do not expose model ports directly. |

## Vision

Selected provider:

- Model: `Qwen/Qwen3.5-9B`.
- Runtime: Ollama `qwen3.5:9b`.
- Host: protected Windows GPU machine.
- Access path: Tailscale or Cloudflare-protected SSH tunnel.
- Output shape: bounded scene summary text or JSON.

Implementation constraints:

- Do not expose the Ollama port directly.
- Do not add automatic provider switching.
- Do not expose generic image chat as the first surface.
- Do not return raw image data through the agent layer.
- Include uncertainty in scene outputs.

Sources:

- Qwen3.5-9B: https://huggingface.co/Qwen/Qwen3.5-9B
- Ollama qwen3.5: https://registry.ollama.com/library/qwen3.5
- Ollama vision API: https://docs.ollama.com/capabilities/vision

## Transport

Selected direction:

- Use Tailscale SSH or private tailnet routing when both hosts are under the
  same operator control.
- Use Cloudflare Tunnel + Access when Cloudflare Zero Trust controls are needed.
- Keep model serving ports private.

Sources:

- Tailscale SSH: https://tailscale.com/docs/features/tailscale-ssh
- Cloudflare SSH through Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/
- Cloudflare Access for Infrastructure SSH: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-infrastructure-access/

## STT

Selected provider:

- Apple Speech `SpeechAnalyzer` / `SpeechTranscriber`
- Fixed `ja-JP`, PCM16LE, 16 kHz, mono contract through the loopback Swift
  sidecar

Sources:

- Author-local archived references, not included in this repository:
  - `0029-mlx-whisper-stt-on-apple-silicon.md`
  - `0041-provider-selectable-stt-with-apple-speechanalyzer.md`
- Migration decision and runtime contract:
  `docs/superpowers/specs/2026-07-11-apple-speech-stt-migration-design.md`
- Apple SpeechAnalyzer:
  https://developer.apple.com/documentation/speech/speechanalyzer
- Apple SpeechTranscriber:
  https://developer.apple.com/documentation/speech/speechtranscriber

## TTS

Selected provider:

- Aivis Speech

Sources:

- AivisSpeech Engine: https://github.com/Aivis-Project/AivisSpeech-Engine
- AivisSpeech: https://github.com/Aivis-Project/AivisSpeech

## Camera

Selected direction:

- Use RTSP snapshots first.
- Use ONVIF only when bounded PTZ operation is required.
- Do not depend on Tapo cloud APIs.

Sources:

- Author-local archived reference, not included in this repository:
  - `0040-onvif-first-tapo-c210-camera-control.md`
- Tapo RTSP/ONVIF FAQ: https://www.tapo.com/faq/34/

## Memory

Selected direction:

- Use in-process memory for active interaction continuity.
- Use Mem0 OSS as the sole durable facility-memory, history, and retrieval owner.
- Keep Qdrant behind the Mem0 adapter rather than treating it as a second Pico-owned store.
- Process session cutoffs in-process after the conversation session ends. Await extraction and
  Mem0 write before acknowledging the cutoff; do not add a persisted queue or drain process.
- Use the startup YAML-selected Pi model for facility-memory extraction. Pass arbitrary model ids
  through the Pi model registry without a model-specific branch or default.
- Keep embedding independent from the LLM provider. Prefer a local multilingual
  embedder if it can approach Japanese-specialized retrieval quality.
- Current embedding shortlist:
  - `jinaai/jina-embeddings-v5-text-small` as the primary local sidecar
    candidate while the deployment remains non-commercial/private.
  - `jinaai/jina-embeddings-v5-text-nano` as the lighter Jina candidate.
  - `BAAI/bge-m3` as the simplest permissive-license Ollama-native candidate.
  - `Qwen/Qwen3-Embedding-0.6B` as an Ollama-native A/B candidate.
  - `intfloat/multilingual-e5-large` as a legacy permissive-license quality
    comparison candidate, with chunking required for longer session text.
  - `cl-nagoya/ruri-v3-310m` as the Japanese-specialized control model.
- Do not make `Qwen3-Embedding-4B` or `Qwen3-Embedding-8B` the default resident
  worker model. They are research candidates only unless a later benchmark and
  resource test justifies the heavier footprint.
- Require explicit vector-index migration when the embedding provider, model, or
  dimension changes.
- Use Mem0 operations as the only correction, history, and deletion boundary.

Sources:

- Pi provider auth: `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
- Pi extension model registry: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Mem0-only architecture research:
  `docs/superpowers/research/2026-07-13-mem0-only-memory-architecture.md`
- Mem0-only long-memory design:
  `docs/superpowers/specs/2026-07-13-mem0-only-long-memory-design.md`
- BGE-M3: https://huggingface.co/BAAI/bge-m3
- Qwen3 embedding: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Ollama Qwen3 embedding: https://ollama.com/library/qwen3-embedding
- Multilingual E5 large: https://huggingface.co/intfloat/multilingual-e5-large
- Jina embeddings v5 text small:
  https://huggingface.co/jinaai/jina-embeddings-v5-text-small
- Jina embeddings v5 text nano:
  https://huggingface.co/jinaai/jina-embeddings-v5-text-nano
- Jina model license notes: https://jina.ai/models/llms.txt
- Ruri v3: https://huggingface.co/cl-nagoya/ruri-v3-310m
