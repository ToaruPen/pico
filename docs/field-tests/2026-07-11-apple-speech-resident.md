# 2026-07-11 Apple Speech Resident Voice Field Test

## Scope

MLX Whisper から Apple Speech へ差し替えた日本語 STT 経路について、sidecar の
readiness、実 provider、実 microphone、echo safety、および
Apple Speech → resident session → Pi Agent → Aivis Speech → speaker playback の結合を
検証する。

## Environment

- Date: 2026-07-11 08:27 JST
- Operator: Codex local operator session
- Host: Apple Silicon Mac (`arm64`), macOS 26.5.1
- Live input: AVFoundation、外付け USB microphone
- Output: system-default Bluetooth speaker
- Apple Speech sidecar: 0.1.0、FlyingFox 0.27.0
- Pi Agent: 0.80.6
- pi-mcp-adapter: 2.11.0
- Aivis Speech: local CPU container
- Config: `config/pico.local.yaml`。secret と device identifier は記録しない

## Commands

Swift / HTTP gate と sidecar 起動確認:

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

curl --fail http://127.0.0.1:8766/health
curl --fail http://127.0.0.1:8766/ready
```

Provider、microphone、echo-control:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml just smoke-voice-providers
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:resident-audio-input
PICO_CONFIG_PATH=config/pico.local.yaml just field-voice-echo-pickup
```

Resident 結合は `.pico-local/apple-speech-integration/resident-real.ts` の一時 harness で
実行した。harness は production と同じ `runVoiceResidentRuntime`、Apple Speech client、
Pi Agent client、Aivis Speech client、`afplay` sink を組み立て、2 個の PCM frame を渡す。
stub、mock、provider fallback は使用していない。試験データと harness は実行後に削除した。

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
PICO_INTEGRATION_WAKE_PCM=<pcm16le-mono-16khz> \
PICO_INTEGRATION_QUERY_PCM=<pcm16le-mono-16khz> \
npx jiti .pico-local/apple-speech-integration/resident-real.ts
```

## Results

### Swift and sidecar

- Swift tests: 30 tests / 9 suites passed。
- Release build with warnings-as-errors: passed。
- CLI、HTTP admission、malformed / oversized request gate: passed。
- `/health`: HTTP 200、`status=ok`。
- `/ready`: HTTP 200、`ready=true`。
- `SpeechAnalyzer.bestAvailableAudioFormat` は固定入力と同じ 16 kHz、signed Int16、mono を
  選択した。resolver の `isInterleaved=true` は mono では同じ sample layout になるため、
  sample type、rate、channels の一致を確認して受け入れる。

### Japanese provider smoke

- Apple Speech STT: passed。
- 日本語 sample の期待文を認識し、confidence 0.914、audio duration 3068.2 ms。
- Aivis Speech TTS: passed。2 chunks、288,202 bytes、3266 ms audio、44.1 kHz、mono、
  PCM16LE。

### Live microphone and echo safety

- AVFoundation capture: passed。16 kHz、mono、3071 ms。
- Observed input: RMS -46.34 dB、peak -20.36 dB、configured minimum -55 dB。
- Echo pickup field: `safety_pass`。half-duplex suppression が作動し、false trigger は 0。

Live input と system-default output は別 device のため、当日の Bluetooth playback を
USB microphone へ再収録する acoustic loop は安定した日本語 utterance にならなかった。
このため、同日 live capture の signal gate と、既に operator 発話で検証済みの実 microphone
PCM を現在の runtime へ投入する結合試験を分離した。使用した実 microphone PCM の由来は
[2026-06-14 live voice field report](./2026-06-14-live-voice-stt-tts.md) に記録されている。

### Real resident integration

既知の日本語 sample を使った最初の実プロバイダー結合:

- processed frames: 2
- started sessions: 1
- completed turns: 1
- failed / suppressed frames and turns: 0
- Apple Speech: 2 calls、total wall 554 ms、confidence 0.914 / 0.849
- Pi Agent: 1 call、4916 ms、non-empty response
- Aivis Speech: 1 call、1 chunk、2529 ms audio、wall 5201 ms
- Speaker playback: 1 call、3230 ms、exit 0

実 microphone PCM を使った結合再検証:

- processed frames: 2
- started sessions: 1
- completed turns: 1
- failed / suppressed frames and turns: 0
- Apple Speech: 2 calls、total wall 205 ms、confidence 0.897 / 0.902
- Pi Agent: 1 call、32,348 ms、non-empty response
- Aivis Speech: 1 call、3 chunks、7106 ms audio、wall 2468 ms
- Speaker playback: 3 calls、9679 ms、all exit 0

PR review 修正と release binary 差し替え後にも、同じ実 microphone PCM で再検証した。

- processed frames: 2
- started sessions: 1
- completed turns: 1
- failed / suppressed frames and turns: 0
- Apple Speech: 2 calls、total wall 198 ms、confidence 0.902 / 0.902
- Pi Agent: 1 call、13,827 ms、non-empty response
- Aivis Speech: 1 call、3 chunks、5713 ms audio、wall 2010 ms
- Speaker playback: 3 calls、8331 ms、all exit 0

### Resident process and memory observation

- Resident LaunchAgent startup warmup: passed。434.6 ms で STT / TTS の warmup を終え、
  microphone loop へ入った。
- Apple Speech sidecar は transcription 後も `processLifetime` retention のまま ready を維持。
- Sidecar process observation: RSS 18,464 KiB、`footprint` 5953 KB。
- Resident Node process after warmup: RSS 256,480 KiB。
- 上記は sidecar process 単体の値であり、macOS の共有 framework / system speech service の
  memory を Apple Speech 専用分として分離した値ではない。

## Verdict

- Apple Speech sidecar / Japanese STT: PASS
- Live microphone capture: PASS
- Echo safety: PASS
- Real microphone PCM → Apple Speech → Pi → Aivis → speaker: PASS
- Same-device contemporaneous acoustic loop: NOT APPLICABLE on the current split input/output setup

MLX Whisper の runtime fallback を使わず、現在の Apple Speech 単独 provider 経路で resident
voice integration は完了した。
