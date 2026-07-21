# resident Apple Speech streaming設計

**日付:** 2026-07-20
**状態:** 実装済み、exclusive field validation待ち

## 目的

macOS resident voiceで、PTT中のaccepted PCMをNodeメモリへ全量保持してからApple
Speechへbatch送信する経路を廃止する。1 activation = 1 turnを維持したまま、同じ
`SpeechAnalyzer`セッションへPCMを連続投入し、2分を超える発話も音声長に比例する
PCMメモリ増加や4 MiB request上限なしで扱う。

この設計は、すでに承認済みの「AVAudioEngineはPico稼働中running、PTTはsample
admission境界だけを切り替える」設計を置き換えない。その下流のSTT搬送と
`SpeechAnalyzer`入力をstreaming化する。

## 背景と確認済み事実

- PR #102は`e2d2163`として`main`へsquash merge済みで、この作業ブランチの基点と
  一致する。#102のturn phaseとterminal telemetry収束を維持する。
- 現WIPはmacOS captureを常時runningのAVAudioEngine sidecarへ移行しているが、
  `voice-resident.ts`はaccepted frameを配列へ蓄積し、release後に連結している。
- Apple Speech sidecarのbatch wire contractはdecoded PCMを4 MiBに制限する。16 kHz、
  mono、PCM16LEでは約131秒である。
- Appleの`SpeechAnalyzer`は、同一セッションへ音声bufferを到着順に追加でき、final
  resultは後続文脈を反映する。Kanary 2.4.2も、bounded `LiveAudioChunkStream`から
  1つのSpeechAnalyzerへ連続投入し、drop数とfinalize回復を観測する構造を持つ。この
  Kanary観測は設計上の参考情報であり、Picoのwire contractの根拠にはしない。
- FlyingFox 0.27の通常HTTP handler timeoutはhandler全体へ適用される。一方、
  WebSocket upgrade後のframe処理はHTTP handler timeoutの外にある。これは0.27.0の
  `HTTPServer.handleRequest`がhandlerだけをtimeoutで包み、返却後に
  `HTTPConnection.sendResponse` / `switchToWebSocket`が`WSHandler.makeFrames`を開始する
  実装で確認した。route testでもHTTP timeoutを超える接続維持を固定する。

## 採用案

Apple Speech sidecarにloopback WebSocket endpointを追加し、resident productionは
1 PTTにつき1 WebSocket/1 SpeechAnalyzerを使用する。

```text
physical F1
  -> native admission
  -> accepted PCM frame
  -> bounded Node frame channel
  -> echo/VAD observation
  -> bounded WebSocket send
  -> bounded Swift AnalyzerInput channel
  -> one SpeechAnalyzer session
  -> release + native 250 ms tail
  -> finish
  -> final results only
  -> Pi turn
```

batch `/v1/transcriptions`はwarmup、provider smoke、有限fixture検証のために残す。
resident productionがstreaming失敗時にbatchへ切り替えるfallbackは設けない。

## 比較した案

### A. WebSocket streaming endpoint（採用）

- 長い入力中にHTTP handler全体のtimeoutを消費しない。
- binary frameでbase64膨張を避けられる。
- start、PCM、finish、terminal result、cancelを1接続で順序づけられる。
- Node 24の標準WebSocketと既存FlyingFoxで実装でき、新依存を増やさない。

### B. chunked HTTP request

PCMをincrementalに読めるが、FlyingFoxのhandler timeoutがPTT時間全体へ適用される。
長時間用に巨大なtimeoutまたは新しいmax hold設定が必要となり、finalization timeoutと
入力継続時間を正しく分離できないため採用しない。

### C. SpeechAnalyzerをmacOS resident I/O sidecarへ統合

captureからASRまでのhopは減るが、`TOOLS.md`の「Apple Speechはloopback Swift
sidecar」というprovider境界を壊し、capture/keyboard healthとSTT lifecycleを1つの
ownerへ集中させる。既存smokeとprovider isolationも失うため採用しない。

## Streaming wire contract

endpointは`GET /v1/transcription-stream`で、WebSocket subprotocolやqueryへ機密値を
載せない。client messageは次の順序だけを受理する。

1. strict JSON text `start`
2. 1個以上のbinary PCM frame
3. strict JSON text `finish`

`start`のexact field setは`type`、`version`、`provider`、`language`、`timeoutMs`、
`encoding`、`sampleRateHz`、`channels`とする。値はversion 1、`apple-speech`、`ja-JP`、
PCM16LE、16 kHz、monoに固定し、`timeoutMs`は正の有限整数とする。serverはadmissionと
bounded analyzer inputを確保した後、`{"type":"ready","version":1,
"provider":"apple-speech"}`を返す。clientは`ready`前にPCMをpipelineせず、serverも
`ready`前のbinaryをprotocol errorとして拒否する。

binary frameはnon-empty、偶数byte、64 KiB以下とする。total PCM byte数には4 MiB
上限を置かず、`Int64`でoverflowを検査する。`finish`後はbinaryを受理しない。
`finish`のexact field setは`type`だけとする。server terminalは次のどちらかを1回だけ
返してnormal closeする。

- `completed`: exact field setは`type`、`provider`、`result`。`result`はbatchと同じ
  `text`、`language`、`confidence`、`durationMs`、`segments`を持つ。
- `failed`: exact field setは`type`、`provider`、`error`。`error`は`code`と固定message
  だけを持つ。codeは`invalid_request`、`busy`、`input_overflow`、`timeout`、
  `model_load`、`backend_error`のいずれかとする。

unknown field、順序違反、duplicate start/finish、oversized/odd PCM、input overflowは
固定error codeでfail-closeする。server busy時も接続内で明示的に失敗し、別providerや
batch routeへ切り替えない。binaryを1個もwriteしなかったturnは`finish`せず、clientが
normal closeしてcancelする。clientの`finish`前closeはprovider failureではなく
cancelとして扱う。

## Admission ownership

Apple Speech sidecarはbatchとstreamで1個の`TranscriptionAdmission` actorを共有する。
batchはoperationの開始から終了まで、streamは`start`受理からterminal teardownまで
leaseを保持する。streamはlease取得後にだけ`ready`を返す。busyは明示的に失敗し、
待機queueを作らない。

現行`SidecarHTTPHandler`内のprivate admissionと`AppleSpeechEngine.requestInFlight`は、
この共有ownerへ統合する。routeごとまたはengine methodごとの二重guardを残さない。
leaseはterminal success、protocol failure、disconnect、timeout、sidecar shutdownの
全経路で同じteardown ownerが1回だけreleaseする。

## Memory and backpressure contract

- Nodeはnative 10 ms frameを到着順に3,200 byte（100 ms）へcoalesceしてbinary messageを
  作る。release時の端数は偶数byteのままflushし、messageは64 KiBを超えない。
- Swiftは`Data`を保持する専用actor channelを使い、未消費PCMを8 MiB以下へ固定する。
  `send`は追加後ではなく追加前にbyte上限を検査し、収まらなければaccepted PCMを1 byteも
  dropして成功扱いにせず、`input_overflow`でturn全体をfail-closeする。
- Swiftのchannelから取り出した`Data`は、`analyzeSequence`へyieldする直前の同一isolation
  domainで`AVAudioPCMBuffer` / `AnalyzerInput`へ変換する。chunkごとの
  `@unchecked Sendable` wrapperは作らない。
- Nodeのnative PCM待ちを128 frameに固定する。満杯時は
  `resident_pcm_backlog`でcapture、同generationのSTT stream、turnをfail-closeする。
  これは10 ms cadenceで1.28秒の接続/ready headroomである。talk admission直後にSTT
  connectionを開始するが、`ready`まではnative channelからpullしない。ready前sampleの
  唯一の滞留場所はこのchannelとし、Node coalescerやWebSocketへ移さない。1秒の
  connect/ready timeoutを先に発火させ、万一128 frameへ達した場合はbacklogを優先して
  fail-closeする。
- Node WebSocketの`bufferedAmount`は真のflow controlとはみなさない。256 KiBをsecondary
  high-water markとし、10 ms間隔で最大1秒だけpollする。close、caller abort、deadlineを
  検知し、解消しなければfail-closeする。WHATWG WebSocketにdrain eventがないため、
  TCPまたは`bufferedAmount`だけへboundednessを委ねない。
- SwiftはFlyingFoxのunboundedなmessage変換streamを使わず、low-level `WSHandler`で
  `AsyncThrowingStream<WSFrame>`を直接かつ逐次consumeする。fragmented text/binary、
  ping/pong、closeを明示的なbounded assemblerで扱い、terminal後は入力を読み続けず
  connectionを即時closeする。これによりsocket readを専用byte channelより先へ無制限に
  進めない。
- PTT外とTTS suppression中のPCMは引き続きSwiftで破棄し、Node、STT、file、log、
  OTelへ送らない。
- accepted PCMもfileへ保存しない。PCM content、transcript、session identifierを通常
  OTelへ記録しない。

## Runtime lifecycle

`VoiceResidentRuntime`はresident用のstreaming STT clientを要求する。

- `talk_pressed` accepted時にcaptureとSTT streamを同じgenerationへbindする。
- STT connection/`ready`には独立した1秒timeoutを適用し、talk admission直後に接続を
  開始する。native frame consumerとcoalescerは`ready`後にだけ起動し、それ以前のframeは
  128 frame native channelにだけ保持する。Node WebSocketは`binaryType = "arraybuffer"`を
  明示する。
- 各accepted frameを既存順序のecho control、speech activityへ通す。echo actionが
  `suppress`でない場合だけ`echo.frame.audio`を同じstreamへ1回writeする。VADは判定だけに
  使い、先頭audioをtrimしない。全frameがecho suppressionされたturnはzero-frame cancel
  とする。
- native `tail_complete`までstreamを閉じない。
- speechがなければstreamをcancelし、final transcriptをturnへ採用しない。
- speechがあれば`finish`し、final resultだけを待つ。volatile transcriptはNode、Pi、
  log、OTelへ出さない。
- F2、shutdown、health invalidation、generation mismatchではcaptureとSTT streamを
  closeしてcancelする。native `resident_pcm_backlog`もstream cancelとgeneration
  invalidationへ伝播させる。late terminal resultは既存generation guardで抑止する。
- `stt` stageはrelease/tail完了からfinal resultまでを測る。utterance durationと固定
  error code以外のcontentを観測へ追加しない。

## Apple Speech engine contract

streaming pathもbatch pathと同じ`SpeechTranscriber`設定とmodel retentionを使う。
`reportingOptions`は空のままにし、final resultだけを収集する。入力chunkを1つずつ
PCM bufferへ変換し、同一`analyzeSequence`へyieldする。finish時だけ
`finalizeAndFinish`を呼ぶ。batch warmupとstreamingは同じtranscriber構成と
`.processLifetime` model retentionを使うため、resident起動時のbatch warmupがstreaming
sessionにも効くことをfixture/field validationで確認する。

finalization timeoutは入力継続中には開始しない。serverが`finish` messageを受理した
時点で開始し、input channel drain、`finalizeAndFinish`、final result consumerの完了を
一体で覆う。値は`min(start.timeoutMs, analysisTimeoutMilliseconds)`とする。

`finish`前は連続10秒client messageがなければ`timeout`でfail-closeする。このinactivity
timeoutはPTT総時間を制限せず、2分超でもPCMが継続するturnには発火しない。専用input
readerはstart前、PCM中、finish後のfinalization中もconnection EOF/throwを監視する。
inactivity timerをresetするのはvalid `start`、binary PCM、`finish`だけとし、ping/pongは
接続livenessに応答してもtimerをresetしない。
disconnect、caller cancel、sidecar shutdown、finalization timeoutは1つのsession
supervisorへ集約し、`cancelAndFinishNow`とresult consumer cancelを必ず1回実行する。
enclosing taskがcancel済みでもteardownを省略しないcancellation-safeなcleanup taskを
使い、active session registryをsidecar shutdownから明示的にcancelする。

## Tests

### Swift

- strict start/finish/terminal codec
- fragmented text/binaryのbounded再構成とmessage単位の順序state
- multiple PCM chunksが1つのanalyzer sequenceへ同順序で入る
- total 4 MiB超を全量保持せず受理する
- odd、empty、oversized PCM拒否
- input queue overflowはsilent dropせずterminal failure
- overflowしたsendと`completed`が同一sessionで共存しない
- finish後finalize、cancel時`cancelAndFinishNow`
- busy、finish前disconnect、finalization中disconnect、sidecar shutdown、duplicate
  terminalの収束
- HTTP handler timeoutを超えて入力が継続し、finish後timeoutだけがfinalizationを制限
- 10秒inactivity timeoutはwedgeを解放するが、継続PCMの2分超turnは解放しない
- ping/pongだけではpre-finish inactivity timeoutをresetしない

### Node

- WebSocket start/ready/write/finish/result mappingとready前write拒否
- ready前frameはnative channelだけに滞留し、ready後に100 ms coalescingを開始する
- 100 ms coalescing、端数flush、high-water poll/deadline、close code、connect/ready timeout、
  caller abort
- productionはstreaming failureからbatchへfallbackしない
- native PCM channelの128 frame上限とbacklog時stream cancel/generation invalidation
- PTT中にframeを逐次STTへ渡し、release前に全量配列へ保持しない
- native tail完了前にfinishしない
- no-speech、全echo suppression、F2、health invalidation、shutdownでcancel
- 4 MiBを超えるdeterministic frame列が1turnとして完了する
- generation mismatchとlate resultを不受理

## Field validation

exclusive microphoneが使えるまでは実マイクPASSを主張しない。実行可能な環境では、
Apple Speech/AivisSpeech preflightと、固定fixtureによるbatch/stream final transcriptの
比較を先に行う。次に2分超fixtureまたは実発話で、PCM byte数ではなくduration、
finalization latency、queue high-water、overflow countだけを保持する。

## Non-goals

- Kanaryの録音保存、speaker capture、用語集補正、要約をこのPRへ入れない。
- volatile transcriptをPiへ途中送信しない。
- streaming失敗時のbatch、Whisper、cloud fallbackを作らない。
- macOS以外のALSA capture contractを変更しない。
- #102のterminal表示を再設計しない。
