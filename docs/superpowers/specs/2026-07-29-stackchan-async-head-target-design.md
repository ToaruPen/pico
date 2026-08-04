# StackChan Async Latest Head Target Design

## 目的

Pico の人物追従で、ローカル MCP `move_head` が ESP32 の応答を待つ時間を制御loopから
分離する。gateway は未送信の頭部姿勢を最新1件だけ保持し、実機への送信を安全な頻度へ
制限する。古い補正を後から順番に再生せず、停止後の指令も送らない。

このsliceはサーボの安全範囲、PINTO検出、camera stream、Picoの125ms観測を変更しない。
画像、検出座標、人物情報をgatewayへ追加送信または永続化しない。

## 根拠

2026-07-29の実機測定では、1°、2°、4°の`move_head` RPCは90、120、150°/秒の
いずれも通常約80〜88msだった。速度を150°/秒へ上げてもRPC時間は短縮せず、
約1.19秒の外れ値が1回発生した。4°移動の理論補間時間は90°/秒で約44ms、
120°/秒で約33msなので、速度変更だけで短縮できるのは約11msである。

camera streamは既存のrefcounted Wi-Fi power-save leaseで`none`を取得するため、
追従中のWi-Fi省電力無効化は既に実施されている。

既存`stackchan_follow_pose_stream`は任意の外部WebSocket姿勢streamを購読する機能である。
20Hz診断では通常MCP要求が10秒以内に完了せず、Pico専用経路としてそのまま流用すると
device callを占有することを確認した。外部WebSocket server、センサー座標変換、
moving averageも今回の顔追従には不要である。

## 選択肢

### A. `moveSpeedDps`を120または150へ上げる

変更量は最小だが、RPC待ちを短縮しない。小さい補正を速く動かすことで視覚的な鋭さは
増える一方、細かな動きが硬くなる可能性がある。今回の主要改善には採用しない。

### B. 既存`stackchan_follow_pose_stream`へPico姿勢を流す

gateway側の高頻度経路を再利用できるが、Picoが新しいWebSocket serverを所有する必要が
ある。20Hzで通常MCPを待たせた実測結果があり、停止、status、homeの制御境界も二重になる。
採用しない。

### C. gateway内に非同期latest-only head-target laneを追加する

認証済みMCP updateはvalidationと最新slot置換だけを行って即時応答する。bounded workerが
ESP32 callを最大10Hz、同時最大2件で送り、device応答待ちの間も新しいupdateでpendingを
置換できる。
既存camera streamやPico runtimeの境界を保ったまま残存待ちを分離できるため採用する。

## 所有境界

### gateway head-target lane

- 最大2つのactive device callと、0または1つのreplaceable pending targetを所有する。
- start時に現在角度を読み、gatewayのconfirmed poseをseedする。
- start時はplanned poseも同じ読取角度でseedし、dispatch開始順の未確認endpointを表す。
- refcounted Wi-Fi power-save leaseを取得し、stop時に解放する。camera streamと同時利用
  しても最終holderが終了するまで元のmodeへ戻さない。
- pending targetを最大10HzでESP32へ送る。
- device replyはdispatch開始順にcommitし、順序が逆転して到着してもconfirmed poseを
  新しいreplyから先に進めない。
- 先行failureがないdevice call成功時だけconfirmed poseとconfirmed sequenceを進める。
- device call失敗時はpipelineをfail closedし、confirmed poseを失敗targetへ進めず、
  失敗targetを自動再送しない。
- pending targetはplanned poseから各軸`maxStepDeg`以内へ再clampしてから送る。
- 再clamp結果がplanned poseと同じでもactive callが残る間は破棄せず保留する。未確認endpointが
  confirmed poseから離れている場合、同じ数値のtargetが必要な反転指令になり得るためである。
  active callがなく同じplanned poseとなるtargetだけをprovably redundantとして破棄する。
- pending ageが設定上限を超えた場合は送信せず破棄する。
- stop開始時に新規updateを拒否してpendingを消去し、active callをbounded drainする。
- 角度系列や人物由来データを永続化しない。

### Pico StackChan module

- head-target laneのtyped lifecycle wrapperを所有する。
- `start`で返るopaque lease IDをinteraction内だけ保持する。
- tracking、hold、scanのabsolute targetを単調増加sequence付きでsubmitする。
- update acknowledgmentをdevice move完了として扱わない。
- stop時はlaneを先に停止し、drain成功後に既存`move_head`でhomeへ戻す。
- laneが利用できない場合に通常`move_head`へ自動fallbackしない。

### Pico attention controller/runtime

- 現行の検出、dead-zone hysteresis、125ms観測、frame freshness判定を維持する。
- 画像上の誤差は実機姿勢から観測されるため、laneのconfirmed poseを次の制御基準とする。
  accept済みでも未確認のabsolute targetを制御基準へ加算しない。
- controllerの観測基準とgatewayのdispatch基準を混同しない。controllerはconfirmed pose、
  gatewayのbounded trajectory frontierはplanned poseを使う。
- 中央またはhold判断では未送信targetをlaneから明示的にclearする。
- runtime statusへlaneの集計counterを投影するが、画像やtarget座標系列を保存しない。

## MCP契約

新しいgateway tool名は`stackchan_head_target_lane`とする。既存`move_head`と
`stackchan_follow_pose_stream`の意味は変更しない。

### `action=start`

入力:

- `rate_hz`: 1以上10以下。Pico production値は10。
- `max_step_deg`: 0より大きく30以下。Pico production値は4。
- `max_pending_age_ms`: 50以上500以下。Pico production値は180。
- `speed_dps`: 15以上240以下。Pico production値は90。

同時に1 leaseだけを許可する。成功時に推測不能なopaque `lease_id`、seed済み
confirmed pose、初期counterを返す。既存leaseがある場合は置換せずfail closedする。

### `action=update`

入力:

- `lease_id`
- 0以上のsafe integer `sequence`
- safe range内の整数`yaw`、`pitch`

sequenceはlease内で単調増加でなければならない。handlerはtargetをpending slotへ保存または
置換し、device応答を待たずに`accepted`、`replaced`、`pending_depth`を返す。

### `action=clear`

対応するleaseのpendingだけを消去する。最大2件のactive device callは取り消さない。中央判定または
holdへ移ったとき、まだ送られていない補正を無効化するために使う。

### `action=status`

次だけを返す。

- phase、lease ID一致
- accepted、replaced、dispatched、confirmed、failed、stale-discarded件数
- active call数、pending depth、それぞれの最大値
- last accepted/confirmed sequence
- confirmed pose
- update acknowledgment、pending age、device dispatch latencyの集計
- last bounded error

時系列、個々のtarget一覧、人物情報は返さない。

### `action=stop`

対応するleaseをstoppingへ移し、pendingを消去し、最大2件のactive callを既存device timeout内で
drainする。drain後にWi-Fi power-save leaseを解放する。stop完了後のdispatch件数が
増えないことをcounterで確認できる。stopは同じleaseに対して冪等とする。

## 状態遷移

1. Pico interaction開始時にcamera streamとhead-target laneを開始する。
2. laneは現在角度を読み、confirmed poseをseedする。
3. Picoは新しいframeだけを検出し、absolute targetを`update`する。
4. update handlerはpendingを置換して即時応答する。
5. workerはrate limit、pending age、lease generation、active上限2件を確認し、planned pose基準で
   1件をdispatchしてplanned frontierを進める。
6. device replyはdispatch開始順にcommitする。成功ならconfirmed poseを進め、失敗ならpipelineを
   fail closedする。
7. 中央またはholdではPicoが`clear`する。
8. interaction終了では観測を止め、`stop`をdrainし、既存`move_head`でhomeへ戻す。
9. camera leaseを解放し、最後のWi-Fi power-save holderが元のmodeへ戻す。

## エラー処理

- unknown action、未知field、範囲外角度、重複sequence、異なるlease IDをfail closedする。
- updateはlane停止中、開始前、stopping中に受理しない。
- device call失敗targetを暗黙retryしない。
- worker crash時はpendingを消去してlaneをfailedへ移し、以後のupdateを拒否する。
- stop drainが失敗した場合、Picoは成功として扱わず、通常command transportへfallback
  しない。runtime errorへ記録する。
- process shutdownでも同じstop cleanupをbest effortで実行する。

## 設定

Picoのfollow設定へ明示的なtransport選択を追加する。

```yaml
camera:
  stackchan:
    follow:
      commandTransport: async-latest
      commandRateHz: 10
      moveSpeedDps: 90
      maxStepDeg: 4
      maxFrameAgeMs: 180
```

`async-latest`選択時にgateway toolがなければ起動を失敗させる。旧gatewayや通常
`move_head`へ自動fallbackしない。parser testは値を明示し、既定値のliteralを固定しない。

## テスト

### gateway deterministic tests

- start seed、単一lease、opaque lease ID
- sequence重複・逆行拒否
- active最大2件中のpending置換、maximum active calls 2、maximum pending depth 1
- 10Hz rate limit
- pending age超過破棄
- planned pose基準のmax-step再clamp
- out-of-order replyのdispatch順commit
- 未確認endpointからconfirmed側へ戻るin-flight reversalをno-op破棄しない
- active中のplanned-pose一致target保留と、idle時だけのprovably redundant破棄
- device failure時のconfirmed pose維持、pipeline fail closed、自動retryなし
- clear、stop drain、stop後dispatch 0
- Wi-Fi power-save refcountの取得・復元
- statusに時系列や人物fieldを含めない

### Pico deterministic tests

- typed lifecycleとtool error containment
- update acknowledgmentをdevice成功として扱わない
- absolute target sequenceとclear
- stop lane、homeの順序
- unavailable toolのfail closed
- runtime counter投影と画像非保持

### 実機field tests

- 125ms観測、20fps camera、PINTO 441-S Dist
- synthetic targetで通常followと同じ8Hz update負荷
- 20Hz update stress中もstatusとstopがtimeoutしない
- error 0、home復帰、camera interruption 0
- reportはmode `0600`、画像なし

## 完了条件

- update acknowledgment p95が25ms以下、p99が50ms以下。
- 125ms controlでaccepted update rateが7.8Hz以上。
- device dispatch rateが7.5Hz以上で、camera observation rateの95%以上。
- active device callが2、pending depthが1を超えない。
- pending accepted-to-dispatch ageがp95 150ms以下、p99 180ms以下。
- 180msを超えたpendingからdevice dispatchしない。
- 20Hz update stress中のstatus p95が100ms以下で、10秒timeoutを起こさない。
- stop後dispatch、stop後pending dispatch、重複sequence dispatchがすべて0。
- final poseがhomeの各軸±1°以内。
- `just check`、gateway `pytest`、`ruff`、secret scanが通る。
- 実人物A/Bでは現行latest-winsを対照とし、停止中の不要動作と追従の主観評価を別々に
  記録する。主観評価は機械ゲートの代替にしない。

## 今回行わないこと

- firmware変更またはサーボ交換
- 150°/秒以上へのproduction速度変更
- Pico内のWebSocket pose server
- 既存`stackchan_follow_pose_stream`の流用または意味変更
- 20Hzを超えるSCS0009書き込み
- Kalman filter、人物identity、画像保存
- 通常`move_head`への自動fallback

## 次段階の根本改善

今回の変更は、ネットワーク応答待ちを制御loopから分離し、有限のplanned frontierで指令列を
安全に構成するものである。物理的な速度・加速度・jerkを直接保証するtrajectory generatorでは
ない。より根本的に滑らかさを高める次段階では、visual target estimatorと固定周期のactuator
trajectory generatorを分離し、後者が現在のposition/velocityを保ったままretargetできる
jerk-limited軌道を生成する。評価にはtarget errorだけでなく、反転要求から新方向のdispatchまでの
response latency、confirmed velocity total variation、acceleration、jerkを併用する。

この分離はRuckigのようなonline trajectory generationで一般化されているが、導入はservo実測、
制御周期、許容速度・加速度・jerkを決める別sliceとする。今回のlaneへ暗黙fallbackや別policy layerを
追加する形では実施しない。
