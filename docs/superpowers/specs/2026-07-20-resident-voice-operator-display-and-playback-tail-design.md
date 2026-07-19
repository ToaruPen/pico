# 常駐音声のオペレーター表示と再生末尾設計

## 背景

`pico` の常駐音声ターンは Pi SDK の子セッションで実行されるため、認識文、
応答本文、tool call は親 Pi の会話画面へ現れない。通常ログと OTel は意図的に
本文を保持せず、現在のコンソール sink も通常起動では無効である。

現地確認では、入力認識そのものより Pi turn が支配的な遅延だった一方、利用者は
各区間を画面から判別できない。また、セッション期限は再生完了時にしか更新されず、
次のターンの処理中に期限切れできる。再生 sink は最後の PCM 書き込み直後に EOF を
送り、出力装置の drain 用余白を明示していない。

## 目的

- 通常の `pico` TUI に認識文、Pi 応答、tool call の成否と実測時間を表示する。
- 本文と tool payload を Pi のモデルコンテキスト、Pi セッション履歴、通常ログ、
  OTel に混入させない。
- 新しい PTT 入力を受理した時点からセッションの inactivity 期限を更新する。
- 逐次合成を維持したまま、最終再生境界だけに PCM 無音を追加して尻切れを防ぐ。
- 元の最終音声 chunk に含まれる末尾無音量を数値で観測できるようにする。

## 非目的

- 親 Pi セッションへ音声会話を user/assistant message として注入しない。
- 本文や tool payload をファイル、OTel、監査ログへ追加しない。
- モデル、thinking level、TTS provider、逐次合成方式を変更しない。
- 再生途中の各文へ無音を追加しない。

## 設計

### 1. 非永続オペレーター表示

常駐音声 runtime、Pi turn client、stage probe が共有する
`ResidentVoiceOperatorSink` を導入する。イベントは次を含む。

- PTT ターン開始
- 認識済み staff transcript
- Pi 応答本文
- 最終 assistant stop reason
- tool 名、引数、結果、成否、実行時間
- 音声処理 stage、status、時間、許可済み数値属性

`pico` の TUI 起動では、この sink を Pi `ExtensionContext.ui.setWidget` に接続する。
widget は UI 状態であり、Pi session entry や LLM message を作らない。直近の会話を
上限付きで保持し、stage はターンごとの一行へ集約する。tool payload と本文は UI を
占有しないよう UTF-8 上限を設ける。改行、端末制御文字、Unicode の行区切りは
単一行へ正規化する。応答本文を返さず終了した assistant の stop reason と、SDK の
終了イベントを返さず中断した tool call も確定状態として表示する。sink の例外は
runtime の成否へ影響させない。

本文の byte 上限は走査中に適用する。tool payload は getter、`toJSON`、custom inspect、
Proxy trap を実行せず、depth、node、property、array item、byte の各 budget 内でのみ
data property を整形する。未完了 tool は raw args ではなく、この不活性な文字列
snapshot だけを上限32件まで保持する。

通常の `VoiceResidentLogSink`、検証 artifact、監査ログ、OTel の契約は変更しない。
とくに通常ログはこれまでどおり本文を受け取らない。

### 2. セッション期限

既存 interaction が active の場合、受理された `talk_pressed` で activity timer を
更新する。STT 後に session を確定した時点でも更新し、再生完了時の既存更新も残す。
これにより capture/STT/Pi/TTS の途中で、直前の再生完了を基準にした古い期限が
発火しにくくなる。終了済み session は再利用も更新もしない。

### 3. 最終 PCM drain padding

連続再生 session の `finish()` は、受理済み音声を書き終えた後、EOF の直前に
300 ms の PCM16LE ゼロ値を一度だけ書く。sample rate と channel 数から frame
alignment を保った byte 数を算出する。

通常の `write()`、逐次合成 chunk、echo reference、発話内容の時間には padding を
含めない。cancel/stop、早期 child close、backpressure、二重 finish の既存収束契約を
維持する。padding write も通常 write と同じ failure と drain の境界を使う。

### 4. 末尾診断

TTS pipeline は最後に再生へ渡した PCM16LE chunk の末尾を走査し、無音閾値以下の
連続 sample frame を ms に換算する。この値を
`pico.voice.trailing_silence_ms` として `tts_playback` stage に追加する。本文や PCM
そのものは記録しない。

## 表示例

```text
Pico voice
Staff: スタックチャンの状態を教えて
Tool: stackchan_get_status({}) -> ok 350 ms {"status":"ready"}
Pico: 準備できています [stop=stop]
時間: STT 155 ms | Pi初字 7.74 s | Pi 20.35 s | TTS初音 1.45 s | 再生 4.41 s | PTT→再生 22.42 s
```

## 検証

- operator sink の整形、上限、stage 集約、tool start/end 対応を単体試験する。
- TUI 以外では widget sink を作らず、通常ログに本文が入らないことを維持する。
- 二つ目の PTT が session timer を更新し、処理中に inactivity ending が始まらない
  回帰試験を追加する。
- PCM padding の byte 数、final-only、backpressure、cancel、idempotent finish を試験する。
- 末尾無音測定を mono/stereo、有音末尾、全無音、不正 alignment で試験する。
- `just check` と疑似音声 field harness で全体を確認する。
