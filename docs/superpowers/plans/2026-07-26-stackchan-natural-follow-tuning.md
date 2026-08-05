# StackChan Natural Follow Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** StackChan の顔追従を4Hzで自然に動かし、見回し周期を分離し、明示した安全なサーボ速度で実機検証できるようにする。

**Architecture:** 既存の config → attention controller → attention runtime → StackChan adapter の境界を維持する。controller は scan の滞在時刻だけを保持し、runtime は全 head move に設定済み速度を渡し、adapter は gateway の既存 `speed` 引数へ変換する。

**Tech Stack:** TypeScript、Vitest、Pi package runtime、StackChan MCP gateway、PINTO 441-S Dist ONNX

---

リポジトリ指示とユーザー指定に従い、この計画では commit、push、PR を行わない。

## Task 1: 自然さ優先の設定契約

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`
- Modify: `.pico-local/field-stackchan.yaml`

- [ ] **Step 1: 既定値と境界値の失敗テストを書く**

`tests/config.test.ts` の StackChan follow 設定期待値を次へ変更する。

```ts
follow: {
  enabled: true,
  frameIntervalMs: 250,
  homeYaw: 0,
  homePitch: 35,
  deadZone: 0.1,
  yawGainDeg: 40,
  pitchGainDeg: 30,
  flipYaw: 1,
  flipPitch: -1,
  maxStepDeg: 4,
  moveSpeedDps: 90,
  lostHoldMs: 1000,
  scanDwellMs: 900,
  scanYaw: [-35, 0, 35],
  scanPitch: [35, 25]
}
```

同じテストファイルへ、`moveSpeedDps` の14と241、`scanDwellMs` の0を拒否する表形式テストを追加する。

```ts
it.each([
  ["moveSpeedDps", 14],
  ["moveSpeedDps", 241],
  ["scanDwellMs", 0]
] as const)("rejects unsafe StackChan follow %s=%s", (field, value) => {
  expect(() =>
    definePicoConfig({
      camera: {
        stackchan: {
          mcpUrl: "http://127.0.0.1:18767/mcp",
          bearerTokenEnv: "STACKCHAN_TOKEN",
          follow: { enabled: true, [field]: value }
        }
      }
    })
  ).toThrow(`camera.stackchan.follow.${field}`);
});
```

- [ ] **Step 2: 設定テストが失敗することを確認する**

Run: `npx vitest run tests/config.test.ts`

Expected: 新しい既定値または未知フィールド `moveSpeedDps` / `scanDwellMs` により FAIL。

- [ ] **Step 3: 型、許可フィールド、既定値、境界を実装する**

`PicoStackChanFollowConfig` の enabled branch へ次を追加する。

```ts
readonly moveSpeedDps: number;
readonly scanDwellMs: number;
```

`defineStackChanFollowConfig` の既知フィールドへ両名を追加し、返却値を次の契約へ変更する。

```ts
frameIntervalMs:
  readOptionalBoundedPositiveInteger(
    input.frameIntervalMs,
    "pico config camera.stackchan.follow.frameIntervalMs",
    maxNodeTimeoutMs
  ) ?? 250,
deadZone:
  readOptionalBoundedDeadZone(
    input.deadZone,
    "pico config camera.stackchan.follow.deadZone"
  ) ?? 0.1,
maxStepDeg:
  readOptionalPositiveNumber(
    input.maxStepDeg,
    "pico config camera.stackchan.follow.maxStepDeg"
  ) ?? 4,
moveSpeedDps:
  readOptionalBoundedInteger(
    input.moveSpeedDps,
    "pico config camera.stackchan.follow.moveSpeedDps",
    15,
    240
  ) ?? 90,
lostHoldMs:
  readOptionalBoundedPositiveInteger(
    input.lostHoldMs,
    "pico config camera.stackchan.follow.lostHoldMs",
    maxNodeTimeoutMs
  ) ?? 1000,
scanDwellMs:
  readOptionalBoundedPositiveInteger(
    input.scanDwellMs,
    "pico config camera.stackchan.follow.scanDwellMs",
    maxNodeTimeoutMs
  ) ?? 900,
```

- [ ] **Step 4: サンプル設定と実機設定を同じ値へ更新する**

`config/pico.example.yaml` と `.pico-local/field-stackchan.yaml` の follow block を次へ合わせる。

```yaml
frameIntervalMs: 250
deadZone: 0.10
maxStepDeg: 4
moveSpeedDps: 90
lostHoldMs: 1000
scanDwellMs: 900
```

- [ ] **Step 5: 設定テストを通す**

Run: `npx vitest run tests/config.test.ts`

Expected: PASS。

## Task 2: 観測周期から独立した見回し滞在

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Modify: `tests/stackchan-attention-controller.test.ts`

- [ ] **Step 1: scan dwell の失敗テストを書く**

controller の共通設定へ `scanDwellMs: 900` を追加し、最初のscan直後は保持し、900ms後だけ次へ進むテストを追加する。

```ts
it("observes every tick but advances scan only after scanDwellMs", () => {
  const first = advanceAttentionState(
    initialAttentionState(),
    { nowMs: 100, currentPose: { yaw: 0, pitch: 35 }, detections: [] },
    config
  );
  const waiting = advanceAttentionState(
    first.state,
    { nowMs: 999, currentPose: { yaw: -35, pitch: 35 }, detections: [] },
    config
  );
  const next = advanceAttentionState(
    waiting.state,
    { nowMs: 1000, currentPose: { yaw: -35, pitch: 35 }, detections: [] },
    config
  );

  expect(first).toMatchObject({
    state: { mode: "scan", scanIndex: 1, lastScanMoveAtMs: 100 },
    effect: { kind: "move", pose: { yaw: -35, pitch: 35 } }
  });
  expect(waiting.effect).toEqual({ kind: "hold" });
  expect(next).toMatchObject({
    state: { mode: "scan", scanIndex: 2, lastScanMoveAtMs: 1000 },
    effect: { kind: "move", pose: { yaw: 0, pitch: 35 } }
  });
});
```

- [ ] **Step 2: controller テストが失敗することを確認する**

Run: `npx vitest run tests/stackchan-attention-controller.test.ts`

Expected: `lastScanMoveAtMs` と dwell 処理が未実装のため FAIL。

- [ ] **Step 3: scan 時刻だけを状態へ追加する**

状態型へ永続画像やtarget情報を増やさず、次だけを追加する。

```ts
export type StackChanAttentionState = {
  readonly mode: StackChanAttentionMode;
  readonly lastTargetAtMs?: number;
  readonly lastTrackedPose?: StackChanHeadPose;
  readonly lastScanMoveAtMs?: number;
  readonly scanIndex: number;
};
```

controller config から runtime 専用の `moveSpeedDps` も除外する。

```ts
export type StackChanAttentionControllerConfig = Omit<
  Extract<PicoStackChanFollowConfig, { readonly enabled: true }>,
  "enabled" | "frameIntervalMs" | "homeYaw" | "homePitch" | "moveSpeedDps"
>;
```

- [ ] **Step 4: scan の滞在判定を最小実装する**

`advanceScan` に `nowMs` を渡し、既にscan中で滞在時間未満ならholdする。

```ts
if (
  state.mode === "scan" &&
  state.lastScanMoveAtMs !== undefined &&
  input.nowMs - state.lastScanMoveAtMs < config.scanDwellMs
) {
  return { state, effect: { kind: "hold" } };
}
```

scan moveを返すstateへ時刻を記録する。

```ts
state: {
  ...state,
  mode: "scan",
  lastScanMoveAtMs: input.nowMs,
  scanIndex: (currentIndex + 1) % poseCount
}
```

顔を再取得した `trackAttentionTarget` の次stateには `lastScanMoveAtMs` を引き継がず、次回loss recoveryの最初のscanを即時にする。

- [ ] **Step 5: controller テストを通す**

Run: `npx vitest run tests/stackchan-attention-controller.test.ts`

Expected: PASS。既存scan sequenceテストは各入力時刻を `scanDwellMs` 以上離して更新する。

## Task 3: 明示速度を adapter と runtime に通す

**Files:**
- Modify: `src/modules/stackchan/index.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`
- Modify: `tests/stackchan.test.ts`
- Modify: `tests/stackchan-attention-runtime.test.ts`
- Modify: `tests/stackchan-face-follow-field.test.ts`

- [ ] **Step 1: adapter の speed 転送失敗テストを書く**

`tests/stackchan.test.ts` で adapter に速度付き移動を要求し、gateway requestを検証する。

```ts
await adapter.moveHead({ yaw: 12, pitch: 34 }, { speedDps: 90 });

expect(client.callTool).toHaveBeenCalledWith({
  name: "move_head",
  arguments: { yaw: 12, pitch: 34, speed: 90 }
});
```

加えて `{ speedDps: 14 }` と `{ speedDps: 241 }` が gateway を呼ぶ前にrejectされることを検証する。

- [ ] **Step 2: runtime の全移動へ速度を渡す失敗テストを書く**

`tests/stackchan-attention-runtime.test.ts` の fake adapter で第2引数を記録し、startup home、tracking move、stop homeのすべてが `{ speedDps: 90 }` になることを検証する。

```ts
moveHead(pose, motion) {
  events.push(`move:${pose.yaw},${pose.pitch}:${motion?.speedDps}`);
  return Promise.resolve();
}
```

- [ ] **Step 3: adapter/runtime テストが失敗することを確認する**

Run: `npx vitest run tests/stackchan.test.ts tests/stackchan-attention-runtime.test.ts`

Expected: `StackChanAdapter.moveHead` の第2引数と gateway `speed` が未実装のため FAIL。

- [ ] **Step 4: typed motion option と gateway 転送を実装する**

`src/modules/stackchan/index.ts` に次を追加する。

```ts
export type StackChanHeadMotion = {
  readonly speedDps: number;
};

export type StackChanAdapter = {
  readonly connect: () => Promise<void>;
  readonly captureJpeg: () => Promise<StackChanJpegFrame>;
  readonly getHeadAngles: () => Promise<StackChanHeadPose>;
  readonly moveHead: (
    pose: StackChanHeadPose,
    motion?: StackChanHeadMotion
  ) => Promise<void>;
  readonly close: () => Promise<void>;
};
```

内部wrapperで指定時だけ速度を検証・転送する。

```ts
const arguments_: Record<string, unknown> = {
  yaw: pose.yaw,
  pitch: pose.pitch
};
if (motion !== undefined) {
  requireBoundedInteger(motion.speedDps, "speedDps", 15, 240);
  arguments_.speed = motion.speedDps;
}
const result = await callStackChanTool(client, "move_head", arguments_);
```

- [ ] **Step 5: runtime の全移動で設定速度を使う**

tracking、startup home、stop homeの各呼び出しを同じ形へ変更する。

```ts
await options.adapter.moveHead(pose, {
  speedDps: options.config.moveSpeedDps
});
```

`attentionControllerConfig` へ `scanDwellMs: config.scanDwellMs` を追加する。

- [ ] **Step 6: 影響するfake configと期待eventを更新してテストを通す**

全 enabled follow fixture に次を追加する。

```ts
moveSpeedDps: 90,
scanDwellMs: 900
```

Run: `npx vitest run tests/stackchan.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-face-follow-field.test.ts`

Expected: PASS。

## Task 4: 静的検証と実機チューニング

**Files:**
- Modify: `.pico-local/field-stackchan.yaml`
- Write field output: `/Users/monsoon/.pico/field-reports/2026-07-26-stackchan-natural-follow-4hz.json`
- Write field output when 5Hz is measured: `/Users/monsoon/.pico/field-reports/2026-07-26-stackchan-natural-follow-5hz.json`
- Modify: `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`

- [ ] **Step 1: 変更識別子の所有箇所を確認する**

Run: `rg -n "moveSpeedDps|scanDwellMs|frameIntervalMs: 250|deadZone: 0.1|maxStepDeg: 4" src tests config .pico-local docs`

Expected: 設定、controller、runtime、adapter、関連fixture、仕様・計画だけに出現する。

- [ ] **Step 2: focused gatesを実行する**

Run: `just typecheck`

Expected: PASS。

Run: `just lint`

Expected: PASS。

Run: `just ast`

Expected: PASS。

Run: `npx vitest run tests/config.test.ts tests/stackchan.test.ts tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-face-follow-field.test.ts`

Expected: PASS。

- [ ] **Step 3: 4Hz実機runを30秒実行する**

安定版gatewayが動作中なら停止せず、feature gatewayが必要な場合だけ既存の検証手順で一時起動する。モデルパスとtokenは既存field環境から読み、secretをログへ出さない。

Run:

```bash
npm run field:stackchan-face-follow -- \
  --enable-live-run \
  --duration-ms 30000 \
  --max-frames 300 \
  --model-path "/Users/monsoon/.pico/models/pinto-441-s/yolox_s_body_head_hand_face_dist_0189_0.4952_post_1x3x256x320.onnx" \
  --report-output "/Users/monsoon/.pico/field-reports/2026-07-26-stackchan-natural-follow-4hz.json"
```

Expected:
- report status `passed`
- errors `0`
- returnedHome `true`
- stream.receivedFps `>= 3.5`
- stream.frameAgeP95Ms `<= 250`
- inference.p95Ms `<= 50`

- [ ] **Step 4: 4Hz合格時だけ5Hzを比較する**

`.pico-local/field-stackchan.yaml` の `frameIntervalMs` だけを200へ変更し、同じ30秒runを
`/Users/monsoon/.pico/field-reports/2026-07-26-stackchan-natural-follow-5hz.json` へ出力する。

Expected:
- report status `passed`
- errors `0`
- returnedHome `true`
- stream.receivedFps `>= 4.5`
- stream.frameAgeP95Ms `<= 250`

5Hzが基準未達なら250msへ戻す。基準達成時も人物不在で自然さを比較できない場合は、
production値を保守的な250msのままにする。

- [ ] **Step 5: 2分のbounded stability runと全gateを実行する**

選択した設定で実機runを120秒に延長し、終了時home復帰とerror 0を確認する。人物不在で
wide scanを続けるため、不要なservo摩耗を避けて10分連続運転は行わない。

Run: `just check`

Expected: PASS。

Run: `npx secretlint .`

Expected: PASS。

- [ ] **Step 6: field reportを文書化する**

`docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md` へ、採用値、4Hz/5Hzの実測、soak結果、人物不在なら主観的な顔追従だけ未判定であること、画像を保存していないことを追記する。
