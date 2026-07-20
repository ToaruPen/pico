# resident AVAudioEngine input 設計

**日付:** 2026-07-20
**状態:** 承認済み
**対象:** macOS production resident input、PTT sample admission、native input health

## 1. 目的

macOS production resident inputを、PTTごとにFFmpeg/AVFoundation processを起動する方式から、
Pico稼働中は常時runningの`AVAudioEngine`へ置き換える。物理talk key押下直後の発話を失わず、
押下前音声を受理せず、PTT外のPCMをSwift processの固定上限メモリ以外へ出さない。

この変更は入力deviceを常時openにするが、常時認識、常時保存、pre-roll受理は行わない。

## 2. 変更対象と非対象

### 対象

- macOS Core Graphics keyboard eventとAVAudioEngine input tapの統合sidecar
- 物理key timestampとaudio host timestampの対応
- Node control admissionに従うPTT sample gate
- 250 ms release tail、cancel、TTS/echo suppression
- stable Core Audio input device selection
- permission、configuration change、sleep/wake、device抜去、engine stopのhealth/recovery
- Swift unit test、Node protocol/runtime boundary test、macOS field evidence

### 非対象

- Linux/ALSA inputの再設計
- Apple Speech provider、Pi AgentSession、TTS provider、playback providerの変更
- PTT中以外のSTT、KWS、pre-roll、continuous transcript
- OpenTelemetry Traces
- Pi TUI operator表示の再設計
- provider fallback

表示改善は独立した仕様、実装、PRで扱う。

## 3. supersedeする既存契約

`2026-07-17-hold-to-talk-resident-control-design.md`の次の記述をmacOS production inputに限って
置き換える。

- idleはmicrophone processとaudio bufferを所有しない
- accepted `talk_pressed`がcapture providerを起動する
- tail完了がaudio input processを閉じる
- AVAudioEngine reconstructionはlater sliceである

置き換え後は、resident I/O sidecarがPico起動からshutdownまで一つのAVAudioEngineをrunningに
保つ。PTT state machine、1 activation = 1 turn、busy talk拒否、F2 cancel、250 ms tail、
interactionごとのPi AgentSession disposeは維持する。

## 4. 採用アーキテクチャ

既存`sidecars/macos-control`を`sidecars/macos-resident-io`へ再編し、一つのSwift executableが
次を所有する。

- `ControlEventSource`: Core Graphics event tap、key repeat/orphan release抑止
- `HostClockMapper`: `CGEventTimestamp`と`AVAudioTime.hostTime`の共通timebase変換
- `ResidentAudioEngine`: permission、device selection、input tap、format conversion、engine lifecycle
- `PttSampleGate`: admission待ちbuffer、press/release sample cutoff、cancel/TTS clear
- `ResidentIoProtocol`: Nodeとのordered duplex IPC
- `HealthCoordinator`: configuration/sleep/wake/device/engine recovery

Node側の`ResidentControlController`はcontrol admissionとturn generationの唯一のownerである。
Swift gateはNodeが返した`accepted`を実行するmedia boundaryであり、busy policyを独自判断しない。

## 5. IPC契約

production sidecarはNodeがmanaged childとしてspawnする。privateなstdin/stdout上で、一つの
length-prefixed binary protocolを使用する。stderrだけをbounded diagnostic出力に使う。

### SwiftからNode

- `ready`: engine running、device一致、tap timestamp有効
- `control_event`: sequence、kind、physical event timestamp
- `pcm_frame`: accepted generation、sample/host timestamp、PCM16LE payload
- `tail_complete`: release cutoffまでのPCM dispatch完了
- `health_event`: state、fixed error code、restart count、numeric metadata
- `fatal`: fixed error code

### NodeからSwift

- `control_result`: sequence、result、generation
- `suppress_capture`: TTS/echo開始前のgate closeとring clear
- `resume_capture`: TTS/echo終了後のring clearとidle capture再開
- `cancel_generation`: active gateとpending PCMの破棄
- `shutdown`: bounded engine/IPC cleanup

frame headerはversion、message kind、metadata byte length、payload byte lengthを持つ。長さは双方で
固定上限を検証する。PCM messageだけがpayloadを持つ。raw stdout、通常log、OTelへframeを
fan-outしない。

既存authenticated loopback HTTP controlとtoken設定はproduction経路から削除する。外部automation
はproduction ownerではなく、必要な場合も別のbounded diagnostic adapterとして扱う。

## 6. audio formatとdevice契約

macOS input設定は次へ置き換える。

```yaml
voice:
  resident:
    audioInput:
      provider: avaudioengine
      deviceUid: explicit-core-audio-device-uid
```

AVFoundation positional device文字列と`system_default` inputはproductionで受理しない。
startup時にCore Audio device一覧からUIDを一つの`AudioDeviceID`へ解決し、input capabilityを確認して
`engine.inputNode.auAudioUnit.setDeviceID`で選択する。system defaultは変更しない。

hardware formatはdeviceから取得する。tap callback外のserial workerでAVAudioConverterを使い、
既存voice contractのPCM16LE、16 kHz、mono、10 ms frameへ変換する。converter stateはengine
generationに属し、rebuild時に再生成する。

## 7. host clockとsample admission

`CGEventTimestamp`は起動後nanoseconds、`AVAudioTime.hostTime`はmach host ticksである。Swift内で
どちらもsecondsへ変換するが、同一epochを仮定せずstartup probeでoffsetを求める。複数sampleの
residualが許容範囲を超える場合はreadyにならない。wake/restartごとに再較正する。

input tapの`when.hostTime`をbuffer先頭sample時刻とし、sample rateから各sample時刻を求める。
talk pressを含むbufferでは、次を満たす最初のsample indexからだけ受理する。

```text
sampleHostTime >= physicalTalkPressedHostTime
```

host timeが無効、sample rateが不正、timestampが後退、frame discontinuityが発生した場合は推定値で
継続しない。active holdを失敗させ、health/recoveryへ移る。

## 8. bounded ringとPTT gate

ringは押下前発話を受理するpre-rollではない。audio callback cadenceとNode admission round-tripを
吸収し、physical eventとbuffer境界を後から正確に切るためだけに使う。

状態は次とする。

- `discarding`: PTT外。固定上限ringより古いPCMを即時破棄し、sidecar外へ出さない
- `pending_admission`: physical press以後のsample候補を固定上限内に保持
- `accepting`: Node accepted generationへpress cutoff以後をdispatch
- `tailing`: physical release + 250 msまでacceptingを継続
- `suppressed`: cancel、TTS、echo boundary。ringとpending outputをclear
- `unavailable`: engine/device/clock failure。talkをreadyとして扱わない

admissionが500 ms以内に返らない場合は部分turnを開始せず、fixed
`admission_timeout`で失敗する。ringは192,000 source framesを上限とし、一般的なCore Audio
sample rateでtimeoutまでの候補を保持できる固定上限（PCM16 monoで最大384,000 bytes）とする。
Node側はcontrol resultのpipe writeを400 msでfail-closedにし、Swift timeoutより先にmanaged
child/runtime cleanupを開始する。遅延accepted resultをSwiftが受けた場合は、そのgenerationを
private IPCで明示的にinvalidateする。未収束sequenceは64件を上限とし、超過時はsidecarを停止する。
field measurement後、この上限を縮小できる場合は別の明示的な仕様変更として扱う。

release cutoffはSwift host clockで`physicalRelease + 250 ms`とする。cutoff以後のsampleは次turnへ
持ち越さない。cutoffまでのPCM dispatch後に`tail_complete`を送り、Nodeがtranscribingへ進む。
Node timerはmissing completionを検出するwatchdogであり、別のmedia cutoffを作らない。

F2 cancelはsidecar内のactive/pending PCMを先にclearし、Node generation cancellationと収束する。

## 9. TTSとecho boundary

最初のplayback provider dispatch前にNodeは`suppress_capture`を送り、Swiftのackを待つ。
sidecarはgateを閉じ、ring、pending admission、未送信PCMをclearする。再生中のtap PCMは固定上限
ringへも保持せず、内容を即時破棄してcountだけを加算する。

playback completionと既存half-duplex echo tail settlement後、Nodeは`resume_capture`を送る。
sidecarは再度ringをclearしてから`discarding`へ戻す。このack前のtalk pressはbusyとして扱い、
後からreplayしない。

## 10. healthとrecovery

health stateは`starting`、`running`、`recovering`、`suspended`、`unavailable`、`stopped`とする。

- microphone permission denied/restricted: actionable startup failure
- configured UID missing/input incapable: actionable startup failure
- `AVAudioEngineConfigurationChange`: active holdを失敗させ、notification callback外のserial ownerで
  同じprovider、同じUIDを再構築
- engine unexpectedly not running: health pollで検出し同じrecoveryへ移行
- configured device unplug: `unavailable`。同UIDだけをboundedに再探索
- sleep: `suspended`へ移行しpending PCMを破棄
- wake: device再解決、clock再較正、tap/converter再構築、engine start、valid callback確認
- bounded recovery failure: `fatal`を送ってsidecar終了

notification callback内でengineをdeallocateしない。recovery中のtalkはacceptedにせず、queueしない。
別device、FFmpeg、system default、ALSAへ自動fallbackしない。

## 11. observabilityとprivacy

必要なstage/eventは次とする。

- physical key eventからcontrol admission
- control admissionからPTT gate open
- gate openからfirst accepted sample timestamp
- first accepted sampleからfirst PCM dispatch
- physical releaseからtail complete
- AVAudioEngine start/restart
- buffer cadence、frame count、timestamp discontinuity
- dropped outside PTT/suppressed frame count
- device/permission/configuration/sleep/wake fixed health code

durationはmonotonic値だけを記録し、通常OTelへ次を出さない。

- PCMまたはcontent-derived特徴量
- transcript、prompt、completion、tool body
- session ID、generation ID、event sequence、physical key名
- device UIDまたはdevice名

通常OTelは既存Logs/Metrics契約を維持する。Tracesは追加しない。field validationのcontent evidenceは
既存private artifact境界だけを使う。

## 12. TDDと検証

### Swift deterministic tests

- press前sample不受理とbuffer途中の正確なsample cutoff
- admission前後の押下直後sample保持
- admission busy/timeout時の全破棄
- 250 ms release tailとcutoff後sample不受理
- cancel、TTS suppress/resumeのclear
- bounded ring overflowのfail-closed
- clock offset/residual、invalid/retrograde timestamp
- configuration change、engine stop、sleep/wake、device missing recovery state
- framed IPCのpartial read、oversize、unknown version/kind、ordered delivery

### Node tests

- control admission replyとgeneration binding
- busy talk拒否、F2 cancel、tail complete待機
- PCM generation mismatch/late frame suppression
- suppress/resume ack前のplayback/talk抑止
- sidecar fatal/completionとruntime shutdown convergence
- config migrationでAVFoundation positional inputを拒否

### verification ladder

1. Swift/Node focused tests、typecheck、lint、ast-grep
2. `just apple-speech-check`
3. resident input smokeとvoice provider preflight
4. strict pseudo-audio full turn
5. physical key/microphone field validation
6. code/config不変の3回以上のreal-provider run
7. `just check`
8. Secretlint、`git diff --check`

別checkoutのPicoを無断停止しない。マイク、port、lockを占有するfield validation前にprocessを確認し、
稼働中ならユーザーと調整する。

## 13. 受入条件

- F1直後のsampleをcallback cadence内で保持し、press前sampleを一つも受理しない
- PTT外PCMがsidecarから出ず、idle STT callが0
- 1 accepted activationが最大1 turnを作る
- busy talk、F2 cancel、250 ms tail、Pi session disposalが既存契約どおり
- TTS中/直後のPCMが次turnへ入らない
- configured Core Audio UID以外へ切り替わらない
- engine/device/clock failureが無言で継続せず、health eventまたはfatalへ収束する
- productionにFFmpeg fallback、mock/stub/fake provider pathを残さない
- focused gates、full gate、Secretlint、real-provider field validationの証拠が揃う
