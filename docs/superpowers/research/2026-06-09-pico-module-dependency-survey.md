# Pico Module Dependency Survey

Date: 2026-06-10
Revised: 2026-07-13
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
| Pi-level memory plugin (outside Pico) | Separately installed capability | Owns durable-memory config, provider, tools, extraction, persistence, mutation, retention, and lifecycle. |
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

- Pi owns conversation sessions, transcripts, context, and history.
- Pico keeps only process-local interaction-control state. It has no short-term
  memory store, working summary, transcript copy, or cutoff-memory hook.
- Durable memory, when enabled, is provided by a separately installed Pi-level
  plugin. That plugin owns its provider, configuration, tools, extraction,
  persistence, retrieval, mutation, retention, and runtime lifecycle.
- Pico does not import, initialize, call, wrap, proxy, or configure Mem0, Qdrant,
  an embedder, or another memory provider.
- Pi settings own plugin loading and memory-tool visibility.
- The product must not use durable memory for child tracking, scoring, or
  profiling. Pico does not implement that policy as a privacy filter or
  natural-language classifier.

Sources:

- Pi-owned memory boundary:
  `docs/superpowers/specs/2026-07-13-pi-owned-memory-boundary-design.md`
