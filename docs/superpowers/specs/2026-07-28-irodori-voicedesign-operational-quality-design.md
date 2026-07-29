# Irodori VoiceDesign 運用品質設計

**Status:** Approved for implementation on 2026-07-28

## 問題

Pico は現在、Windows 上の
`Aratako/Irodori-TTS-600M-v3-VoiceDesign` を SSH ローカルフォワード経由で利用している。
サービスは稼働しており、短文と長文の過去計測も残っている。しかし、既存結果は現在の
公開 API、transport、cold start、同時実行、資源使用量、任意 caption の意味効果を一つの
不変な条件で測った baseline ではない。

ここで必要なのは、速そうな設定を先に試すことではない。まず、公開 API が受理する値と
モデルが実際に消費する値を分け、同じ fixture と seed で再現できる基準を凍結する。その
基準を越えた改善だけを Pico の推奨値へ採用する。

## 決定

評価は二層に分ける。

1. 公開 API 層は、稼働中の FastAPI を Windows loopback と macOS の SSH tunnel から
   黒箱評価する。validation、固定 style mapping、HTTP/WAV framing、queue、transport
   上乗せ、caller cancellation と connection reuse をここで測る。
2. direct runtime 層は、別の停止枠で Windows Scheduled Task
   `Pico-Irodori-TTS-8924` だけを停止し、同じ production source、checkpoint、
   speaker embedding、runtime flags を使う非 HTTP harness とする。任意 caption と
   runtime-only control はここで測る。

Pico の `dev.toarupen.pico.resident-voice` は両層で起動しない。稼働中サービスと direct
runtime を同時に GPU へ載せず、検証用 HTTP endpoint も追加しない。Aivis は明示的な
切り戻し先として残すが、自動 fallback は設けない。

公開 API だけでは、未知 field の拒否とモデル非対応を区別できない。反対に、direct
runtime だけでは Pico が実際に受ける queue や tunnel の挙動が分からない。二層を
混ぜずに残すことで、この二つを別々に説明できる。

## 評価対象の境界

| 入力・機能 | 公開 API | direct runtime | 初期分類と判定方法 |
| --- | --- | --- | --- |
| `text` | 受理、非空 | 受理 | 両層で同一 fixture を比較する |
| `speaker` | portable ID を受理 | 対応する `ref_embed` | 公開解決後の embedding hash を一致させる |
| `ref_embed` | route が 422 で拒否 | 受理 | 公開では unsupported、direct では効果候補 |
| `style` | 4 値だけを受理 | 正確な mapped caption | 同一 text/seed で両層を比較する |
| 任意 `caption` | unknown field として拒否 | 受理 | direct の固定 seed panel で effective/ignored を判定する |
| `voice_description` | 拒否 | 独立 field なし | unsupported。caption の意味実験と混同しない |
| `emotion` | 拒否 | 独立 field なし | unsupported。caption の意味実験と混同しない |
| `speed` | 拒否 | 独立 field なし | unsupported。`duration_scale` の alias にしない |
| `num_steps` | 受理 | 受理 | 品質を保つ最小値を paired 比較する |
| 3 種の CFG | 受理 | 受理 | 対応 condition が有効な場合だけ比較する |
| `seed` | 受理 | 受理 | 同一 seed の再現性と固定 seed 間の差を分ける |
| `duration_scale` | 受理 | 受理 | speed とは別 control として比較する |
| `num_candidates` | 1 から 4 | 受理 | latency と選択挙動を分ける |
| schedule / sway | 受理 | 受理 | 他条件固定の paired 比較にする |
| independent guidance | 固定値 | runtime control | direct だけで確認する |
| decode mode | 設定固定 | runtime control | direct だけで確認する |
| context KV cache | 設定固定 | runtime control | direct だけで確認する |
| compile | 設定固定 | runtime control | direct だけで確認する |
| progressive streaming | 提供しない | 提供しない | 現行は合成後の framed delivery と記録する |

`unsupported` は schema、route、model profile のいずれかに入力経路がない状態を指す。
`ignored` は、受理後に drop または定数置換されることが source trace で確認できる場合、
または固定条件の差が repeatability envelope 内に留まる場合とする。`effective` は、
入力以外を固定した差が期待方向へ再現し、runtime での消費も source 上で確認できた場合
だけに付ける。

証拠が足りない値は三分類へ押し込まない。skill への公開は保留し、fail closed を選ぶ。

## 固定 fixture

共有報告では本文を出さず、次の ID、正規化後の長さ、SHA-256 だけを扱う。

- `F1_SHORT_GREETING`: 短い挨拶
- `F2_ISHIGAKI_WEATHER`: 石垣市の天気回答を想定した中長文
- `F3_JUGEMU`: 寿限無程度の長文
- `F4_FACILITY_GUIDANCE`: 施設内の案内
- `F5_STYLE_COMPARISON`: neutral/calm/cheerful/clear の表現比較に使う同一短文

raw text、生成 WAV、選択 speaker の情報は mode `0600` の private artifact に置く。
共有可能な結果には fixture ID、text hash、WAV hash、canonical PCM hash、集計値だけを
残す。

## 不変 baseline manifest

各 run は上書きしない manifest を持つ。最低限、次を記録する。

- baseline ID と作成時刻
- Pico、infra、Irodori-TTS の revision と dirty-state 要約
- production と一致を確認した主要 infra file の SHA-256
- model repo ID、resolved Hub revision、checkpoint artifact SHA-256
- runtime source commit
- speaker manifest SHA-256 と選択 embedding SHA-256
- OS、GPU、driver、CUDA、Python、PyTorch の version
- model/codec device と precision、compile、KV cache、decode mode
- 公開 API schema/default の fingerprint
- Scheduled Task と SSH tunnel の非秘密設定
- fixture ID、正規化後の scalar/byte 長、text SHA-256
- request parameter、seed、case order、cancellation mode、connection mode
- harness hash と resource sampling cadence

現在の `/health` は model identity を返さない。そのため、profile 同一性は秘密を含まない
immutable deployment manifest から計算した `profile_id` で検証する。HTTP endpoint の追加は
不要である。manifest を検証できない場合は測定も skill も開始しない。

## 公開 API baseline

最初の baseline はサービスを止めずに採る。

1. health、environment、listener、tunnel、idle resource を snapshot する。
2. 公開 schema の validation probe を行う。未知 field、任意 caption、無効 style、
   `ref_embed` などは合成せず拒否結果だけを記録する。
3. 60 秒の loaded-idle を観測する。
4. `F1_SHORT_GREETING` を 3 回 warm-up し、測定値には含めない。
5. Windows loopback の warm core を
   `F1,F2,F3,F4,F4,F3,F2,F1` の順で 5 block 実行する。各 fixture は 10 反復になる。
6. style core を `neutral,calm,cheerful,clear,clear,cheerful,calm,neutral` の順で
   5 block 実行する。各 style は 10 反復になる。
7. transport は fixture ごとに `loopback,tunnel,tunnel,loopback` を 5 block 実行し、
   route ごとに 10 反復を得る。connection reuse を主系列、fresh connection を補助系列に
   分ける。
8. concurrency は tunnel 上で同一 `F2` を barrier 送信し、`2,4,4,2` を 5 block
   実行する。start skew が 20 ms を超えた wave は無効にする。
9. `F2` を tunnel 上で 30 回連続実行し、tail latency、failure、memory drift を測る。
10. resource sampling の overhead を `off,on,on,off` で確認してから、200 ms cadence の
    resource pass を別系列として採る。

retry は無効にする。healthと合成にはアプリケーションtimeoutを設けず、callerの
AbortSignalだけを中断境界にする。長時間応答しない場合の収束はcaller cancellationで
検証し、provider固有の時間制限は導入しない。

## cold と direct runtime

cold は OS reboot ではなく process/model cold と定義する。この phase でだけ Windows
Scheduled Task を停止する。

公開 cold は 5 cycle とする。各 cycle で listener 不在と GPU process memory の
pre-load envelope 復帰を確認し、task start から TCP accept、`status=ok`、
`model_loaded=true` までを 250 ms cadence で記録する。その直後の `F1` を position
1、2、3 で測って停止する。

5 cycle 後は task を停止したまま direct harness を単独起動する。load time、最初の
3 call、3 warm-up 後の固定 fixture/style sequence、field ごとの固定 seed panel を
実行する。任意 caption は seed `42`、`314159`、`271828` を使い、各 seed 内の順序を
`baseline,low,high,high,low,baseline` とする。二値 control は
`off,on,on,off` とする。

終了時は harness process、GPU memory、Scheduled Task、health、tunnel 経由の単一 smoke
synthesis を順に確認する。途中で失敗しても restore を `finally` 相当の経路から行う。
Pico resident は起動しない。

## 計測定義

clock は monotonic high-resolution を用いる。

- `t_request`: client が request を開始する直前
- `t_flush`: request body の送信完了
- response headers arrival
- first body byte
- stream handshake parse
- WAV header parse
- first PCM sample
- full body completion

主 TTFA は `t_request` から first PCM sample までとする。transport 分解用に `t_flush`
基準も併記する。現行実装では first PCM が per-segment 合成完了後に届くため、
progressive generation の指標として扱わない。

RTF は系列を混ぜない。

- public loopback: `t_flush` 基準 wall / audio duration
- public end-to-end: `t_request` 基準 wall / audio duration
- direct: runtime call time / audio duration

音声は sample rate、channels、bit depth、WAV bytes、canonical PCM SHA-256、duration、
20 ms frame の silence ratio、clipping fraction、integrated loudness、固定 version と
hop の voiced F0 分布を保存する。既存の speaker similarity 実装は純粋な gate だけで、
検証済み抽出器がないため hard gate に使わない。話者同一性は当面、これらの物理指標と
blind paired listening で確認する。

GPU utilization、memory、power、process working set/private bytes、CPU、system RAM は
200 ms cadence で別 pass に記録する。sampling 付き timing は主 latency 系列へ混ぜない。
n が 30 未満なら p95 を主張せず、median、IQR、min、max を報告する。

## 最適化の採否

baseline を保存した後、原則として一因子ずつ変える。fixture、speaker、seed、order、
checkpoint、environment、公開契約を変えない。

candidate は error、unexpected cancellation、malformed WAV が 0 件であることを前提とする。主 warm
loopback metric の paired candidate/baseline 比が `0.90` 以下で、paired bootstrap
95% CI の上限が `0.95` 以下なら速度改善とみなす。各 canonical fixture の median、
SSH end-to-end、30-run p95、concurrency p95 は 5% を超えて悪化させない。cold readiness
と first request は 10% を超えて悪化させない。

peak VRAM/RAM は baseline 比 5% を超えて増やさず、VRAM 使用率は 90% 以下を保つ。
30-run で repeatability envelope を超える持続的 memory slope を許さない。

品質の absolute guardrail は次の値とし、同一 seed 反復から得る `3 × MAD` の方が大きい
場合はそちらを使う。

- audio duration: 3%
- integrated loudness: 1 LU
- silence ratio: 2 percentage point
- voiced median F0: 5%
- clipping 増加: 0.05 percentage point、かつ absolute 0.1% 以下

意図的に duration や style を変える実験は、期待方向の metric を gate から外して記録する。
blind paired listening で明瞭性低下、話者逸脱、artifact が再現した candidate は棄却する。
direct runtime だけの改善は採用せず、復元後の公開 API full gate を通す。

最初に評価する候補は `num_steps`、既存の model residency、context KV cache、compile、
分割/framing、queue behavior、HTTP connection reuse である。Cloudflare は SSH tunnel の
測定値が要件を満たさず、原因が transport にあると示された場合だけ比較する。現行 SSH
より遅い、または不安定なら採用しない。

## skill v1 の境界

実測後、skill v1 の責務は本文や合成設定全体の組み立てではなく、発話意図を検証済み
VoiceDesign preset に変換することへ絞る。caller が指定できる field は
`model_profile_id`、`target`、`preset`、`annotations`だけとする。unknown field、free-form
`caption`、`voice_description`、`emotion`、`speed` は拒否する。

`model_profile_id` は必須で、実測 manifest と完全一致しなければ送信前に失敗する。
`target` の未指定値は `pico_resident_hook`、`preset` の未指定値は `neutral`、
`annotations`の未指定値は空配列とする。

resident hookと公開APIが許すpresetは`neutral`、`calm`、`cheerful`、`clear`だけである。
resident hookは`v`、`style`、`annotations`だけを持つspeech planを返し、公開APIは
`style`だけのrequest patchを返す。直接runtimeはこれらに加えて`calm_slow`と
`calm_fast`を許し、成功時のpatchは固定captionだけを持つ。複数presetに対応する意図を
合成せず、callerに一つを選ばせる。

caption は最大 96 Unicode scalar value かつ 384 UTF-8 byte に制限する。実測 tokenizer
上限の 512 token をそのまま製品境界にはしない。preset wording、model revision、
source commit、speaker manifest、embedding のいずれかが変われば新しい profile を実測し、
既存 manifest を推測で更新しない。

normalizer は入力 key の allowlist、完全一致 profile、target/preset の組み合わせ、
annotation allowlist、caption長を決定的に検査する。出力 file は owner-only で新規作成し、
既存 path を上書きしない。
別 model、Aivis、別 preset への自動切替は行わない。音声合成や resident LaunchAgent の起動も
skill の責務に含めない。

## 配置と切り戻し

skill の canonical source は
`/Users/monsoon/Dev/dotfiles/home/.codex/skills` とする。`skill-index.json` が管理する
symlink 配布だけを使い、重複コピーを作らない。

Pico 統合は skill と API contract の実測完了後に行う。Irodori からの切り戻しは
YAML の provider を明示的に Aivis へ変更し、Aivis の設定を選ぶ。runtime の自動判定や
失敗時 fallback は導入しない。

2026-07-27 の既存 benchmark と WAV は historical evidence として保持する。現在の
baseline ID へ混ぜず、上書きもしない。
