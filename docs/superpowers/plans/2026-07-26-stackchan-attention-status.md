# StackChan Attention Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像を保存せず、StackChanが顔または頭をカメラ中央に捉えているかをruntime、interaction owner、field reportから確認できるようにする。

**Architecture:** controllerは選択targetから正規化中心誤差とdead-zone中央判定を一度だけ計算し、transitionの一時観測値として返す。runtimeは最新1件と集計カウンターだけをprocess memoryに保持し、ownerはactive runtime statusを転送する。field reportは座標やconfidenceを永続化せず、target frame数、centered frame数、centered ratioだけを記録する。

**Tech Stack:** TypeScript、Vitest、Pi package runtime、StackChan field harness

---

リポジトリ指示とユーザー指定に従い、この計画ではcommit、push、PRを行わない。

### Task 1: Controller target observation

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Test: `tests/stackchan-attention-controller.test.ts`

- [ ] **Step 1: Write the failing controller test**

中央外のface transitionが次のtarget observationを返すことを検証する。

```ts
expect(result.target).toEqual({
  label: "face",
  confidence: 0.8,
  centerX: 0.8,
  centerY: 0.8,
  horizontalError: 0.3,
  verticalError: 0.3,
  centered: false
});
```

中央内のfaceでは `centered: true`、targetなしのscanでは `target` が未定義になることも個別に検証する。

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/stackchan-attention-controller.test.ts`

Expected: `target` がtransitionに存在しないためFAIL。

- [ ] **Step 3: Implement the minimal observation contract**

`StackChanAttentionTargetObservation` を追加し、`StackChanAttentionTransition` にoptional `target`を追加する。`trackAttentionTarget`内でbox中心、誤差、dead-zone判定を一度計算し、hold/moveの両方へ同じtarget observationを返す。targetなしのhold/scanには追加しない。

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/stackchan-attention-controller.test.ts`

Expected: PASS。

### Task 2: Runtime live status and bounded counters

**Files:**
- Modify: `src/runtime/stackchan-attention-runtime.ts`
- Test: `tests/stackchan-attention-runtime.test.ts`

- [ ] **Step 1: Write the failing runtime status test**

fake clockと `[centered face] -> []` の2 tickを使い、最初のstatusが次を返すことを検証する。

```ts
attention: {
  mode: "track",
  targetVisible: true,
  targetFrames: 1,
  centeredFrames: 1,
  lastTarget: {
    label: "face",
    confidence: 0.9,
    centerX: 0.5,
    centerY: 0.5,
    horizontalError: 0,
    verticalError: 0,
    centered: true,
    observedAtMs: 100,
    ageMs: 25
  }
}
```

2 tick目では `mode: "hold"`、`targetVisible: false`、counter不変、`ageMs`だけ増えることを検証する。

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/stackchan-attention-runtime.test.ts`

Expected: statusに `attention` が存在しないためFAIL。

- [ ] **Step 3: Implement the minimal in-memory status**

runtimeに `targetVisible`、`targetFrames`、`centeredFrames`、`lastTarget`を追加する。tickごとにcontroller transitionのtarget有無を反映し、targetありの場合だけcounterと最新1件を更新する。`status()`取得時に `ageMs = max(0, nowMs() - observedAtMs)` を計算し、画像byte、bounding box全体、detection配列を含めない。

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/stackchan-attention-runtime.test.ts`

Expected: PASS。

### Task 3: Owner status forwarding

**Files:**
- Modify: `src/runtime/stackchan-attention-owner.ts`
- Test: `tests/stackchan-attention-owner.test.ts`

- [ ] **Step 1: Write the failing owner test**

active runtime fakeが返すattention statusを、owner statusの `runtime` fieldが同じ値で公開することを検証する。inactive ownerとinteraction終了後は `runtime` fieldが存在しないことも検証する。

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/stackchan-attention-owner.test.ts`

Expected: owner statusに `runtime` が存在しないためFAIL。

- [ ] **Step 3: Implement runtime status forwarding**

`StackChanAttentionOwnerStatus`へoptional `runtime`を追加する。active runtimeがある場合だけ `runtime.status()` のbounded resultを返し、raw error、token、画像を追加しない。

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/stackchan-attention-owner.test.ts`

Expected: PASS。

### Task 4: Aggregate-only field report

**Files:**
- Modify: `scripts/field/stackchan-face-follow.ts`
- Test: `tests/stackchan-face-follow-field.test.ts`

- [ ] **Step 1: Write the failing report test**

成功statusに `targetFrames: 8` と `centeredFrames: 5` を与え、reportへ次だけが出ることを検証する。

```ts
attention: {
  targetFrames: 8,
  centeredFrames: 5,
  centeredRatio: 0.625
}
```

serialized reportに `lastTarget`、`confidence`、`centerX`、`centerY`がないことも検証する。

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/stackchan-face-follow-field.test.ts`

Expected: reportに `attention` aggregateが存在しないためFAIL。

- [ ] **Step 3: Implement aggregate reporting**

成功reportのdetailsへattention aggregateを追加する。`centeredRatio`はtarget frameが0なら0、それ以外は `centeredFrames / targetFrames` を小数第3位へ丸める。失敗reportのshapeは変更しない。

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/stackchan-face-follow-field.test.ts`

Expected: PASS。

### Task 5: Full verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run \
  tests/stackchan-attention-controller.test.ts \
  tests/stackchan-attention-runtime.test.ts \
  tests/stackchan-attention-owner.test.ts \
  tests/stackchan-face-follow-field.test.ts
```

Expected: PASS。

- [ ] **Step 2: Run repository gates**

Run: `just check`

Expected: typecheck、lint、ast、testがすべてPASS。

- [ ] **Step 3: Run secret scan**

Run: `/Users/monsoon/Dev/dotfiles/node_modules/.bin/secretlint .`

Expected: PASS。画像、token、ローカルsecretを新規出力しない。

- [ ] **Step 4: Run bounded live validation when the device reconnects**

既存の30秒field commandを実行し、reportの `attention.targetFrames` が1以上かつ
`attention.centeredFrames <= attention.targetFrames` であることを確認する。画像保存件数が0であることも確認する。本体未接続の場合は自動テスト完了と実機未検証を分離して報告する。
