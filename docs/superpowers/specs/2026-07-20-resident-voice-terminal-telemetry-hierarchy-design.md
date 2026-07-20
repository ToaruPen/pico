# 常駐音声ターミナルの情報階層設計

## 位置づけ

この設計は
`2026-07-20-resident-voice-operator-display-and-playback-tail-design.md` のうち、
非永続オペレーター表示の見せ方を置き換える。イベント取得、本文と payload の
非永続境界、セッション期限、再生末尾、OTel の契約は変更しない。

## 背景

現行 widget は認識文、応答、tool payload、stop reason、6種類の時間を同じ強さの
文字列として積み上げる。会話と内部診断の区別がなく、狭い端末では横へ溢れ、
通常利用で知りたい現在状態と認識結果を素早く確認しにくい。

外部設計資料は次の方針を支持する。

- CLI は人が読む出力を優先し、成功時は簡潔にしながら現在状態を明示する。
  <https://clig.dev/>
- トレースは end-to-end の root span から始め、個々の span は原因調査時に掘る。
  <https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/traces/investigate/choose-span-data/>
- 子 span は詳細観測用の部分処理であり、root と単純加算してはならない。
  <https://opentelemetry.io/docs/specs/otel/trace/api/>
- 状態の意味を色だけで伝えず、記号と文言を併用する。
  <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html>

## 目的

- 通常利用で現在状態、認識文、応答、tool成否を一目で追えるようにする。
- ユーザー体感の応答開始時間を一つの代表値として示す。
- 遅延の内訳は、応答開始へ寄与する最長区間だけを要約する。
- 端末幅とPi themeへ追従し、すべての描画行をviewport内へ収める。
- 既存の安全な文字列化、上限、best-effort境界を維持する。

## 非目的

- raw tool引数、raw tool結果、本文、音声をログやOTelへ新たに保存しない。
- OTelのspan、attribute、sampling、exporter構成を変更しない。
- latencyの良否を判定するSLOや固定閾値を導入しない。
- full-screen TUI、対話式の詳細展開、履歴ブラウザを作らない。
- 音声capture、STT、Pi turn、TTS、再生の実行経路を変更しない。

## 情報の優先順位

### 常時表示

- 状態記号と日本語ラベル
- `F1 話す` と `F2 中断`
- 認識済みstaff発話
- Picoの返答
- 実行されたtool名、成否、所要時間
- `ptt_release_to_playback_start` を「応答開始」とした実測値
- 明示的な失敗箇所と、既存error codeから得られる短い理由

### 一行へ要約

応答開始へ寄与する比較可能な区間から最長のものを選び、
`最長 Pi 20.35 s` の形式で示す。候補は `stt`、`pi_turn`、
`tts_time_to_first_chunk` とする。end-to-end値、`pi_time_to_first_text` のような
区間内milestone、応答開始後の `tts_playback` は候補に含めない。

### 通常画面へ出さない

- raw tool引数とraw tool結果
- 全stageの一覧、trailing silenceなどの診断属性
- trace ID、span ID、内部stop reason
- OTelに既に記録される低水準のstatus、error、duration属性

raw tool引数と結果は、非表示にするだけでなく既存契約どおり非永続のままとする。
後からの性能調査には、既存OTelの許可済みstage・duration・status・error属性を使う。

## 表示状態

状態はoperator eventから導出し、新しいruntime制御イベントを追加しない。

| 状態 | 契機 | 表示 |
| --- | --- | --- |
| 待機中 | 初期状態、再生完了 | `● 待機中` |
| 聞き取り中 | `turn_started` | `● 聞き取り中` |
| 考えています | `staff_transcript`、tool完了 | `◐ 考えています` |
| Tool実行中 | `tool_execution_start` | `◐ Tool実行中` |
| 音声準備中 | `pi_response` | `◐ 音声準備中` |
| 話しています | `tts_time_to_first_chunk`完了 | `● 話しています` |
| 失敗 | error status、応答本文のないterminal failure | `✗ <失敗箇所>` |

状態は同じheader位置で更新し、イベントごとの進捗行は履歴へ積み上げない。
色はPi themeの `success`、`accent`、`warning`、`error`、`muted` を使うが、
記号と文言だけでも状態を判別できるようにする。

## Turnカード

表示上限は「進行中または直近のturn」と「その一つ前の完了turn」の2件とする。
各turnは構造化状態として保持し、最終描画時に次の順で出力する。

```text
● 待機中  Pico voice                       F1 話す · F2 中断
────────────────────────────────────────────────────────
YOU   スタックチャンの状態を教えて
TOOL  ✓ stackchan_get_status  350 ms
PICO  準備できています。
      応答開始 22.42 s · 最長 Pi 20.35 s
```

tool失敗では `✗` と短いerror codeを表示する。成功したtoolのraw引数と結果は
表示しない。stop reasonは応答本文が得られないterminal failureの説明にだけ使い、
正常応答へ `[stop=stop]` を付加しない。

## 幅への追従

Piのcustom widget componentを使い、`render(width)` のたびにviewport幅へ合わせる。
Pi themeで色を適用し、`@earendil-works/pi-tui` のANSI-awareな幅処理を使う。

- 72 column以上: header、操作、応答開始要約を可能な範囲で一行表示する。
- 48〜71 column: 操作と計測要約を次行へ送る。
- 48 column未満: 罫線を省略し、role labelの後続行へ本文を折り返す。
- 長文は安全なUTF-8 byte上限を先に適用し、その後terminal column単位で折り返す。
- すべての返却行についてANSIを除いた表示幅が `width` 以下でなければならない。

## 構造とデータフロー

`resident-voice-terminal-display.ts` はoperator eventを構造化turn stateへ変換し、
pending toolをraw payloadなしで上限付きに保持する。新しい
`resident-voice-terminal-renderer.ts` は副作用のないview modelから表示行を作る。

```text
ResidentVoiceOperatorEvent
          │
          ▼
 bounded structured turn state ──── change notification
          │                              │
          ▼                              ▼
 pure width-aware renderer         tui.requestRender()
          │
          ▼
 Pi custom widget component
```

widget factoryは一度だけ登録する。event受理時は状態を更新して
`tui.requestRender()` を呼び、Piが次に指定した幅とthemeで再描画する。
rendererやrefreshが失敗してもvoice runtimeへ例外を返さない。

## 安全性と上限

- 改行、制御文字、Unicode行区切りを既存どおり無害化する。
- transcriptとresponseのUTF-8 byte上限を維持する。
- tool名は既存byte上限を維持する。
- pending toolはID、無害化済みtool名だけを最大32件保持する。
- accessor、`toJSON`、custom inspect、Proxy trapを呼び出さない。
- viewは最大2turnに制限し、入力件数に比例して増えない。
- theme、render、requestRenderの失敗はoperator表示内で収束させる。

raw payloadを表示しなくなるため、payload serializerは削除する。安全性回帰試験は
「event受理がhostile payloadを参照・実行しない」契約へ置き換える。

## 検証

- 待機、聞き取り、思考、tool、音声準備、発話、失敗の状態遷移を単体試験する。
- 正常turnで正常stop reasonとraw payloadが表示されないことを試験する。
- tool名、成否、durationが表示され、hostile args/resultへ触れないことを試験する。
- end-to-endと比較可能な最長区間だけが要約されることを試験する。
- 40、60、100 columnで全行がviewport内に収まり、日本語が正しく折り返されることを
  Pi TUIの `visibleWidth` で試験する。
- 2turnを越えた履歴が保持されないことを試験する。
- widget factory、theme、requestRenderの例外がvoice runtimeへ影響しないことを試験する。
- `just check` を最終gateとする。
