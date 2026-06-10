# pico

`pico` is a Pi Agent-centered domain extension for one resident AI support staff
member in an after-school care facility.

The repository is in foundation stage. It currently defines the package shape,
module boundaries, quality gates, and active provider decisions.

## Development

Use Node.js 24 or newer. CI runs on Node 24.

Install dependencies:

```bash
npm install
```

Run all local checks:

```bash
just check
```

Run the same parallel gate shape used by CI:

```bash
just ci
```

Run the milestone smoke suite after local credentials and hardware/provider
sidecars are configured. Missing optional provider configuration is reported as
an explicit skipped section; failed configured sections make the command fail.

```bash
just smoke-milestone
```

Pico smoke provider settings are loaded from `config/pico.local.yaml` by
default. Copy the tracked example and fill in local-only values, including the
Tapo camera account credentials created in the Tapo app:

```bash
cp config/pico.example.yaml config/pico.local.yaml
```

`config/pico.local.yaml` is ignored by git. To use another path, set
`PICO_CONFIG_PATH`:

```bash
PICO_CONFIG_PATH=/path/to/pico.local.yaml just smoke-milestone
```

For full real-world validation, run the deterministic gate first, prepare the
voice sample if the STT smoke is enabled, then run the milestone suite:

```bash
just check

# Example local sample generation for the STT smoke. A real recorded sample can
# also be used if it is PCM16LE, mono, 16 kHz.
say -v Kyoko -o /tmp/pico-known-ja.aiff 'こんにちは。今日はピコの音声認識テストです。'
ffmpeg -y -hide_banner -loglevel error \
  -i /tmp/pico-known-ja.aiff \
  -ac 1 \
  -ar 16000 \
  -f s16le \
  /tmp/pico-known-ja.pcm

# Choose an Aivis Speech style id from:
# curl -s http://127.0.0.1:10101/speakers
just smoke-milestone
```

Run the authenticated Pi Agent runtime smoke after `pi` is configured with model
credentials:

```bash
just smoke-pi-runtime
```

To pass explicit Pi provider/model flags, run:

```bash
npm run smoke:pi-runtime -- --provider openai --model gpt-4o-mini
```

Optional provider smoke commands read the same local config. Missing provider
sections exit successfully with explicit skipped reports:

```bash
just smoke-voice-providers
just smoke-camera-tapo
just smoke-ollama-vlm
just smoke-camera-vlm-scene
```

Configure these sections in `config/pico.local.yaml` as needed:

- `voice.tts.aivis` for Aivis Speech TTS. Choose a style id from
  `curl -s http://127.0.0.1:10101/speakers`.
- `voice.stt.mlxWhisper` for mlx-whisper STT. `samplePcm16lePath` must point to
  a PCM16LE mono 16 kHz sample.
- `camera.tapo` for one Tapo RTSP JPEG frame.
- `vision.ollama` for `qwen3.5:9b` through the protected local tunnel.
- `camera.tapo` plus `vision.ollama` for camera-to-VLM scene smoke.

See:

- `AGENTS.md` for agent-facing repository guidance.
- `TOOLS.md` for tool references.
- `docs/superpowers/specs/2026-06-09-pico-agent-design.md` for product and
  module boundaries.
- `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`
  for the current implementation plan.
