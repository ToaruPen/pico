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

Optionally expose the local `pico` helper command in your shell:

```bash
npm link
```

Without linking, use `npm run pico -- <command>` from the repository root. The
helper is for development only; Pi Agent owns production startup and loads pico
through `package.json` `pi.extensions`.

Run all local checks:

```bash
just check
```

Run the TypeScript gates in the same parallel shape as the Linux CI job:

```bash
just ci
```

`just ci` is TypeScript-only. On macOS, use `just check` above to run both the
TypeScript gates and the Apple Speech gate.

Run the milestone smoke suite after local credentials and hardware/provider
sidecars are configured. Smoke commands are regression and readiness gates, not
completion evidence for real-world validation. Missing optional provider
configuration is reported as an explicit skipped section; failed configured
sections make the command fail.

```bash
just smoke-milestone
```

When `telemetry.otel.enabled` is true, run a loopback OpenTelemetry Collector
before Pico. The tracked example is for `otelcol-contrib` because it uses the
file and Prometheus exporters:

```bash
otelcol-contrib --config config/otel-collector.example.yaml
PICO_CONFIG_PATH=config/pico.local.yaml just smoke-otel-telemetry
```

The Collector accepts OTLP HTTP only on `127.0.0.1:4318` and exposes Prometheus
metrics only on `127.0.0.1:9464`. Pico emits metadata-only Logs and Metrics; it
does not send transcripts, responses, tool arguments, tool results, or resident
session identifiers to OTel.

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
interaction ending, OTel/audit evidence, and any follow-up issues created from
failures.

Field test reports live under `docs/field-tests/`.

Run the authenticated Pi Agent runtime smoke after `pi` is configured with model
credentials:

```bash
just smoke-pi-runtime
```

To expose the selected StackChan tools to Pi Agent, install the verified MCP
adapter version once and export the local gateway bearer token before starting
Pi or the resident voice process:

```bash
node_modules/.bin/pi install npm:pi-mcp-adapter@2.11.0
export STACKCHAN_TOKEN='<local gateway token>'
```

This intentionally installs the verified third-party adapter in Pi's user
package scope, so it is trusted code for every Pi session owned by that local
user and has the same process privileges as Pi. The model-callable tool
allowlist below limits agent actions; it is not a sandbox for extension code.

The tracked `.pi/mcp.json` reads only `STACKCHAN_TOKEN`; it does not contain the
token. It keeps the MCP endpoint on loopback and selects a bounded direct-tool
set instead of all gateway hardware and configuration tools.

The adapter requires cached MCP metadata before it can register direct tools.
Prime that cache in a trusted interactive session with all model-callable tools
disabled, then restart Pi:

```text
node_modules/.bin/pi --no-tools
/mcp reconnect stackchan
/quit
```

Use Pi settings to expose only the direct tools needed by each agent. For
example, a harmless status check needs only `stackchan_get_status`. Do not
enable the generic `mcp` proxy tool. Keep camera and Stack-chan tools exclusive
to Pico through those settings. A separately installed Pi-level memory plugin,
if used, owns its own tools and visibility; Pico does not register or proxy them.

The adapter expires cached metadata after seven days. If resident startup
reports `missing required tools`, repeat the trusted `--no-tools` cache-prime
session above, exit Pi, and restart the resident process. Do not work around a
missing direct-tool cache by enabling the generic proxy.

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
- `voice.stt.appleSpeech` for the local Apple Speech sidecar. The resident and
  real-microphone field paths do not require a sample file;
  `samplePcm16lePath` is optional and, when set for provider smoke, must point
  to a PCM16LE mono 16 kHz sample.
- `voice.resident.audioInput` and `voice.resident.audioOutput` for the direct
  resident voice harness. On macOS use `avaudioengine` with an explicit stable
  Core Audio `deviceUid`, plus `ffplay` with `route: system_default`. Run the
  bounded macOS audio probe to identify and verify the selected UID, then use
  `just field-resident-hold-to-talk` for PTT signal validation. AVAudioEngine
  keeps the selected input device open while Pico is running, so macOS shows its
  microphone indicator; PCM outside an accepted PTT boundary is discarded in
  the Swift sidecar and is not sent to Node, STT, logs, or files. Linux keeps
  explicit `alsa` input/output devices.
- `voice.resident.control` for the integrated `macos_resident_io` keyboard and
  audio sidecar. `talkKey` and `cancelKey` are explicit startup-only bindings;
  the example uses `F13` and `F14` without making them defaults.
- Resident Apple Speech uses one loopback WebSocket and one `SpeechAnalyzer`
  session per accepted PTT turn. Accepted PCM is sent online in bounded 100 ms
  messages, so a two-minute turn does not accumulate one full recording in
  Node or hit the batch endpoint's 4 MiB limit. The batch transcription route
  remains only for startup warmup and finite provider checks; production does
  not fall back to it when streaming fails. Only the final transcript enters
  the Pi turn, and PCM is not written to files or ordinary telemetry.
- `camera.tapo` for one Tapo RTSP JPEG frame.
- `vision.ollama` for `qwen3.5:9b` through the protected local tunnel.
- `camera.tapo` plus `vision.ollama` for camera-to-VLM scene smoke.

### Apple Speech sidecar

Apple Speech STT requires macOS 26 and a compatible selected Xcode 26 or Command
Line Tools installation. Xcode toolchains resolve Swift Testing through SwiftPM;
when the selected Command Line Tools expose both `Testing.framework` and
`lib_TestingInterop`, the gate adds their explicit link paths. Build and validate
the Swift sidecar, install the Japanese speech assets, and check readiness before
starting the resident voice process:

```bash
just apple-speech-check
cd sidecars/apple-speech
swift build -c release -Xswiftc -warnings-as-errors
binary="$(swift build -c release --show-bin-path)/pico-apple-speech-sidecar"
"$binary" install-assets --locale ja-JP
"$binary" preflight --locale ja-JP
"$binary" serve \
  --host 127.0.0.1 \
  --port 8766 \
  --locale ja-JP \
  --analysis-timeout-ms 25000
```

Keep that terminal running. In a second terminal, verify liveness and installed
asset readiness before starting a provider smoke or resident process:

```bash
curl --fail http://127.0.0.1:8766/health
curl --fail http://127.0.0.1:8766/ready
PICO_CONFIG_PATH=config/pico.local.yaml just smoke-voice-providers
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice
```

The sidecar accepts only loopback traffic and the fixed `ja-JP`, PCM16LE,
16 kHz, mono contract. It processes one transcription at a time and returns a
busy response to additional concurrent requests. Pico does not spawn or restart
the sidecar: keep the release binary running in a dedicated trusted user process
before launching `resident:voice`. Asset, locale, port, or binary changes take
effect after the sidecar and resident process are restarted.

Pi Agent is the runtime owner. Start Pi Agent with this package available so it
loads the pico extension from `package.json` `pi.extensions`; do not treat
`pico` as a standalone production process.

Normal Pi and Pico may run at the same time. Start normal Pi with `pi`; start
the resident Pico controller explicitly with either equivalent command:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
  node_modules/.bin/pi --no-session --extension ./src/index.ts --pico
PICO_CONFIG_PATH=config/pico.local.yaml pico
```

`pico` delegates to `pi --no-session --pico`; it does not choose a model on the
command line. The non-persistent Pi host owns the resident process but does not
retain a conversation transcript. The extension reads `pico.model.provider`,
`pico.model.id`, and `pico.model.thinkingLevel` from YAML and fails startup if
that exact model is unavailable.

Each accepted interaction uses one Pi-owned in-memory `AgentSession`. Turns and
the timeout farewell reuse that session; Pico then emits its Pi extension
shutdown lifecycle and disposes it. The next accepted interaction starts with
an empty Pi context. The Pi host process remains resident throughout.

The direct resident scripts remain low-level field and provider harnesses while
resident voice integration is validated:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run resident:voice
```

`resident:voice` owns the live microphone, speaker, and interaction lifecycle in
the current terminal for direct field validation. It is not the public pico
startup contract.

For a repeatable full-turn measurement, inject one finite PCM16LE mono 16 kHz
WAV or raw PCM fixture through the explicit field harness. This path invokes the
configured Apple Speech STT, Pi Agent, Aivis Speech TTS, and playback providers:

```bash
validation_dir="$(mktemp -d /tmp/pico-voice-validation.XXXXXX)"
PICO_CONFIG_PATH=config/pico.local.yaml \
  npm run field:resident-voice-pseudo-audio -- \
  --audio-fixture /tmp/pico-known-ja.wav \
  --validation-output "$validation_dir/events.jsonl" \
  --required-tool-name stackchan_get_status
```

The validation JSONL is intentionally contentful and mode `0600`: it contains
the recognized transcript, Pi response, and tool names/arguments/results so the
operator can verify correctness as well as timing. It is never forwarded to
OTel or normal resident logs. Treat it as sensitive, keep it only for the field
run, and delete it when validation is complete. Its immediate parent must be a
real, current-user-owned mode-`0700` directory, and the output file must not
already exist. If OTel is disabled, the field harness still executes the same
SDK pipeline with in-process recording exporters and reports their Log/Metric
counts.

### Memory ownership

Pi owns the non-persistent host session and each in-memory interaction session,
including transcript, context, and history. Pico's process-local `SessionRecord`
contains the session ID, active/ended state, start/end timestamps, and trusted
trigger; the managed lifecycle additionally holds the inactivity timer.
Farewell, deferred-tool cancellation, and Pi session cleanup are
end-of-interaction operations, not retained state. Pico does not keep
conversation entries or create a memory side effect when an interaction ends.

Durable memory, when enabled, is a separately installed Pi-level plugin. That
plugin—not Pico—owns provider configuration, extraction, persistence, search,
updates, deletion, retention, tool registration, and runtime lifecycle. This
repository provides no Mem0/Qdrant client, memory worker, memory configuration,
memory-search tool, adapter, fallback, or provider smoke.

Any independently installed memory capability must not be designed for child
tracking, evaluation, scoring, or profiling. It must not create child-linked
individual records containing health, disability, abuse, or family-circumstance
information. Pico does not enforce that product policy through a privacy filter
or natural-language classifier.

Rotate any provider, OTel, or Stack-chan token before production use if it has
appeared in a terminal transcript, field artifact, or shared log. The remaining
product risks are speaker authority, emergency/handoff behavior, and retention
of operational log metadata; this slice does not claim to solve them.

For local development on macOS, open a Minecraft-server-style log terminal for
the voice resident process:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml pico dev
```

This opens kitty by default, starts Pi Agent with `--no-session --pico`, and
displays Pi's interactive output in that terminal window. The non-persistent
host follows the same interaction-session lifecycle as the normal `pico`
command. The Pico wrapper does not duplicate that output into a file. Pico
persists only output produced by its metadata-only log sink under
`~/.pico/resident-voice/development/processes/YYYY-MM-DD/<run-id>.log`. Use
`pico dev --terminal=terminal` to open Terminal.app instead. Stop it from the
opened terminal with `Ctrl-C`; the development terminal closes after the
resident process exits. This is a visible development helper around the same
Pi-hosted ownership path. The direct resident harness remains available
separately for bounded field validation.

The development terminal uses concise voice probe logs by default and does not
support verbose mode. It shows admitted STT completion, Pi Agent turn and
response-duration metadata, TTS synthesis/playback, interaction ending, and
errors. It does not log staff input or Pi Agent response text. Per-frame
successful capture/echo-control events are suppressed because they are too
high-volume for operator-facing logs. Use
`PICO_VOICE_PROBE_STDOUT=verbose npm run resident:voice` only when debugging the
frame pipeline directly from a plain terminal, not from `pico dev`.

Resident voice logs are stored under `~/.pico` with local-user-only
permissions. Development and normal resident runs are separated:

```text
~/.pico/
  resident-voice/
    development/
      processes/YYYY-MM-DD/<run-id>.log
      metrics/YYYY-MM-DD/<run-id>.jsonl
      events/YYYY-MM-DD.jsonl
      sessions/YYYY-MM-DD/<run-id>/<session-id>.jsonl
    normal/
      processes/resident-voice.out.log
      processes/resident-voice.err.log
      processes/YYYY-MM-DD/<run-id>.log
      events/YYYY-MM-DD.jsonl
      sessions/YYYY-MM-DD/<run-id>/<session-id>.jsonl
```

Process logs contain stage summaries, durations, and errors. Daily and session
JSONL files contain metadata-only interaction events with `schemaVersion`,
`runMode`, `runId`, event kind, timestamp, session ID, and duration where
relevant. They contain no text field and do not store staff input or Pi Agent
responses. Raw audio is never persisted by the resident
runtime. The bounded hold-to-talk field harness reports aggregate timing,
frame-count, CPU, and RSS metadata only.

Resident voice is explicit hold-to-talk. Pressing the configured talk control
starts microphone capture, releasing it keeps a fixed 250 ms speech tail and
then submits at most one Pi turn. A separate configured control cancels
recording, STT, the active Pi turn, TTS, or playback without ending the Pi parent
conversation. Talk presses while Pico is busy are ignored and never queued.

Background music is not removed by the resident voice runtime. Echo control is
for pico's own TTS playback reference, so loud music or lyric-heavy audio can
still degrade STT accuracy while the talk control is held. Explicit controls
prevent that background audio from activating Pico while idle. Validate
resident placement with the same background audio expected in the room.

On the Mac mini resident host, the public production startup target is Pi Agent
with the pico extension loaded. The direct LaunchAgent harness below is kept for
low-level resident voice validation after `smoke:resident-audio-input` proves
that the configured microphone clears `voice.resident.vad.minRmsDb` when the
energy gate is selected:

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
under `~/.pico/resident-voice/normal/`. The normal LaunchAgent session keeps
process stdout/stderr in `processes/resident-voice.out.log` and
`processes/resident-voice.err.log`, and the resident runtime writes dated
process, event, and session logs under the same normal run mode. `stop` boots
the KeepAlive service out of the user launchd domain while leaving the plist
installed; use `install` to bootstrap it again or `uninstall` to remove the
plist. `install` also builds the project-owned macOS control bridge at its stable
package-relative release path. The bridge requires macOS Input Monitoring
permission and consumes the two configured controls globally.

Run the bounded control-and-capture field check after stopping the resident
service:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
  npm run field:resident-hold-to-talk -- --duration-ms 30000
```

Use the configured talk and cancel controls during the interval. The command
does not invoke STT, Pi, TTS, or playback and emits aggregate metadata only.

Normal abort and graceful shutdown are owned by Pi. If a hard kill or power loss
leaves an orphaned helper, Pico does not maintain a TaskRun database or attempt
automatic task resumption. A recurring Codex stale-process cleanup reviews
command line, parentage, age, CPU, state, and active-workflow evidence before
sending `TERM` to an identified residue. It does not kill a generic `node` or
`pi` process by name, and reports `STAT=Z` zombies for parent reaping instead of
trying to signal them.

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
