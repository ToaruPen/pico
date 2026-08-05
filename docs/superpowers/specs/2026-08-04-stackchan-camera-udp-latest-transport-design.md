# StackChan camera UDP latest-only transport設計

> **Historical rejected design — non-executable.** The original SCU1 draft below is retained as
> investigation history. It must not be implemented or deployed without the AEAD, stream-epoch,
> nonce-uniqueness, and replay-window requirements added to this document.

## 目的

人物追従で残る間欠停止を、camera媒体だけを再送しないlatest-only datagramへ移すことで除去する。既知の滑らかな人物追従制御器、MCP control、音声WebSocket、servo spring、Gateway head-target laneには変更を加えない。

実測ではfirmwareが52 frameをencode failure 0で生成した間にGatewayが40 frameを受信し、sequence 37から49への飛びと1,527.81 msの停止を観測した。この停止は`CONFIG_LWIP_TCP_RTO_TIME=1500`と一致する。現在の1-slot latest-only senderは送信前の古いframeを置換できるが、同期TCP `send()`へ入ったframeを中断できない。本設計はこの境界だけを置き換える。

## 非目的

- 人物検出、target association、gain、dead zone、最大step、filter、command rateを変更しない。
- control/audio transportを変更しない。
- TCP RTO短縮、TCP_NODELAY、retry、fallback transportで停止を覆わない。
- 汎用datagram framework、汎用queue、永続store、recovery serviceを追加しない。
- camera frameの完全配送を保証しない。欠損した古いframeは配送せず、次のframeを優先する。
- internet越しの汎用media transportやDTLSを設計しない。既存の保護されたlocal Gateway境界を維持する。

## 固定する受入baseline

- camera: 8 fps、JPEG quality 60。
- controller: face/head対象、125 ms観測、10 Hz command、yaw gain 44、pitch gain 30、round、filter無効、最大4度、90 deg/s。
- Gateway head-target lane: active最大1。
- pitch指令: 23度未満を禁止。
- `auto-sleep=false`を維持する。
- user評価「ずっといい感じ」の状態をbaselineとし、transport検証中はcontroller値を変更しない。

## 採用方式

camera専用WebSocketは認証、session確立、datagram設定通知、切断検知だけに残す。JPEG binaryとframe creditはUDPへ移す。control/audio WebSocketは現状のまま別socketで維持する。

Gatewayとfirmwareは`camera_datagram_v1` capabilityを明示的にnegotiationする。片側が未対応の場合はcamera stream開始を明示的に失敗させ、旧WebSocket binary経路へfallbackしない。firmwareとGatewayは一組として更新する。

## session確立

1. firmwareは既存Bearer、Device-Id、Client-Idでcamera専用WebSocketへ接続する。
2. Gatewayは接続中control sessionのdevice identityとcamera WebSocketのdevice identityが一致することを確認する。
3. Gatewayはcamera WebSocket接続ごとにCSPRNGで128-bitのsession tokenを生成する。tokenをlogへ出力しない。
4. Gatewayはcamera WebSocketで次の設定を送る。
   - type: `camera_datagram_config`
   - version: `1`
   - UDP port
   - datagram最大長: `1200`
   - 32桁hex session token
5. firmwareは現在接続中のGateway candidate URLからhostを取得し、既存`NetworkInterface::CreateUdp()`で通知portへ接続する。
6. firmwareはtokenだけを含むUDP helloを送る。
7. Gatewayはtokenとcamera WebSocket peerのsource IPが一致したhelloだけを受理し、そのsource endpointをsessionへ固定する。
8. UDP helloが1秒以内に成立しなければcamera media sessionを失敗させる。TCP binaryへのfallbackは行わない。

同じ数値portをTCP WebSocketとUDP listenerで共有できるが、wire上は別transportである。Gatewayは既存WebSocket bind hostと同じhost、設定通知したportへUDP listenerを一つだけ開く。

## wire format

すべてnetwork byte orderとし、magicはASCII `SCU1`、versionは`1`とする。session tokenは16 byte固定とする。

### 共通prefix

- magic: 4 byte
- version: 1 byte
- kind: 1 byte
- session token: 16 byte

kindは次の三つだけを受理する。

- `1`: frame chunk、firmwareからGateway。
- `2`: credit grant、Gatewayからfirmware。
- `3`: session hello、firmwareからGateway。

未知kind、version、長さ、tokenはpayload allocationより前に破棄する。

### frame chunk

共通prefixの後ろに次を置く。

- frame sequence: unsigned 32-bit
- chunk index: unsigned 16-bit
- chunk count: unsigned 16-bit
- full frame length: unsigned 32-bit
- full frame CRC32: unsigned 32-bit
- chunk payload

datagram全体は1,200 byte以下とする。分割対象は現在のSCL1 envelope全体であり、Gatewayで再構築後に既存SCL1 parserへ渡す。frame lengthは既存`MAX_CAMERA_FRAME_BYTES`以下、chunk countはframe lengthと最大payloadから算出される値と完全一致しなければならない。

chunkは順不同で受理し、同一chunkの重複は一度だけ数える。CRC32は配送保証や認証ではなく、再構築したframeの破損検出だけに使う。

### credit grant

共通prefixの後ろに1 byteのcredit数を置く。値は1から4だけを受理する。

Gatewayはactiveなcamera subscriberが存在する間、250 msごとにcredit 4を送る。firmware側の既存credit上限4により加算は4を超えない。これによりdatagram欠損時も次のgrantで回復し、Gatewayまたはsessionが消失した場合は最大4 frameでproducerが自然停止する。

## latest-only reassembly

Gatewayはactive device sessionごとに未完成frameを一つだけ保持する。

- より新しいsequenceのchunkを受けたら、未完成の古いframeを即時破棄する。
- 現在より古いsequenceのchunkは破棄する。
- 同じsequenceはchunk bitmapへ格納する。
- 全chunkが揃った場合だけCRC32とSCL1 envelopeを検証し、既存`LatestCameraFrameStore`へpublishする。
- 未完成frameは500 msを超えた時点で、次のdatagram処理またはstream cleanup時に破棄する。専用cleanup workerは追加しない。
- stream start、stop、session token変更、camera/control disconnectで未完成frameを消去する。

sequenceはstream startごとに1から始めるだけではepochを識別できない。各stream startで
128-bit random stream epochを生成してauthenticated WebSocket上で合意し、すべての
datagram headerへ載せる。Gatewayはcurrent epoch以外のchunk/creditをallocation前に
破棄し、restart前の遅延datagramを現streamへ混入させない。reassembly resetだけを
epoch境界としてはならない。

## firmware data flow

1. 既存camera workerがcreditをclaimし、JPEGとSCL1 envelopeを生成する。
2. 既存1-slot `CameraPacketSendLane`が未送信frameをlatest-onlyで保持する。
3. senderはSCL1 envelopeを1,200 byte以下のSCU1 chunkへ分割し、既存`Udp::Send()`で順に送る。
4. chunk送信失敗はそのframeを終了し、creditを返す。古いframeをretryしない。
5. UDP sessionが未確立、または受信token epochが現在のcamera WebSocket sessionと一致しない場合は送信を失敗させ、creditを返す。
6. WebSocket `SendBinary()`はcamera pathから外す。control/audio binaryの意味は変更しない。

managed componentへ新しいsocket APIを追加しない。既存`CreateUdp()`、`Udp::Connect()`、`Udp::Send()`、`Udp::OnMessage()`だけを使用する。

## Gateway data flow

1. Gateway起動時にWebSocket listenerと同じlifecycleでUDP listenerを開始する。
2. camera WebSocket認証成功時にtokenを生成し、UDP hello成立までsessionをreadyにしない。
3. `CameraStreamService.acquire()`はreadyなdatagram sessionを要求してから既存`self.camera.start_stream`を呼ぶ。
4. active subscriberが存在する間だけ250 msのcredit grantを送る。
5. 完成したSCL1 frameだけを既存frame storeへpublishする。frame受理ごとのTCP credit replenishmentは削除する。
6. release、idle expiry、camera/control disconnectではcredit taskを止め、assemblerをclearし、既存`self.camera.stop_stream`を呼ぶ。

UDP listener、session registry、assemblerはcamera moduleの責務とし、head-target、MCP request、audio moduleへ公開しない。

## failure handling

- 不正tokenまたはsource IP不一致: logへtokenを含めず破棄する。
- malformed header、過大frame、矛盾するchunk count: allocation前に破棄する。
- chunk欠損、順序入替、重複: 古いframeを待たず、次のsequenceを優先する。
- CRC32またはSCL1検証失敗: frameを破棄し、次のframeを受理する。
- UDP send失敗: 当該frameを破棄し、再送しない。
- camera WebSocket切断: tokenを無効化し、credit taskとstreamを停止する。
- control WebSocket切断: camera sessionも無効化する。
- firmware/Gateway capability不一致: camera startを失敗させる。旧TCP mediaへfallbackしない。

## security boundary

- session tokenは128-bit、camera WebSocket接続ごとにrotateし、process log、MCP response、field reportへ出力しない。
- Gatewayはtokenに加えてcamera WebSocket peerのsource IPとUDP source IPを一致させる。
- 不正datagramはpayload allocation前にrejectする。
- UDP portをinternetへ公開しない。既存Gatewayと同じ保護されたlocal/Tailscale境界でbindする。
- CRC32は偶発的な再構築破損の検出専用であり、認証ではない。
- authenticated WebSocketでstreamごとのkey materialと128-bit epochを合意する。frameと
  creditはdirection-separated keyを使うAEADでheaderとpayload全体を認証し、nonceを
  epochと単調datagram counterから一意に導出する。
- receiverはcurrent epochだけを受け入れ、directionごとのbounded replay windowで
  duplicate/old counterをrejectする。AEAD検証前にframe payloadをallocate/publishせず、
  token/source IP検査は追加のrouting filterとしてのみ使う。
- 利用するESP-IDF暗号primitive、key derivation、nonce layout、counter wrap/rekeyを独立に
  reviewし、C++/Python golden vectorとtamper/replay試験を通すまで本設計を実装可能としない。

## deterministic tests

### protocol単体

- C++とPythonで同一golden vectorを検証する。
- 1,200 byte上限、chunk index/count、network byte order、token、CRC32を検証する。
- zero length、過大frame、未知version/kind、短いheaderをrejectする。
- stream restart後に届いた旧epoch datagramをrejectする。
- header/payload改変、credit偽造、duplicate/old counter、direction違いのreplayをrejectする。

### Gateway reassembly

- 順番どおり、順不同、重複chunkから一つのframeを完成できる。
- 新sequenceが未完成旧sequenceを即時置換する。
- 古いsequence、期限切れ、CRC不一致、SCL1不正をpublishしない。
- 同時に保持する未完成frameが一つ、frame storeが一つである。
- token/source IP不一致ではbufferを確保しない。

### lifecycle

- UDP hello前はcamera streamを開始しない。
- acquire後だけcredit taskが動き、release、idle expiry、disconnectで止まる。
- datagram欠損後も次のcredit grantと新sequenceを処理できる。
- media/control切断でassembler、token、source endpointをclearする。
- 旧WebSocket camera binaryへfallbackしない。

### firmware host

- SCL1 packetを1,200 byte以下へ決定的に分割する。
- 一つのchunk送信失敗後に残りchunkや旧frameをretryしない。
- newer frameが既存1-slot上のunsent frameを置換する。
- invalid credit、token、session epochをrejectする。
- camera datagram変更がhead spring、auto-sleep、MCP dispatchテストへ影響しない。

## 実機A/B

実機試験はuser在席時だけ行う。各試験前後にcamera停止、home指令yaw 0 / pitch 33、実測pose、`auto-sleep=false`を確認する。pitch 23度未満を指令しない。

1. camera-onlyで40 frameを取得し、frame sequence、待ち時間、CRC/assembly dropを記録する。
2. pitch 33固定、yaw +15 / 0 / -15の小振幅を加えた40 frame試験を3回連続で行う。
3. 3回すべてでWebSocket切断0、servo command失敗0、encode failure 0、camera wait最大500 ms以下を要求する。
4. gate通過後に既知baselineの20秒人物追従を一回行う。
5. userの滑らかさ、追従速度、逆方向、急跳び、固まりを一次受入条件とする。frame数だけで合格にしない。

失敗runを再試行で隠さない。最初の異常sequence、assembler drop理由、camera wait、servo ACK、session状態を同じreportへ残す。

## 採用しない変更

- TCP RTO、Nagle、WiFi power-save、JPEG quality、camera fpsを同時に変更しない。
- controllerやservo springをtransportの補償目的で変更しない。
- UDP上で古いcamera frameを再送しない。
- FEC、DTLS、QUIC、WebRTC、複数device registryを今回追加しない。
- 明示依頼がないためcommitしない。
