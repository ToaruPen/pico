# StackChan Speed-Adaptive Target Filter Design

## 目的

顔検出中心のフレーム間ジッタを追従指令へ直接変換せず、静止・低速時の滑らかさを改善する。同時に、速い移動や方向反転では固定ローパスフィルタの遅れを避け、端数繰り越し候補で得た応答速度を可能な限り維持する。

実機用設定、Gateway、ファームウェア、OTAには触れない。TypeScriptの純粋制御境界、決定論的な信号トレース、既存の正規リプレイだけを変更・検証対象とする。

## 根拠

現在の`advanceAttentionState`は、選択したfaceまたはheadのbounding box中心をそのままデッドゾーン判定と比例制御へ渡す。時間方向の検出揺れを抑える処理はない。

One Euro Filterは、低速時には低いカットオフ周波数でジッタを抑え、推定速度が上がるとカットオフ周波数を上げて遅延を減らす一次ローパスフィルタである。Géry Casiez、Nicolas Roussel、Daniel VogelによるCHI 2012の原方式を採用し、定速度を仮定する予測器やKalman filterは追加しない。

参考: https://gery.casiez.net/1euro/

## 検討した方式

### 1. 速度適応型One Euro Filter（評価候補として採用、実機候補には不採用）

観測中心とその微分を軸別に平滑化し、平滑化した速度の絶対値に応じて位置フィルタのカットオフ周波数を変える。

- 低速時のジッタ抑制と高速時の応答性を同じ状態機械で扱える。
- normalized image座標だけを短期状態として保持し、人物識別情報を追加しない。
- 3パラメータの選定と、ロスト・時刻異常時のリセット規則が必要になる。

### 2. 静止時だけデッドゾーンを拡大（不採用）

指令数は減らせるが、動き始めに粘りが出やすい。速度判定が必要になるため、目的に対してOne Euro Filterの劣化版になる。

### 3. 観測速度による未来位置予測（保留）

推論・通信遅延を補償できる可能性があるが、反転時のオーバーシュートと複数人物間の切替リスクが大きい。フィルタだけで不足すると実機証拠が得られるまで追加しない。

## モジュール境界

`src/modules/stackchan/target-center-filter.ts`を新設する。フィルタ計算、軸状態、パラメータ型はこのファイルが所有し、設定解析、target選択、サーボ角、lane送信は所有しない。

`attention-controller.ts`は選択済みtargetの生の中心と観測時刻をフィルタへ渡し、返された制御中心を既存のcenter判定、端数繰り越し、サーボ範囲制限へ渡す。target lossとscanへの遷移ではフィルタ状態を破棄する。

## 設定契約

enabledな`camera.stackchan.follow`へ、必須の`targetFilter`を追加する。

```yaml
targetFilter:
  enabled: false
```

または、次の有効設定を使う。

```yaml
targetFilter:
  enabled: true
  minimumCutoffHz: 1
  speedCoefficient: 2
  derivativeCutoffHz: 1
```

型は次のstrict unionとする。

```ts
export type PicoStackChanTargetFilterConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly minimumCutoffHz: number;
      readonly speedCoefficient: number;
      readonly derivativeCutoffHz: number;
    };
```

すべて有限値とし、`minimumCutoffHz`と`derivativeCutoffHz`は`0.1..30`、`speedCoefficient`は`0..30`に制限する。フィールド実機設定と既存fixtureは`enabled: false`にする。正規リプレイ候補だけが明示パラメータで有効化する。

## フィルタアルゴリズム

各軸について、観測値`x`、前回観測値`xPrev`、秒単位の間隔`dt`を使う。

1. 生の微分`dx = (x - xPrev) / dt`を計算する。
2. `derivativeCutoffHz`による一次ローパスで微分`edx`を更新する。
3. `cutoff = minimumCutoffHz + speedCoefficient * abs(edx)`を計算する。
4. `cutoff`による一次ローパスで制御中心`filteredX`を更新する。

一次ローパスの係数は次の通りとする。

```text
tau = 1 / (2 * PI * cutoff)
alpha = 1 / (1 + tau / dt)
filtered = alpha * value + (1 - alpha) * previousFiltered
```

初回観測は生値で初期化する。観測時刻が前回以下、値や計算結果が非有限、またはtarget labelがfaceとheadの間で変わった場合も、生値で安全に再初期化する。フィルタ出力は`0..1`へ制限する。

## 状態とリセット

controller stateへoptionalなtarget filter stateを追加する。状態は前回観測時刻、target label、yaw相当のhorizontal軸状態、pitch相当のvertical軸状態だけを持つ。各軸状態は前回生値、前回平滑値、前回平滑微分を持つ。

- `targetFilter.enabled: false`: 状態を作らず、生中心をそのまま返す。
- target lossの最初のhold: 状態を破棄する。
- scanへの移行とscan継続: 状態を破棄する。
- centered: 状態を保持して更新する。ここで破棄すると静止ジッタ抑制が失われる。
- 再捕捉: 最初の生中心から再初期化し、過去targetの動きを持ち込まない。
- stop: 既存runtimeが新しいtickを受理しないため、追加処理を行わない。

端数繰り越しの残差状態とは共有しない。

## 決定論的な候補選定

外部依存を追加せず、125 ms間隔の固定トレースを用いる。

### stationary-jitter

真のhorizontal centerを0.595、vertical centerを0.5に固定し、seed固定の有界ノイズを両軸へ加える。生入力はdead zone境界を往復する。生入力と候補について次を比較する。

- filtered centerのtotal variation
- 真値に対するabsolute error p50/p95
- controllerのmove request count
- controller command path total variation
- 最大整数ステップ

### noisy-reversal

真のhorizontal centerを0.38から0.62へ移動し、保持後に0.38へ反転させ、同じ有界ノイズを加える。次を比較する。

- 反転後に正しい方向へ最初に進むまでの時間
- target absolute error p50/p95
- command normalized roughness
- command velocity total variation
- 反転後の不要な方向再反転数

候補グリッドは`minimumCutoffHz = [0.5, 1, 1.5, 2]`、`speedCoefficient = [0.5, 1, 2, 4]`、`derivativeCutoffHz = 1`とする。

候補は次を全て満たす必要がある。

- stationary-jitterのcontroller command path total variationをraw比70%以下にする。
- stationary-jitterの最大整数ステップをraw以下にする。
- noisy-reversalの初動をrawから250 ms超遅らせない。
- noisy-reversalの不要な方向再反転数をraw以下にする。
- error、stale、post-stop、overlap、servo-limit、home errorを増やさない。

合格候補は、stationary-jitterのcommand path total variation、noisy-reversalの初動遅延、noisy-reversalのtarget error p95、`minimumCutoffHz`、`speedCoefficient`の順で辞書式に最小化する。合格候補がなければフィルタを不採用とし、実機設定は変更しない。

## 正規リプレイ検証

選定候補を既存の5シナリオへ設定し、同じ125 ms、yaw gain 44、max step 4、error-feedback量子化で3回反復する。シナリオ入力と既存の安全閾値は緩和しない。

- 5シナリオ全てpassed
- 3反復のcanonical hashとcomparison-set hashが一致
- 全シナリオのabsolute safetyがtrue
- producer source hashが現在ソースと一致
- 低速追従の最大確認ステップ、failed、stale、post-stop、overlap、home errorが非回帰

追従改善がノイズ付きトレースだけに現れ、正規リプレイで安全性を維持できる場合は、未有効の実機レビュー候補として保持する。正規リプレイが失敗する場合は候補を棄却する。

## 実機レビュー状態

`.pico-local/field-stackchan.yaml`は`targetFilter.enabled: false`、`stepQuantization: round`、yaw gain 44を維持する。次回立会い時は同一ファームウェアとgain 44で、rawとerror-feedbackのみを一変数で比較する。速度適応フィルタは正規リプレイ不合格のため実機レビュー対象にしない。

## 非対象

- targetの永続ID、顔認識、人物プロファイル
- Kalman filter、alpha-beta predictor、未来位置の外挿
- フレーム周期、サーボ速度、最大ステップの増加
- Gateway、ファームウェア、省電力設定の変更
- 実機での滑らかさ合格判定

## Pro相談

前回のPro相談は表示アカウント不一致で安全停止しており、回答を実装根拠に使えない。本設計は原典、既存コード、決定論的ローカル証拠だけに基づく。

## 検証結果

2026-08-01の固定seed評価では、16候補中5候補が局所ノイズ基準を満たした。辞書式選定は`minimumCutoffHz: 1`、`speedCoefficient: 4`、`derivativeCutoffHz: 1`となり、stationary-jitterのcontroller command path total variationは26から3、move requestは15から2へ減少した。noisy-reversalの初動追加遅延は250 msで上限内だった。

しかし、選定候補を既存の正規リプレイへ適用すると、static boundary invariantが失敗し、fast reversal response p95は既存上限125 msに対して750 msとなった。局所基準を通過した残り4候補もstatic boundary invariantに失敗し、fast reversal response p95は625〜750 msだった。既存閾値は変更せず、速度適応フィルタを不採用とした。

正規fixtureと無人実機設定は`targetFilter.enabled: false`へ戻した。無効状態の3反復正規リプレイは5シナリオ全てpassed、absolute safety true、決定論的一致となった。フィルタ実装と評価器は明示的に無効な探索基盤として残すが、現在の実機候補には含めない。

全体ゲートで、controllerの新しい直接依存`target-center-filter.ts`がリプレイ証拠アーカイブへ含まれていないことを検出した。証拠のproducer契約を6固定ロールへ拡張し、フィルタソースを開始時attestation、比較契約、aggregate hash、アーカイブmanifest、portable verificationの対象に加えた。フィルタソース改変の拒否テストを追加し、証拠テスト37件、集中テスト234件、全体1,481件が合格した。最新6ソースハッシュで再生成した無効状態の正規リプレイも、5シナリオ・3反復・全absolute safetyを満たした。
