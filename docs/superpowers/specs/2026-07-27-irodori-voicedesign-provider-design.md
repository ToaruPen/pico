# Pico Irodori VoiceDesign プロバイダー設計

## 目的

Picoの既存音声出力パイプラインを維持しながら、TTS合成元を起動時設定で
AivisSpeechまたはIrodori VoiceDesignから明示的に選べるようにする。
本番設定ではIrodoriを選び、既存AivisSpeech設定は手動切り戻し用に残す。

## 所有境界

- Picoは発話テキスト、話者名、固定style、推論パラメーターをIrodoriへ送る。
- IrodoriサービスはstyleからVoiceDesign captionへの変換、話者埋め込み、
  モデル推論、WAV生成を所有する。
- Picoの既存再生、割り込み、エコー抑制、テレメトリ経路は再利用する。
- 汎用TTS抽象化レイヤーは新設せず、既存voiceモジュール内に明示的な
  Irodoriプロバイダーを追加する。
- プロバイダー間の自動フォールバックは行わない。選択先の障害はreadinessと
  発話失敗として可視化する。

## 設定契約

`voice.tts.provider` は `aivis-speech` または `irodori` とする。
既存設定との互換のため省略時は `aivis-speech` とするが、Pico本番設定では
`irodori` を明記する。

Irodori設定は次を持つ。

- `id`: テレメトリ上のサービス識別子
- `localBaseUrl`: 保護トンネルのloopback URL
- `speaker`: voice bank上の話者名
- `style`: `neutral`、`calm`、`cheerful`、`clear`
- `numSteps`: 推論ステップ数
- `seed`: 再現用seed

本番初期値は、`http://127.0.0.1:18923`、話者 `カスミ`、style `calm`、
30 steps、seed 42とする。`localBaseUrl` は保護SSHトンネルがbindする
`http://127.0.0.1` originに限定し、HTTPS、`localhost`、IPv6 loopbackを受理しない。
healthと合成にはアプリケーションtimeoutを設けず、callerの`AbortSignal`だけで中断する。

## 合成契約

- Picoの文章分割単位ごとに `POST /synthesize_stream` を順次呼ぶ。
- リクエストは `text`、`speaker`、`style`、`num_steps`、`seed` を送る。
- 応答はversion 1のbinary framingとし、最初のJSON lineでhandshake、
  続くJSON lineとraw bytesの組で連番chunkを返す。terminal chunkは
  `final=true` またはbounded error codeを持ち、各chunkの `elapsed` は
  同一文章内で一致しなければならない。
- 応答bodyは16 MiB、frame数は16、JSON headerは1 KiB、単一chunkは
  handshakeが宣言する4 MiB以下に制限する。`Content-Length` の有無にかかわらず
  読み取り中に実測上限を適用し、Base64へ変換しない。
- 完了frameのWAVをPCM16LEへ変換する前に、RIFF size、sample rate
  8–192 kHz、1–8 channels、byte rate、block alignment、PCM alignmentを検証する。
- 生成された音声セグメントにはprovider、service id、speaker、styleを記録する。
- frameの `elapsed` をservice合成時間として保持し、wall time、音声長、RTFとともに
  スモーク結果へ記録する。
- 同一合成元判定ではproviderごとの識別情報を比較する。
- callerのAbortSignalだけを各HTTP呼び出しへ伝播する。
- healthと合成のHTTP redirectは追従せず、fail-closedにする。

## Readinessとスモーク

- 選択プロバイダーだけをreadiness対象にする。
- Irodoriでは `/health` のHTTP成功、64 KiB以下のJSON、
  `status="ok"`、`model_loaded=true` を要求する。
- スモークコマンドも選択プロバイダーを使い、合成時間と音声長を報告する。
- AivisSpeechとIrodoriの両設定が存在しても、非選択側へリクエストしない。

## 配備と検証

- WindowsサービスをVoiceDesign checkpointで正常起動させる。
- Mac miniの既存SSHトンネル `127.0.0.1:18923` を維持する。
- Pico本番ローカル設定だけを `provider: irodori` に切り替える。
- 短文、石垣市の天気相当文、寿限無相当長文をトンネル越しに合成する。
- 独立ハーネスでrequestから再生直前までを確認し、常駐Picoは検証中に起動しない。
- AivisSpeechへの切り戻しは設定値を明示的に戻す。常駐プロセスへの適用は、
  operatorが別途承認した運用枠で行う。
