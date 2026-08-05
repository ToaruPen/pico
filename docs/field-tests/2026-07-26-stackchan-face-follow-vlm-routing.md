# StackChan Face Follow and Agent VLM Field Validation

## 実施情報

- 日時: 2026-07-26 10:16–17:28 JST
- operator: Codex（利用者立ち会い）
- branch: `codex/stackchan-face-follow-vlm-routing`
- hardware: M5Stack CoreS3 StackChan、内蔵320×240 camera、yaw/pitch servo
- gateway: 初期比較はinstalled `stackchan-mcp==0.15.0`、stream検証は
  `codex/stackchan-camera-stream` worktree (`0.17.0`)
- MCP endpoint: `http://127.0.0.1:18767/mcp`
- Pi Agent: `0.80.6`
- cloud model: `openai-codex/gpt-5.6-sol`（image input対応）
- local config: `.pico-local/field-stackchan.yaml`
- private reports: `~/.pico/field-reports/2026-07-26-stackchan-*.json`

token値はprivate environmentから読み、config、command、reportには記録していない。
reportには画像を含めない。初期比較で取得した元JPEGはstackchan-mcpの既存private
capture directoryだけに置いた。read後削除を実装した後の再検証では、新しいJPEGが
残らないことを別途確認した。

## PINTO model

公式PINTO Model Zoo 434 archiveから、後処理済み
`yolox_n_body_head_hand_face_0299_0.3803_post_1x3x256x320.onnx`をgit外へ展開した。

- SHA-256:
  `09d077768b9a5afb51f1ec81f24da1ae88197e668c3c111c6f4aa626ffd634e5`
- input: BGR NCHW float、`1×3×256×320`
- output: `[N, 7]`
- local inference: ONNX Runtime

## Camera grid

実行:

```bash
source ~/.pico/stackchan-mcp/local-gateway.env
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run field:stackchan-camera-grid -- \
  --enable-live-run \
  --model-path ~/.pico/models/pinto-434/yolox_n_body_head_hand_face_0299_0.3803_post_1x3x256x320.onnx \
  --report-output ~/.pico/field-reports/2026-07-26-stackchan-camera-grid.json
```

| yaw / pitch | JPEG | capture | inference | PINTO result |
|---|---:|---:|---:|---|
| 0° / 35° | 12,879 B | 4,724 ms | 24 ms | face 1、head 1、selected face 0.891 |
| -35° / 35° | 11,567 B | 7,268 ms | 15 ms | head 1、selected head 0.568 |
| 35° / 35° | 7,225 B | 6,190 ms | 17 ms | 対象なし |

全frameは320×240だった。正面で顔を高信頼度検出でき、左右で結果が変わったため、
当初の未検出は画質不足よりcameraの向きと画角の影響が大きい。終了時のhome復帰は
合格した。

## Agent-routed VLM

frame preparation:

```bash
source ~/.pico/stackchan-mcp/local-gateway.env
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run smoke:camera-vlm-scene
```

結果はagent route、StackChan source、JPEG 13,399 B、VLM input 13,797 Bで合格した。

実際のPi Agent model loop:

```bash
source ~/.pico/stackchan-mcp/local-gateway.env
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
node_modules/.bin/pi \
  --approve --no-session --no-builtin-tools --no-skills \
  --extension ./src/index.ts \
  --provider openai-codex --model gpt-5.6-sol --thinking medium \
  --tools pico_camera_scene_description \
  -p '<one explicit, privacy-bounded scene-description request>'
```

Pi Agentは`pico_camera_scene_description`を1回呼び、tool resultの画像を
`openai-codex/gpt-5.6-sol`で読み、一般的な室内状況と可視人数だけを日本語1文で返した。
人物識別や属性推測は行わなかった。

## Bounded face follow

実行:

```bash
source ~/.pico/stackchan-mcp/local-gateway.env
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run field:stackchan-face-follow -- \
  --enable-live-run \
  --duration-ms 30000 \
  --max-frames 3 \
  --model-path ~/.pico/models/pinto-434/yolox_n_body_head_hand_face_0299_0.3803_post_1x3x256x320.onnx \
  --report-output ~/.pico/field-reports/2026-07-26-stackchan-face-follow.json
```

- processed frames: 3
- bounded move commands: 1
- runtime errors: 0
- final readback: yaw -1°、pitch 34°
- configured home: yaw 0°、pitch 35°
- home tolerance: ±1°
- result: passed

10秒runでは最初のcapture完了と停止が競合し、late move抑止が正しく働いた。30秒runへ
拡張すると、顔位置に応じたbounded moveとhome復帰を実機確認できた。

## PINTO model comparative benchmark

### Run information

- time: 2026-07-26 11:07–11:40 JST
- host: Apple M4、arm64
- runtime: Node.js 24.13.0、ONNX Runtime Node 1.26.0、Sharp 0.35.1
- input set: 同日のStackChan 320×240 JPEG 16枚
- input-set SHA-256: `76537bdf4b225e756650e7bb19fe3cd6ea665403e4edb459f5f34e38c12e401a`
- manual labels: 人物あり14枚、顔が見える12枚、空景2枚
- thresholds: head 0.35、face 0.40

画像そのものや絶対pathはreportへ保存していない。各modelは別Node processでsessionを生成し、
10回warm-up後にJPEG decode、resize、BGR NCHW変換、ONNX inference、head/face抽出までを
連続測定した。重いmodelは安全な実行時間に収めるため反復数を減らした。RSSはprocess開始時と
warm-up後の差分であり、常駐時の概算値として扱う。

| model | input | ONNX | timed runs | p50 | p95 | RSS delta | head recall | face recall | empty false positive |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 434-N | 320×256 | 3.9 MB | 160 | 7.16 ms | 9.92 ms | 75.7 MiB | 13/14 | 10/12 | 0/2 |
| 434-S | 320×256 | 36.0 MB | 160 | 12.97 ms | 14.92 ms | 187.2 MiB | 13/14 | 10/12 | 0/2 |
| 441-S Dist | 320×256 | 36.0 MB | 160 | 12.61 ms | 14.32 ms | 185.3 MiB | 13/14 | 11/12 | 0/2 |
| 459 YOLOv9-S | 320×256 | 28.6 MB | 160 | 16.30 ms | 18.86 ms | 233.4 MiB | 13/14 | 11/12 | 0/2 |
| 465 DEIM-S | 320×256 | 41.6 MB | 160 | 114.72 ms | 123.56 ms | 700.0 MiB | 13/14 | 10/12 | 0/2 |
| 471 YOLO-S | 320×240 | 29.2 MB | 160 | 77.09 ms | 90.34 ms | 582.7 MiB | 11/14 | 9/12 | 0/2 |
| 471 YOLO-C | 320×240 | 102.1 MB | 32 | 185.65 ms | 193.04 ms | 803.4 MiB | 9/14 | 9/12 | 0/2 |
| 471 YOLO-E | 320×240 | 232.7 MB | 16 | 414.52 ms | 438.87 ms | 2,147.9 MiB | 10/14 | 9/12 | 0/2 |
| 472 DEIMv2-S | 320×240 | 40.5 MB | 32 | 241.70 ms | 254.10 ms | 479.1 MiB | 13/14 | 11/12 | 0/2 |

`471-S`は640×480入力も測定したが、p95 85.87 ms、head 10/14、face 9/12で
改善しなかった。元画像の320×240を拡大しても新しい視覚情報は増えず、今回の実画像では
大型化や入力拡大は上位互換にならなかった。

配布物とmodel contract:

- 434-S SHA-256:
  `619971fd2243f8d671c79ee8063857b8757bbd6a2033f6f5f9fdaacbfc317d8b`
- 441-S Dist SHA-256:
  `71b70a85f89d3a9771b7034f55b22f8bcd8f7b56d8a421b92671253337765852`
- 459-S SHA-256:
  `ae9f367a7d8753dc5441273364c87493c9171f60d65b306c3b966ff858e76fb8`
- 465-S SHA-256:
  `365ac98245d803aa60ee2e421af2f80e8dd1caa36df87a08c0bf2c651417bdae`
- 471-S/C/E and 472-S are dynamic external input models with fixed exported
  inference contracts. 465-S accepts dynamic `N×3×H×W`.
- [434](https://github.com/PINTO0309/PINTO_model_zoo/tree/main/434_YOLOX-Body-Head-Hand-Face)、
  [441](https://github.com/PINTO0309/PINTO_model_zoo/tree/main/441_YOLOX-Body-Head-Hand-Face-Dist)、
  [465](https://github.com/PINTO0309/PINTO_model_zoo/tree/main/465_DEIM-Wholebody28)、
  [472](https://github.com/PINTO0309/PINTO_model_zoo/tree/main/472_DEIMv2-Wholebody34)は
  Apache-2.0。459はGPLv3、471はMIT。

### Degradation test

人物14枚と顔可視12枚のlabelを固定し、元JPEGから暗所、Gaussian blur、
JPEG quality 15、暗所＋blur＋JPEG劣化を生成した。変換画像はRAM内だけで処理した。

| model | condition | head recall | face recall | empty head false positive |
|---|---|---:|---:|---:|
| 434-S | original | 13/14 | 10/12 | 0/2 |
| 434-S | JPEG quality 15 | 9/14 | 6/12 | 0/2 |
| 434-S | combined | 6/14 | 0/12 | 0/2 |
| 441-S Dist | original | 13/14 | 11/12 | 0/2 |
| 441-S Dist | JPEG quality 15 | 13/14 | 10/12 | 0/2 |
| 441-S Dist | combined | 13/14 | 7/12 | 0/2 |
| 459 YOLOv9-S | original | 13/14 | 11/12 | 0/2 |
| 459 YOLOv9-S | JPEG quality 15 | 13/14 | 10/12 | 0/2 |
| 459 YOLOv9-S | combined | 14/14 | 2/12 | 1/2 |

441-S Distは通常画像で459-Sと同じrecallを保ち、複合劣化では顔recallが高く、
空景誤検出を出さなかった。459-Sは複合劣化した極端なblur frameもheadとして拾ったが、
空景1枚もheadとして誤検出した。latest-frame追従では極端なblur frameを無理に採用せず、
次の鮮明なframeを待つ方が不要なservo移動を抑えられる。

### Model decision

StackChan attention trackingの第一候補を434-Nから`441-S Dist 320×256`へ更新する。
434-Sと同等のp95/RSSで、実画像と劣化画像のface/head recallが高く、
Apache-2.0かつ既存の4-class `[N,7]` contractを維持できる。459-Sは精度上の対抗馬だが、
今回の比較では441-Sを超えず、25-class parserとGPLv3採用を追加する根拠がない。
DEIM/後発大型YOLOは2 FPSの単純なframe budgetには収まるものもあるが、同じ画像で
recallが改善せず、会話runtimeと共有するCPU/RSSを大幅に増やす。

## 441-S Dist adoption and live revalidation

12:08–12:10 JSTにproduction-facing config contractとprivate field configを次へ切り替えた。

- model family: `pinto441-yolox-body-head-hand-face-dist`
- model:
  `yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx`
- field provider ID: `stackchan-cores3+pinto441-dist`
- model SHA-256:
  `71b70a85f89d3a9771b7034f55b22f8bcd8f7b56d8a421b92671253337765852`

旧`pinto434-yolox-body-head-hand-face`はenabled/disabledのどちらでもconfig parserが
拒否する。compatibility pathやprovider fallbackは追加していない。

private environment fileは値を表示せず、実行shellでexportしてからfield harnessへ渡した。
最初の試行ではshell変数がexportされておらず、MCP接続やservo移動より前に
`StackChan bearer token is missing`でfail closedした。再実行は次の形に統一した。

```bash
set -a
source ~/.pico/stackchan-mcp/local-gateway.env
set +a
PICO_CONFIG_PATH=.pico-local/field-stackchan.yaml \
npm run field:stackchan-camera-grid -- \
  --enable-live-run \
  --model-path ~/.pico/models/pinto-441-s/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx \
  --report-output ~/.pico/field-reports/2026-07-26-stackchan-camera-grid-pinto441-s-dist.json
```

Camera gridは3姿勢すべて320×240で処理し、model hashを照合して合格した。

| yaw / pitch | JPEG | capture | inference | result |
|---|---:|---:|---:|---|
| 0° / 35° | 2,011 B | 6,163 ms | 54 ms | 対象なし |
| -35° / 35° | 1,948 B | 5,075 ms | 15 ms | 対象なし |
| 35° / 35° | 2,032 B | 5,288 ms | 32 ms | 対象なし |

今回は人物が3姿勢の画角に入っていなかったため、検出0はmodel比較値として扱わない。
人物あり画像のrecallは同じcameraで取得した上記16枚比較を根拠にする。grid終了時の
home復帰は合格した。

同じ441-S Dist設定で30秒・最大3frameのbounded followを実行した。

- processed frames: 3
- move commands: unknown（このrunのharnessは指令数を計測していない）
- runtime errors: 0
- final readback: yaw 0°、pitch 34°
- configured home: yaw 0°、pitch 35°
- home tolerance: ±1°
- home-return result: passed
- command-count qualification: excluded（計測済み指令数を要求する判定には使用しない）

private reportはどちらもmode `0600`で、画像、token、capture pathを含まない。

## Ephemeral capture revalidation

14:43–14:44 JSTに、MCP error containment、regular-file validation、read後unlinkを
実装した状態で441-S Distのcamera gridとbounded followを再実行した。実行前後に
`~/.stackchan/captures`直下の通常ファイル件数と、sort済みpath集合のSHA-256を比較した。

- 実行前: 24 files
- 実行後: 24 files
- path集合: unchanged
- camera grid: passed、3姿勢、全frame 320×240、home復帰
- 正面検出: head 1、face 1、selected face confidence 0.871
- 左右検出: 0（誤検出なし）
- face follow: 30秒、3 frames、1 move、errors 0、home復帰
- private report mode: `0600`

このrunで撮影した6枚は、各bounded readの完了後に検証済みcanonical pathの1ファイルだけが
削除された。既存24ファイルと隣接ファイルは削除していない。モデルSHA-256は採用値
`71b70a85f89d3a9771b7034f55b22f8bcd8f7b56d8a421b92671253337765852`
と一致した。

続くsecurity reviewでは、scene toolのimage base64が明示field validation JSONLへ
残り得る経路を検出した。Pi AgentSession内のtool resultはmodel入力のため変更せず、
validation/operator eventへ渡す結果だけをprovider、source ID、byte count、capture timeの
metadataへ投影した。回帰testでimage base64とtext instructionが両eventへ到達しないことを
確認した。

full-diff reviewでは、attentionとscene toolが別MCP clientから同時に`take_photo`を呼ぶと、
gatewayのcamera lock待ちが各request timeoutへ重なり得ることも検出した。StackChan moduleに
process-owned FIFO hardware laneを追加し、captureとhead moveを直列化した。scene captureが
attention captureの後ろで待つ時間はSDK timeout開始前となり、先に待機したscene captureは
次のfollow moveより先に実行される。2 adapterの重複capture/move回帰testで順序を固定した。
また、face-follow field harnessは`framesProcessed > 0`を合格条件へ追加した。

最終的に同じprivate configから`openai-codex/gpt-5.6-sol`のPi model loopを
`--no-session`で再実行した。standard scene toolを1回呼び、室内に1人、天井照明、
棚上の箱が見えるという簡潔な日本語応答を返した。個人識別や属性推測はなく、
capture file集合は24 filesのまま不変だった。これにより、read後unlink後も
in-memory tool resultの画像が現在のPi provider/modelへ到達することを実機確認した。

## In-memory high-speed camera stream

16:03–17:04 JSTに、`take_photo`を経由しないbounded streamをStackChan firmware、
stackchan-mcp gateway、Pico adapterへ実装して実機検証した。

- firmwareはGC0308のQVGA YUYV frameを`esp_new_jpeg`でJPEG化し、`SCL1`
  binary envelopeで既存WebSocketへ送る。
- encoder handle、出力PSRAM buffer、V4L2 mmap bufferをstream中は再利用する。
- gatewayは最大4 creditでbackpressureを掛け、最新JPEG 1枚だけをmemoryへ保持する。
- `camera_stream(start|stop|status)`が参照数を管理し、最終release時にJPEG bytesを消去する。
- Picoは認証済み`/camera/latest`をlong-pollし、顔追従とagent VLMで同じstream leaseを使う。
- stream中だけWi-Fi power saveを`none`へ切り替え、終了時に元のmodeへ戻す。

最適化前は20fps requestで11.09fps、encoder p95 76msだった。per-frameのencoder
open/close、YUYV全量copy、JPEG outputの確保・解放を除去した後の最終値は次の通り。

| request | frames | elapsed | delivered rate | sequence gaps | gateway→Pico p50 / p95 | encoder p50 / p95 / max |
|---:|---:|---:|---:|---:|---:|---:|
| 15fps | 120 | 8.558s | 13.91fps | 1 | 2 / 2ms | 42 / 59 / 59ms |
| 20fps | 120 | 6.794s | 17.52fps | 0 | 1 / 2ms | 27 / 30 / 31ms |

20fps runのJPEGはp50 1,910B、p95 2,717B、最大3,455Bだった。ただし、検証時の
画角は暗く情報量が少なかったため、このbyte数を明るい実運用環境の上限とは扱わない。
frame deliveryのp95は2msで、queueの無制限成長やOpus audioとの誤分類は観測しなかった。

続いて20fps requestを10分間、推論とservo移動なしでsoakした。

- observed duration: 600,015ms
- delivered frames: 9,895
- delivered rate: 16.49fps
- sequence gaps: 10（約0.10%）
- gateway receive→Pico read: p50 1ms、p95 2ms
- maximum JPEG: 3,624B
- gateway stale frames: 0
- close後: `available=false`、`sequence=null`

gateway aggregateでは9,905 framesを受信した。Picoの測定開始前と最終readからstopまでに
受信したframeを含むため、delivered数より10多い。soak中にlong-poll timeout、接続断、
unbounded queue、audio誤分類は発生せず、最終release後にJPEG bytesが消去された。

現行StackChan board presetは
`CONFIG_CAMERA_GC0308_DVP_YUV422_320X240_20FPS=y`であり、設定上のcapture上限は
20fpsである。したがって30fpsを受け付ける見かけ上の設定変更は行わなかった。
30fps化にはsensor mode、clock、camera driverを含む別のhardware experimentが必要になる。

### Stream-based PINTO follow

採用済み`441-S Dist`で30秒の実機runを行った。

- requested stream: 20fps
- processed frames: 29（controller interval 1,000ms、0.96Hz）
- move commands: 28
- runtime errors: 0
- frame freshness: p50 5ms、p95 66ms
- inference: p50 27.41ms、p95 29.66ms
- final readback: yaw -1°、pitch 34°
- home tolerance: passed

sequence gap 459はstream欠落ではない。producerを20fps、推論・servo controlを1Hzとし、
各tickで最新frameだけを選んだために意図して読み飛ばした数である。対象不在時は
設定済みyaw/pitch scanを継続し、停止時はhomeへ戻った。

同じstreamでcamera gridも再実行し、3姿勢すべて320×240、capture 2–3ms、
inference 26–47ms、home復帰で合格した。今回の暗い画角ではface/head検出は0だった。
同じcameraで取得した明るい人物ありdatasetでは441-S Distがhead 13/14、
face 11/12、空景false positive 0/2だったため、今回の0件はcamera画質だけを理由にした
不合格とはしない。照明と初期画角は引き続き実運用条件として確認する。

### Stream-based agent VLM and retention

StackChan最新frameをPi tool contentへ渡すsmokeはprovider `agent`、source
`stackchan`で合格した。続いて`openai-codex/gpt-5.6-sol`の実model loopを実行し、
toolを1回呼んで「画面が暗く一般的な物体は確認できず、見える人物は0人」と応答した。
これは暗い入力に対する結果であり、識別や属性推測は行っていない。

stream lease終了後の`/camera/status`は`available=false`、`sequence=null`だった。
受信数などのaggregate counterだけを残し、JPEG bytesは保持していない。private field
report 2件はmode `0600`で、画像、token、絶対capture pathを含まない。

独立code reviewでは、device切断後に論理subscriberだけが残る場合と、最終stopのtransport
失敗時にproducerへcreditを返し続ける場合を検出した。gateway serviceを論理subscription、
物理stream、pending stopへ分離し、次を回帰testで固定した。

- device切断時は論理subscriptionを保ったままJPEGを消去し、frame受理とcredit返却を止める。
- device再接続後、初期化完了時にpending streamをstopして同じ設定でstartとinitial creditを
  再送する。
- 最終stop失敗時もJPEGを消去してframeを受理せず、次のstopで再試行できる。
- shutdown時のcamera cleanup失敗はgateway server closeを妨げない。
- gatewayが`isError=false`のtextへ`{"error":...}`を返す既存形式も、Picoはlease成功と
  誤認せずfail closedする。

security reviewでは、認証済みclientが`start`後にcrashすると明示`stop`が来ず、
producerと最新JPEGが残る経路を検出した。private MCP SDKのsession internalsへ結合せず、
認証済み`/camera/latest` readで更新する30秒idle leaseをgatewayへ追加した。期限切れ時は
logical subscriberを0にし、producerをbest-effort停止してJPEGを消去し、Wi-Fi modeを戻す。
timer generationを照合するため、更新前のstale timerが新しいleaseを停止することはない。

### Post-polishment verification

polishmentとai-slop-cleaner後の独立reviewで、main taskがbinary sendを処理する前にlatest
slotが未送信frameを置換すると、producerが先に消費したcreditを回収できない経路を検出した。
同様にtransport未接続と`SendBinary`失敗でもcreditが失われていた。slot置換、invalid packet、
未送信packetで1 creditを返し、正常送信時だけgatewayからのcreditを待つよう修正した。
6連続publishで5回置換するhost regressionを追加し、firmware host testは16/16、
StackChan向けDocker full buildも合格した。

app領域だけを実機へ再書き込みし、NVSを保持したまま43 toolsで再接続した。feature gateway
上で30秒のfollowを再実行した結果は4 frames、4 moves、errors 0、home復帰だった。
servo commandがmain taskを占有する間にもgatewayは48 framesを受信し、47 framesを
latest-only置換した。4 creditを超える置換後も新しいsequenceが届き続けたため、修正前の
credit枯渇は再現しなかった。

agent route smokeは元frame 7,913B、resize後9,012Bで合格した。同じ実行中Pi sessionの
`openai-codex/gpt-5.6-sol`へ1枚だけ渡した実model loopは「室内に棚や壁が見え、人物は1人
見えます。」と応答し、識別や属性推測を行わなかった。全lease終了後は
`available=false`、`sequence=null`で、private follow reportはmode `0600`だった。
検証後はfeature gatewayを停止し、installed gateway 0.15.0のlaunchd常駐へ戻した。

## 自然さ優先の追従チューニング

利用者不在の19:16–19:20 JSTに、人物を必要としない機械・性能検証を追加実施した。
採用候補を次へ変更した。

- camera producer: 20fps
- observation interval: 250ms（4Hz）
- dead zone: 0.10
- tracking maximum step: 4°
- explicit servo speed: 90°/秒
- lost hold: 1000ms
- scan dwell: 900ms

`move_head` の速度未指定ではfirmwareの固定600ms補間になるため、tracking、startup home、
stop homeの全経路で90°/秒を明示した。90°/秒はfirmwareの実測smoothness floor
72°/秒以上、安全上限240°/秒以下である。観測周期とscan移動周期を分け、顔を4Hzで探し
ながら、対象不在時の見回し指令は約1Hzに抑えた。

installed gateway 0.15.0は`camera_stream`を公開しないため、最初のrunはtool不在で
fail closedした。これはPicoの制御失敗ではなくgateway version境界であり、以後は既に
camera stream検証済みのfeature gateway 0.17.0を一時起動した。検証後はfeature gateway
を停止し、installed 0.15.0のlaunchd常駐と43-tool device接続を復帰した。

| profile | duration | frames | effective | moves | freshness p95 | inference p95 | errors | home |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 4Hz / 250ms | 30秒 | 115 | 3.81Hz | 29 (0.96Hz) | 64ms | 17.67ms | 0 | passed |
| 5Hz / 200ms | 30秒 | 114 | 3.77Hz | 30 (0.99Hz) | 66ms | 19.79ms | 0 | passed |
| 4Hz / 250ms | 120秒 | 394 | 3.28Hz | 117 (0.97Hz) | 68ms | 18.12ms | 0 | passed |

5Hzは4Hzより実効処理率が上がらなかった。runtimeはhead read、latest frame read、推論、
必要時のmoveを1 tick内で直列化し、active tick中の次intervalを安全に捨てる。200ms
profileではservo moveを含むtickが次intervalへ重なりやすいため、自然さ優先の採用値は
250msのままとした。120秒runではwide scan中のdevice呼び出しによって長時間平均は
3.28Hzになったが、frame freshness、推論時間、error 0、home復帰は安定していた。

private reportは次の3ファイルで、すべてmode `0600`、画像を含まない。

- `~/.pico/field-reports/2026-07-26-stackchan-natural-follow-4hz.json`
- `~/.pico/field-reports/2026-07-26-stackchan-natural-follow-5hz.json`
- `~/.pico/field-reports/2026-07-26-stackchan-natural-follow-4hz-120s.json`

streamはgateway memory上のlatest frameだけを使い、この検証時刻以降のcapture fileは
0件だった。人物またはカメラ視野内の顔画像がなかったため、実人物に対する見た目の
自然さだけは未判定である。機械的な速度、周期、境界、停止安全性の検証とは分けて扱う。

## 無人合成target校正

2026-07-27 10:38–10:46 JSTに、特定人物を模倣しない成人の合成顔をMac画面へ表示し、
利用者不在で固定home姿勢の校正を行った。

- initial synthetic report（旧failure形式）:
  `~/.pico/field-reports/2026-07-27-stackchan-center-calibration-synthetic-baseline.json`
- aggregate report再検証:
  `~/.pico/field-reports/2026-07-27-stackchan-center-calibration-aggregate-revalidation.json`
- classification: `insufficient-target`
- processed frames: 80
- target / face / head frames: 0 / 0 / 0
- final readback: yaw -1°、pitch 34°
- configured home: yaw 0°、pitch 35°
- home tolerance: passed
- changed parameter: なし
- synthetic proxy: failed
- 実人物最終検証: pending

通信と推論の切り分け用に、同じhome姿勢で80 frameを再集計した。captureとinferenceは
ともに80回完了したが、targetは0件だった。続いてproduction設定済みの
yaw `[-35, 0, 35]`、pitch `[35, 25]`の6姿勢を各4 frame確認したが、
24 frameすべてでface/headは0件だった。姿勢ごとの平均輝度は27.6–49.9で変化したため、
camera streamは新しいframeを供給していた。

合成targetが現在の画角へ入っていない条件でgain、dead zone、home、scanを調整すると
controllerではなく物理配置へ過適合する。このため30秒face-followとparameter candidateは
実行せず、fail closedした。画像はreportやrepositoryへ保存しておらず、診断用の一時frameと
合成targetはsession cleanupで破棄した。

独立reviewで、旧failure reportが固定reasonだけを残し、取得済みaggregateを破棄する問題を
検出した。failed reportにもraw errorや画像を含めず、`failureCode`、frame/target集計、
stream freshness、inference、軸誤差、lost gap、final pose、home結果を残すよう修正した。
合成targetは既に破棄済みだったため初回reportを推測値で上書きせず、11:02 JSTにtarget不在の
同じ画角で別reportを実機生成した。

- classification: `insufficient-target`
- frames / target / face / head: 80 / 0 / 0 / 0
- errors: 0
- stream freshness p95: 1ms
- inference p95: 17.54ms
- maximum lost gap: 5,846ms
- final readback: yaw 0°、pitch 34°
- home tolerance: passed
- report mode: `0600`

## 実人物による固定姿勢校正と追従調整

2026-07-27 20:18–20:24 JSTに、利用者本人がStackChanから約50–100cmの会話距離にいる
条件で実測した。画像、個別検出、人物情報は保存せず、集計reportだけをmode `0600`で
保存した。開始前後のcapture fileは24件、path集合のSHA-256は
`a9b4687e3d5c92da949fb4c6feab6a82033b84d3e73fe3125f1ca3f83e5fb447`で一致した。

最初にhome yaw 0°、pitch 35°で80 frameの固定姿勢校正を行った。

- target / face / head: 78 / 78 / 0
- horizontal signed p50: -0.076
- vertical signed p50: +0.077
- inference p95: 16.59ms
- maximum lost gap: 232ms
- runtime errors: 0
- home復帰: passed

同じiterationで複数変数を動かさない規則に従い、まずpitch offsetだけを-2°変更した。
`homePitch`を33°、`scanPitch`を`[33, 23]`とし、再度80 frameを測定した。

- target / face / head: 76 / 76 / 0
- horizontal signed / absolute p50 / absolute p95: -0.035 / 0.034 / 0.112
- vertical signed / absolute p50 / absolute p95: +0.002 / 0.003 / 0.024
- inference p95: 16.78ms
- maximum lost gap: 125ms
- runtime errors: 0
- home復帰: passed

固定姿勢の縦偏差は`+0.077`から`+0.002`へ改善し、横偏差も補正対象の0.05以内だった。
この条件では441-S Distが76/80 frameで顔を検出したため、内蔵cameraの解像度と画質は
会話距離の顔追従に利用できる。

続いて、利用者が正面から左右へゆっくり動き、途中で短く停止する30秒の実人物追従を
2回行った。baselineを評価器へ渡すと、振動や位置偏りではなく水平軸の収束不足と分類され、
候補どおり`yawGainDeg`だけを40から44へ10%増やした。

| profile | target frames | first centered | 5–25秒 centered | horizontal signed p50 | horizontal absolute p50 / p95 | max lost | moves | errors | home |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| yaw gain 40 | 54 | 6.214秒 | 8/37 (21.6%) | -0.232 | 0.292 / 0.456 | 1.226秒 | 45 | 0 | passed |
| yaw gain 44 | 66 | 2.390秒 | 15/47 (31.9%) | -0.113 | 0.220 / 0.423 | 1.439秒 | 44 | 0 | passed |

gain 44では初回中心化が3.824秒短縮し、評価区間の中心率が10.3 percentage points改善した。
符号反転は水平1回、垂直0回、servo limitは0 frameで、往復振動や可動域への張り付きは
観測しなかった。固定姿勢で位置偏りが解消し、追従runでも見失いは2秒未満だったため、
この実機のfield profileでは`homePitch=33`、`scanPitch=[33,23]`、`yawGainDeg=44`を
次のiteration用の暫定値とした。端末の設置差で変わる校正値であり、全StackChan共通の
parser既定値やexample設定には反映しない。

70%基準は静止した合成targetを前提に設計した値であり、意図的に移動し続ける人物runとは
同じ合否条件にできない。2回目は初回中心化の5秒基準を満たしたため評価器の追加候補はなく、
残る低い中心率に対してgainやspeedを重ねて上げなかった。camera producerは20fpsを維持した
一方、servo commandを含む制御tickは直列化されるため、この人物runで処理した最新frameは
1.87fpsと2.20fps、move rateは1.50Hzと1.47Hzだった。次の改善対象はモデル速度ではなく、
実際の会話動作を再現できる反復可能な移動protocolと制御commandの待ち時間である。

private report:

- `~/.pico/field-reports/2026-07-27-stackchan-center-calibration-human-baseline.json`
- `~/.pico/field-reports/2026-07-27-stackchan-center-calibration-human-pitch-offset.json`
- `~/.pico/field-reports/2026-07-27-stackchan-face-follow-human-baseline.json`
- `~/.pico/field-reports/2026-07-27-stackchan-face-follow-human-yaw-gain.json`

全lease終了後、feature gatewayは`running=false`、`subscribers=0`、
`physical_running=false`、`available=false`、`sequence=null`で、latest endpointは204を
返した。feature gateway停止後はinstalled launchd gatewayへ戻し、device接続と43 toolsを
確認した。installed gatewayの`/camera/status`は想定どおり404だった。

## 実人物A/Bと中心付近の制御軟化

2026-07-28 06:29–06:40 JSTに、同じ実人物、model、20fps producer、field profileで
観測間隔だけを変えたblind A/Bと、結果に基づく制御変更を実施した。画像、個別検出、
人物情報は保存せず、集計reportだけをmode `0600`で保存した。

blind解除後の条件はAが167ms、Bが250msだった。利用者の主観評価では両条件とも静止中の
補正が残り、追従も滑らかではなかった。167msは250msより移動回数が少なく、最大見失い時間と
単発のmove latency外れ値が大きかったため採用しなかった。

| profile | frames | moves | centered | first centered | max lost | move p95 / max |
|---|---:|---:|---:|---:|---:|---:|
| 167ms | 139 | 51 | 21/101 (20.8%) | 5.008秒 | 7.114秒 | 373ms / 3,875.5ms |
| 250ms | 147 | 74 | 30/142 (21.1%) | 3.586秒 | 1.620秒 | 337ms / 368.27ms |

初回runではfield harnessの100ms status pollが、refreshによって60ms未満で連続完了する
frameを取りこぼし、runtimeが正常でもdiagnostics invalidになることを確認した。pollを20msへ
変更し、60ms frameをstop前に観測できるbehavior testをRed→Greenで追加した。

制御診断ではPINTO推論p95が約31ms、capture-to-command p95が32ms以下だった一方、
250ms条件の75指令すべてが最大4°だった。controllerはdead zoneを出た直後からerror全量へ
gainを掛けるため最大stepへ飽和しやすく、runtimeはmove中に見えたtargetの時刻をcontroller
stateへ反映していなかった。

軸errorのうちdead zone超過分だけへgainを掛け、move中のtarget観測状態を保持するよう
変更した。250ms条件のまま、最初の10秒を静止、次の10秒を左右移動、最後の10秒を
静止する30秒runを行った。

| profile | frames | moves | 1° / 2° / 3° / 4° | centered | first centered | max lost |
|---|---:|---:|---:|---:|---:|---:|
| 250ms full-error | 147 | 74 | 0 / 0 / 0 / 75 | 30/142 (21.1%) | 3.586秒 | 1.620秒 |
| 250ms dead-zone excess | 140 | 39 | 11 / 6 / 3 / 19 | 66/136 (48.5%) | 3.279秒 | 0.908秒 |

変更後はmove rateが2.47Hzから1.30Hzへ下がり、最大4°指令が75回から19回へ減った。
runtime error、failed move、servo limit、stop後のin-flight observation/moveはいずれも0で、
homeへ復帰した。最終的な自然さは利用者の主観確認を待つ。

private report:

- `~/.pico/field-reports/2026-07-28-stackchan-human-ab-a.json`
- `~/.pico/field-reports/2026-07-28-stackchan-human-ab-b.json`
- `~/.pico/field-reports/2026-07-28-stackchan-human-soft-control.json`

検証後はcamera streamが`available=false`、`sequence=null`、latest HTTP 204であることを
確認した。capture fileは24件、228,055 bytes、path集合のSHA-256
`a9b4687e3d5c92da949fb4c6feab6a82033b84d3e73fe3125f1ca3f83e5fb447`のまま増えていない。
feature gatewayを停止し、installed launchd gateway PID 58693へ戻した。deviceは43 toolsで
readyになり、Cloudflare tunnelは停止していない。

## Pico側latest-wins制御の実機capacity検証

2026-07-29 07:58–08:02 JSTに、captureとmoveのlane分離、125ms観測、180ms frame
freshness上限、center enter/release hysteresis、in-flight 1件とreplaceable pending
1件の制御を実機で検証した。通常30秒runと、250ms・167ms・125msを観測のみ／合成target
制御ありで各2回測るcapacity runは、ともに合格した。

通常30秒runは228 frames（7.60Hz）、29 moves、error 0だった。観測間隔はp95 131ms /
p99 143ms、frame ageはp95 77ms / p99 104ms、PINTO推論はp95 26.44ms /
p99 52.96ms、move latencyはp95 184ms / p99 209msだった。stale dispatch、
concurrent move、停止後のin-flight処理はいずれも0で、homeへ復帰した。このrunでは顔検出が
1 frameだけだったため、実人物に対する主観的な滑らかさは未判定である。

| interval | obs rate | control rate | control gap worst p95 | move worst p95 | sustainable |
|---:|---:|---:|---:|---:|---|
| 250ms | 4.06Hz | 4.00Hz | 263ms | 176ms | yes |
| 167ms | 6.00Hz | 6.00Hz | 176ms | 184ms | yes |
| 125ms | 8.00Hz | 7.87Hz | 132ms | 176ms | yes |

125ms controlの2 blockでは、move中にも48 / 49 observationsを処理した。pending深さは最大1、
置換は各2回、pending dispatchは46 / 47回で、stale frame dispatchとstop後のpending
dispatchはいずれも0だった。frame age p99は114ms / 126ms、move p99は201ms /
202msで、両blockともhomeへ復帰した。

private reportは次の2ファイルで、modeは`0600`、画像は含まない。

- `~/.pico/field-reports/2026-07-29-stackchan-face-follow-125ms-latest-pending.json`
- `~/.pico/field-reports/2026-07-29-stackchan-attention-capacity-125ms-latest-pending.json`

検証後はgateway memory上のlatest frameが`available=false`、`sequence=null`へ戻り、
private capture directoryの総bytesは既存の228,055 bytesから増えていない。feature
gatewayを停止し、installed launchd gateway PID 21392へ戻した。deviceはconnected、
tools count 43で、Cloudflare tunnelは停止していない。

## Gateway側async-latest制御の実機検証（旧one-active実装）

> この節は2026-07-29時点のone-active実装に対する実機記録であり、現行契約の説明ではない。
> 2026-07-31以降のcanonical contractは、active device call最大2件、replaceable pending
> target最大1件、planned dispatch frontier基準の再clamp、dispatch順のconfirmation commitで
> ある。以下の測定値は履歴として保持する。

2026-07-29 19:29–19:39 JSTに、head commandの待ち時間を観測loopから外し、gatewayが
active call 1件とreplaceable pending 1件を所有する実装を検証した。入力は最大20Hz、
device dispatchは最大10Hz、pending TTLは180ms、servo speedは90°/秒である。

独立stressは30秒で600 updateを受理し、354件を未送信の新しいtargetへ置き換え、
245件をdeviceへ送信して全件確認した。update acknowledgmentはp95 11ms / p99 12ms、
status latencyはp95 12ms / p99 13ms、stopは118.35msだった。active callとpending depthの
最大値はいずれも1で、device failure、stale discard、stop後のdispatchは0。終了時の
home誤差はyaw 0°、pitch 1°だった。

同じ実装で250ms・167ms・125msの観測のみ／合成target制御ありを各2回測った。

| interval | obs rate | control rate | update ack worst p95 | dispatch / accepted | pending age worst p95 / p99 | sustainable |
|---:|---:|---:|---:|---:|---:|---|
| 250ms | 4.00Hz | 4.00Hz | 6ms | 64 / 64 | 1ms / 1ms | yes |
| 167ms | 6.00Hz | 5.99Hz | 6ms | 96 / 96 | 16ms / 44ms | yes |
| 125ms | 8.00Hz | 7.92Hz | 5ms | 124 / 127 | 100ms / 113ms | yes |

125ms条件でもdevice dispatchは受理済みupdateの97.6%を維持した。全12 blockを通じて
camera interruption、failed update、device failure、stale discard、servo limit、
stop後のdispatchは0で、各control blockはhomeへ復帰した。

最初のmatrix試行だけは、設定home `0°/33°`に対する実機readback `-1°/32°`を
旧harnessが範囲外と誤判定し、2 blockで停止した。servo角度の±1°量子化を再現する
回帰testを追加すると、合成target生成も厳密一致のため`3°→7°`と行き過ぎることが分かった。
target到達判定と軌道範囲へ同じ±1°許容を適用した再試行は全block合格した。これは
controllerやgatewayの動作変更ではなく、実機readbackを扱うfield harnessの修正である。

device tool call自体の遅延は残った。125ms control blockのdevice dispatch latencyは
p95 177–181ms、最大p99 236msである。ただし呼び出し中も次のframeと推論を処理し、
新しいtargetだけをpendingへ残すため、この遅延は観測周期を約2Hzへ落とさなくなった。
非同期化で改善したのはservoの物理速度ではなく、遅いdevice応答が制御loop全体を
直列化していた部分である。

最後に30秒の通常face-followを実行した。233 framesを7.77Hzで処理し、PINTO推論p95は
23.49ms、capture-to-command p95は23ms、update acknowledgment p95は6msだった。
このrunはtarget frameが0で、30 commandは対象不在時のscanだったため、実人物追従の
主観評価には使わない。runtime error、failed update、stale dispatchは0で、終了時は
yaw 0°、pitch 32°へ復帰した。

private aggregate reportは次の3ファイルで、modeは`0600`。画像、個別target、検出座標、
MCP raw responseは含まない。

- `.pico-local/head-target-lane-live.json`
- `.pico-local/stackchan-capacity-async-latest.json`
- `.pico-local/stackchan-face-follow-async-latest-live.json`

検証後はfeature gatewayを停止し、installed launchd gateway PID 54740へ戻した。
deviceはconnected、tools count 43、queue depth 0で、頭部readbackはyaw 0°、pitch 32°だった。
Cloudflare tunnelは停止していない。

## 無人replay qualification gate

2026-07-30に、画像や実人物を使わずproduction attention runtimeをvirtual monotonic
clockで駆動するreplay reportをschema version 6へ更新した。reportとeventのJSON
Schema、metric定義、metric実装、acceptance profile、fixture、scenario input、
producer sourceを個別のSHA-256で識別する。比較対象はproducer provenance以外の
comparison-set hashが一致しない限りA/B比較できない。READMEへhashを手入力せず、
検証済みreportから証跡builderが生成する。

全aggregate、invariant、scenario status、canonical hashはraw eventだけを入力とする
同一reducerから再計算する。保存済みaggregateやstatusは正規化入力として信用しない。
欠落key、余分なkey、型違反、非finite値、event timestampの後退または同値、
schema hash不一致はreport書込み前にfail closedとなる。qualified reportは固定3 runの
raw evidenceをすべて保持し、各runのscenario roster、canonical input、frame sequence、
accepted sequence、最終runtime evidence、累積lane counterを独立に検証する。stop eventの
runtime phaseが`stopped`でなければscenarioはfailedとなる。

ただし、同期validatorが保証するのはreport内部の構造と因果関係までであり、提出された
raw eventが現行producerから生成されたことまでは証明しない。qualified判定では、依存注入を
許さない現行production producerをvirtual clock上で新たに3 run実行し、report全体の
canonical JSONが提出物と完全一致することを非同期trust boundaryで確認する。提出物とfresh
rerunのどちらもstatus `passed`でなければならない。timestamp、controller mode、centered、
request、clear、stop/homeを含む一部のfieldだけを自己整合的に書き換えても、この完全一致で
fail closedとなる。証跡builderはこのfresh検証を必須とし、同期validatorだけをqualifiedの
出自判定には使わない。

`qualified`と`historical-normalized`は別のvalidation modeである。qualifiedは現行fixture、
固定3 run、stop event由来のruntime evidence、既知producer hashを必須とする。
historical-normalizedは旧reportの分析専用で、repeatは1、runtime summaryはlegacy、
producer sourceは不明を表す`null`である。historical artifactをqualified判定へ渡すと
fail closedとなる。

qualified fixtureは次を含む。

- yaw/pitchそれぞれの正負で、正規化誤差`0`、`±0.09`、`±0.11`、`±0.13`、
  `±0.15`を通る64観測のdead-zone/release境界
- visibility 95%以上、scan 0、settling打ち切り1件以下のslow tracking
- 16 plateau、左右反転6回以上、visibility 95%以上、有効confirmed movement
  16件以上、settling非打ち切り80%以上のfast reversal。未確認planned frontierに対する
  required reversal、ordinary movement、provably redundant dispatchを分離し、反転要求から
  新方向dispatchまでのresponse latencyも測る
- `track-moving`、`pending-present`、`scan-active`を独立判定するstop/home
- target loss、scan waypoint到達後dwell、reacquisition

旧schema version 2の修正前後reportはhistorical-normalized modeでraw eventを同じ
metric reducerへ通した。修正前は
waypoint reach 0、premature advance 7、reacquisition 7,125msでtarget-loss判定が
failedだった。修正後はreach 1、premature 0、minimum post-arrival dwell 1,000ms、
reacquisition 2,125ms、same-pose scan dispatch 0でtarget-loss判定がpassedになった。
旧fixtureには新しいstatic/fast coverageがないため、正規化report全体はqualified
current-source baselineとは区別してfailedのまま保持する。

review evidenceは決定的なtar.gzとして生成する。archiveには提出されたqualified/currentと
builder自身が生成した`qualified-fresh-rerun.json`の両方を保存し、canonical SHA-256の
一致をmanifestへ記録する。さらにhistorical before/after、producer 3依存、Gateway lane、
replay producer、JSON Schema、schema hash helper、関連test、検証log、Git scope、
資格判定開始時に保存したCodex JSONL recordを含める。controller、runtime、Gateway laneの
開始時SHA-256は当時のraw recordと照合する。`attention-detection.ts`はproducer依存だが
開始時recordへhashを保存していなかったため、current-only snapshotとして明記し、開始時
から不変とは主張しない。Git scopeにはbuild時に観測した両repositoryのbranch、base/HEAD、
porcelain status、baseからのdiff name、untracked nameの生データを独立artifactとして保存する。
`production-scope.json`は開始時scope、生のGit観測、埋め込みsource、検証logから再生成して
バイト単位で照合する。このため、元worktreeを削除または移動した後もarchive単体で検証できる。
archive内の`SHA256SUMS`、producer/gate/review manifest、production scope、2つのqualified
reportのfresh current-producer一致を検証してからreviewへ渡す。

実行例:

```bash
npm run field:stackchan-attention-replay -- \
  --report-output /absolute/path/to/report.json \
  --repeat 3 \
  --producer-source-hash <producer-source-sha256>
```

このgateが示すsmoothnessは合成入力上のrequest、dispatch、confirmed poseの測定であり、
servo機構のbacklash、慣性、振動、音を含む物理的な滑らかさは引き続き実機確認が必要である。

## 結論と制約

- 内蔵cameraは、照明と画角が確保できる条件ではPINTO顔・頭検出とCodex scene
  descriptionに利用できる。実人物の固定姿勢では441-S Distが76/80 frameで顔を検出した。
  暗い画角では認識材料が不足するため、画質だけでなくscan姿勢と照明も運用条件になる。
- 会話interactionに追従runtimeを結び付ける実装は成立し、停止時home復帰も確認済み。
- attention modelは`441-S Dist 320×256`を第一候補とする。warm p95は14.32 msで、
  20fps camera inputと250ms observation intervalの双方に対して十分速い。
- 20fps requestで短時間17.52fps、10分soak 16.49fpsを実測し、旧`take_photo`の
  4.7–7.3秒待ちを追従runtimeから除去した。captureとmoveのlane分離後は125ms負荷でも
  7.87 control observations/秒を維持し、move中の最新補正を最大1件だけ保持できた。
  実人物での主観評価は別途必要である。
- VLM routingは`agent`と`ollama`を明示選択でき、agent routeは現在のPi/Codex modelへ
  JPEGを渡す。暗黙fallbackは追加していない。
- 30fpsは現行GC0308 QVGA 20fps presetの範囲外であり、今回のproduction設定には含めない。
- firmwareはstream対応版を書き込み済み。gatewayとPicoはfeature worktree上の実装であり、
  常駐環境へ配備するまではinstalled gateway 0.15.0からstream toolを利用できない。
