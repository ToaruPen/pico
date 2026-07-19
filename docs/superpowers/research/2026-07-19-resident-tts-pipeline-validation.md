# Resident TTS Pipeline Field Validation

## 結論

モデルと推論強度を変えずに、Pico側の初回音声生成待ちは短縮された。3回の実provider計測で
`tts_time_to_first_chunk`の中央値は937.540 msとなり、旧`tts_request_wall` baselineの
2,762.335 msから1,824.795 ms短い。`ptt_release_to_playback_start`の中央値も
12,792.912 msから10,714.631 msへ2,078.281 ms短縮し、設計上の1,000 ms改善条件を満たした。

各runは、既知の日本語transcript、指定toolの正確に1回の正常終了、最終assistant本文の存在、
1つのplayback process、全chunkの再生、telemetry health failure 0を同時に満たした。本文、
tool arguments/results、音声データはこの文書へ転載していない。

## 計測条件

- 実行日: 2026-07-19 UTC（Asia/Tokyoでは2026-07-20）
- branch: `codex/resident-latency-observability`
- model: `openai-codex/gpt-5.6-sol`
- thinking level: `medium`
- STT: 実Apple Speech sidecar
- agent/tool: 実Pi Agentと`stackchan_get_status`
- TTS: 実AivisSpeech Engine
- playback: Homebrew FFmpeg 8.1の実`ffplay`
- telemetry: in-process OpenTelemetry exporter
- microphone: 物理入力ではなく有限audio fixtureを注入

最終計測には、以前のbaseline計測と同じ7.043812秒のWAVを用いた。形式はPCM16LE、16 kHz、
mono、16 bit、サイズは225,480 bytes、SHA-256は
`58bf16c401321eb799d4d01dfc6ec5ea0261cbb520eab39da3e53835385a68e5`である。
3回ともApple Speechの認識結果はcanonicalな既知文のSHA-256と完全一致した。field harnessは
UTF-8の認識結果を内部でhash化して照合し、期待hashも実値もmetadata reportへ出力しない。

計画に例示されていた`/tmp/pico-known-ja.pcm`は、実際には状態確認用とは別の22文字fixtureだった。
そのままでは既知文との一致も指定toolの選択も成立しないため、成功データには採用していない。
正しいbaseline fixtureへ切り替えてから3回を取り直した。

## 実行方法

各runは次の形で個別に実行した。`N`は1から3である。

```bash
umask 077
npm run field:resident-voice-pseudo-audio -- \
  --audio-fixture /tmp/pico-otel-stackchan-check-20260719.wav \
  --validation-output /tmp/pico-tts-pipeline-final-v2.xls3fZ/events-N.jsonl \
  --required-tool-name stackchan_get_status \
  --expected-transcript-sha256 a4704845dc50a8c392ce82e6b9544e88f3a79b65543ed23320bfd147ae23d266 \
  --timeout-ms 120000
```

ユーザーのPi設定には、最終assistant本文をOSC 777 desktop notificationとしてstdoutへ送るPi-level
extensionがある。PicoはPi plugin設定を所有しないためextension自体は変更せず、field commandの
出力段でOSC notificationだけを除去した。保存した`report-N.txt`にOSC列や本文は残っていない。

## 内容とownershipの検証

3回すべてで次の条件が成立した。

- field statusは`passed`。
- `staff_transcript`は1件で、canonical fixtureの既知文と完全一致。
- `stackchan_get_status`のstart/endは同一tool-call IDで1組だけ存在。
- tool endは`isError: false`。
- 非空の最終`pi_response`が1件存在。
- accepted hold 1、completed turn 1、failed/cancelled/late turn 0。
- playback sinkの`open()`は1回だけ。
- `tts_request_wall`の`chunkCount`と`playedChunkCount`は各runで一致。
- OpenTelemetry Logs/Metricsのconsecutive failureは0。

chunk数はrun 1が2、run 2が2、run 3が3だった。すべてのchunkは同じ1つのplayback childへ書かれ、
句読点境界でprocessを作り直していない。

## 計測結果

単位はすべてmsである。

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| `stt` | 206.034 | 184.635 | 181.279 | 184.635 |
| `pi_session_resource_load` | 655.220 | 607.388 | 587.317 | 607.388 |
| `pi_tool_execution` | 64.575 | 47.617 | 53.977 | 53.977 |
| `pi_time_to_first_text` | 10,258.601 | 8,964.944 | 6,711.933 | 8,964.944 |
| `pi_turn` | 10,286.250 | 8,985.917 | 6,732.262 | 8,985.917 |
| `tts_time_to_first_chunk` | 937.540 | 1,279.820 | 583.664 | 937.540 |
| `tts_request_wall` | 2,251.733 | 2,573.632 | 2,750.371 | 2,573.632 |
| `ptt_release_to_playback_start` | 11,693.827 | 10,714.631 | 7,762.842 | 10,714.631 |
| `tts_playback` | 8,209.933 | 9,880.751 | 9,885.533 | 9,880.751 |
| `pi_session_dispose` | 11.137 | 9.734 | 9.525 | 9.734 |
| `interaction_end` | 12.440 | 10.794 | 10.540 | 10.794 |

run 1ではPi TTFTが10.259秒まで伸びたが、Picoのfirst-chunk待ちは0.938秒に収まった。モデル側の
揺れとPico側の短縮を同じ原因として扱うことはできない。中央値ではPi TTFTが8.965秒、Pico
first-chunkが0.938秒だった。

全文合成の完了は、各runでplayback開始後も続いた。`tts_request_wall`からfirst-chunk時間を引いた
後続合成時間はrun 1で1,314.193 ms、run 2で1,293.812 ms、run 3で2,166.707 msである。一方、
playback wall timeはそれぞれ8.210秒、9.881秒、9.886秒だった。後続文の合成は第1chunk再生中に
収まり、Aivis requestの直列性と1-chunk lookaheadはunit testで別途固定されている。

## Baseline比較

| 指標 | Baseline | Candidate median | 短縮量 |
|---|---:|---:|---:|
| TTS初回待ち | 2,762.335 | 937.540 | 1,824.795 |
| PTT releaseからplayback開始 | 12,792.912 | 10,714.631 | 2,078.281 |
| Pi TTFT | 9,442.902 | 8,964.944 | 477.958 |

TTS比較では、baselineの全文`tts_request_wall`とcandidateの`tts_time_to_first_chunk`を比較している。
これは今回の利用者体感に対応する主指標であり、全文合成コストが消えたという意味ではない。
candidateの全文`tts_request_wall`中央値は2,573.632 msで、後続chunkの合成は再生と重なっている。

release-to-playbackは16.2%、TTS初回待ちは66.1%短縮した。モデルとthinking levelは全runで不変で
あり、Piのtool-call判断も維持している。したがって、今回の短縮は推論量の削減ではなく、文単位の
逐次合成とcontinuous playbackへ待ち時間の配置を変えた結果である。

## 診断で検出した問題

最初の診断runは成功扱いにしなかった。そこで二つの問題が明確になった。

1. 例示fixtureがcanonicalな状態確認音声と異なり、指定tool条件を満たさなかった。
2. FFmpeg 8.1の`ffplay`はraw PCM入力で`-ac`を受け付けず、playback childが即時終了した。

`ffplay -h full`と無音stdinによる再現では、sample rateに`-ar`、channel layoutに
`-ch_layout Nc`を使う組み合わせがmono、stereo、1 channel、6 channelsでexit 0となった。
playback引数をTDDで修正し、focused 50 testsと全gateを通した後に最終3runを実施している。
field harnessの厳格な`passed`判定により、この不完全な診断runは偽陽性にならなかった。

## Private artifact

最終証拠は`/tmp/pico-tts-pipeline-final-v2.xls3fZ`に保存した。directory modeは`0700`、
`events-*.jsonl`、`report-*.txt`、`stderr-*.txt`はすべて`0600`である。

`events-*.jsonl`だけがtranscript、最終assistant本文、tool arguments/resultsを保持する。
`report-*.txt`はstage、件数、duration、model設定、healthだけを保持し、OSC notificationは除去済みで
ある。通常のauditとOpenTelemetryにも本文、tool body、audio、session identifierは含まれない。

## 残る検証範囲

3runは中央値を示すには足りるが、p95や長時間運用の分散を評価する件数ではない。run 1のPi TTFTは
10.259秒まで伸びており、推論側の揺れは残る。Picoのfirst-chunk短縮とは切り分けて、将来は同一
fixtureの反復数を増やす必要がある。

今回のtelemetryはin-process exporterで確認したため、外部OTLP Collectorまでのnetwork deliveryは
未検証である。また有限fixtureはAVFoundationの実microphone startup、利用者のhold時間、部屋の反響を
含まない。continuous playbackにより句読点ごとのprocess再生成は消えたが、実環境でのクリック音の
最終判定は物理speakerと人の聴取で行う。

## 参照

- `docs/superpowers/specs/2026-07-19-resident-tts-pipeline-design.md`
- `docs/superpowers/research/2026-07-19-resident-voice-opentelemetry-validation.md`
- FFmpeg 8.1 local `ffplay -h full`
- <https://ffmpeg.org/ffmpeg-all.html>
