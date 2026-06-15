# 2026-06-15 Tapo RTSP and Camera-to-VLM Field Test

## Scope

- Issue: #41.
- Config path: `config/pico.local.yaml`.
- Camera: Tapo RTSP at the local facility network boundary.
- VLM endpoint: `qwen3.5:9b` through the protected Windows GPU host tunnel at
  `http://127.0.0.1:11435`.
- Stream split:
  - `camera.tapo.streams.scene`: `stream1` for high-quality VLM snapshots.
  - `camera.tapo.streams.detection`: `stream2` for lower-latency person
    detection frames.

## Environment Fix

The VLM path initially failed on `/api/chat` with a socket close before an HTTP
response. Boundary checks showed:

- Mac to Windows/WSL nginx `/api/tags`: passed.
- Direct Tapo RTSP snapshot: passed.
- Minimal authenticated `/api/chat`: failed with `SocketError: other side closed`.
- WSL `ollama.service` stopped shortly after the last WSL command exited.

Root cause: the Windows vision host did not keep the Ubuntu WSL distro alive, so
Ollama could stop while a chat request was loading or generating.

Permanent host change applied on the Windows vision host:

- Registered `PicoWslOllamaKeepAlive` in Windows Task Scheduler.
- Action: run `wsl.exe -d Ubuntu-24.04 --exec sh -lc "while true; do sleep 86400; done"`.
- Trigger: user logon.
- Runtime evidence after stopping the temporary keepalive: task state is running,
  WSL has the scheduled keepalive process, `ollama.service` is active, and
  authenticated `/api/chat` returns HTTP 200.

## Commands and Results

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:ollama-vlm
```

Result: passed.

- Endpoint: `windows-ollama-qwen3-5`.
- Model: `qwen3.5:9b`.
- Checked URL: `http://127.0.0.1:11435/api/tags`.

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:camera-vlm-scene
```

Result: passed.

- Provider: `tapo-rtsp+ollama`.
- RTSP frame: about 116 KB from `stream1`.
- VLM frame: about 27 KB after resizing.
- Scene summary: desk, monitor, keyboard, mug, water bottle, cables, notebook,
  pen, lamp.
- Observed people: none.

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:milestone
```

Result: skipped overall only because live PTZ nudge is intentionally gated by
`PICO_ENABLE_LIVE_PTZ_NUDGE=1`. Relevant #41 sections passed:

- `tapo_snapshot`: passed.
- `person_detection`: passed, using `tapo-rtsp+coreml` and the detection stream.
- `ollama_vlm`: passed.
- `camera_vlm_scene`: passed.

Other observed passed sections:

- `pi_runtime`.
- `voice_stt`.
- `voice_tts`.
- `mem0_runtime`.
- `memory_candidate`.
- `audit_otel`.

## Follow-Up

- Full resident-agent field exercise remains required after the #41 PR lands:
  launch Pi Agent, speak through STT/TTS, capture camera context, run VLM, end a
  session, and verify long-memory/audit side effects.
- Live PTZ nudge remains intentionally disabled unless
  `PICO_ENABLE_LIVE_PTZ_NUDGE=1` is set for a bounded camera movement test.
