# Pico Voice Resident Runtime Design

## 目的

`pico` に、実利用前提の音声常駐 runtime を追加する。これは実地テスト用
harness ではなく、施設内で `pico` が待機し、話しかけられたときに会話し、
セッション終了後に施設知識を抽出し、Mem0 へ保存する本体 runtime である。

field validation はこの runtime を短時間・明示条件で起動して検証する薄い
wrapper に留める。

## 非目標

- LINE 連携、日報配信、外部通知は扱わない。
- production に mock、stub、fake、fallback provider chain は追加しない。
- Durable memory を子どもの tracking、scoring、profiling 目的に使わない。
- human review gate は追加しない。
- Pi Agent CLI を turn ごとに spawn する実装にはしない。

## 基本方針

常駐 runtime は `src/runtime/voice-resident.ts` に置く。

production startup owner は Pi Agent であり、pico は Pi Agent extension として
読み込まれる。`npm run resident:voice` は direct resident voice harness として
この runtime を直接起動する低レベル検証口に留める。実地検証用の script は、
必要になった時点で `field:*` として追加し、この runtime を呼ぶ。

OS 依存のマイク入力、スピーカー再生、Pi Agent turn、probe 出力は interface
で分離する。production path では config が不足したら fail closed し、別
provider へ自動で切り替えない。

## Runtime Data Flow

1. `voice.audio` が 10ms 程度の短い PCM frame を継続取得する。
2. frame は必ず `voice.echoControl.processNearEnd` を通る。
3. `suppress` された frame は STT に渡さない。
4. `pass` された frame は configured speech gate (`energy` または明示設定された
   `ten_vad`) と configured silence threshold で utterance window に集約する。
   `ten_vad` は 16kHz mono frame 契約を config 境界で検証し、provider の自動
   fallback は行わない。
5. utterance window が閉じた時だけ `voice.stt` へ渡す。10ms frame を直接
   STT sidecar に渡さない。
6. session 開始前の transcript は trigger 判定だけに使い、保存しない。
7. wake name、greeting、将来の bell/tool event など trusted trigger が成立したら session を開始する。
8. active session 中の staff utterance を session entry として append する。
9. 同じ Pi Agent SDK session に turn を渡す。
10. Pi Agent response text を assistant entry として append する。
11. response text を Aivis Speech で synthesize し、`voice.audio` で再生する。
12. 再生音声は playback 呼び出し前に同じ chunk start timestamp で
    `echoControl.acceptFarEndReference` へ渡す。
13. configured timed duration で session を cut off する。
14. cutoff payload を configured Pi worker で処理し、検証済み施設知識を Mem0 へ保存する。
15. Mem0 write 成功後に cutoff を acknowledge する。失敗は呼び出し元へ表面化する。

## Pi Agent Integration

Pi Agent 連携は SDK session API を使う。

`createAgentSession` / `AgentSession` を使い、同一 process 内で以下を扱う。

- `prompt()` による turn 投入。
- `subscribe()` による response/event 収集。
- session cutoff 時の abort/cancel。
- model/auth/resource loader/tool scope の一貫性。

CLI per turn は使わない。CLI は smoke や手動検証用途に限定する。

既存 `registerPicoExtension` と resident runtime が別々の `SessionLifecycle` を
持つと、`pico_session` tool が見る session と resident が cutoff 処理する
session が分裂する。そのため、`pico_session` と perception tools を登録する
helper を切り出し、extension path と resident SDK path の両方へ同じ
`SessionLifecycle` を注入できるようにする。

## Session And Memory Cutoff

`SessionLifecycle.cutoff()` は現在 payload を返すだけなので、resident runtime が
cutoff から Mem0 write までの順序を所有する。

順序は以下に固定する。

1. active session の cutoff payload を生成する。
2. configured Pi worker が施設知識を抽出し、Mem0 へ `infer: false` で保存する。
3. Mem0 write 成功後に session を cleanup 対象にする。

抽出または Mem0 write が失敗した場合、runtime は失敗を audit/probe し、session
cleanup を成功扱いにせず、呼び出し元へ失敗を返す。

cutoff payload の persisted queue、drain loop、retry、dead letter は持たない。worker と
外部 sidecar request は startup-only config の timeout で bounded にし、probe/audit には
transcript 本文を出さない。

## Pre-Trigger Transcript Policy

session 開始前の STT 結果は ambient speech とみなす。

- trigger 判定にだけ使う。
- session entry にしない。
- memory extraction input に含めない。
- probe/audit に本文、断片、trigger phrase の値を出さない。

trigger 判定は以下を満たす場合のみ成立する。

- configured trigger phrase に一致する。
- STT confidence が設定閾値以上。
- echo control が `pass` している。
post-TTS cooldown と debounce window はこの slice ではまだ config contract に含めない。
自己音声抑制は echo control の `suppress` と far-end reference timing が所有する。

## Audio And Echo Control Timing

AEC の far-end reference は、合成後にまとめて渡すだけでは不十分である。

`voice.audio` は speaker playback と far-end reference tee を同じ monotonic
clock 境界で扱う。playback adapter は再生開始時刻、frame duration、device
latency 補正可能な metadata を返す。

実装初期段階で OS/driver から正確な latency を取れない場合も、設計上は timing
metadata を interface に含め、後続改善で差し替えられるようにする。

## Probe Design

probe は runtime overhead と失敗箇所を観測するための低オーバーヘッド計測である。
raw audio、transcript、prompt、completion、secret、credential、URL query は出さない。

stage は固定 enum とする。

- `mic_capture`
- `echo_control`
- `utterance_window`
- `stt`
- `trigger_match`
- `session_start`
- `pi_turn`
- `tts_synthesize`
- `tts_playback`
- `session_cutoff_memory`

event name は `voice.runtime.stage` に統一する。

属性は allowlist のみにする。

- `pico.voice.stage`
- `pico.voice.stage_status`
- `pico.voice.stage_duration_ms`
- `pico.voice.frame_count`
- `pico.voice.utterance_duration_ms`
- `pico.voice.sample_rate_hz`
- `pico.voice.channels`
- `pico.voice.triggered`
- `pico.voice.entry_count`
- `pico.voice.chunk_count`
- `pico.voice.error_code`

high-cardinality な `sessionId`、`frameId`、endpoint、model full name、
trigger phrase 値は metric label にしない。必要な場合でも短期 trace/log の bounded
属性として扱い、audit schema の上限内に収める。

duration は monotonic clock で測る。wall-clock timestamp は event occurrence のため
だけに使う。

## Failure Behavior

resident runtime は fail closed を基本にする。

- echo control が unhealthy: listening を停止し、別 provider へ fallback しない。
- STT failure: 該当 window を破棄し、session へ append しない。
- trigger false/uncertain: Pi Agent に送らない。
- Pi Agent turn failure: active session は維持し、該当 turn の TTS を行わない。
- TTS failure: playback せず、far-end reference も追加しない。
- playback failure: listening cooldown を延長し、自己音声誤認を避ける。
- memory extraction/write failure: cutoff を acknowledge せず、runtime failure として表面化する。

process lifecycle は以下を持つ。

- single-instance lock。
- SIGINT/SIGTERM handling。
- microphone/speaker resource cleanup。
- echoControl flush。
- active Pi Agent SDK session disposal。
- active session の cutoff/extraction/Mem0 write 試行。ただし memory worker が構成されている
  resident process に限る。

## Mac Direct Resident Harness Management

Mac mini を resident host とする場合も、公開 production startup target は
Pi Agent with pico extension である。`npm run resident:voice` を launchd の
user LaunchAgent から起動する経路は、direct resident voice harness の低レベル
検証・移行用管理口として扱う。

- package entrypoint は `npm run resident:voice:launchd -- <operation>` とする。
- operation は `install`、`start`、`restart`、`stop`、`status`、`uninstall`、
  `print-plist` を明示指定する。
- LaunchAgent label は `dev.toarupen.pico.resident-voice` とする。
- plist は `~/Library/LaunchAgents/dev.toarupen.pico.resident-voice.plist` に置く。
- `ProgramArguments` は current Node executable、local
  `node_modules/jiti/lib/jiti-cli.mjs`、`scripts/resident/voice.ts` を直接指定する。
  `PICO_CONFIG_PATH` と stable `PATH` は `EnvironmentVariables` で渡す。
- local config の内容、camera credential、transcript、audio payload は plist や
  launchd command plan に埋め込まない。渡すのは resolved config path だけにする。
- stdout/stderr は
  `~/.pico/resident-voice/normal/processes/resident-voice.out.log` と
  `~/.pico/resident-voice/normal/processes/resident-voice.err.log` に分ける。
  resident runtime の process/event/session logs も `~/.pico/resident-voice/normal/`
  配下に保持し、development terminal のログは
  `~/.pico/resident-voice/development/` 配下に分離する。
- `RunAtLoad` と `KeepAlive` を有効化し、process crash や login 後に resident
  voice が戻る形にする。
- `stop` は `KeepAlive` による即時再起動を避けるため `launchctl bootout` を使い、
  plist は残す。完全削除は `uninstall` が bootout 後に plist を削除する。

## Configuration

既存 `PicoConfig` に resident runtime 用の config 境界を追加する。

必要な項目:

- `voice.resident.audioInput`。Mac mini 常駐では `provider: avfoundation`
  と AVFoundation device を明示する。Raspberry Pi / Linux 常駐では
  `provider: alsa` と ALSA device を明示する。
- `voice.resident.audioOutput`。Mac mini 常駐では `provider: afplay` と
  `route: system_default` を明示し、macOS の現在の default output route を
  resident 用として運用者が承認する。Raspberry Pi / Linux 常駐では
  `provider: alsa` と ALSA device を明示する。
- `voice.resident.utteranceWindow`。`minSpeechMs`、`silenceMs`、
  `maxUtteranceMs`、`minRmsDb` で常時待受の VAD/windowing を調整する。
- trigger confidence。provider が返す `0...1` の confidence に対する default は
  `0.5` とし、日本語 Apple Speech の実地結果と施設環境の false trigger / false
  reject を見て local config で調整する。特定 provider の固定返値を根拠にしない。
- probe enablement and sink。

resident config が不足している場合は起動時に失敗する。field script の env-only
設定を resident runtime にそのまま流用しない。

Mac mini を resident host とする場合、ALSA を Mac に持ち込まない。
resident runtime は音声 I/O provider を通して macOS の AVFoundation capture と
明示承認された default route の afplay playback を使う。Linux/Pi では同じ runtime
contract の ALSA provider を使う。provider の暗黙 fallback は持たない。

## Testing Strategy

TDD で実装する。

unit tests は production fake provider path を追加せず、constructor に注入した
interface 実装で runtime contract を検証する。

優先テスト:

- suppressed mic frame が STT に渡らない。
- pre-trigger transcript が session/memory に保存されない。
- trigger 成立後だけ session が start する。
- Pi Agent SDK session が process 内で再利用される。
- assistant response が TTS/playback/far-end reference の順に流れる。
- cutoff 生成後、Mem0 write 成功まで session cleanup しない。
- probe が allowlist 属性だけを出す。
- role-free runtime failure が fail closed する。

field validation は実機で以下を確認する。

- real microphone capture。
  `npm run smoke:resident-audio-input` は短時間の bounded capture から
  RMS/peak dB と `minRmsDb` 閾値判定だけを報告し、音声 payload は出さない。
- Apple Speech STT。
- Aivis Speech TTS playback。
- echo control による自己音声抑制。
- Pi Agent SDK turn。
- session cutoff。
- configured Pi worker による施設知識抽出と awaited Mem0 write。
- persisted queue、retry、fallback、独立 memory process がないこと。
- OTel/probe event。
