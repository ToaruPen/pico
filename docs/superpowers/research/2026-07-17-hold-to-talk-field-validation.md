# Hold-to-Talk フィールド検証記録

## 結論

2026-07-17 時点で、制御状態機械、認証付きloopback transport、オンデマンド録音、
キャンセル伝播、macOS Core Graphics bridgeの自動検証は通過した。実キーボードによる
end-to-end検証は、このホストでMoonlander、8BitDo、その他のキーボード候補を検出できず、
`config/pico.local.yaml`も存在しなかったため未実施である。未実施部分をPASSとして扱わない。

## 環境

| 項目 | 値 |
| --- | --- |
| OS | macOS 26.5.1 (25F80), arm64 |
| Node.js | 24.13.0 |
| npm | 11.6.2 |
| Swift | Apple Swift 6.3.2、target arm64-apple-macosx26.0 |

## 実施結果

| 対象 | コマンドまたは確認方法 | 結果 |
| --- | --- | --- |
| TypeScript全テスト | `npm run test` | PASS、64 files / 673 tests |
| 自動検証commit | `git rev-parse HEAD` | `2c13fb8d66e716053e47f9248f245dce1ef3229f` |
| フィールドCLI契約 | `npm run field:resident-hold-to-talk -- --help` | PASS |
| キーボード接続 | `system_profiler SPUSBDataType`をMoonlander、ZSA、8BitDo、keyboardで照合 | 該当なし |
| 音声入力候補 | AVFoundation device listing | `SRS-XB100`、`UAB-80`を検出 |
| ローカル設定 | `test -f config/pico.local.yaml` | 不在 |
| production bridge artifact | `just macos-control-build`とstable release pathの実行可能性確認 | PASS |

Swift bridgeのAPI選定とInput Monitoring preflightの根拠は、
`docs/superpowers/specs/2026-07-17-hold-to-talk-resident-control-design.md`の
「macOS bridge spike result」に記録した。自動テストでは、設定キーの明示マッピング、
repeat抑止、orphan release抑止、認証付きhealth/event request、ready handshake、異常終了、
SIGTERM cleanupを検証する。

## 新しいフィールドハーネス

`field:resident-hold-to-talk`は最大300秒のbounded runだけを許可する。実際のmacOS bridgeと
設定済みmicrophone captureを使い、次の集計値だけを出力する。

- accepted / ignored / noop outcome数
- capture startup、hold、250 ms release tail、cancel convergenceの集計時間
- completed / cancelled hold数と総frame数
- native health、restart、buffer cadence、PTT外/suppressed/total drop数
- physical keyからtail完了までのnative timing stage集計
- capture invalidation数とgeneration不一致PCM frame数
- CPU user/system時間とRSS

キー名、raw audio、transcript、prompt、completion本文、activationごとの生値は出力・保存しない。
このハーネス自体はSTT、Pi、TTS、playbackを呼ばないため、idle STT call数を成功証拠として
出力しない。production runtimeのidle無処理とcancel伝播は統合テストで別に検証する。

## 実機で残る確認

1. `config/pico.local.yaml`へ`macos_resident_io` control、stable Core Audio `deviceUid`を
   持つ`avaudioengine` input、`ffplay`の`system_default` outputを設定する。旧loopback
   control tokenは使用しない。
2. Moonlanderまたは代理キーボードを接続し、設定したtalk/cancel controlを送出できるようにする。
3. `just macos-resident-io-build`後、統合sidecarのstable release binaryへmacOSの
   Input Monitoringとmicrophone権限を許可する。
4. 他checkoutのPicoとexclusive microphone/lock所有を確認して調整した後、
   `just macos-resident-audio-probe --device-uid <uid>`と次のbounded harnessでtalk hold、
   busy中talk、各stage相当のcancelを確認する。無断で別processを停止しない。

   ```bash
   PICO_CONFIG_PATH=config/pico.local.yaml \
     npm run field:resident-hold-to-talk -- --duration-ms 30000
   ```

5. production residentでは、capture startupと先頭音節保持、1 hold = 1 turn、busy入力非queue、
   context継続、録音中・STT中・Pi中・再生中のcancelを別途確認する。

最新の順序、privacy境界、未実施項目は
`docs/superpowers/research/2026-07-20-resident-avaudioengine-input-validation.md`を正とする。
