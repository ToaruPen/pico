# StackChan 静止人物中央保持校正設計

## 背景

StackChan の CoreS3 camera stream、PINTO 441-S Dist による顔・頭検出、会話中の
head follow は実機で動作している。2026-07-27 の30秒試験では、56処理frame中49
frameでtargetを検出し、9 frameが画面中央のdead zone内だった。中央率は18.4%、
moveは40回、errorは0、終了時のhome復帰にも成功した。

この結果から、人物を見つける能力より、静止人物を中央へ収束させて保持する能力に
改善余地がある。ただし既存reportは中央率だけを保存するため、上下方向の恒常的な
偏り、収束不足、中央をまたぐ往復運動を区別できない。

## 目的

- 正面約1mの静止人物を5秒以内に捕捉し、その後20秒間の中央率を70%以上にする。
- 中央率低下の原因を集計値から分類し、一度に一変数だけ調整する。
- 利用者不在時は合成顔を静止targetとして、制御系の収束と保持を反復検証する。
- camera画像をdiskへ保存せず、session終了時にmemory上のJPEGも破棄する。

## 非目的

- 動く人物への追従性能を今回の採用条件にしない。
- 顔識別、人物同定、よく見る人物の記録、profile作成を行わない。
- 合成顔の画面位置から実環境向け`homePitch`を最終決定しない。
- Pico production runtimeへ自動調整器や永続的な校正storeを追加しない。
- gateway、firmware、modelをこの校正のためだけに置き換えない。

## 採用するアプローチ

計測と補正を分ける二段階方式を採用する。

1. field専用の固定姿勢校正で、target中心誤差を集計する。
2. 既存face-followを使い、収束時間、中央保持、見失い、符号反転を集計する。
3. 集計結果に対応する一変数だけを試験用local configで変更する。
4. 同じ条件で再測定し、採用条件を満たさなければ元へ戻す。

複数parameterの自動総当たりは、人物や画面位置の差をparameter差と誤認しやすく、
servo動作も増えるため採用しない。PID、追跡ID、velocity予測は動く人物向けの後続候補
とし、静止人物の基準を満たす前には追加しない。

## 成功条件

### 実人物による最終条件

- 通常の室内照明
- StackChan正面約1m
- 人物は静止
- 開始時は画面中央外でもよい
- 5秒以内に最初の中央判定へ到達
- その後20秒間の中央率70%以上
- 連続した見失いが2秒未満
- runtime error 0
- 終了時に設定済みhome姿勢へ±1度以内で復帰

中央判定は現行どおり、顔または頭のbox中心が画面中心から水平・垂直ともに
`deadZone=0.10`以内にある状態とする。

### 無人時の代理条件

実在人物ではない合成顔と上半身を画面へ表示し、同じ5秒捕捉、20秒測定、中央率70%、
見失い2秒未満、error 0、home復帰を要求する。これは制御系の合格条件であり、
実環境の距離、高さ、立体感、照明を代表しない。したがって合成targetだけで
`homeYaw`、`homePitch`、`scanYaw`、`scanPitch`のproduction採用値を変更しない。

## コンポーネント

### 固定姿勢校正ハーネス

field専用scriptを`stackchan-face-follow`と同じ境界に追加する。adapterとPINTO modelを
再利用し、home姿勢へ移動してから一定時間camera streamを読む。校正中はservoへ
追従moveを送らない。

各新規camera sequenceにつき、`selectAttentionTarget`が選択した1 targetだけを集計する。
個別frame、JPEG、bounding box、center座標、confidenceはreportへ書かない。

reportには次の集計だけを含める。

- 処理frame数
- target frame数
- face frame数
- head frame数
- 水平・垂直それぞれの符号付きp50
- 水平・垂直それぞれの絶対誤差p50、p95
- 最大連続見失い時間
- stream freshness p95
- inference p95
- home復帰結果

target frameが20未満なら校正不足としてfail closedする。
failed reportも取得済みの集計、boundedなfailure code、home復帰結果を保持する。raw error、
画像、個別検出は含めず、final poseの取得可否をboundedなstatusとして明示する。

### Face-follow診断集計

既存face-follow field harnessへ、個別観測を保存しないbounded accumulatorを追加する。
同じcamera sequenceをpollingで重複計上しない。

既存のtarget frame数、centered frame数、中央率に加え、次を集計する。

- 最初のtarget検出までの時間
- 最初の中央判定までの時間
- 水平・垂直の符号反転回数
- dead zone外の符号比較回数
- 水平・垂直の絶対誤差p50、p95
- 最大連続見失い時間
- servo limitへ到達したframe数

符号反転はdead zone外の連続したtarget観測間だけを数える。dead zone内の微小な符号差と
targetなし期間は反転に含めない。servo limitはyawが±90度、pitchが5度または85度の
各limitから1度以内にある状態とする。

### 合成target

個人を模倣しない中立的な成人の合成顔と上半身を一時生成し、Macの画面へ表示する。
実在人物の写真や過去のStackChan captureは使わない。生成物はrepositoryへ追加せず、
field session終了後に破棄する。

StackChan cameraから合成targetが検出できない、画面が視野にない、反射やmoireで
target frameが20未満の場合は、無人実機iterationを成立しなかったものとして停止する。
この場合にconfidence thresholdを下げて合格扱いにはしない。

## 補正の判定規則

一度のiterationで変更できるのは一変数だけとする。

### 恒常的な位置偏り

固定姿勢校正で、ある軸の符号付きp50の絶対値が0.05を超え、同軸の絶対誤差p95が
絶対誤差p50から0.10以内にある場合は位置偏りとして記録する。実人物試験では
`homeYaw`または`homePitch`を先に補正し、対応するscan姿勢へ同じ角度差を適用する。

合成target試験では画面の物理位置が偏りを作るため、homeまたはscanのproduction値を
変更しない。

### 往復運動

follow中の符号反転回数をdead zone外の符号比較回数で割った値が0.25以上、符号付き
p50の絶対値が0.03以下、絶対誤差p95が0.10を超える場合は往復運動と判断する。この場合は
gainや速度を上げない。まずdead zoneへの進入閾値0.10と退出閾値0.14を分ける
hysteresisを候補とする。中央判定の評価閾値は0.10のまま変えない。

### 収束不足

dead zone外の観測の70%以上で同じ符号の誤差が残り、servo limitへ到達せず、最初の
中央判定が5秒を超える場合は収束不足と判断する。該当軸のgainを10%上げるか、
`maxStepDeg`を1度上げるかのどちらか一方だけを候補にする。move speedとframe intervalは
同じiterationでは変更しない。

### 無効な幾何条件

servo limitへ到達してもtargetが中央へ入らない場合は、controller parameterではなく
targetの高さ、距離、画面位置が無効と判断する。parameterを変更せず、そのrunを不採用に
する。

## Iterationの上限

無人runはbaselineを含め最大4回とする。変更候補は最大3件で、同じ失敗にparameterを
重ねない。70%へ到達しない場合は、集計結果と残る仮説を報告して実人物試験を待つ。

## エラー処理とcleanup

gateway未接続、model不在、target不足、camera stream失敗、servo command失敗のいずれでも
reportをfailedとし、production設定を変更しない。

成否に関係なく`finally`相当の経路で次を実行する。

1. camera stream leaseを解放する。
2. gatewayのlatest JPEGが利用不能になったことを確認する。
3. headをhome姿勢へ戻してreadbackする。
4. MCP adapterを閉じる。
5. 一時的な合成targetを破棄する。
6. feature gatewayを使った場合はinstalled launchd gatewayへ戻す。

field reportはmode `0600`で書き、token、raw error、画像、個別検出を含めない。

## テスト

TDDで次を検証する。

- 新規sequenceだけを集計する。
- 符号付きp50と絶対誤差p50、p95を正しく計算する。
- face/head数、符号反転、最大見失い時間、servo limit数をboundedに集計する。
- target 20未満でfail closedする。
- JPEG、base64、confidence、center座標、bounding boxをreportへ書かない。
- model、stream、servoの例外時にもstream解放、home復帰、adapter closeを試みる。
- 採用条件の全項目を満たした場合だけcandidateを合格とする。

software gateはfocused Vitest、`just check`、secret scanとする。実機ではcapture directoryの
件数が増えていないこと、stream subscriberが0へ戻ること、latest frameが消えること、
installed gatewayへ43 toolsで再接続することを確認する。

## 配備境界

無人試験で70%を満たしても、実人物による最終条件が未検証であることを明記する。
実人物試験を通るまでhome/scanのproduction採用値は変更しない。commit、push、upstream
PRは行わず、変更とprivate field reportは既存作業ツリーとprivate runtime directoryに
保持する。
