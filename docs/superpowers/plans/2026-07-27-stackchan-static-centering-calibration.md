# StackChan 静止target中央保持校正 実装計画

> **実行者向け:** `executing-plans` と `test-driven-development` を使い、各挙動変更を
> Red → Green → Refactor の順で実装する。利用者の明示指示により、この計画では
> commit、push、PRを行わない。

**目的:** StackChanの静止target追従を、個別画像や個別検出を保存せずに診断し、
合成targetによる最大4回の無人実機iterationで中央保持率70%を目指す。

**構成:** production controllerへ自動調整器は追加しない。field scriptだけが一時的な
観測値をbounded accumulatorへ渡し、privateなaggregate reportへ変換する。固定姿勢の
校正と追従runを分離し、baselineの分類結果に応じて一度に一変数だけを変更する。

**技術:** TypeScript、Vitest、既存StackChan MCP adapter、CoreS3 camera stream、
ONNX Runtime、PINTO 441-S Dist、YAML local field config

---

## Task 1: 集計診断の純粋ロジックを追加する

**Files:**

- Create: `scripts/field/stackchan-attention-metrics.ts`
- Test: `tests/stackchan-attention-metrics.test.ts`

### Step 1: 失敗する集計テストを書く

`tests/stackchan-attention-metrics.test.ts`で次を固定入力として検証する。

- 同一`sequence`は二重計上せず、新規sequenceだけを`framesProcessed`へ加える。
- targetなしの区間を含む`maximumLostGapMs`を計算する。
- `faceFrames`と`headFrames`を別々に数える。
- 水平・垂直の符号付きp50、絶対誤差p50/p95を小数3桁で返す。
- dead zone外の連続targetだけで`eligibleSignComparisons`と`signFlips`を数える。
- dead zone外の正・負それぞれのframe数を数え、収束不足の70%同符号判定に使う。
- poseがyaw ±90度、pitch 5/85度から1度以内なら`servoLimitFrames`を数える。
- 最初のtarget時刻と最初の中央時刻をrun開始からの相対時間で返す。未到達時は
  repositoryの`unicorn/no-null`規則に従って`undefined`とし、JSONではfieldを省略する。
- run開始5,000ms後から25,000ms未満だけのtarget frame数、centered frame数、中央率を
  全run集計と分けて返す。
- report向け集計objectに`confidence`、`centerX`、`centerY`、`boundingBox`、JPEG、
  base64、個別観測配列が存在しない。

テスト入力型は次に限定する。

```ts
type AttentionMetricSample = {
  readonly sequence: number;
  readonly observedAtMs: number;
  readonly pose: StackChanHeadPose;
  readonly target?: {
    readonly label: "face" | "head";
    readonly horizontalError: number;
    readonly verticalError: number;
    readonly centered: boolean;
  };
};
```

Run:

```bash
npx vitest run tests/stackchan-attention-metrics.test.ts
```

Expected: module未実装でFAIL。

### Step 2: bounded accumulatorを最小実装する

`scripts/field/stackchan-attention-metrics.ts`へ次を実装する。

- `createAttentionMetricsAccumulator({ runStartedAtMs, deadZone })`
- `record(sample): boolean`
- `summarize(runEndedAtMs): AttentionMetricsSummary`
- `percentile(values, quantile)`はnearest-rank方式
- sequence重複排除は直前sequenceではなく`Set<number>`で行う。
- 内部に保持するのは数値配列、直前のdead-zone外符号、最終target時刻だけとし、
  JPEG、box、confidenceを受け取らない。
- signは`error > deadZone`なら`1`、`error < -deadZone`なら`-1`、それ以外は比較対象外。
- targetなし観測から次のtargetまで、および最終targetからrun終了までをlost gap候補にする。
- servo limitはtarget観測時のposeを対象に一frame一回だけ数える。
- acceptance windowは`observedAtMs - runStartedAtMs`が5,000以上25,000未満のsampleだけを
  対象にし、target 0件なら中央率0とする。

### Step 3: focused testを通す

Run:

```bash
npx vitest run tests/stackchan-attention-metrics.test.ts
```

Expected: PASS。

### Step 4: 型とformatを確認する

Run:

```bash
npx tsc --noEmit
npx biome check scripts/field/stackchan-attention-metrics.ts tests/stackchan-attention-metrics.test.ts
```

Expected: PASS。

## Task 2: 固定姿勢校正field harnessを追加する

**Files:**

- Create: `scripts/field/stackchan-center-calibration.ts`
- Create: `tests/stackchan-center-calibration-field.test.ts`
- Modify: `package.json`
- Modify: `TOOLS.md`

### Step 1: 失敗するfield harnessテストを書く

次を検証する。

- `--enable-live-run`、duration、max frames、minimum target frames、model、report pathを
  named argumentとして必須またはboundedにparseする。
- adapterへ`connect`、home move、capture/detect、final home move、readback、`close`の順で
  接続し、校正中にhome以外のmoveを送らない。
- camera sequenceが変わったframeだけを集計する。
- target選択は既存`selectAttentionTarget`を使い、face優先規則を複製しない。
- 20 target未満では`failed` reportを返す。
- model、capture、servoの各例外でもfinal homeとadapter closeを試みる。
- passed/failed reportはaggregateだけで、failed時も取得済み集計、boundedなfailure code、
  home結果を保持する。`JSON.stringify(report)`にraw error、`confidence`、`centerX`、
  `centerY`、`boundingBox`、`bytes`、`base64`を含まない。
- report writerのdefaultはmode `0o600`。

Run:

```bash
npx vitest run tests/stackchan-center-calibration-field.test.ts
```

Expected: module未実装でFAIL。

### Step 2: 固定姿勢runを最小実装する

`runStackChanCenterCalibrationField`は次の順で動作する。

1. StackChan/attention detection設定を検証する。
2. adapterとPINTO modelを生成する。
3. adapterへ接続し、設定済みhomeへ一度移動する。
4. durationまたはmax framesまで`captureJpeg`と`detect`を繰り返す。
5. `frame.sequence`がない場合はfail closedし、古いframeを再利用しない。
6. 新規sequenceごとに`selectAttentionTarget`を一回だけ呼び、中心誤差をmemory上で
   accumulatorへ渡す。
7. `finally`でhome move、settle、readback、adapter closeを順に試みる。
8. target frame数、runtime error、home ±1度を全て検査してreportを書く。

reportの成功detailsは次に限定する。

```ts
{
  sourceId,
  durationMs,
  maxFrames,
  framesProcessed,
  errors,
  stream: { requestedFps, frameAgeP95Ms },
  inference: { p95Ms },
  attention: {
    targetFrames,
    faceFrames,
    headFrames,
    horizontal: { signedP50, absoluteP50, absoluteP95 },
    vertical: { signedP50, absoluteP50, absoluteP95 },
    maximumLostGapMs
  },
  finalPose,
  returnedHome
}
```

### Step 3: task entry pointとtool説明を追加する

`package.json`へ以下を追加する。

```json
"field:stackchan-center-calibration": "jiti scripts/field/stackchan-center-calibration.ts"
```

`TOOLS.md`へ、固定home姿勢で新規sequenceだけを処理し、画像を保存しないaggregate校正で
あることを記す。

### Step 4: focused testを通す

Run:

```bash
npx vitest run tests/stackchan-center-calibration-field.test.ts
npm run typecheck
```

Expected: PASS。

## Task 3: face-follow field harnessへ診断集計を追加する

**Files:**

- Modify: `scripts/field/stackchan-face-follow.ts`
- Modify: `tests/stackchan-face-follow-field.test.ts`
- Reuse: `scripts/field/stackchan-attention-metrics.ts`

### Step 1: 失敗する追従診断テストを書く

既存成功reportへ次のaggregateを要求する。

```ts
diagnostics: {
  firstTargetMs,
  firstCenteredMs,
  maximumLostGapMs,
  evaluationWindow: {
    targetFrames,
    centeredFrames,
    centeredRatio
  },
  horizontal: {
    signedP50,
    absoluteP50,
    absoluteP95,
    signFlips,
    eligibleSignComparisons,
    positiveOutsideFrames,
    negativeOutsideFrames
  },
  vertical: {
    signedP50,
    absoluteP50,
    absoluteP95,
    signFlips,
    eligibleSignComparisons,
    positiveOutsideFrames,
    negativeOutsideFrames
  },
  servoLimitFrames
}
```

テストではruntime statusの`framesProcessed`を変化させ、同一frame countのpollを二重計上
しないことを検証する。`targetVisible: false`の新規frameもtargetなしsampleとして記録する。
adapterの`getHeadAngles` instrumentationから直近poseを関連付け、servo limit数も検証する。
既存privacy assertionへ個別観測配列がないことを追加する。

Run:

```bash
npx vitest run tests/stackchan-face-follow-field.test.ts
```

Expected: diagnostics未実装でFAIL。

### Step 2: runtime pollingをfield内だけで集計する

- `runRuntime` dependencyへ任意の`onStatus(status)` callbackを渡せるfield専用contractを
  追加する。
- default `runBoundedRuntime`は100ms pollごととstop後にcallbackを呼ぶ。
- `framesProcessed`をfield-local sequenceとして扱い、同じpollを二重計上しない。
- `targetVisible`がfalseの新規frameはtargetなし、trueなら`lastTarget`をtarget sampleとして
  記録する。
- adapter instrumentationで最後に読んだposeをmemory上に保持し、status sampleへ付与する。
- report生成後はmetrics accumulatorとpose参照をscope外へ出さない。
- production runtimeとcontrollerの公開contractは変更しない。

### Step 3: focused testを通す

Run:

```bash
npx vitest run tests/stackchan-attention-metrics.test.ts tests/stackchan-face-follow-field.test.ts
npm run typecheck
```

Expected: PASS。

## Task 4: 採用条件と原因分類を純粋関数で固定する

**Files:**

- Create: `scripts/field/stackchan-centering-evaluation.ts`
- Create: `tests/stackchan-centering-evaluation.test.ts`

### Step 1: 失敗する判定テストを書く

次の独立ケースをtable testにする。

- target frames 20未満は`insufficient-target`。
- first centered未到達または>5,000ms、5秒後からの20秒window中央率70%未満、
  lost gap 2,000ms以上、errorあり、
  home未復帰のどれか一つでもcandidate不合格。
- 全条件を満たす場合だけ`accepted: true`。
- fixed-poseのsigned p50絶対値>0.05かつabsolute p95-p50<=0.10で`position-bias`。
  固定姿勢の偏りはgain/hysteresis候補より先に分類し、合成targetでは候補を返さない。
- sign flip ratio>=0.25、signed p50絶対値<=0.03、absolute p95>0.10で`oscillation`。
- dead-zone外誤差の同符号率>=0.70、servo limit 0、first centered>5,000msで
  `insufficient-convergence`。
- servo limit frameありかつ未中央なら`invalid-geometry`を他分類より優先する。
- synthetic targetでは`position-bias`を検出してもhome/scan変更候補を返さない。

Run:

```bash
npx vitest run tests/stackchan-centering-evaluation.test.ts
```

Expected: module未実装でFAIL。

### Step 2: deterministic evaluatorを実装する

出力は次のbounded contractにする。

```ts
type CenteringEvaluation = {
  readonly accepted: boolean;
  readonly reasons: readonly CenteringAcceptanceReason[];
  readonly classification:
    | "accepted"
    | "insufficient-target"
    | "invalid-geometry"
    | "position-bias"
    | "oscillation"
    | "insufficient-convergence"
    | "unclassified";
  readonly candidate?: {
    readonly parameter: "deadZoneRelease" | "yawGainDeg" | "pitchGainDeg" | "maxStepDeg";
    readonly operation: "set" | "multiply" | "increment";
    readonly value: number;
  };
};
```

`reasons`は値を含まない固定enum文字列とし、raw errorや個別観測を持たせない。
一度に返すcandidateは一件だけにする。

### Step 3: focused testを通す

Run:

```bash
npx vitest run tests/stackchan-centering-evaluation.test.ts
npm run typecheck
```

Expected: PASS。

## Task 5: baseline結果に応じた一変数candidateをTDDで適用する

**Files (baseline分類により一方だけ):**

- Oscillation時:
  - Modify: `src/config/index.ts`
  - Modify: `src/modules/stackchan/attention-controller.ts`
  - Modify: `src/runtime/stackchan-attention-runtime.ts`
  - Modify: `tests/config.test.ts`
  - Modify: `tests/stackchan-attention-controller.test.ts`
  - Modify: `.pico-local/field-stackchan.yaml`
- Insufficient convergence時:
  - Modify: `.pico-local/field-stackchan.yaml`
- Accepted/invalid geometry/insufficient target/unclassified時:
  - production/config変更なし

### Step 1: baselineを分類する

Task 7の固定姿勢runとface-follow baselineを実行し、
`evaluateCenteringCandidate`のclassificationを記録する。

### Step 2A: oscillationの場合だけhysteresisの失敗テストを書く

- `deadZoneRelease`は`deadZone`以上1未満である。
- 未中央targetは進入閾値`deadZone`で中央へ入る。
- 一度中央へ入ったtargetは、両軸が`deadZoneRelease`以内ならmoveを再開しない。
- report上の`centered`は常に元の`deadZone`で評価し、保持hysteresisで水増ししない。
- target喪失、scan遷移、runtime restartでlatchを解除する。

その後、controller stateへ一つの`holdingCenteredTarget` booleanを追加し、
runtime config mappingへ`deadZoneRelease`を渡す。local field configだけを`0.14`へする。

### Step 2B: insufficient convergenceの場合だけlocal値を一つ変更する

同符号率が高い軸だけのgainを現在値の1.10倍へ変更する。両軸が同条件なら、
absolute p95が大きい一軸だけを選ぶ。gain分類が成立しない場合に限り
`maxStepDeg`を1度だけ増やす。frame interval、move speed、home、scanは変えない。

### Step 3: focused testとconfig loadを通す

Run:

```bash
npx vitest run tests/config.test.ts tests/stackchan-attention-controller.test.ts
npm run typecheck
```

Expected: 選択したcandidateに関係するtestがPASS。該当しないproduction fileは変更しない。

## Task 6: software gateを通す

**Files:**

- Verify only

### Step 1: formatterを適用する

Run:

```bash
just format
```

### Step 2: focused suiteを再実行する

Run:

```bash
npx vitest run \
  tests/stackchan-attention-metrics.test.ts \
  tests/stackchan-center-calibration-field.test.ts \
  tests/stackchan-face-follow-field.test.ts \
  tests/stackchan-centering-evaluation.test.ts \
  tests/stackchan-attention-controller.test.ts
```

Expected: PASS。

### Step 3: 全gateとsecret scanを実行する

Run:

```bash
just check
npx secretlint .
git diff --check
```

Expected: 全てPASS。

## Task 7: 合成targetで最大4回の無人実機iterationを行う

**Files:**

- Temporary only: `mktemp -d`配下の合成target
- Private reports: `/Users/monsoon/.pico/field-reports/*.json`
- No repository asset

### Step 1: 実機preflightを行う

- model fileが通常fileであることを確認する。
- installed gatewayのhealth、device connected、tool数を記録する。
- capture directory件数を記録する。
- field configがproduction home/scan値を保持していることを確認する。
- camera streamを提供するfeature gatewayが必要なら、installed launchd gatewayをbootoutし、
  feature gatewayをforeground sessionで起動する。Cloudflare tunnelは停止しない。

### Step 2: 中立的な成人合成targetを生成して表示する

`imagegen`で、特定人物を模倣しない正面向きの成人の顔と上半身を一枚生成する。
temporary directoryへ保存し、Mac画面に最大表示する。実在人物写真、過去capture、
repository assetを使わない。

### Step 3: 固定姿勢baselineを実行する

```bash
npm run field:stackchan-center-calibration -- \
  --enable-live-run \
  --duration-ms 12000 \
  --max-frames 80 \
  --minimum-target-frames 20 \
  --model-path /Users/monsoon/.pico/models/pinto-441-s/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx \
  --report-output /Users/monsoon/.pico/field-reports/2026-07-27-stackchan-center-calibration-synthetic-baseline.json
```

target 20未満、servo limit、stream/model errorならparameterを変更せず停止する。

### Step 4: face-follow baselineを実行する

30秒runで最初の5秒を捕捉猶予、以後20秒を採用windowとして評価する。

```bash
npm run field:stackchan-face-follow -- \
  --enable-live-run \
  --duration-ms 30000 \
  --max-frames 120 \
  --model-path /Users/monsoon/.pico/models/pinto-441-s/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx \
  --report-output /Users/monsoon/.pico/field-reports/2026-07-27-stackchan-face-follow-synthetic-baseline.json
```

### Step 5: 最大3 candidateを一変数ずつ試す

baselineが不合格でcandidateがある場合だけTask 5を実施し、同じ表示、duration、model、
frame上限で再runする。各run後にsoftware focused testを通す。candidateを重ねず、
前candidateが不合格ならその変更を元へ戻してから次candidateを選ぶ。run総数はbaselineを
含め4以下とする。

採用条件:

- first centered <=5,000ms
- 5秒後から25秒までのcentered ratio >=0.70
- maximum lost gap <2,000ms
- errors 0
- home readback ±1度

### Step 6: 必ずcleanupする

成否にかかわらず次を確認する。

1. face-follow/calibration processが終了している。
2. camera stream subscriberが0、physical stream停止、latest frameなし。
3. StackChan headがhomeへ±1度で復帰している。
4. feature gatewayを停止し、installed launchd gatewayをbootstrapする。
5. installed gatewayへdevice connected、43 toolsで復帰している。
6. capture directory件数がpreflightから増えていない。
7. 合成targetを閉じてtemporary directoryを破棄する。
8. report file modeが`0600`である。

## Task 8: 最終検証とhandoffを行う

**Files:**

- Modify if needed: `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`

### Step 1: field結果をaggregateで記録する

runごとに次だけを記録する。

- report path
- classification
- changed parameter一件または変更なし
- target frames、first centered、20秒window中央率、lost gap、errors、home復帰
- synthetic proxy pass/fail
- 実人物最終検証がpendingであること

画像、個別検出、token、raw errorは記録しない。

### Step 2: final treeを再検証する

Run:

```bash
just check
npx secretlint .
git diff --check
git status --short
```

Expected: gate PASS、意図した未commit変更だけが残る。

### Step 3: 利用者へ結果を報告する

次を簡潔に報告する。

- 実装したfield診断
- synthetic proxyで採用した一変数と実測値
- cleanupとinstalled gateway復帰状態
- 画像を保存していないこと
- 実人物による5秒/20秒/70%最終検証が残ること
- commit、push、PRを行っていないこと
