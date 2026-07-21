# Resident TTS逐次合成・連続再生設計

## 目的

Resident voiceのモデル推論品質を変更せず、Pi応答確定後から最初の音声再生までの待ち時間を
短縮し、文境界で聞こえる切断音と無音をなくす。

2026-07-19の実機計測では、同じ2文のAivis Speech合成に次の時間を要した。

| 対象 | 合成時間 |
| --- | ---: |
| 第1文 | 0.93〜1.05秒 |
| 第2文 | 1.21〜1.27秒 |
| 現行の全文合成待ち | 2.20〜2.30秒（直接計測）、2.762秒（resident field計測） |

現行実装は、全ての文を直列に合成してから、文ごとに一時WAVファイルとplayback childを
作り直して再生する。この設計では第2文以降の合成時間が初回再生前に露出し、playback child
の境界が句読点の切断音と文間待ちの候補になる。

## 既存仕様との関係

この設計は、次の既存仕様のうちTTS resultとplayback providerに関する箇所だけを置き換える。

- `2026-06-18-voice-resident-runtime-design.md`の最終assistant text一括TTS、macOS `afplay`、
  Linux chunk単位`aplay`。
- `2026-07-17-hold-to-talk-resident-control-design.md`のchunk単位`play()`と
  `afplay`/`aplay` child ownership。

generation、cancel、late-result suppression、echo control、interaction session lifecycleは
既存仕様を維持する。

## 非目的

- Piが選択するLLM、モデルID、reasoning effort、プロンプト、tool-call判断を変更しない。
- Apple Speech STT、PTT release tail、interaction session lifecycleを変更しない。
- Aivis Speech Engine内の推論処理を改造しない。
- Aivis Cloud APIや別のTTS providerへの自動fallbackを追加しない。
- Piのtoken形式や特定モデル固有のstream eventへPicoを結合しない。

## 設計原則

### モデル非依存

Picoが受け取る境界は、Pi adapterが最終assistant messageとして確定した本文とする。上流モデルが
一括本文を返す場合も本文deltaを返す場合も、Pi adapterが同じ確定本文へ正規化する。モデル名、
provider名、token ID、reasoning item、tool-call内部表現を発話処理へ渡さない。

tool call前の暫定本文、tool callの引数・結果、reasoning textは発話しない。Pi adapterが
`willRetry === false`、`stopReason === "stop"`、queued messageなしを確認して公開したcanonical
final assistant本文だけを発話対象にできる。本文deltaから発話を先行開始する変更は本設計へ
含めない。Pi-level settlementは再生と並行できるが、resident turn、session dispose、次のfarewellは
再生とsettlementの両方が収束するまで完了しない。

モデル変更時の受け入れ条件は、Pi設定のモデル選択だけを変更してもTTS pipelineとplayback
実装が変わらないことである。

### Provider責務の分離

- Pi adapterはassistant本文を確定し、Picoへ渡す。
- utterance segmenterは本文を安定した発話単位へ分割する。
- TTS adapterは発話単位を順序どおりに音声chunkへ変換する。
- playback sinkは1 turnにつき1つの連続音声streamを所有する。
- resident controllerはgeneration、cancel、late-result suppression、状態遷移を所有する。

Aivis固有の`/audio_query`、`/synthesis`、speaker ID、voice parameter、WAV decodeはTTS
adapter内に閉じ込める。playback sinkとresident controllerはAivisを認識しない。

## 採用方式

### 発話単位

既存の日本語文境界分割を共通のincremental segmenterとして扱う。

1. `。！？.!?…`と対応する閉じ括弧までを確定発話として出力する。
2. 本文完了時に残余文字列を1つの発話としてflushする。
3. 句読点のない長文は120 Unicode code pointを上限とし、上限以前で最後に現れる
   `、,，;；:：`または空白を優先して分割する。候補がなければ120 code pointで分割する。
4. 空白だけの発話は生成しない。
5. Unicode code point境界を維持し、model token境界は使用しない。

この規則により、モデルが句読点を多用する場合、使わない場合、一括本文を返す場合、本文delta
を返す場合を同じ処理で扱う。

### 逐次合成と1-chunk先読み

TTS contractは全文完了後に`chunks[]`を返す形から、型付きの非同期event streamへ変更する。
`TtsSynthesisEvent`は`chunk`、`completed`、`failed`のdiscriminated unionとし、`failed`は既存の
reason、message、sentence index、sourceを保持する。部分成功後の失敗を例外文字列だけに
落とさない。

処理順は次のとおりとする。

1. 最初の発話単位をAivis Speechで合成する。
2. 最初のchunkが確定した時点でplayback sessionを開き、再生へ渡す。
3. 現在chunkをplaybackへ渡す前にevent iteratorの次の`next()`を開始し、現在chunkを再生して
   いる間に次の発話単位を合成する。
4. 合成済みchunkは最大1つだけ先読みし、無制限queueを作らない。
5. Aivisへの`/audio_query`と`/synthesis`は発話順に1組ずつ実行し、複数発話を同時に
   Aivisへ送らない。
6. 最後のchunkを渡した後にplayback入力を閉じ、実再生完了まで待つ。

この方式はAivis Speech Engineの1 request内streamingを仮定しない。短い発話単位ごとの完成
音声をPicoがpipeline化する。Aivis Speech Engineが一般的なPC上の単一利用を想定し、長文より
短い意味単位の合成を推奨している制約とも整合する。

### 連続再生

`VoicePlaybackSink`はchunkごとの`play()`から、turn単位のsession contractへ変更する。

- 最初のchunk formatで1つのplayback childを開始する。
- PCM16LEを同じstdinへ順序どおりに書き、backpressureを守る。
- 途中chunkのsample rate、channel数、encodingが最初と異なる場合は失敗させる。
- 入力完了後はstdinを閉じ、playback childのterminal completionまで待つ。
- cancelは現在のsessionだけを停止し、後続generationへ影響させない。
- shutdownはactive sessionをbounded terminationへ収束させる。

macOSのproduction providerは、文ごとにファイルとprocessを作る`afplay`から、raw PCMを1つの
stdinで受け取る`ffplay` providerへ置き換える。既存のmacOS captureが依存するFFmpeg配布物の
`ffplay`を使用し、startup readinessでcommand availabilityを検証する。
Linuxは`aplay`をturn単位で1回起動し、同じsession contractを実装する。provider間の自動
fallbackは持たない。

## 状態遷移

最初のTTS chunkが届くまでは`synthesizing`を維持する。最初のplayback dispatch直前に
`speaking`へ進み、後続発話の合成と再生は`speaking`内で重なる。

`speaking`は「全合成完了」を意味せず、「少なくとも1 chunkの再生を開始し、同じgenerationが
残りの合成と再生を所有している」状態とする。turn完了は、TTS event streamの正常完了と
playback sessionの正常完了の両方が成立した時だけ記録する。

## Cancelと失敗

- 最初のchunk前のcancelはTTS requestをabortし、playbackを開始しない。
- 再生開始後のcancelはTTSとplaybackを同じgeneration signalで停止し、echo controlをflush
  する。
- 後続発話の合成失敗時は、すでにplaybackへ渡した現在chunkだけをdrainして入力を閉じる。
  未投入chunkは破棄し、現在chunkを文の途中で切らずに部分発話失敗として記録する。
- 最初のchunkの合成失敗時は、現行どおり音声を一切再生しない。
- playback失敗時はTTS producerをabortし、後続chunkを生成し続けない。
- invalidated generationから遅着したchunk、process completion、TTS completionは状態を進めない。
- 部分発話失敗はcompleted turnへ数えず、resident process自体は継続する。

## Echo control

各chunkはplaybackへ渡す直前にfar-end referenceへ登録する。continuous playback session内の
offsetは、実際に渡したchunkの累積音声長から計算する。合成中の未再生chunkはfar-end
referenceへ登録しない。

cancelまたはplayback失敗時は、現行契約どおりplayback停止とecho flushを収束させる。

## Telemetry

`tts_request_wall`と`tts_playback`を維持する。2026-07-21のoperability修正により、旧
`ptt_release_to_playback_start`は`ptt_release_to_first_pcm_write`へ置き換える。

- `ptt_release_to_first_pcm_write`: PTT releaseから最初のplayback session write成功まで。
- `tts_request_wall`: 最初のTTS request開始からTTS event streamのterminal eventまで。
- `tts_playback`: 最初のplayback dispatchからplayback childのterminal completionまで。

診断可能性のため、次を追加する。

- `tts_time_to_first_chunk`: 最初のTTS request開始から最初の音声chunk確定まで。
- `tts_audio_query`: Aivis `/audio_query` 1回ごとのwall time。
- `tts_synthesize`: Aivis `/synthesis` 1回ごとのwall time。

各stageはstatus、duration、sentence index、chunk count、生成音声長、error codeのうち、そのstage
で確定できるallowlisted属性だけを記録する。本文、音声、speakerの個人情報、HTTP bodyはOTelへ
記録しない。field validationの明示的なprivate artifactだけがassistant本文を保持できる。

部分発話失敗は、`pico.voice.played_chunk_count`と`pico.voice.sentence_index`を数値属性として
識別できるようにする。

## 設定

- LLM model設定とreasoning effortは変更しない。
- Pi-level memory pluginの所有権、設定、capture処理は変更しない。
- Aivisの既定voice parameterは現行値を維持する。
- `speedScale`による再生時間短縮は本変更へ含めない。
- macOS continuous playback providerは設定で明示し、旧providerから暗黙移行しない。
- queue depth、並列度、文分割閾値を運用configへ露出しない。1-chunk先読みと安全上限を
  contractとして固定する。

## 代替案

### `afplay`を維持して先読みだけ行う

初回再生は短縮できるが、文ごとのprocess・一時WAV境界が残るため、切断音の是正にならない。
採用しない。

### Aivisへ複数文を並列送信する

合成完了は短縮できる可能性があるが、Aivis Speech Engineの単一利用前提と競合し、CPU・GPU
負荷と順序制御を複雑にする。再生中に次文の直列合成を隠せるため採用しない。

### native AVAudioEngine playback sidecarを追加する

長期的にはdevice recoveryや低遅延制御に優れるが、新しいnative audio ownershipと配布物が
必要になる。まず既存のFFmpeg依存でcontinuous PCM contractを検証し、実測で不足が残った場合の
明示的な次段階とする。

## テスト戦略

TDDで次の順に追加する。

1. Aivis TTSが第1文のchunkを第2文完了前に公開する。
2. Aivis requestは発話順に直列で、同時request数が1を超えない。
3. resident runtimeが第1chunk受領後にplaybackを開始し、再生中に第2文を合成する。
4. 1-chunkを超えて先読みしない。
5. 2文を1つのplayback childへ順序どおりに書く。
6. playback format不一致、stdin backpressure、spawn/error/exit/close、timeoutをterminal stateへ
   収束させる。
7. synthesizing中、speaking中、後続合成中のcancelがTTS、playback、echoを一度だけ停止する。
8. 後続合成失敗を部分発話失敗として記録し、completed turnへ数えない。
9. model IDやprovider名を変更したPi response fixtureでも、同じ本文から同じ発話順になる。
10. 句読点なし、閉じ括弧、空白、Unicode補助文字、残余本文を正しくflushする。
11. `tts_time_to_first_chunk`とAivis substage telemetryが本文や音声を含まない。

focused unit test後に`just check`を通し、実機では既存の疑似音声fixtureを注入して次を比較する。

- `ptt_release_to_first_pcm_write`の新しいbaselineを取得する。旧stageのbaselineとは直接比較しない。
- 第2文の合成が第1文のplayback期間内に重なる。
- 文境界で別playback childを生成しない。
- tool callと最終assistant本文が正しく、reasoning effortが`medium`のままである。
- cancel後にTTS request、playback child、session ownershipが残らない。

## 受け入れ条件

- モデル、reasoning effort、Pi tool-call判断を変更せず、初回playback dispatchをbaseline比で
  1秒以上短縮する。
- 1 turnの通常再生でplayback childを1つだけ所有する。
- 句読点境界でprocessを再生成しない。
- 後続合成は第1chunk再生と重なり、Aivis request自体は直列である。
- cancel、部分失敗、provider失敗、shutdownが既存generation契約内でterminal stateへ収束する。
- LLM model/providerの変更がTTS adapter、playback sink、resident controllerの変更を要求しない。
- private validation以外のtelemetryへ本文・tool body・音声を記録しない。

## 参照

- [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine):
  `/audio_query`、`/synthesis`、短い意味単位での合成、単一利用向けの制約。
- `docs/superpowers/research/2026-07-19-resident-voice-opentelemetry-validation.md`:
  resident field baseline。
