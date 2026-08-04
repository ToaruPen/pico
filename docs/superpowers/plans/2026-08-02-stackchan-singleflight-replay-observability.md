# StackChan Single-Flight Replay and Quantization Observability Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the deterministic StackChan attention replay reproduce the production gateway's single-flight head-target lane, compare legacy rounding with the existing error-feedback quantizer from one build, and expose enough non-behavioral diagnostics to determine whether residual release is coupled to visual-frame cadence or RPC confirmation cadence.

**Architecture:** Keep the production controller and runtime as the only source of quantization behavior. Add a default-off diagnostic observer at the controller/runtime boundary, feed those records into the field replay, and model the gateway as one active request plus one latest-wins pending request. The replay runs both quantizers from identical fixtures and timing, then reports quantization, zero-run, lane, settling, and causal-probe evidence without changing production defaults.

**Tech Stack:** TypeScript, Vitest, Zod/JSON Schema validation, existing StackChan attention controller/runtime/replay tooling, `just` repository gates.

**Scope constraint:** Tasks 1-7 preserve all pre-existing dirty worktree changes and do not commit, push, clean, reset, update firmware, reboot hardware, or change production defaults. The user subsequently authorized a separately audited real-device cycle; that continuation remains one-shot, fail-closed, and does not authorize commit or push.

**Progress (2026-08-02):** Tasks 1-7は完了した。error-feedback、最小移動時間、wrong-way cancelは比較で不採用とし、既存の速度継承は追加変更不要と確認した。次の下流候補として、ファームウェアのnative `WritePos`直前にdefault-offのexact duplicate suppressionと固定長telemetryをTDD実装した。host 49/49、Gateway 795 pass/5 skip、firmware script 30/30、ESP-IDF 5.5.2 buildを通過し、ChatGPT Proから一回限りのOTA/ABBA実機評価承認を得た。

実機runnerは、更新前後のready-session分離、更新後session固定、final native write pending gate、識別子非保存、auto torque releaseの保存・一時無効化・復元を追加のRed→Green 9テストで固定した。2026-08-02の一回限りrunは、実機から43/46-tool ready-sessionが180秒間確立しなかったため、OTA転送前に`OTA blocked`として停止した。OTA、再起動、サーボ駆動、設定変更、ABBA blockはいずれも0で、自動再試行はしていない。証拠は`/tmp/stackchan-field-20260802/evidence/20260801T202122Z-abba/`に保存した。

次の根本候補は、servo busへの`ReadPos`負荷を増やさず、CoreS3内蔵BMI270のgyro/accelをnative telemetryと同一monotonic clockで固定長収集する物理評価経路である。ただし現行StackChanはESP-IDF 5.5の`i2c_master_bus_handle_t`を共有し、既存`espressif/bmi270_sensor` componentはlegacy `i2c_bus_handle_t`を要求する。したがって同一controllerへ別legacy busを作らず、新I2C master busのdevice handleを共有するadapter設計を別監査・別buildとして扱う。

Pro承認済みのhost-only範囲で、default-off/no-heapのraw IMU ring、100 Hz cadence契約、同一clock、固定500 ms bias、offline derivativeをRed→Green実装した。独立レビューが、許容窓を1 us超えたwakeで次の正常slotまで消費する境界不具合、sampleされないearly wake間の時刻逆行の記録漏れ、500 ms契約がAPI上可変という3点を検出した。各点を失敗テストで再現してから修正し、nonzero stale axesを伴うread failureのzero化とbias入力のnon-monotonic拒否も明示テストへ追加した。Proの最終host監査で求められた`ScorableWindow`も追加し、cadence/read/buffer/timestamp/bias/axisのいずれかが不正ならfield採用用bias・角速度・加速度・jerkを一切返さない契約を固定した。最終独立レビューで外部構築された範囲外biasによるsigned overflow候補もRed→Greenで拒否へ直し、再レビューは所見なし・approveとなった。最終host gateは74/74 pass、`git diff --check` passである。adapter実装、firmware build/link、Gateway再起動、実機接続、OTAは未実施のまま保持した。

---

## Task 1: Lock the production single-flight replay contract

**Files:**
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `tests/stackchan-attention-replay-field.test.ts`
- Modify: `tests/stackchan-attention-replay-lane-policy.test.ts`

- [ ] Add failing tests proving the replay lane never exceeds one active request, never retains more than one pending latest-wins request, never dispatches a superseded pending target, drains to zero after stop, and preserves pose bounds.
- [ ] Run `npx vitest run tests/stackchan-attention-replay-field.test.ts tests/stackchan-attention-replay-lane-policy.test.ts` and confirm the new tests fail for the current active-two model.
- [ ] Change the virtual lane to the production `active=1, pending=1` contract and update metadata so the reported lane contract is generated from the executed model rather than a stale literal.
- [ ] Re-run the focused tests and confirm they pass without weakening existing lane assertions.

## Task 2: Add explicit replay-only quantization selection

**Files:**
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `tests/stackchan-attention-replay-field.test.ts`

- [ ] Add failing tests for an explicit `round | error-feedback` replay option, CLI selection, fail-closed invalid values, identical default fixture/timing inputs, independent state reset, and matching nonzero producer source hashes.
- [ ] Run the focused field replay tests and confirm the option/CLI tests fail.
- [ ] Thread the replay-only mode through runtime creation and metadata while leaving the production StackChan configuration default unchanged.
- [ ] Re-run the focused tests and confirm both modes execute from the same build and fixture.

## Task 3: Expose default-off controller decision diagnostics

**Files:**
- Modify: `src/modules/stackchan/attention-controller.ts`
- Modify: `src/runtime/stackchan-attention-runtime.ts`
- Modify: `tests/stackchan-attention-controller.test.ts`
- Modify: `tests/stackchan-attention-runtime.test.ts`

- [ ] Add failing controller tests for per-axis normalized error, raw post-deadzone correction, clamped correction, legacy rounded step, selected quantized step, residual before/after, residual action/reset reason, base confirmed pose, requested pose, and negative-zero normalization.
- [ ] Add a failing runtime characterization test proving an absent observer preserves command, state, request, and timing behavior, while an enabled observer receives each accepted decision once.
- [ ] Run the focused controller/runtime tests and confirm the diagnostic assertions fail.
- [ ] Implement a pure diagnostic result and default-off runtime observer that reuses the controller's actual intermediate values rather than reimplementing quantization in the replay.
- [ ] Re-run the focused tests and confirm production behavior remains unchanged.

## Task 4: Record quantization and lane outcomes in replay evidence

**Files:**
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `scripts/field/stackchan-attention-replay-schema.ts`
- Modify: `scripts/field/stackchan-attention-replay-report.schema.json`
- Modify: `tests/stackchan-attention-replay-field.test.ts`
- Modify: `tests/stackchan-attention-replay-gate.test.ts`

- [ ] Add failing schema and field tests for monotonic decision IDs, request linkage, per-axis diagnostic fields, effect outcomes (`dispatched`, `replaced`, `noop`, `stale`, `none`), ticks since confirmed update, and reset/reversal records.
- [ ] Run the focused replay/schema tests and confirm the new evidence contract fails.
- [ ] Attach controller diagnostics to accepted replay decisions and correlate them with virtual-lane outcomes without recording images, personal data, secrets, or device identifiers.
- [ ] Update the TypeScript schema and JSON Schema together, bump their version, and re-run focused tests.

## Task 5: Measure zero-runs, releases, and causal coupling

**Files:**
- Modify: `scripts/field/stackchan-attention-metrics.ts`
- Modify: `scripts/field/stackchan-attention-replay.ts`
- Modify: `tests/stackchan-attention-metrics.test.ts`
- Modify: `tests/stackchan-attention-replay-field.test.ts`

- [ ] Add failing metric tests for zero-run duration and length percentiles, censored runs, release-step magnitude, residual-release outcome, releases consumed without dispatch, sign-reversal resets, dispatch interval, reply-to-next-dispatch delay, and virtual-confirmed total variation.
- [ ] Add failing deterministic probe tests for: repeated sub-degree observations with delayed reply, visual-cadence-only changes, and reply-cadence-only changes.
- [ ] Run the focused metric/replay tests and confirm failures are caused by missing metrics/probes.
- [ ] Implement the metrics and three probes with fixed seeds and identical non-varied inputs, explicitly labeling virtual-confirmed variation as non-physical telemetry.
- [ ] Re-run focused tests and characterize exact half-step hits and negative-zero command count.

## Task 6: Execute the comparison matrix and classify the quantizer

**Files:**
- Modify only if a defect is proven by the matrix: the files already listed above
- Write private reports only under a fresh `/tmp` directory

- [ ] Run focused controller/runtime/replay/metric suites.
- [ ] Run five deterministic scenarios three times for `round` and three times for `error-feedback`, using the same fixture, producer hash, seed, timing, reply model, gain `44`, and production single-flight lane.
- [ ] Verify byte-stable or schema-stable deterministic results across repeats and inspect zero-runs, lane outcomes, settling, path length, reversals, roughness, error percentiles, and virtual-confirmed variation.
- [ ] Classify the current error-feedback mode as locally viable, rejected, or inconclusive, with an explicit causal finding for visual-frame and reply-cadence coupling.
- [ ] If a defect is found, write one failing test, make the smallest correction, and repeat this task. Do not introduce an alternate production controller in this plan.

## Task 7: Validate the repository and consult ChatGPT Pro

**Files:**
- Modify only proven in-scope defects

- [ ] Run `npx vitest run tests/stackchan-attention-controller.test.ts tests/stackchan-attention-runtime.test.ts tests/stackchan-attention-replay-field.test.ts tests/stackchan-attention-replay-gate.test.ts tests/stackchan-attention-replay-lane-policy.test.ts tests/stackchan-attention-metrics.test.ts`.
- [ ] Run relevant gateway tests in `/Users/monsoon/.config/superpowers/worktrees/stackchan-mcp/camera-stream` without changing that worktree.
- [ ] Run `just check` from this Pico worktree.
- [ ] Re-check the ChatGPT Pro account/model identity, send structured evidence under instruction ID `stackchan-singleflight-replay-observability-tdd-20260801`, and receive the next bounded instruction.
- [ ] Use hardware only if the evidence and next instruction identify a specific physical hypothesis; record the exact command, safety bounds, observation, and rollback. Do not flash firmware or reboot without a separately justified need.
- [ ] Apply any accepted bounded correction through another Red→Green cycle, repeat the relevant gates, and remove private temporary reports before final handoff.
