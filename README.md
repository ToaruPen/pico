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
sidecars are configured. Smoke commands are regression and readiness gates, not
completion evidence for real-world validation. Missing optional provider
configuration is reported as an explicit skipped section; failed configured
sections make the command fail.

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

Before field validation, run the deterministic gate first, prepare the voice
sample if the STT smoke is enabled, then run the milestone suite:

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

Field validation must be performed against the actual resident-agent operating
path, not only the smoke scripts. A field report should include the date,
operator, hardware used, config path, Pi Agent launch method, spoken session
steps, audible TTS confirmation, Tapo camera observation, VLM scene summary,
session cutoff, Mem0/long-memory result, OTel/audit evidence, and any follow-up
issues created from failures.

Field test reports live under `docs/field-tests/`.

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
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:resident-audio-input
just smoke-camera-tapo
just smoke-ollama-vlm
just smoke-camera-vlm-scene
```

Configure these sections in `config/pico.local.yaml` as needed:

- `voice.tts.aivis` for Aivis Speech TTS. Choose a style id from
  `curl -s http://127.0.0.1:10101/speakers`.
- `voice.stt.mlxWhisper` for mlx-whisper STT. `samplePcm16lePath` must point to
  a PCM16LE mono 16 kHz sample.
- `voice.resident.audioInput` and `voice.resident.audioOutput` for the
  production resident voice process. Use `avfoundation` plus `afplay` with
  explicit `route: system_default` on macOS, and `alsa` plus `alsa` with explicit
  devices on Raspberry Pi / Linux. `smoke:resident-audio-input` records a short
  bounded sample and reports RMS/peak levels only; speak near the resident mic
  during the capture to verify it clears `voice.resident.utteranceWindow.minRmsDb`.
- `camera.tapo` for one Tapo RTSP JPEG frame.
- `vision.ollama` for `qwen3.5:9b` through the protected local tunnel.
- `camera.tapo` plus `vision.ollama` for camera-to-VLM scene smoke.

Run the resident processes after the local providers are configured:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:memory
```

`resident:voice` owns live microphone, speaker, session cutoff, and enqueueing.
`resident:memory` is the companion drain worker that writes queued session
cutoffs to Mem0 and OTel/audit without adding a default job timeout. It recovers
stale `processing` jobs after `PICO_RESIDENT_MEMORY_RECOVER_PROCESSING_OLDER_THAN_MS`
or 10 minutes by default; this is crash recovery, not a per-job execution
deadline.

On the Mac mini resident host, manage the production voice process as a user
LaunchAgent after `smoke:resident-audio-input` proves that the configured
microphone clears `voice.resident.utteranceWindow.minRmsDb`:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice:launchd -- install
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice:launchd -- status
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice:launchd -- restart
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice:launchd -- stop
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice:launchd -- uninstall
```

The LaunchAgent label is `dev.toarupen.pico.resident-voice`. It runs the
resident voice script through the current Node executable and local `jiti` with
`PICO_CONFIG_PATH` set to the resolved local config path, writes the plist to
`~/Library/LaunchAgents/dev.toarupen.pico.resident-voice.plist`, and writes logs
under `.pico-local/logs/`. `stop` boots the KeepAlive service out of the user
launchd domain while leaving the plist installed; use `install` to bootstrap it
again or `uninstall` to remove the plist.

For the protected Windows GPU vision host, run Windows native Ollama on
`127.0.0.1:11434` and reach it only through the pico-host SSH local forward. The
validated field setup uses a Windows Task Scheduler task named
`PicoNativeOllamaServe` that runs `%LOCALAPPDATA%\Programs\Ollama\ollama.exe
serve` with `OLLAMA_HOST=127.0.0.1:11434` at logon.

See:

- `AGENTS.md` for agent-facing repository guidance.
- `TOOLS.md` for tool references.
- `docs/superpowers/specs/2026-06-09-pico-agent-design.md` for product and
  module boundaries.
- `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`
  for the current implementation plan.
