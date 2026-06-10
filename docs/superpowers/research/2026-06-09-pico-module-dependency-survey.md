# Pico Module Dependency Survey

Date: 2026-06-10
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
| memory | In-process short-term memory first | Durable memory starts later. |
| long_memory | SQLite + FTS5 when needed | SQLite is the durable source of truth. |
| local_models | Selected provider boundary | Model access is explicit, not automatically switched. |
| STT | `mlx-whisper` | Current local STT baseline. |
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

- `mlx-whisper`

Sources:

- Author-local archived references, not included in this repository:
  - `0029-mlx-whisper-stt-on-apple-silicon.md`
  - `0041-provider-selectable-stt-with-apple-speechanalyzer.md`
- `mlx-whisper`: https://pypi.org/project/mlx-whisper/

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
- Use SQLite + FTS5 when durable memory becomes real.
- Treat vector search as a later secondary index, not the source of truth.

Sources:

- SQLite JSON: https://www.sqlite.org/json1.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
- SQLite WAL: https://www.sqlite.org/wal.html
