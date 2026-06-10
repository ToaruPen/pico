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

Run the authenticated Pi Agent runtime smoke after `pi` is configured with model
credentials:

```bash
just smoke-pi-runtime
```

To pass explicit Pi provider/model flags, run:

```bash
npm run smoke:pi-runtime -- --provider openai --model gpt-4o-mini
```

Run the optional live voice provider smoke. Without provider environment
variables, the command exits successfully with explicit skipped sections:

```bash
just smoke-voice-providers
```

To run the Aivis Speech TTS smoke:

```bash
PICO_TTS_AIVIS_BASE_URL=http://127.0.0.1:10101 \
PICO_TTS_AIVIS_SPEAKER_ID=1 \
just smoke-voice-providers
```

To run the mlx-whisper STT smoke, provide a known PCM16LE sample:

```bash
PICO_STT_MLX_WHISPER_BASE_URL=http://127.0.0.1:8765 \
PICO_STT_SAMPLE_PCM16LE_PATH=./samples/known-ja.pcm \
PICO_STT_SAMPLE_RATE_HZ=16000 \
PICO_STT_CHANNELS=1 \
just smoke-voice-providers
```

Run the optional live Tapo RTSP snapshot smoke. Without `PICO_TAPO_HOST`, the
command exits successfully with an explicit skipped report:

```bash
just smoke-camera-tapo
```

To capture one JPEG frame from a Tapo RTSP source:

```bash
PICO_TAPO_HOST=192.168.10.25 \
PICO_TAPO_USER=your-camera-user \
PICO_TAPO_PASSWORD=your-camera-password \
PICO_TAPO_STREAM=stream2 \
just smoke-camera-tapo
```

See:

- `AGENTS.md` for agent-facing repository guidance.
- `TOOLS.md` for tool references.
- `docs/superpowers/specs/2026-06-09-pico-agent-design.md` for product and
  module boundaries.
- `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`
  for the current implementation plan.
