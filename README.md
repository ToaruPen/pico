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

Expose the local `pico` command in your shell:

```bash
npm link
```

Without linking, use `npm run pico -- <command>` from the repository root.

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
PICO_CONFIG_PATH=config/pico.local.yaml pico foreground
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:memory
```

`pico foreground` owns live microphone, speaker, session cutoff, and enqueueing
in the current terminal. Use it when you want the resident voice process to stop
with that shell. Use `pico start` when Pico should keep listening as a background
resident service.
`resident:memory` is the companion drain worker that writes queued session
cutoffs to Mem0 and OTel/audit without adding a default job timeout. It recovers
stale `processing` jobs after `PICO_RESIDENT_MEMORY_RECOVER_PROCESSING_OLDER_THAN_MS`
or 10 minutes by default; this is crash recovery, not a per-job execution
deadline.

For local development on macOS, open a Minecraft-server-style log terminal for
the voice resident process:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml pico dev
```

This opens kitty by default, starts the resident voice process, streams stdout
and stderr in that terminal window, and also appends the same output to
`~/.pico/resident-voice/development/processes/YYYY-MM-DD/<run-id>.log`. Use
`pico dev --terminal=terminal` to open Terminal.app instead. Stop it from the
opened terminal with `Ctrl-C`; the development terminal closes after the
resident process exits. This is a development entrypoint; production resident
voice management still uses the LaunchAgent below.

The development terminal uses concise voice probe logs by default and does not
support verbose mode. It shows utterance windows, STT completion, trigger
decisions, session start, Pi Agent turns, Pi Agent response duration, wake
acknowledgement prompts/responses, active user input text, active Pi Agent
response text, TTS synthesis/playback, cutoff enqueue, and errors. Text payloads
are displayed as indented multiline blocks so operator logs show the actual
response shape without hiding line breaks. Per-frame successful
capture/echo-control events are suppressed because they are too high-volume for
operator-facing logs. Use `PICO_VOICE_PROBE_STDOUT=verbose pico foreground` only
when debugging the frame pipeline directly from a plain terminal, not from
`pico dev`.

Resident voice logs are stored under `~/.pico` with local-user-only
permissions. Development and normal resident runs are separated:

```text
~/.pico/
  resident-voice/
    development/
      processes/YYYY-MM-DD/<run-id>.log
      metrics/YYYY-MM-DD/<run-id>.jsonl
      events/YYYY-MM-DD.jsonl
      sessions/YYYY-MM-DD/<run-id>/<session-id>.log
      sessions/YYYY-MM-DD/<run-id>/<session-id>.jsonl
    normal/
      processes/resident-voice.out.log
      processes/resident-voice.err.log
      processes/YYYY-MM-DD/<run-id>.log
      events/YYYY-MM-DD.jsonl
      sessions/YYYY-MM-DD/<run-id>/<session-id>.log
      sessions/YYYY-MM-DD/<run-id>/<session-id>.jsonl
```

Process logs contain stage summaries, durations, and errors. Session logs keep
the spoken input and Pi Agent response text for review, while JSONL files carry
the same session events in a script-friendly shape with `schemaVersion`,
`runMode`, and `runId`. Raw audio is not stored continuously; use targeted field
harnesses for short diagnostic audio artifacts.

The resident voice process generates a short Pi Agent wake acknowledgement after
trusted wake-name or greeting triggers. This confirms that pico is listening
without treating the wake phrase itself as the user's task.

Background music is not removed by the resident voice runtime. Echo control is
for pico's own TTS playback reference, so loud music or lyric-heavy audio can
still degrade STT accuracy, keep an utterance window open, or create false wake
matches. Validate resident placement with the same background audio expected in
the room.

On the Mac mini resident host, manage the production voice process as a user
LaunchAgent after `smoke:resident-audio-input` proves that the configured
microphone clears `voice.resident.utteranceWindow.minRmsDb`:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml pico install
PICO_CONFIG_PATH=config/pico.local.yaml pico status
PICO_CONFIG_PATH=config/pico.local.yaml pico restart
PICO_CONFIG_PATH=config/pico.local.yaml pico stop
PICO_CONFIG_PATH=config/pico.local.yaml pico uninstall
```

The LaunchAgent label is `dev.toarupen.pico.resident-voice`. It runs the
resident voice script through the current Node executable and local `jiti` with
`PICO_CONFIG_PATH` set to the resolved local config path, writes the plist to
`~/Library/LaunchAgents/dev.toarupen.pico.resident-voice.plist`, and writes logs
under `~/.pico/resident-voice/normal/`. The normal LaunchAgent session keeps
process stdout/stderr in `processes/resident-voice.out.log` and
`processes/resident-voice.err.log`, and the resident runtime writes dated
process, event, and session logs under the same normal run mode. `stop` boots
the KeepAlive service out of the user launchd domain while leaving the plist
installed; use `install` to bootstrap it again or `uninstall` to remove the
plist.

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
