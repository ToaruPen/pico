# Irodori VoiceDesign 運用品質調査

## 結論

現行構成は、常駐モデルと SSH ローカルフォワードを維持したまま運用できる。Pico の推奨値は
`provider=irodori`、`style=calm`、`numSteps=30`、`seed=42`、
アプリケーション合成 timeout なしである。中断は caller の `AbortSignal` だけで扱う。
context KV cache は有効、compile は無効のままとする。

速度だけを見れば `num_steps=20` は有利だった。しかし同一 seed の PCM は 30 steps と
異なり、blind listening と検証済み speaker-similarity gate を完了していない。品質同等性を
証明できないため採用しない。Cloudflare、キャッシュ、queue、streaming、HTTP keepalive
設定にも、現行構成を変更するだけの改善根拠は得られなかった。

Pico の resident LaunchAgent `dev.toarupen.pico.resident-voice` は全工程で停止したままである。
Windows の Scheduled Task は cold/direct 計測時だけ境界付きで停止し、終了後に health と
smoke synthesis まで復元した。

## 実機とバージョン

本番 Windows runtime は次の組み合わせだった。

| 項目 | 実測値 |
| --- | --- |
| Irodori-TTS source | `eaf74d6a19138f743acb5b71a445fd25a57db987` |
| infra source | `672565a959beba02d9cd5aa71c5a5f40b3fa4992` |
| model | `Aratako/Irodori-TTS-600M-v3-VoiceDesign` |
| model revision | `e863a3a93e652e09afeff3e84823a206a0a60314` |
| profile ID | `f0a618870c60d9ee4348449a48a39b12417da141259b5e83472ee13732251842` |
| OS / GPU | Windows 10.0.26200 / RTX 4070 12 GB |
| Python / PyTorch / CUDA | 3.11.15 / 2.10.0+cu128 / 12.8 |
| precision | model bf16 / codec fp32 |
| runtime | sequential decode / KV cache on / compile off |

Windows の Irodori-TTS source は調査時点の official main と一致した。macOS の
`/Users/monsoon/Dev/PoC/irodori-tts` は古く、未追跡 benchmark もあるが、本番実行元では
ないため更新していない。infra は local `main`/`origin/main` と一致し、Windows 上の4つの
core file hash も local worktree と一致した。

Pico は `origin/main` より1 commit 古い。差分は Terminal.app の開き方に関する変更で、
VoiceDesign の検証結果へ影響しない。未コミットの provider 作業を保護するため pull して
いない。今回の目的に必要な main 更新はない。

model checkpoint、speaker manifest、選択 embedding は SHA-256 まで profile に固定した。
raw embedding、発話本文、秘密値は共有用 metadata に含めていない。

## 入力契約

公開 API は Pydantic の strict contract で extra field を拒否する。任意 caption を受け取る
API ではなく、`style` を4つの固定 caption に写像する API である。`neutral`、`calm`、
`cheerful` は対応 caption を direct runtime へ渡した結果と公開 API の WAV が一致した。
`clear` は公開 API 内の同一条件反復だけを bit-exact と確認した。

| 意図・field | 公開 API | direct runtime | 判定 |
| --- | --- | --- | --- |
| `caption` | 422 | preset caption で差分を再現 | 公開 unsupported / direct effective |
| `voice_description` | 422 | 独立 field なし | unsupported |
| `style` | 4値を固定 caption へ写像 | caption として消費 | effective |
| emoji annotation | 独立 field なし | 本文中の絵文字で変化 | model effective / Pico production pending |
| `emotion` | 422 | 独立 field なし | unsupported |
| `speed` | 422 | 独立 field なし | unsupported |
| pace caption | field なし | slow 5.80 s / neutral 5.24 s / fast 5.04 s | effective |
| `seed` | direct request へ伝播 | 同一条件で bit-exact | effective |
| `num_steps` | accepted | 20/30/40 で wall と PCM が変化 | effective |
| `duration_scale` | accepted | 0.8/1.0/1.2 で 4.16/5.20/6.24 s | effective |
| CFG 3種 | accepted | upstream request へ伝播 | behavioral effect undetermined |
| schedule / sway | accepted | upstream request へ伝播 | behavioral effect undetermined |
| caller `ref_embed` | 422 | frozen embedding が必須 | 公開 unsupported |

`neutral` と whitespace caption は同一 seed で bit-exact だった。caption の default tokenizer
上限は 512 token、本文は 256 token だったが、skill はこれを caller の自由作文枠にはしない。
各 field の詳細は実測 artifact の `input-contract.csv` に残した。

公式 VoiceDesign モデルは、caption に加えて本文中の絵文字 annotation をサポートする。
`🫶`、`😊`、`📖`、`⏸️` を prefix/suffix に挿入した隔離評価では、全条件が同一条件反復で
bit-exact かつ無 annotation とは異なる WAV になった。特に pause は音声長を
prefix で9.2%、suffixで18.5%増やし、active speech ratioを4.4/7.7 point下げた。
一方、音響特徴だけでは gentle/joyful/narration の意味的正しさを証明できない。matched-pair
listening と Pico の適用経路が未承認なので、production annotation allowlist は空とする。

## 固定評価セット

評価セットは短い挨拶、石垣市の天気回答、寿限無程度の長文、施設案内、表現比較文の5種で
固定した。表現比較では `neutral`、`calm`、`cheerful`、`clear` に加え、direct runtime
だけで slow/fast pace caption を評価した。

発話本文と WAV は owner-only の private directory に保存し、共有側には text hash、PCM/WAV
hash、scalar/byte length、音声形式、長さ、silence ratio、clipping fraction だけを残した。
同一 text/style/seed の warm repetition は全 fixture で 10/10 bit-exact、style panel でも
各10/10 bit-exact だった。

## 性能ベースライン

### warm loopback

| Fixture | 音声長 | TTFA median | wall median | RTF median |
| --- | ---: | ---: | ---: | ---: |
| 短い挨拶 | 3.64 s | 1.085 s | 1.086 s | 0.298 |
| 石垣市の天気 | 20.24 s | 1.503 s | 1.508 s | 0.074 |
| 寿限無程度 | 24.60 s | 2.861 s | 2.867 s | 0.117 |
| 施設案内 | 15.96 s | 1.340 s | 1.347 s | 0.084 |

公開 endpoint は handshake を先に返すが、現在の実装は同期合成後に完全な WAV を送る。
ここでの TTFA は progressive generation の開始時間ではなく、最初の PCM を受信できた時刻で
ある。

### SSH transport

ABBA block の paired median では、TTFA 上乗せは23.160–29.144 msだった。完全な WAV の
転送上乗せは短文55.118 ms、天気158.333 ms、長文221.005 msで、payload 長に応じて増えた。
合成時間に対して transport が支配的ではなく、30連続実行でも失敗は0件だった。このため
Cloudflare は比較していない。

Python の persistent connection を5秒超 idle にした実験では、Uvicorn の既定 keep-alive
window をまたいだ stale connection failure を1件再現した。fresh connection の ABBA
系列は安定しており、service health も継続していた。server 設定変更ではなく client 側の
再接続で扱えるため、keepalive 変更は採用しない。

### 安定性と同時実行

F2 の tunnel 30連続実行は、TTFA median 1.506 s、p95 1.893 s、wall median 1.663 s、
p95 2.052 s、RTF median 0.0822、p95 0.1014だった。失敗は0件、WAV hash は1種類である。

pipeline capacity は1で、acquire timeout は未設定である。concurrency 2 の wave median は
3.115 s、concurrency 4 は6.063 s、concurrency 4 の request wall p95 は6.175 sだった。
全60 request は成功したが、実装は並列合成ではなく無制限待ちの直列 queue である。

### cold と resource

process/model-cold 5 cycle の readiness は33.216–46.032 s、median 33.915 sだった。
readiness 後の最初の短文 TTFA median は1.154 s、direct runtime の model load は16.929 s
である。毎リクエスト cold load は運用要件に合わないため、model residency を維持する。

20連続 F2 中の resource median は、system CPU 18.07%、service CPU 7.75%、service working
set 1080.8 MiB、service private commit 13013.0 MiB、GPU utilization 63%、GPU power
136.75 Wだった。GPU physical used は11449/12282 MiBで、他プロセスも含む。Windows GPU
process counter では service dedicated allocation 8565 MiB を観測したが、physical total と
同じ意味の値として足し合わせない。

## 最適化判断

| 候補 | 実測 | 採否 |
| --- | --- | --- |
| steps 20 | F2 median 1.116 s、PCM変化 | 品質同等性未証明で棄却 |
| steps 30 | F2 median 1.458 s | 維持 |
| steps 40 | F2 median 1.814 s | 速度上の利点なし |
| model residency | cold median 33.915 s | 維持 |
| context KV cache | on 1.467 s / off 1.646 s | on を維持 |
| compile | Tritonなし、native Windows CUDA supportを確立できず | 未実行・棄却 |
| progressive streaming | 現行は完全 WAV 後送信 | 変更根拠なし |
| queue | capacity 1、concurrency 4のwall p95 6.175 s | timeoutを設けず直列化を既知限界として保持 |
| HTTP keepalive | fresh接続安定、stale再利用だけ失敗 | infra変更なし |
| Cloudflare | SSH TTFA上乗せ約23–29 ms | 比較不要 |

音質を落とさないという条件は、速度向上だけでは満たせない。比較 WAV と metadata は残したが、
今回の実行者は聴取判断を代行できない。steps 20、compile、分割方式を採用するには、固定
speaker/text/seed の blind paired listening と、必要なら検証済み speaker similarity
extractor を追加した同一 benchmark の再実行が必要である。

## Codex skill

canonical source は
`/Users/monsoon/Dev/dotfiles/home/.codex/skills/irodori-voicedesign-speech-plan` である。
`~/.codex/skills` には canonical への symlink だけを置き、重複コピーは作っていない。

skill は exact profile、target、preset、annotation ID の4 fieldだけを受け取る。
既定targetは `pico_resident_hook`、既定presetは `neutral`、annotation未指定は空配列である。
resident hookは `v/style/annotations` の3 fieldだけ、公開targetは4つの `style` patchだけ、
direct targetは検証済み6 presetのcaption patchだけを返す。captionは96 scalar /
384 UTF-8 byteを上限とする。unknown field、free-form caption、voice description、
emotion、speed、profile mismatch、target境界違反、未承認annotationをfail-fastする。
Aivisや別modelへの自動fallbackはない。

`skill-creator` の具体例、resource 選定、初期化、実装、quick validation、実利用、反復の順を
守った。normalizerの10 test、system quick validator、hook `calm`、公開 `clear`、
direct `calm_slow` の実利用を通した。独立 skill eval はfresh executorによる
median/edgeを2回、holdoutを1回実行し、全5 runで100%、contract violation 0だった。

## Resident hook

Pi 0.80.6のextension lifecycleで実装できるため、Pi本体の更新や第三者voice pluginは不要で
ある。`before_agent_start`でresident限定のnonce付き指示を追加し、`message_end`で
hidden speech-plan suffixをstrip/validate/cacheする。再生へのcommit pointは既存
`agent_end`のcanonical-final publish gateだけである。assistant timestampとclean text
SHA-256が一致するone-shot planだけを消費し、`agent_settled`はcleanupだけを行う。

研究・文書作成を含む最終回答も同じpublish gateを通るので、別の「文書完了後annotation」
hookは不要である。reader-facing本文、Pi履歴、生成ファイルにはsuffixを残さない。speech plan
はIrodori選択時だけ有効化し、Aivisへ渡された場合はfail-fastする。

## Picoへ渡す契約

Pico の request body は次の5 fieldに固定する。

```json
{
  "text": "<sentence>",
  "speaker": "<configured speaker>",
  "style": "calm",
  "num_steps": 30,
  "seed": 42
}
```

`localBaseUrl` は SSH tunnel の `http://127.0.0.1:18923` とし、sentenceごとの
アプリケーションtimeoutは設定しない。caller cancellationだけを伝播する。caption、
voice description、emotion、speed、duration scale、CFG、schedule、caller ref embeddingは
Pico v1の契約へ加えない。公開styleは
`neutral|calm|cheerful|clear` の明示値だけを許す。

Pico sourceではIrodoriのhealth/synthesis timeout設定を撤去し、caller signalだけを使う。
また、resident hookのbounded plan、canonical-final相関、request単位styleの伝播、
Aivis fail-fastを追加した。`duration_scale` は有効と判明したが、話速UIとしての意味・
範囲・品質gateを別途設計するまで公開しない。

切替は YAML の `voice.tts.provider` を明示的に変更する。Irodori を使う場合は `irodori`
block、rollback では `aivis-speech` と既存 `aivis` block を選ぶ。runtime の health failure
から自動で別 provider へ切り替える path は作らない。

## 成果物

- machine-readable summary:
  `.codex/artifacts/irodori-voicedesign-operational-20260728-074810-JST/summary.json`
- field contract:
  `.codex/artifacts/irodori-voicedesign-operational-20260728-074810-JST/input-contract.csv`
- sanitized run report:
  `.codex/artifacts/irodori-voicedesign-operational-20260728-074810-JST/report.md`
- hook/annotation follow-up:
  `.codex/artifacts/irodori-voicedesign-hook-20260729-073956-JST/report.md`
- benchmark harness:
  `.codex/benchmarks/voicedesign_operational/`
- canonical skill:
  `/Users/monsoon/Dev/dotfiles/home/.codex/skills/irodori-voicedesign-speech-plan/`

raw fixture text と WAV は private artifact のまま保管する。公開用 report には本文を複製しない。
