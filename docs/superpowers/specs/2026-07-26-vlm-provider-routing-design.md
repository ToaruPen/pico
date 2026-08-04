# VLM Provider Routing Design

## 目的

scene description の provider と camera source を起動時設定で明示選択できるようにし、
現在の Ollama VLM に加えて、Pico の Pi Agent model を cloud VLM として利用する。

provider routing は hidden fallback、priority list、health-based reroute を持たない。

## 採用方式

`vision.sceneDescription.provider` は `ollama` または `agent` の closed union とする。
`vision.sceneDescription.source` は `tapo` または `stackchan` の closed union とする。
scene description を利用する場合、この route は必須であり、省略時に既定 provider や
camera source を補わない。

```yaml
vision:
  sceneDescription:
    provider: agent
    source: stackchan
    timeoutMs: 30000
    maxImageEdgePixels: 512
```

### provider: ollama

既存の protected SSH tunnel、Ollama `/api/chat`、`qwen3.5:9b`、strict JSON parsing を
維持する。`vision.ollama` がなければ fail closed する。

### provider: agent

camera tool は1枚の bounded image と、既存 safety prompt に相当する短い text
instruction を tool result として現在の Pi AgentSession へ返す。Pi が選択済みの
model/provider/auth と同じ path で画像を処理する。

第二の AgentSession、OpenAI SDK client、Pico 独自 model registry は作らない。
画像解析結果は現在の assistant response として生成される。

## Model capability gate

`provider: agent` の場合、Pico startup は選択 model の `input` metadata に `image` が
含まれることを確認する。画像非対応 model なら resident controller を開始せず
fail closed する。

model の切り替え粒度は従来どおり startup-only とする。turn ごとの
`AgentSession.setModel()` は追加しない。

## Camera source

### source: tapo

既存 scene RTSP snapshot と resize path を使う。

### source: stackchan

`camera.stackchan` の authenticated MCP client で camera stream lease を取得し、
gateway の authenticated `/camera/latest` から直前より新しい latest-only JPEG を
byte bound 内で1枚読む。VLM provider と StackChan camera transport は独立して選択する。
同じprocessのattention captureとhead moveはStackChan moduleのFIFO laneで直列化し、
待機時間をMCP request timeoutへ算入しない。

## Tool result

`provider: agent` の tool result は次だけを含む。

1. text instruction
2. base64 image content with `image/jpeg`
3. privacy-safe details: source ID、frame byte count、capture time

path、token、camera credential、raw MCP response は details と log に含めない。
Pi AgentSession内のtool resultはmodelが画像を読むまで維持するが、
validation artifactとoperator eventへはimage/text contentを渡さない。
これらの境界ではprovider、source ID、byte count、capture timeだけを保持する。

`provider: ollama` は既存 `SceneDescription` を text result として返す。

追加の送信確認 dialog は設けない。アクティブな会話でユーザーが「これ見える？」など
現在の視野を尋ねた場合、standard scene tool は1枚を取得して選択済み Pi model へ渡す。
この自然な会話導線を、staff identity の証明や個人単位の認可には使わない。

StackChan gateway は各 device の最新 frame だけをメモリ上に保持する。Pico は bounded
read 後の JPEG を file として保存しない。
agent route の画像 byte は interaction の in-memory AgentSession にだけ存在し、
interaction 終了時の session dispose 後に Pico が保持しない。

## Deferred tool

現在の agent-routed image は実行中の AgentSession が画像を読む必要がある。
`provider: agent` と resident deferred tool の組み合わせは fail closed する。
通常の resident production path は standard scene tool を使う。

## エラー処理

- config field が欠けている場合は provider/source 名を含む bounded error にする。
- agent model が image input 非対応なら startup error にする。
- camera capture error、resize error、oversized image は tool error にする。
- agent route から Ollama、または Ollama から agent へ自動で切り替えない。
- route 未設定時は capture 前に fail closed する。
- user が現在の視野を尋ねた scene request ごとに、cloud provider へ送信するのは1枚だけとする。
- StackChan transport error は固定の bounded message に変換し、raw response を上位へ渡さない。

## テスト

- config parser が4つの provider/source 組み合わせを受理する。
- unknown provider/source と不足した provider-specific config を拒否する。
- agent route が text と image content を返し、raw image を details へ入れない。
- Ollama route の既存 structured result を維持する。
- image 非対応 agent model の startup を拒否する。
- StackChan source が authenticated MCP capture adapter を使う。
- route 省略時に暗黙の Ollama/Tapo capture を行わない。
- StackChan latest frame を byte bound 内で読み、session 終了後に画像を保持しない。
- scene toolのvalidation/operator eventがimage base64を保持しない。
- attention capture中のscene requestと、その後のhead moveをFIFO順に直列化する。
- `just check` と `npx secretlint .` が通る。

## 今回行わないこと

- provider の自動選択
- provider fallback
- turn 中の model switching
- 任意 provider plugin registry
- camera image の durable storage 追加
- child identity または private trait inference
