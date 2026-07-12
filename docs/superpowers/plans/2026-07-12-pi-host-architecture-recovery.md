# Pi Host Architecture Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pi が本番 resident process と単一 conversation session を所有し、Pico extension が既存 Pi session へ音声 turn を渡す ownership foundation を構築する。

**Architecture:** `pico-runtime-profile` は startup-only で、既定の `worker`、明示的な `interactive`、明示的な `resident` を中央制御する。resident profile は extension lifecycle から音声 service を開始し、`pi.sendUserMessage()` と Pi events を使う薄い boundary を注入する。直接 `createAgentSession()` を使う既存コードは field harness に隔離し、異常残留 process の最終回収は Codex schedule の運用責務として runtime から分離する。

**Tech Stack:** TypeScript 6、Pi Agent SDK 0.80.6、Vitest 4、ast-grep、Biome、launchd field harness

---

## File Structure

- Create `src/runtime/pi-host-turn.ts`: 既存 Pi session への literal input、event集約、abort、shutdownを所有する。
- Create `src/runtime/pico-runtime-profile.ts`: startup-only profile、tool capability filtering、resident controller lifecycleを中央制御する。
- Create `src/runtime/resident-voice-service.ts`: 現在の resident voice provider配線を再利用可能なserviceとして所有する。
- Modify `src/index.ts`: default extensionにPi host boundaryとruntime profileを登録する。
- Modify `scripts/resident/voice.ts`: serviceを呼ぶdirect field harnessだけに縮小する。
- Modify `src/runtime/resident-development-terminal.ts`: development terminalをPi resident hostから起動する。
- Create `tests/pi-host-turn.test.ts`: literal input、response、concurrency、abort、shutdownを検証する。
- Create `tests/pico-runtime-profile.test.ts`: profile default、capability制約、単一起動、shutdown drainを検証する。
- Create `tests/pi-subagent-capability.test.ts`: Pico extensionとPi公式subagent extensionを同じSDK sessionへ読み込めることを検証する。
- Modify `tests/extension.test.ts`: default extensionのflag/event登録を検証する。
- Modify `tests/resident-development-terminal.test.ts`: dev terminalがPi hostを起動することを検証する。
- Modify `AGENTS.md` and `README.md`: Pi/Pico ownership、profile、field harness、cleanup責務を記録する。

## State Boundary

1. **State being changed:** startup-only runtime profile、extension-scoped resident controller、current Pi context、active voice turn、音声serviceのcapture/timer/playback資源。
2. **Lifecycle boundary:** `startup-only-immutable`。profile変更にはPi再起動が必要で、session reloadやconfig watcherでは変更しない。
3. **Mutation path inventory:** Pi CLI flag、`session_start`、Pi message events、`agent_settled`、AbortSignal、`session_shutdown`、focused tests。env、config watcher、API、migration、admin job、background mutationは非対象。Codex scheduleはruntime stateを変更せずOS processだけを別運用で回収する。
4. **Consumer/invariant inventory:** Pico tool registry、Pi active tools、resident voice service、`runVoiceResidentRuntime`、development terminal、system prompt、extension loader、SDK capability test、health/preflight、shutdown cleanup。
5. **Central enforcement point:** `registerPicoRuntimeProfile()` がprofile解釈、active tool filtering、controller生成・破棄の唯一の境界。`createPiHostTurnClient()` がactive Pi turnの唯一の境界。
6. **Forbidden paths:** production residentから `createAgentSession()`、scriptから第二Pi session、profileのhot reload、workerの`pico_*`／`stackchan_*`／`subagent`利用、複数controller生成、古いcontext保持、Pico独自worker runner、TaskRun store、自動再開。
7. **Required tests:** worker default、interactive/resident明示、unknown profile拒否、tool bypass除去、start冪等性、shutdown待機、literal slash input、同時turn拒否、abort一回、settled後state解放、session shutdown中のactive turn終了、実SDKでのPico+subagent共存。
8. **Async ownership and terminal states:** Piがagent/subagent/agent abort/settledを所有する。Pi host turn boundaryはpending voice turnを`agent_settled`またはshutdown rejectionで除去する。resident controllerはcapture/timer/playbackを所有し、`session_shutdown`はcontrollerの`stop()`完了を待つ。Codex scheduleは残留processを別運用で回収し、runtime内にterminal task stateを保持しない。

### Task 1: Pi-hosted turn boundary

**Files:**
- Create: `src/runtime/pi-host-turn.ts`
- Test: `tests/pi-host-turn.test.ts`

- [ ] **Step 1: Write failing literal-input and settled-response tests**

テスト用capture APIに `on()` と `sendUserMessage()` を持たせ、`session_start` contextを渡した後、次を検証する。

```ts
const response = client.prompt({ sessionId: "facility-1", text: "/status" });
expect(sentMessages).toEqual(["/status"]);
emit("message_update", textDelta("応答です"), context);
emit("agent_settled", { type: "agent_settled" }, context);
await expect(response).resolves.toEqual({ text: "応答です" });
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run tests/pi-host-turn.test.ts`

Expected: FAIL because `src/runtime/pi-host-turn.ts` does not exist.

- [ ] **Step 3: Implement the minimal Pi host boundary**

実装する公開契約:

```ts
export type PiHostTurnClient = PiAgentTurnClient & {
  readonly close: () => void;
};

export function createPiHostTurnClient(
  pi: Pick<ExtensionAPI, "on" | "sendUserMessage">
): PiHostTurnClient;
```

`session_start`でcurrent contextを束縛し、`message_update`の`text_delta`だけをactive turnへ追加し、`agent_settled`でresolveする。`prompt()`はcontext未束縛、非idle、active turn重複、close後を拒否し、入力を加工せず`pi.sendUserMessage(input.text)`へ渡す。

- [ ] **Step 4: Add failing cancellation and shutdown tests**

AbortSignalは`context.abort()`を一回だけ呼び、`agent_settled`後にpromptをrejectする。`session_shutdown`と`close()`はactive turnをrejectし、terminal stateを消す。close後の新規promptも拒否する。

- [ ] **Step 5: Implement cancellation and terminal cleanup**

active turn内にresolve/reject、text chunks、abort requested、signal listener cleanupを保持する。settle/closeの単一helperだけがstateを除去し、二重完了を防ぐ。

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/pi-host-turn.test.ts`

Expected: PASS.

Commit: `feat: add Pi-hosted resident turn boundary`

### Task 2: Startup-only runtime profile and capability boundary

**Files:**
- Create: `src/runtime/pico-runtime-profile.ts`
- Test: `tests/pico-runtime-profile.test.ts`

- [ ] **Step 1: Write failing profile resolution tests**

検証する契約:

```ts
expect(resolvePicoRuntimeProfile(undefined)).toBe("worker");
expect(resolvePicoRuntimeProfile("interactive")).toBe("interactive");
expect(resolvePicoRuntimeProfile("resident")).toBe("resident");
expect(() => resolvePicoRuntimeProfile("unknown")).toThrow("pico-runtime-profile");
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run tests/pico-runtime-profile.test.ts`

Expected: FAIL because the profile module does not exist.

- [ ] **Step 3: Implement profile registration and central tool filtering**

公開契約:

```ts
export type PicoRuntimeProfile = "worker" | "interactive" | "resident";
export type ResidentVoiceController = {
  readonly start: () => void | Promise<void>;
  readonly stop: () => void | Promise<void>;
};

export function registerPicoRuntimeProfile(
  pi: ExtensionAPI,
  options: {
    readonly createResidentController: (
      context: ExtensionContext
    ) => ResidentVoiceController;
  }
): void;
```

`pico-runtime-profile` string flagのdefaultを`worker`にする。workerではactive toolsから`pico_*`、`stackchan_*`、`subagent`を除く。residentではfacility sessionの重複ownerになる`pico_session`を除く。interactiveは既存active toolsを維持する。

- [ ] **Step 4: Add failing lifecycle tests**

residentの複数`session_start`でcontroller生成/startが一度だけであること、`session_shutdown`が`stop()`をawaitすること、worker/interactiveがcontrollerを作らないことを検証する。

- [ ] **Step 5: Implement idempotent lifecycle**

controller stateをextension closureに閉じ、`session_start`以外から生成させない。shutdown中の再startを拒否し、stop完了後に参照を除去する。

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/pico-runtime-profile.test.ts`

Expected: PASS.

Commit: `feat: enforce Pico runtime profiles`

### Task 3: Resident voice service extraction

**Files:**
- Create: `src/runtime/resident-voice-service.ts`
- Modify: `scripts/resident/voice.ts`
- Test: `tests/pico-runtime-profile.test.ts`

- [ ] **Step 1: Add failing controller integration test**

`createResidentController`へ注入したcontrollerがPi host turn clientを受け取り、resident startで起動し、session shutdownがstop完了まで待つことをprofile testで固定する。

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run tests/pico-runtime-profile.test.ts`

Expected: FAIL because production controller wiring is absent.

- [ ] **Step 3: Move provider wiring into a source-owned service**

現在の`voice.ts`からconfig、health、lock、audio、STT、TTS、memory、activation、logging、warmup、`runVoiceResidentRuntime()`配線を`resident-voice-service.ts`へ移す。公開契約:

```ts
export function createResidentVoiceService(options: {
  readonly piAgent: PiAgentTurnClient;
  readonly onError: (error: Error) => void;
}): ResidentVoiceController;

export async function runDirectResidentVoiceHarness(): Promise<void>;
```

service controllerはstartを一回だけ許可し、専用AbortControllerとsingle-instance lockを所有する。stopはabort後、既存`shutdownGraceMs`内でruntime cleanupを待ち、最後にlockをreleaseする。direct harnessだけが`createPiAgentTurnClient()`を生成する。

- [ ] **Step 4: Replace the script with the field-harness wrapper**

```ts
import { runDirectResidentVoiceHarness } from "../../src/runtime/resident-voice-service.js";

await runDirectResidentVoiceHarness();
```

- [ ] **Step 5: Run resident and turn regression tests**

Run: `npx vitest run tests/voice-resident.test.ts tests/pi-agent-turn.test.ts tests/pico-runtime-profile.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `refactor: expose resident voice as extension service`

### Task 4: Wire the default Pico extension to Pi ownership

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`

- [ ] **Step 1: Write failing default-extension registration tests**

default extensionが`pico-runtime-profile` flag、`session_start`、`message_update`、`agent_settled`、`session_shutdown`を登録し、resident profileでPi host clientをresident service factoryへ渡すことを検証する。

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run tests/extension.test.ts`

Expected: FAIL because the default extension does not register Pi host runtime ownership.

- [ ] **Step 3: Implement default production wiring**

default factoryで`createPiHostTurnClient(pi)`を一度だけ生成し、`registerPicoRuntimeProfile()`へ次のcontroller factoryを渡す。

```ts
createResidentVoiceService({
  piAgent,
  onError: (error) => {
    context.ui.notify(error.message, "error");
    context.shutdown();
  }
});
```

`registerPicoExtensionWithRuntime()`はfield/injected用途の契約を維持するが、本番default factoryはembedded session clientを参照しない。

- [ ] **Step 4: Run extension/profile tests and commit**

Run: `npx vitest run tests/extension.test.ts tests/pi-host-turn.test.ts tests/pico-runtime-profile.test.ts`

Expected: PASS.

Commit: `feat: host resident voice inside Pi extension`

### Task 5: Prove Pi subagent coexistence without a second integration session

**Files:**
- Create: `tests/pi-subagent-capability.test.ts`

- [ ] **Step 1: Write the real-SDK capability test**

`DefaultResourceLoader`へPico extensionとPi同梱
`examples/extensions/subagent/index.ts`を読み込み、`SessionManager.inMemory()`の一つの
`AgentSession`を作る。profile flagを`interactive`に設定し、active toolsに
`pico_session`と`subagent`が同時に存在することを検証してdisposeする。model promptは実行しない。

- [ ] **Step 2: Run the test and verify its actual result**

Run: `npx vitest run tests/pi-subagent-capability.test.ts`

Expected: PASS with no provider/model call. Failureした場合はAPI差分を調査し、custom runnerへ切り替えない。

- [ ] **Step 3: Add the structural production-owner assertion**

同じテストで`src/index.ts`と`src/runtime/resident-voice-service.ts`のproduction pathが
`createAgentSession`を含まず、`scripts/resident/voice.ts`だけがdirect harnessを呼ぶことを確認する。

- [ ] **Step 4: Commit**

Commit: `test: prove Pi-owned subagent capability`

### Task 6: Switch the development launch path and document ownership

**Files:**
- Modify: `src/runtime/resident-development-terminal.ts`
- Modify: `tests/resident-development-terminal.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Write a failing development launch assertion**

development terminal commandが`npm run resident:voice`ではなく、local Pi executableと
`--pico-runtime-profile=resident`を含むことを検証する。

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run tests/resident-development-terminal.test.ts`

Expected: FAIL with the old direct-harness command.

- [ ] **Step 3: Change only the Pi-hosted development command**

shell commandを次へ変更し、既存logging/terminal close contractを保つ。

```text
node_modules/.bin/pi --pico-runtime-profile=resident
```

`npm run resident:voice`とlaunchd scriptはdirect field harnessとして残す。

- [ ] **Step 4: Update ownership documentation**

AGENTS.mdへ英語で、Piがprocess/session/subagentを所有し、Picoがaudio/facility policyを所有すること、worker default、direct field harness、Codex stale cleanupを簡潔に追記する。READMEへworker/interactive/resident起動例と、異常残留は自動再開せず定期cleanupが扱うことを記載する。

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/resident-development-terminal.test.ts tests/pico-cli.test.ts tests/justfile.test.ts`

Expected: PASS.

Commit: `docs: make Pi host ownership explicit`

### Task 7: Configure Codex stale-process cleanup

**Files:**
- No repository files unless the automation review proves a missing deterministic helper requirement.

- [ ] **Step 1: Inspect existing Codex automations and cleanup helper capabilities**

既存automationとの重複を確認し、dotfiles-managed
`stale-process-cleanup` helperのJSON report、orphan review、generic termination opt-inを確認する。

- [ ] **Step 2: Create the approved recurring cleanup**

Codex cron automationを作成し、1時間以上の候補をJSON列挙する。既知helperは既存policy、
Pi/Pico候補はcommand line、parentage、age、CPU、state、active workflowをCodexが確認する。
generic processは強い所有根拠があるPIDだけを明示的opt-inで`TERM`し、`KILL` escalationは
設定しない。`STAT=Z`は終了対象にせず報告する。

- [ ] **Step 3: Validate one report-only run**

現在のprocessを変更しないreport-only実行で、候補数、reviewable PID、zombie分類が得られ、
active editor/server/watcherがtermination対象にならないことを確認する。

### Task 8: Full verification and PR preparation

**Files:**
- Modify only files required by verified failures.

- [ ] **Step 1: Format and inspect identifier placement**

Run: `just format`

Run: `rg -n "pico-runtime-profile|createPiHostTurnClient|createResidentVoiceService|createAgentSession" src scripts tests README.md AGENTS.md`

Expected: host identifiers appear only in the planned owner/helper files; production default extension has no embedded session creation.

- [ ] **Step 2: Run focused architecture gates**

Run: `npx vitest run tests/pi-host-turn.test.ts tests/pico-runtime-profile.test.ts tests/pi-subagent-capability.test.ts tests/extension.test.ts tests/resident-development-terminal.test.ts tests/voice-resident.test.ts tests/pi-agent-turn.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full repository gate**

Run: `just check`

Expected: Swift sidecar checks, TypeScript, lint, ast-grep, formatting, and all Vitest suites PASS.

- [ ] **Step 4: Review the final diff against the approved spec**

確認項目: old worktree未変更、custom runnerなし、second integration sessionなし、TaskRun storeなし、production Pi ownership、worker deny、shutdown drain、direct harness隔離、cleanup運用分離。

- [ ] **Step 5: Commit verification-only fixes if required**

Commit: `fix: close Pi host verification gaps`

- [ ] **Step 6: Push, open a draft PR, and converge**

Push `codex/pi-host-architecture-recovery`、draft PRを作成し、CIとreview findingsを確認する。actionable findingsは再現・修正・focused/full verification後にpushする。全required checksがpassし、未解決actionable reviewがなくなるまで収束する。
