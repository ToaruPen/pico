# StackChan Face Follow Design

## 目的

現行の `stackchan-mcp` firmware と gateway を維持したまま、CoreS3 内蔵カメラ、
PINTO 441-S Dist YOLOX Body/Head/Hand/Face、StackChan の頭部サーボを接続し、会話中だけ
人物の頭部または顔へ追従する。追従処理は、古い観測や未完了の首振り命令によって
遅延が累積しない latest-wins 制御とする。

追従は人物識別ではない。画像、検出結果、追跡対象を durable memory に保存せず、
児童の識別、評価、スコアリング、プロファイリングを行わない。

## 現状と採用判断

- `stackchan-mcp` は `camera_stream`、authenticated `/camera/latest`、`move_head`、
  `get_head_angles` を提供する。
- firmware は producer credit で送信量を制限した binary JPEG stream を提供し、
  gateway は受信済みの最新1枚だけを保持する。
- Pico は adapter 接続時に stream lease を取得し、切断時に解放する。追従制御は既定
  20fps・JPEG quality 60 の stream から、125ms ごとに直前より新しい frame を1枚読む。
- `stackchan_follow_pose_stream` は姿勢ストリーム購読を提供するが、任意の外部センサー
  stream向けであり、Picoの顔追従には流用しない。Pico側latest-wins後にも残ったdevice
  response待ちは、後続の
  [`2026-07-29-stackchan-async-head-target-design.md`](./2026-07-29-stackchan-async-head-target-design.md)
  でgateway内の非同期latest-only laneとして分離する。
- PINTO 441-S Dist の 4-class postprocessed output は `[N, 7]` rows の
  `[batch, classId, score, x1, y1, x2, y2]` で、class ID は body=0、head=1、
  hand=2、face=3 である。

production path は latest-only JPEG stream を採用する。30fps は transport の上限検証
に使えるが、現在の追従制御は20fps producer、8Hz consumerから開始する。capacity測定
では125ms条件で約8.05観測/秒、PINTO推論p95は約32ms、frame age p95は74〜98msであり、
Mac mini M4の推論能力ではなく待ち構造が主な制約である。Pico に firmware transportを
再実装しない。

## 選択肢と採用方針

### A. 観測周期だけを短くする

変更量は最小だが、現行runtimeは `move_head` 処理中の制御結果を捨て、完了後に追加撮影を
発火する。またcameraとhead moveを同じFIFO laneで直列化する。このまま周期だけを短く
すると、観測数が増えても操作指令の鮮度と停止応答は改善しにくい。

### B. Pico内をbounded latest-wins制御にする

camera laneとhead move laneを分離し、観測周期を125msへ変更する。head moveは
in-flight 1件と置換可能なpending 1件だけを持ち、古いframeを制御に使わない。
中央判定には進入・離脱の2閾値を設ける。firmwareを変更せず、実測で確認された主要な
待ちを個別に除去できるため、今回はこちらを採用する。

### C. gatewayとfirmwareまでlatest-wins setpoint化する

最終形としては、gateway側20Hz controllerとfirmware側の専用setpoint mailboxに
sequence、session、TTLを持たせる構成が有力である。ただしPico側の待ちを残したまま
同時変更すると効果と不具合の帰属が難しい。Bの実機結果で残存遅延を測ってから別設計で
判断する。Pico側変更後の実測によりgateway内の非同期laneだけを次sliceとして採用し、
firmware mailboxは追加しないことを
[`2026-07-29-stackchan-async-head-target-design.md`](./2026-07-29-stackchan-async-head-target-design.md)
で確定した。

## 所有境界

### stackchan-mcp

- ESP32 connection と認証
- producer-credit 付き binary JPEG stream と latest-only frame 配信
- 頭部角度の取得と設定
- firmware 固有の servo 制約

### Pico StackChan module

- Streamable HTTP MCP client の接続と lifecycle
- camera stream lease の取得と解放
- authenticated `/camera/latest` の sequence、timing、content type、byte bound、
  JPEG validation
- `get_head_angles` と `move_head` の typed wrapper
- process内でcapture同士、head move同士をそれぞれ直列化し、captureとhead moveは
  相互に待たせない独立lane

### Pico vision attention detector

- PINTO postprocessed ONNX model のロード
- demo と同じ BGR float32、値域 0..255、NCHW preprocess
- head と face のみを typed detection として返す
- face を優先し、face がない場合は head を選ぶ

### Pico StackChan attention runtime

- acquire、track、hold、scan、stop の状態
- bounding-box center error から bounded yaw/pitch step への変換
- in-flight 1件と置換可能なpending 1件によるlatest-wins head command
- frame sequenceとframe ageによる古い観測の破棄
- 画像を保持しない最新1件の注視ステータスと中央判定カウンター
- interaction start/stop と runtime shutdown
- 画像や detection row を telemetry、audit、conversation history に保存しない

## 設定

`camera.stackchan` は StackChan camera と head actuator の共有設定を持つ。

```yaml
camera:
  stackchan:
    sourceId: stackchan-core-s3
    mcpUrl: http://127.0.0.1:18767/mcp
    bearerTokenEnv: STACKCHAN_TOKEN
    timeoutMs: 10000
    maxFrameBytes: 5242880
    streamFps: 20
    streamJpegQuality: 60
    follow:
      enabled: true
      frameIntervalMs: 125
      maxFrameAgeMs: 180
      homeYaw: 0
      homePitch: 35
      deadZone: 0.10
      deadZoneRelease: 0.14
      yawGainDeg: 40
      pitchGainDeg: 30
      flipYaw: 1
      flipPitch: -1
      maxStepDeg: 4
      moveSpeedDps: 90
      lostHoldMs: 1000
      scanDwellMs: 900
      scanYaw: [-35, 0, 35]
      scanPitch: [35, 25]

vision:
  attentionDetection:
    enabled: true
    provider: onnxruntime
    modelFamily: pinto441-yolox-body-head-hand-face-dist
    modelPath: ../models/pinto441/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx
    inputWidth: 320
    inputHeight: 256
    headConfidenceThreshold: 0.35
    faceConfidenceThreshold: 0.35
```

`deadZone` は中央状態へ入る閾値、`deadZoneRelease` は中央状態から離れる閾値であり、
`deadZoneRelease >= deadZone` を必須とする。`maxFrameAgeMs` はgatewayが記録した
`receivedAtMs` から制御判断時点までの上限である。各値は設定可能な運用パラメータで、
testsはproduction既定値の数値そのものではなく、明示した入力に対する境界と挙動を検証
する。

`bearerTokenEnv` は secret 自体ではなく環境変数名である。環境変数が未設定なら起動時
または明示 field harness 実行時に fail closed する。別 provider や unauthenticated
接続へ切り替えない。

## 検出と対象選択

1. score が threshold 未満の row を除く。
2. class ID 1 と 3 以外を除く。
3. 座標を model input size から撮影画像 size へ scale し、0..1 に正規化する。
4. face detections があれば最大面積ではなく、`score * sqrt(area)` が最大の face を選ぶ。
5. face がなければ同じ式で head を選ぶ。
6. label は `head` または `face` の固定値であり、個人名や identity field を持たない。

## 追従状態

### acquire

interaction start で optical home へ移動し、最初の frame を取得する。対象があれば
即座に track へ移る。対象がなければ scan pose を1つずつ進める。

### track

選択 box の中心と画像中心の差を正規化して求める。中央状態でないときは両軸が
`deadZone` 内へ入ると中央状態になり、中央状態ではどちらかの軸が
`deadZoneRelease` を越えるまで動かさない。これにより境界付近の細かな方向反転を
抑える。

中央状態外では制御参照姿勢に比例stepを加え、`maxStepDeg` と mechanical range で
clampして整数角度を送る。`move_head` には `moveSpeedDps` を明示し、
firmware の固定 600ms 補間に依存しない。既定の 90°/秒は実機で確認済みの滑らかさ
下限 72°/秒以上、firmware の安全上限 240°/秒以下であり、4°の追従 step は約45ms
で補間される。

### command pipeline

- captureとinferenceのtickは同時に1件だけ実行し、前のtickが未完了なら次のtickを
  開始しない。
- frameのsequenceが直前の制御判断以下、または判断時点のframe ageが
  `maxFrameAgeMs`を超える場合、その観測は状態更新にもhead commandにも使わない。
- head command送信時に、制御参照姿勢をRPC完了待ちせずin-flight targetへ進める。
- head command実行中に新しい観測が完了した場合、in-flight targetを基準に最新の
  desired effectを計算し、pending slotを置換する。pendingから再帰的に姿勢を積み増さ
  ない。
- 最新観測が中央状態またはholdを示した場合、未送信のpending moveを消去する。
- in-flight command成功後は、pendingがあれば追加撮影をせず直ちに1件だけ送信する。
  pendingがなければ次の定期tickを待つ。
- in-flight command失敗時は最後に成功した姿勢へ制御参照を戻し、その失敗した姿勢を
  基準に計算済みのpendingを捨てる。次の新しい観測で再計算する。
- stop開始時はpendingを捨て、以後のcommand dispatchを禁止する。最大1件のin-flight
  commandをdrainしてからhomeへ戻る。

### hold と scan

対象を失って `lostHoldMs` までは最後の姿勢を保持する。その後は最後に検出した姿勢に
近い scan pose から bounded scan を行う。scan は設定された yaw/pitch の直積だけを
循環し、機械範囲外へ出ない。観測周期と scan の移動周期は分離し、同じ scan pose に
`scanDwellMs` 滞在してから次へ進む。これにより、8Hzで顔を探し続けながら、見回し動作
は約0.9秒ごとの落ち着いた動きに保つ。

### stop

interaction end、runtime shutdown、明示 field harness 終了では capture loop を止め、
進行中の tick を drain してから optical home へ戻す。stop は冪等である。

## 注視ステータス

runtime と interaction owner の `status()` は、画像を保存せずに次の一時状態を返す。

- `mode`: `acquire`、`track`、`hold`、`scan`
- `targetVisible`: 最新フレームで face または head が選択されたか
- `targetFrames`: 起動後にtargetが選択されたframe数
- `centeredFrames`: target中心がdead zone内だったframe数
- `lastTarget`: 最新targetのlabel、confidence、正規化中心座標、水平・垂直誤差、
  `centered`、観測時刻、status取得時点のage
- `flow`: frame sequence、stale frame破棄数、pending置換・送信数、in-flight有無、
  pending depth

targetを失ったframeでは `targetVisible=false` とし、`lastTarget` は再取得判断用ではなく
operator確認用の最新1件だけをprocess memoryに残す。画像byte、bounding box全体、
detection配列、個人識別子は保持しない。runtime終了でこの状態は破棄する。

field follow reportで永続化する人物由来の集計は `targetFrames`、`centeredFrames`、
`centeredRatio` だけとする。sequence、frame age、pending depthなど人物と無関係な
制御フロー指標は記録してよい。最新target座標やconfidenceはreportへ永続化しない。

## エラー処理

- 同時 tick を許可しない。
- 同時head commandを許可せず、pending depthは常に0または1とする。
- capture timeout、MCP error、malformed tool result、missing file、oversized file、
  inference error は status に記録し、次の interval まで head を動かさない。
- error に token、capture path、画像 byte、tool body を含めない。
- MCP transport error は固定 code/message に変換し、raw exception を上位へ渡さない。
- process内のStackChan captureはcapture lane、head moveはmove laneで個別にFIFO
  直列化する。異なるadapter間でも同種操作は重ねないが、captureとhead moveは相互に
  待たせない。各requestのtimeout/cancellationはlane取得待ちから開始し、期限切れの
  waiterをqueueから除去する。取消済みwaiterは後からlaneを取得して実行してはならない。
  MCP callは同じ残余deadline内で完了させる。
- optional attention failure は resident voice conversation を終了させない。
- 連続した error による provider fallback は行わない。
- MCP client close と home return failure は bounded shutdown result に含める。

## 会話 lifecycle

新しい timed interaction が作られた直後に attention runtime を非同期開始する。同じ
interaction の次 turn では再起動しない。interaction ending cleanup で停止し、
process shutdown でも必ず停止を試みる。

追従処理は Pi prompt、STT、TTS、playback の critical path に入れない。開始失敗や
途中失敗で会話を fail させない。
会話中のscene captureはattention moveと並行して最新frameを取得できる。意図的に静止した
scene captureが必要になった場合は、暗黙のglobal laneではなくinteraction ownerへ明示的な
pause/resume契約を別途設計する。

## Field validation

### Camera grid

明示的な live flag を必要とする field harness で stream lease を取得し、home と
bounded scan poses を順に評価する。各 pose では直前より新しい latest frame を読み、
次だけを JSON report に残す。

- pose
- JPEG dimensions と byte count
- capture、inference latency
- head count、face count、selected label、confidence
- box center と coverage

gateway は各 device の最新1枚だけをメモリ上に保持する。画像は report へ埋め込まず、
lease 解放または session 終了後に Pico は保持しない。

### Follow run

別の bounded harness で duration と max frames を必須指定し、start、track、lost、
stop を実機で確認する。少なくとも1 frameを処理しなければfail closedとし、終了時に
home angle を読み戻す。自然さの判定では、実効処理周期、move回数、エラー、受信frame
数、置換frame数、frame freshness、推論時間を記録する。画像自体は保存しない。

人物が不在の自律検証では、次を実施できる。

- synthetic detection sequence により dead zone、最大step、loss hold、scan dwell を
  deterministic test で確認する。
- 実機で bounded scan、明示速度、home復帰、camera streamとの同時動作を確認する。
- 125ms観測でframe interval、decision時frame age、stale破棄、pending深さ、
  camera/move相互待ち、中央率を測定する。

実人物またはカメラ視野内の顔画像がない場合、「顔を自然に追う」主観評価だけは未判定
として report に明記し、機械・性能検証の合否と混同しない。

## 完了条件

- postprocessed PINTO rows を正しく head/face detection に変換する unit tests が通る。
- acquire、dead zone、bounded step、lost hold、scan、idempotent stop の tests が通る。
- `move_head` に 15..240°/秒の明示速度を渡し、範囲外設定をfail closedにする。
- scan pose は観測ごとではなく `scanDwellMs` ごとに進み、観測自体は継続する。
- latest frame reader が malformed metadata、HTTP error、oversized response を
  fail closed にする。
- resident interaction start/end と attention start/stop の lifecycle tests が通る。
- captureが未完了でもhead moveを開始でき、head moveが未完了でもcaptureを開始できる。
- head move実行中は最新pending 1件だけを保持し、中央またはhold観測でpendingを消去する。
- 制御参照姿勢がcommand送信時に進み、command失敗時は最後の成功姿勢へ戻る。
- `maxFrameAgeMs`を超えるframeと重複sequenceからhead commandを送らない。
- camera grid report が実機画像を少なくとも3 poseで評価する。
- bounded follow run が uncontrolled movement なしで終了し、home pose へ戻る。
- runtime/owner statusで最新targetの中央判定とageを確認できる。
- field follow reportでtarget frame数、centered frame数、centered ratioを確認できる。
- 125ms設定の30秒実機runでtick errorがなく、観測interval p95が150ms以下、
  p99が200ms以下になる。
- decision時frame ageがp95 140ms以下、p99 180ms以下で、古いframeからのdispatchが
  0件になる。
- pending depthが1を超えず、cameraとhead moveの相互待ちが0件になる。
- 人物を用いたrunのcentered ratioが暫定65%以上になる。最終目標75%はこのslice後の
  tuningまたはgateway/firmware変更判断に使い、今回の機械検証と混同しない。
- `just check` と `npx secretlint .` が通る。

## 今回行わないこと

- 顔認証、identity matching、児童追跡
- camera frame または detection history の永続化
- Pico からの firmware transport の置換
- Pico 内の独自 camera streaming protocol
- このspec内でのgateway controllerまたはfirmware setpoint mailboxの追加。後続sliceでは
  gateway内の非同期latest-only laneだけを追加し、firmware mailboxは追加しない。
- 予測器、Kalman filter、複数frame連続判定
- health-based provider fallback
- 複数人物間の identity continuity
