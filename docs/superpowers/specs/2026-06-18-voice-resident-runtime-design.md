# Pico Voice Resident Runtime Design

## 目的

`pico` に、実利用前提の音声常駐 runtime を追加する。これは実地テスト用
harness ではなく、施設内で `pico` が待機し、話しかけられたときに Pi の親
conversation session を通して会話する本体 runtime である。

field validation はこの runtime を短時間・明示条件で起動して検証する薄い
wrapper に留める。

## 非目標

- LINE 連携、日報配信、外部通知は扱わない。
- production に mock、stub、fake、fallback provider chain は追加しない。
- short-term memory、durable memory、memory tool、cutoff-memory hook は Pico に
  追加しない。
- 子どもの tracking、scoring、profiling を行わない。
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
8. active interaction 中の accepted utterance は activity timestamp だけを更新する。
9. 同じ Pi 親 conversation session に turn を渡す。
10. Pi Agent response text を Aivis Speech で synthesize し、`voice.audio` で再生する。
11. 再生音声は playback 呼び出し前に同じ chunk start timestamp で
    `echoControl.acceptFarEndReference` へ渡す。
12. configured timed duration で interaction state を ended にする。
13. 必要な場合だけ farewell turn を完了する。
14. session-owned deferred tool を cancel する。
15. bounded direct harness では Pi SDK session を dispose する。
16. Pico lifecycle record を削除する。

## Pi Agent Integration

production では Pi Agent が親 conversation session、model/auth、tool scope、event loop、
subagent、通常 cancel を所有する。Pico は `pi.sendUserMessage()` と Pi events を使い、
別の integration session を作らない。CLI per turn は使わない。

`npm run resident:voice` は低レベルの direct field harness に限り Pi SDK session を
同一 process 内に作成できる。この bounded harness は production ownership path ではない。

## Interaction Ending

Pico の `SessionLifecycle` は activation と inactivity 制御に必要な process-local state
だけを持つ。staff/assistant utterance、transcript、summary、memory candidate、cutoff
payload は保持しない。

終了順序は以下に固定する。

1. interaction state を ended にする。
2. 必要な場合だけ farewell turn を完了する。
3. session-owned deferred tool を cancel する。
4. bounded harness では Pi SDK session disposal の完了を待つ。
5. Pico lifecycle record を削除する。

Memory extraction、write、acknowledgement、retry、drain はこの順序に含めない。

## Pre-Trigger Transcript Policy

session 開始前の STT 結果は ambient speech とみなす。

- trigger 判定にだけ使う。
- Pico interaction state に保存しない。
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
- `speech_gate`
- `stt`
- `session_start`
- `pi_turn`
- `tts_request_wall`
- `tts_playback`
- `camera_capture`
- `vlm_scene_description`

固定 enum と出力方針は単一の stage policy registry で所有する。metrics JSONL に永続化する
stage は `speech_gate`、`stt`、`session_start`、`pi_turn`、`tts_request_wall`、
`tts_playback`、`camera_capture`、`vlm_scene_description` とする。このうち summary stdout
へ出すのは `speech_gate` を除く7 stage とする。高頻度の `mic_capture` と
`echo_control` は固定 enum と verbose probe には残すが、metrics JSONL と summary stdout
には出さない。

TTS の wall-clock stage は `tts_request_wall` と `tts_playback` とする。
音声長は `pico.voice.utterance_duration_ms` 属性に分離し、stage にはしない。

event name は `voice.runtime.stage` に統一する。

属性は allowlist のみにする。

- `pico.voice.stage`
- `pico.voice.stage_status`
- `pico.voice.stage_duration_ms`
- `pico.voice.frame_count`
- `pico.voice.utterance_duration_ms`
- `pico.voice.sample_rate_hz`
- `pico.voice.channels`
- `pico.voice.suppressed_frame_count`
- `pico.voice.speech_detected`
- `pico.voice.speech_probability`
- `pico.voice.rms_db`
- `pico.voice.chunk_count`
- `pico.voice.frame_bytes`
- `pico.voice.vlm_frame_bytes`
- `pico.voice.queue_depth`
- `pico.voice.error_code`

high-cardinality な `sessionId`、`frameId`、endpoint、model full name、
trigger phrase 値は metric label にしない。必要な場合でも短期 trace/log の bounded
属性として扱い、audit schema の上限内に収める。

duration は monotonic clock で測る。wall-clock timestamp は event occurrence のため
だけに使う。

## Failure Behavior

resident runtime は fail closed を基本にする。

- echo control が unhealthy: listening を停止し、別 provider へ fallback しない。
- STT failure: 該当 window を破棄し、Piへ送らない。
- trigger false/uncertain: Pi Agent に送らない。
- Pi Agent turn failure: active session は維持し、該当 turn の TTS を行わない。
- TTS failure: playback せず、far-end reference も追加しない。
- playback failure: listening cooldown を延長し、自己音声誤認を避ける。

process lifecycle は以下を持つ。

- single-instance lock。
- SIGINT/SIGTERM handling。
- microphone/speaker resource cleanup。
- echoControl flush。
- bounded direct harness の active Pi Agent SDK session disposal。
- active interaction の end、farewell、deferred cancellation、terminal record removal。

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
- pre-trigger transcript が Pico interaction state に保存されない。
- trigger 成立後だけ session が start する。
- Pi Agent SDK session が process 内で再利用される。
- assistant response が TTS/playback/far-end reference の順に流れる。
- interaction ending が farewell、deferred cancellation、Pi session disposal、
  terminal record removal の順に完了する。
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
- timed interaction ending と shutdown cleanup。
- memory config、worker、provider、tool、sidecar が Pico runtime にないこと。
- OTel/probe event。
