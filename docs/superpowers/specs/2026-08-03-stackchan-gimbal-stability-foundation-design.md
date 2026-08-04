# StackChanジンバル安定検証基盤設計

## 目的

人物追従の滑らかさ調整を一時停止し、同一条件の実機試験が同じ結果を返す基盤を先に確立する。既知の滑らかな制御器を固定したまま、camera、WebSocket制御、Gateway head-target lane、firmware servoを別々に判定し、最初に壊れる境界だけを修正する。

この設計では新しいruntime service、汎用queue、別の制御器を追加しない。既存のcamera credit、latest-only frame、one-active head-target lane、servo native telemetry、field harnessを再利用する。

## 現在の証拠

- 検出器は固定時50/50、pitch 23度への移動直後43/50、整定後49/50で、推論p95は約19 ms、capture-to-command p95は24--36 msだった。検出と推論は主因ではない。
- camera-only 8 fps / 20秒は143 frameを受信し、p95間隔182.6 ms、最大間隔1,241.82 msだった。
- 同じ8 fps、同じ追従設定の20秒runは69、130、92 frameへ変動し、最大観測間隔は7.4、1.2、2.1秒だった。
- 3回目の複合runだけhead laneが1回失敗し、同じhead commandのyaw/pitch native servo ACKも失敗した。
- 20 fpsでは画像を受信できても`start_stream`応答が返らず、制御面と媒体面のhead-of-line blockingが観測された。
- control/mediaを別WebSocketに分けた後も、firmwareのmain taskがcamera `SendBinary`を同期実行していたため、stream停止後のWiFi power-save復帰が約10.8秒遅れた。USB時刻とGateway tool timeoutが一致し、main task starvationを直接確認した。
- camera送信を専用latest-only laneへ移した後、40 frame取得は8.9秒、欠落0、停止直後の状態確認も即応した。USB併用の再測定は7.1秒、capture wait p95 201 ms、最大447 ms、欠落0だった。
- 同時小振幅yaw試験は40 frame、9.6秒、欠落0で完了し、走行開始後のhead commandは継続して受理された。終了後はcamera停止、yaw -1 / pitch 33、auto-sleep falseを確認した。
- active 2は遅延応答を自己増幅したためactive 1を維持する。
- controllerの全量補正、7度lookahead、未確認planned pose累積は実機で不合格のため再導入しない。

## 構造上の原因仮説

根因は二段あった。

1. camera JPEGとMCP応答が同じWebSocket、send mutex、TCP送信を共有していた。
2. media socketを分離しても、`Application` main taskがcamera `SendBinary`を同期実行していた。

このためcamera送信が詰まると、MCP response、head lane apply reply、停止処理、WiFi power-save復帰まで同時に遅れた。creditを1または2へ変えるだけでは間欠を除去できず、短いtransport stallがrun全体の長い停止へ増幅された。

採用した最小構造は次の通りである。

- 既存Gateway endpointへ、同じBearer認証とdevice identityを使うcamera専用WebSocketを1本追加する。
- control socketはMCP text/audio、media socketはcamera creditとSCL1 binaryだけを扱い、controlへのfallbackは持たない。
- firmwareは既存の1-slot latest-only packetを専用sender threadでflushする。capture側のpublishは待たず、置換したpacketのcreditを返す。media分離後は8 fpsのround-trip待ちを避けるため4 creditへ戻すが、未送信packetの保持は1枚のままである。
- sender laneの所有者がpublishとresetを排他し、reboot/destructorとの競合によるuse-after-freeを防ぐ。blocking senderのjoinはowner mutex外で行う。
- head target laneはactive 1のまま維持する。

第二候補はdevice task競合である。camera stream threadとservo taskはいずれもpriority 5で、JPEG encodingはcamera thread上の同期処理である。ただしこれはWebSocket送信境界を安定させた後もservo ACKだけが失敗する場合に限って調べる。

## 採用する進め方

### 1. 制御器を凍結する

既知滑らか基準のface/head選択、125 ms観測、10 Hz command、yaw gain 44、pitch gain 30、round、filter無効、最大4度、90 deg/s、active 1を固定する。滑らかさの改善値は安定性gateを通るまで変更しない。

### 2. 既存field harnessを決定的な複合試験へ揃える

`scripts/field/stackchan-servo-latency.ts`のcamera contention試験を所有者とする。新しい独立harnessは作らない。

- homeはyaw 0 / pitch 33。
- 動作はpitch固定、yawを小振幅の+3 / 0 / -3 / 0度で繰り返す。
- 各runは20秒とし、camera off、camera 8 fps、camera 8 fps + PINTO推論を別条件として測る。
- camera frame間隔、MCP応答時間、head lane状態、native servo ACK、WebSocket切断、stop時間、実測homeを同じreportへ集約する。
- field reportの成功件数は物理到達確認と呼ばない。servo native ACKと独立した実角度を別に記録する。

### 3. 最初に壊れる境界だけ直す

credit 1、credit 2、production latest-only lane、cached seed readの順に一変数A/Bし、いずれもcamera送信中のcontrol starvationを除去しなかった。USBとGatewayの時刻が同期送信を指した段階で、control/media socket分離とfirmware専用sender laneへ進んだ。4 creditは共有socket上では保留したが、媒体を分離して保持slotを1枚に固定した後はcapture cadence用のbaselineとして復帰した。

head lane内部の`planned_pose`はactive call上限1のdispatch baseであり、2本目は1本目の成功replyが完了するまでdispatchされない。失敗時はpendingを破棄してlaneをfail-closeする。このため、実機で暴走した「複数の未確認planned poseを累積する方式」には戻っていない。

新しい汎用queue、retry、fallback、recovery stateは追加しない。媒体側は1-slot latest-onlyだけを所有し、control側の既存latest-only head laneとは責務を分ける。

camera cadenceとMCP応答が安定しているのにnative servo ACKだけが落ちる場合は、camera threadとservo taskのpriority/CPU競合を次の単一変数とする。証拠なしにservo spring、速度、ゲインを変えない。

### 4. 安定性gate

同じcamera 8 fps + 小振幅servo複合runが3回連続で次を満たしたときだけ人物追従A/Bへ進む。

- WebSocket切断0。
- MCP、head lane、native servo ACKの失敗0。
- camera frame最大間隔500 ms以下。
- head lane active call最大1、pending最大1。
- pitch 23度未満の指令0。
- 各run後にcamera停止。
- 実測home誤差はyaw/pitchとも1度以下。
- `auto-sleep=false`を各run後に実測確認。
- stopとhome復帰が5秒以内に完了する。

gate値を満たさないrunを再試行で隠さない。失敗した境界、最初の異常時刻、その前後のframe/MCP/native writeをreportへ残し、その時点で次の条件へ進まない。

## 棄却する案

- 8 fps固定、prewarm、再試行だけを安定化とみなす案。同条件runの大幅な変動とACK失敗を解消しない。
- head lane active 2への復帰。遅延中のin-flight requestを増やし停止を自己増幅した。
- 証拠なしに制御用と媒体用WebSocketを分離する案。creditとproduction laneのA/B後に共有送信境界が根因と確定したため、現在は分離を採用した。
- 一時的なtransport stallを多数のretry、fallback、recovery stateで覆う案。原因を隠し、比較条件を増やす。
- detector、target association、gain、springを同時に変更する案。安定性と滑らかさの効果を分離できない。

## 人物追従への復帰

安定性gate通過後、既知滑らか基準をbaselineとして20秒の自由追従を実施する。ユーザーの滑らかさ、追従速度、逆方向、急跳び、固まりを一次評価とし、一度に変更する変数は一つだけとする。数値上のframe率やapply reply件数だけで合格としない。

2026-08-03の20秒runはcontrol 44/44成功、active 1、ack p95 5 ms、終了直後も即応したが、target frameは0だった。一時画像はほぼ全面が暗く、pitch 33と23で同一視野だったため、cameraはジンバルと連動しておらず、現在は人物が写らない物理方向を向いているか遮蔽されている。これは人物追従の主観判定には使わない。一時画像は確認後に削除した。

## 追補: 専用media lane後に残った境界

専用control/media WebSocketとfirmware latest-only sender laneは、camera送信によるcontrol main taskのstarvationと未送信frameの滞留を除去した。一方、2026-08-04のproducer/consumer同時計測では、firmwareが52 frameをencode failure 0で生成した間にGatewayが受信したのは40 frameで、sequence 37から49への飛びを観測した。最大待ち1,527.81 msは実機の`CONFIG_LWIP_TCP_RTO_TIME=1500`と一致する。servo側の同時command ACKは約75--90 ms、native writeは最大877 microsecondsだった。

したがって、残る間欠停止は検出器、JPEG encode、servo spring、head laneではなく、すでに送信中のcamera frameがreliable TCPの再送待ちに入る境界である。1-slot latest-onlyは送信前の古いframeを置換できるが、同期`send()`へ入ったframeを中断できない。この制約を制御器のgain、step、filter、retryで隠さない。

TCP_NODELAYは1,500 ms停止の説明にならないため、試験実装をflash前に撤回した。RTO短縮は全TCP socketへ影響する緩和策であり根治ではないため採用しない。根治を行う場合は、camera mediaだけをabort可能またはunreliableなlatest-frame transportへ変える設計判断として別途扱う。

既知の滑らかなincremental controllerを復元し、user評価が「以前よりは良い」から「ずっといい感じ」へ改善した時点を新しい受入baselineとする。以後、transportの設計変更なしにcontroller値を追加調整しない。

## 安全と運用

- 実機動作はユーザー在席時だけ行う。
- 新しい実機試験ではpitch 23度未満を指令しない。
- 各run後にhome、camera停止、`auto-sleep=false`を実測する。
- firmware flashは正規の`release.py stackchan` buildから`xiaozhi.bin`だけを書き、NVSを保持する。現実機は`ota_1`（0x410000）から起動しているため、この実機への検証投入は0x410000を使う。0x20000への書込みは現在の起動imageを更新しない。
- 明示依頼がないためcommitしない。
