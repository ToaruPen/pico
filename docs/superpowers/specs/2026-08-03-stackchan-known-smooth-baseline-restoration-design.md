# StackChan既知滑らか基準復元設計

## 目的

2026年8月1日にユーザーが「以前よりもずっと滑らか」と評価した顔追従を、現在の制御へ継ぎ足さずに復元する。復元後の改善は一変数ずつ比較し、滑らかさ、追従速度、逆方向、急跳び、固まりというユーザーの目視評価を一次の受入条件とする。

## 肯定評価時点の基準

- 検出対象はfaceとheadだけで、body矩形を追従目標へ使わない。
- Gatewayが適用応答を受けた姿勢を基準に、dead-zone超過分へ比例ゲインを掛け、各軸を整数丸めする。履歴上はこれを`confirmed pose`と呼んでいたが、物理角度の確認ではない。
- 視覚補正の上限は設定済み`maxStepDeg`であり、別の7度lookaheadを持たない。
- 短い検出ロスト中は新しい動作を再送せず、その場でholdする。
- ロスト時間超過後は設定済みscanへ移り、直前位置を基準にした16点局所探索を使わない。
- 実機設定は125 ms観測、10 Hz command、yaw gain 44、pitch gain 30、round、filter無効、最大4度、90 deg/sだった。
- 肯定評価時のGatewayはactive 2だったが、その後の実測で数秒停止を自己増幅したため、復元後もactive 1を維持する。
- 肯定評価時のspringは、restへ到達した補間フレームで終了し、次のservo tickへ追加のexact-targetフレームを予約しない。

## 履歴上の証拠

- 肯定評価はCodex task `019fb7c8-f798-7562-8b0d-e25cd6fa2888`のturn `019fba39-0b89-79c0-ac07-2b56be3452bf`にある。
- その時点のOTAイメージは3,054,864 bytes、file SHA-256は`06cac3bafa95c52917b38c6c4e5ddfbb4d7da663195c5b97240ebc7d4a667df3`、ELF SHA-256は`ca9c269edc821595593356ac3227424ad0ecd63436e74ac6243c43d955e3c14b`だった。
- 小振幅3秒試験は8 Hzで24 accepted、24 dispatched、24 apply reply、device latency p95 161 ms、停止22.57 ms、home一致だった。apply replyは物理到達確認ではない。
- 続く15秒顔追従はユーザーが滑らかさを肯定した。自動ゲートの不合格理由は最終pitch 31度に対するhome 33度の不一致で、追従品質の否定ではなかった。
- 現在の定常検出は固定50/50、pitch 23度への移動直後43/50、整定後49/50、推論p95約19 ms、capture-to-command p95 24–36 msであり、モデル遅延を主因から除外する。

## 復元前との差分

| 境界 | 肯定評価時点 | 2026-08-03復元前 | 復元後 |
| --- | --- | --- | --- |
| 検出対象 | face、head | face、head、body | face、head |
| 対象選択 | label優先とconfidence/面積 | 前回anchor近傍を優先し、body上端15%をanchor化 | label優先とconfidence/面積 |
| 制御基準 | Gateway apply-replied pose（当時の名称はconfirmed） | 同左 | 同左。物理確認とは呼ばない |
| 一観測の補正上限 | 設定`maxStepDeg`、実機4度 | 固定7度lookahead。その後の試験ラッパーは比例補正全量 | 設定`maxStepDeg`、実機4度 |
| 短い見失い | hold | 最終未達setpointを再送 | holdし、pendingをclear |
| 1秒後の見失い | 設定scan、900 ms dwell | 直前位置中心の16点局所探索、250 ms dwell | 設定scan、900 ms dwell |
| target filter | 無効、round | 無効、round | 無効、round |
| Gateway同時実行 | active 2 | active 1 | active 1 |
| Firmware spring | rest到達フレームで終了。stale write freshness guardあり | rest後の次tickへexact-target frameを保持 | 追加terminal frameを除去し、freshness guardとretarget中の非blocking受理は維持 |
| Firmware運用 | auto-sleep制御なし | 診断とauto-sleep制御を追加 | `auto-sleep=false`と診断を維持 |
| pitch安全下限 | 通常servo範囲 | 試験中にpitch 7度へ到達 | 在席A/B中は23度 |

## 回帰の因果仮説

第一候補は、検出器ではなく制御目標の意味を一度に変えたことにある。4度の確定姿勢基準増分から7度lookahead、さらに比例補正全量の絶対目標へ広げたため、同じ画像誤差でも大きい目標差を作り、pitch 7度までの急降下と衝突を引き起こした。

第二候補は、不確かな観測区間にも動作を継続したことにある。短い見失いで未達setpointを再送し、1秒後に250 ms間隔の局所探索へ入るため、肯定評価時には静止していた区間で移動、反転、pending置換が増えた。

第三候補は、bodyとcross-label continuityの導入である。顔・頭の中心からbody上端15%へanchorが切り替わると、人物が同じでも垂直誤差が離散的に変わり、pitchの急跳びを作り得る。

Gateway active 2は独立の増幅要因である。実測で数秒停止を自己増幅したため、肯定評価時との差分ではあるがactive 1へ戻さない。未確認planned poseの累積も逆方向暴走の実測があるため候補から除外する。

第四候補は、肯定評価後に入ったspring終端exact-writeである。肯定評価直後、homeの2度残りを直すために、springがrestへ到達しても`snapped_on_rest`を保持し、次の20 ms tickでexact integer targetをもう一度送る変更を加えた。そのOTA直後、同じ`gain44 / round`に対してユーザーは「以前スムーズだったものがカクカク」と評価した。初版にはblocking `WritePos`中もmotion lockを保持する回帰も混入し、後に解消されたが、追加terminal frame自体は現在まで残っていた。1〜4度の短いretargetごとに停止後の別フレームを作るため、既知の滑らかなspringへ戻す対象とする。

2026年8月3日の復元試験では、24 frame中20 frameでtargetを得て14件のGateway応答があった一方、中央化は0/20で、ユーザーは「全然動いていない」と評価した。しかしGatewayの`confirmed`はfirmwareの`set_head_angles`応答時点で増え、物理ReadPosやservo write完了を確認していなかった。したがってこのrunは検出器の失敗ではなく、同時に物理無動作を証明する資料でもない。成功件数を`applyReplies`へ改称し、以後は目視評価または独立した物理姿勢証拠なしに移動成功と扱わない。

## 復元時に維持する安全差分

- `auto-sleep=false`を維持する。肯定評価時の旧ファームへそのまま戻すOTAは、この要件を満たせないため行わない。
- 新しい実機試験ではpitch 23度未満を指令しない。現在のscan pitch下限による追従クランプを、安全試験期間中だけ維持する。
- Gatewayはone-active、one-replaceable-pendingを維持する。
- 未確認planned poseをPicoの制御基準にしない。
- Firmwareのstale write freshness guardと、blocking servo ACK中に新しいtargetを受理できるロック境界を維持する。
- `auto-sleep=false`と診断機能を維持する。追従中の各短区間へ追加terminal frameを予約する挙動だけは捨てる。

## 捨てる挙動

- body検出をhead代替として追従へ使う挙動。
- 7度のabsolute visual setpoint。
- 検出ロスト中に最後の未達目標を再送する挙動。
- ロスト後の8度刻み・最大24度の局所探索。
- 実機試験用の全量比例補正ラッパーと、未確認planned poseの累積。
- spring rest後の次tickへ追加するexact-target frame。
- Gateway apply replyを物理的な到達確認と呼ぶレポート表現。

## 最小復元パッチ

- `attention-detection.ts`からbody、body専用anchor、前回anchor continuityを除く。
- `attention-controller.ts`から固定7度上限、最終setpoint再送、局所探索状態を除き、設定`maxStepDeg`と通常scanへ戻す。
- runtime、Gateway、Firmwareの所有境界は変えない。
- field/replayの型と受入条件だけを復元した制御契約へ同期する。
- `AdvanceAxisSpring`はrestへ到達したフレームでlogical poseをtargetへsnapし、追加terminal pendingをclearする。stale frame freshness guard、auto-sleep制御、診断APIは維持する。
- field runのdurationはruntime起動完了後から測り、homeは固定1秒待ちではなく実角度を最大5秒pollする。lane集計は`confirmed`ではなく`applyReplies`と記録する。

## 検証

自動テストでは、body行を無視すること、補正が`maxStepDeg`を超えないこと、短いロストでholdすること、ロスト時間超過後に通常scanへ移ること、設定したscan pitch下限（実機設定では23度）を守ること、active 1を維持することを確認する。

2026年8月3日のオフライン検証は、Picoの全ゲート95 files / 1495 tests、Gatewayの797 passed / 5 skippedとruff、Firmware hostの62 testsを通過した。正規の`release.py stackchan`によるESP32-S3 buildも成功し、生成した`xiaozhi.bin`のSHA-256は`18379689a9fd3766141e9a032bedc4d8d629aef5eca922d26912fb5a2df4c794`である。OTA、Gateway起動、servo指令は行っていない。

実機はユーザー在席時だけ動かす。順序は、小振幅、上下安全確認、20秒自由追従とする。各試験後にhome姿勢と`auto-sleep=false`を実測し、数値ゲートが通っても目視で激しい、逆方向、急跳び、固まりがあれば不合格とする。
