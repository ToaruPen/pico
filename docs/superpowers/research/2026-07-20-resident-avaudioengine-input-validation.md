# resident AVAudioEngine input 検証記録

**日付:** 2026-07-20
**状態:** deterministic validation完了、exclusive field validation未実施

## 実装前の既知計測

- FFmpeg/AVFoundationをPTTごとにspawnした場合のfirst PCM: 275.7、201.3、215.4、211.2、207.8 ms。中央値211.2 ms。
- AVAudioEngineをprepare後にオンデマンドstartした場合: 282〜321 ms。中央値291 ms。
- start後pause→startした場合: 254〜281 ms。中央値260 ms。

このため、productionはPico稼働中にAVAudioEngineをrunningのまま維持し、PTTではsample admission境界だけを切り替える。

## Deterministic evidence

- Swift protocol/gate/device/clock/health/conversion testsは`just macos-resident-io-check`で実行する。
- Node protocol/bridge/controller/runtime/config testsは`just test`と`just check`で実行する。
- wire timestampはUInt64 decimal stringで保持する。
- timing eventは固定stage名とdurationだけを持ち、device UID、key、sequence、generation、PCMを通常観測へ出さない。
- health sampleはbuffer cadence、restart count、PTT外/suppressed/total dropped frame countだけを持つ。
- callbackがphysical key eventより先にowner queueで処理される場合も、16,384 source frameの
  private reorder ringからpress timestamp以後だけを切り出す。audio→press逆順testで固定した。
- 全未収束control sequenceはkindを問わず64件を上限とし、超過時は`control_backlog`でfail-closeする。
- sleep中はhealth timerとcontrol admissionから独立したsuspended latchでengine restartを禁止し、wakeだけが
  新しいrecovery cycleを開始する。TTS suppressionはcancel/recoveryをまたいで明示的なresumeまで維持する。
- field hold-to-talk harnessはengine start、必須timing stage、health aggregate、capture invalidation、
  generation不一致PCM countを実測する。recovery/timeout/overrun/invalidation/unexpected PCM後のPASSを禁止し、
  sidecar終了失敗もPASSにしない。audio fixture利用時はnative generationを所有したままnative PCMを内容非参照で
  破棄し、fixture frameだけを測定する。STTを呼ばない同harnessから固定のidle STT成功値は出さない。
- resident STTは1 PTTにつき1 WebSocketと1 SpeechAnalyzerを使う。Nodeは10 ms native frameを
  100 ms単位へcoalesceし、Swift analyzer inputは8 MiB、native受信は128 frameでfail-closeする。
  total PCMにはbatchの4 MiB上限を適用せず、4 MiB超の逐次入力、overflow、disconnect、cancel、
  finalization競合をdeterministic testで固定した。batch endpointはwarmup/smoke専用で、production
  streaming failureからのfallbackはない。

2026-07-20に次を同一treeで実行し、すべてexit 0を確認した。

- `bash scripts/ci/run-macos-resident-io-gates.sh`: Swift Testing 42 testsとwarnings-as-errors release build。
- `just test`: 73 files、1,004 tests（最終`just check`内で再実行）。
- `just apple-speech-check`: Swift Testing 59 testsとwarnings-as-errors release build。
- `just check`: macOSの両Swift gate、typecheck、lint、AST rules、format check、全Vitest。
- `npx --yes --package secretlint@latest --package @secretlint/secretlint-rule-preset-recommend@latest secretlint .`。
- `git diff --check`。

同日のexclusive resource事前確認では、別checkoutのPico、AVFoundation capture、
resident I/O sidecar、Apple Speech/AivisSpeech listenerは見つからなかった。
Apple Speech sidecarの実`preflight --locale ja-JP`は
`Apple Speech assets are ready`で成功し、Speech framework、日本語asset、固定16 kHz
mono PCM formatのready判定を通過した。repository内に音声fixtureとlocal configはなく、
AivisSpeechも停止中だったため、認識requestを発生させるprovider smokeは実行していない。

`npx secretlint .`だけの呼び出しは、repo設定が参照するpreset packageがローカル依存にないためrule load前に失敗した。上記の明示package指定で同じrepo設定を検査した。

## 未実施のexclusive field validation

ユーザーが現在Picoを起動できず、別checkoutのPicoやexclusive microphone/lockを無断停止しない条件のため、次は未実施である。

1. 現在のAVFoundation `:1`に相当するCore Audio device UIDの照合。最初のholdで、連続
   callback host timestampの差とframe durationの残差が現行の0.5 sample tolerance内に
   収まり、`audio_timeline_discontinuity`を誤検出しないことをbenchmark前に確認する。
2. `just macos-resident-audio-probe --duration-seconds 30 --device-uid <uid>`によるcallback cadence、host clock、CPU/電力、sleep/wake、route/configuration change計測。
3. AivisSpeech preflightと、Apple Speechへの実transcription request。
4. immediate-speech physical PTT、250 ms tail、cancel、busy talk、TTS clear、device抜去/再設定の実マイク確認。
5. code/config不変の3回連続real-provider run。

加えて、固定fixtureによるbatch/streaming最終transcript一致と2分超入力のreal-provider
runは未実施である。deterministic testは自己設定の4 MiB上限を除いたことを証明するが、
Apple Speech framework自体の長時間精度や実環境の資源消費を証明するものではない。

exclusive windowが得られるまで、実マイクで冒頭欠落が解消したことやproduction field validation完了は主張しない。
