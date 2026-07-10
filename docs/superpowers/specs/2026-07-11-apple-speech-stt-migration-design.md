# Apple Speech STT Migration Design

## 目的

pico の日本語音声認識 provider を MLX Whisper から Apple Speech へ差し替える。
Pi Agent、resident session、echo control、Aivis Speech TTS の責務は変更せず、既存の
STT adapter boundary の内側だけを置き換える。

本仕様は、既存の設計・計画に残る `mlx-whisper` provider 選択と
`voice.stt.mlxWhisper` 設定を supersede する。過去の field report と実装計画は当時の
記録として残す。

## 決定

- STT provider は macOS 26 の `SpeechAnalyzer` / `SpeechTranscriber` を使う。
- Swift sidecar を pico と同じ Mac 上で動かし、HTTP は loopback に限定する。
- provider fallback は設けない。sidecar が未起動、asset 未導入、timeout、backend
  error の場合は明示的に失敗する。
- progressive partial result は採用せず、resident の utterance window ごとに確定結果を
  1 回返す。
- runtime 設定は startup-only とし、変更時は sidecar と resident process を再起動する。
- analyzer の model retention は低latencyを優先して `processLifetime` とする。RSS評価は
  modelを保持した定常状態で行い、常駐memoryが運用上の制約になった場合だけ再検討する。

## 固定契約

設定キーは `voice.stt.appleSpeech` とする。音声契約は次に固定する。

- provider: `apple-speech`
- locale / language: `ja-JP`
- encoding: signed PCM16LE
- sample rate: 16 kHz
- channels: mono
- endpoint: `POST /v1/transcriptions`
- readiness: `GET /ready`
- liveness: `GET /health`

TypeScript adapter は raw PCM を Base64 JSON envelope にし、Swift sidecar は exact key、
media type、値、Base64 canonical form、偶数 byte length、上限 4 MiB を検証する。成功時は
text、language、confidence、duration、確定 segment を返す。失敗 code は
`invalid_request`、`timeout`、`model_load`、`backend_error` に限定する。

## Runtime boundary

sidecar は同時に 1 件だけ transcription admission を許可する。処理中の追加 request は
body を展開する前に busy として拒否し、resident 側で暗黙に再試行しない。timeout または
cancellation 時は Speech analyzer と result consumer を終了させる。

sidecar の起動・再起動は pico の TypeScript process が所有しない。operator は release
binary を trusted user process として先に起動し、次の順に readiness を確認する。

1. `install-assets --locale ja-JP`
2. `preflight --locale ja-JP`
3. `serve --host 127.0.0.1 --port 8766 --locale ja-JP`
4. `/health` と `/ready`
5. provider smoke、実 microphone、resident integration

## Verification

- TypeScript unit / integration testsで exact wire contract と config migration を検証する。
- Swift testsで CLI、asset state、PCM変換、response mapping、HTTP admission と timeout を
  検証する。
- `just check` は macOS 上で Swift gate も実行する。
- GitHub Actions は通常の pico quality gate と macOS 26 の Apple Speech gate を分離して
  必須結果を見分けられるようにする。
- 完了判定には日本語音声の provider smoke、実 microphone transcription、resident
  microphone-to-Pi-to-TTS field test を含める。
