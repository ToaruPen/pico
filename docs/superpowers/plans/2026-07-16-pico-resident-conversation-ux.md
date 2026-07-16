# Pico Resident Conversation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pico` の短縮起動、可視モニター、5分間の連続会話、ツール実行前の音声前置き、長時間作業中の状態照会・中止・完了通知を、Pi所有権を保ったまま実装して実機確認する。

**Architecture:** 通常 `pico` は既存Terminal launcherをproduction modeで使用し、local Piへextension pathを明示する。音声由来turnの状態とtool-start gateは既存 `PiHostTurnClient` とresident voice runtimeへ集約し、Pi eventから作るprocess-local projectionだけをUIへ渡す。第二のPi session、task queue、worker、永続TaskRunは作らない。

**Tech Stack:** TypeScript 6、Pi coding agent extension API 0.80.6、Vitest 4、Terminal.app AppleScript、Apple Speech STT、Aivis Speech TTS

---

Repository instructionによりcommit stepは実行しない。

### Task 1: Production Terminal startup

**Files:**
- Modify: `tests/pico-cli.test.ts`
- Modify: `tests/resident-development-terminal.test.ts`
- Modify: `src/runtime/pico-cli.ts`
- Modify: `src/runtime/resident-development-terminal.ts`
- Modify: `scripts/resident/development-terminal.ts`

- [ ] **Step 1: Write the failing default CLI test**

```ts
expect(createPicoCliPlan([])).toEqual({
  kind: "script",
  scriptPath: "scripts/resident/development-terminal.ts",
  args: ["--mode=production", "--terminal=terminal"]
});
```

- [ ] **Step 2: Write the failing production launcher test**

```ts
const session = defineResidentDevelopmentTerminalSession({
  mode: "production",
  repoRoot,
  homeDirectory,
  configPath,
  pathEnvironment,
  terminal: "terminal"
});
expect(session.shellCommand).toContain("node_modules/.bin/pi --extension ./src/index.ts --pico");
expect(session.shellCommand).not.toContain("PICO_RESIDENT_VOICE_LOG_MODE='development'");
```

- [ ] **Step 3: Run RED**

Run: `npx vitest run tests/pico-cli.test.ts tests/resident-development-terminal.test.ts`
Expected: default planと`mode` contractが未実装のためFAIL。

- [ ] **Step 4: Implement production mode**

`ResidentDevelopmentTerminalSessionOptions`へ
`readonly mode?: "production" | "development"`を追加する。development専用log/probe envは
developmentだけに付与し、Pi commandは両modeでlocal Pi、明示extension、`--pico`を使う。
CLI defaultはproduction Terminal scriptへ変更し、scriptは`--mode`をstrictにparseする。

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/pico-cli.test.ts tests/resident-development-terminal.test.ts && just typecheck`
Expected: exit 0。

### Task 2: Process-local monitor

**Files:**
- Create: `src/runtime/resident-voice-monitor.ts`
- Create: `tests/resident-voice-monitor.test.ts`
- Modify: `src/index.ts`
- Modify: `src/runtime/resident-voice-service.ts`
- Modify: `src/runtime/resident-voice-runner.ts`

- [ ] **Step 1: Write the failing monitor API test**

```ts
const monitor = createResidentVoiceMonitor({ ui, scheduleInterval });
monitor.setPhase("waiting");
monitor.showAcceptedTranscript("文書を作って");
monitor.setPhase("working", { toolName: "write" });
expect(events).toContain("status:pico:待機中");
expect(events).toContain("notify:info:聞き取り: 文書を作って");
expect(events).toContain("title:Pico — 作業中");
```

close後のevent抑止とnotification failure isolationも個別testにする。

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/resident-voice-monitor.test.ts`
Expected: module未作成でFAIL。

- [ ] **Step 3: Implement and wire the monitor**

`setStatus`、`setTitle`、`notify`だけを使い、file/audit sinkは受け取らない。elapsed schedulerは
inject可能にし、`close()`で解除する。`src/index.ts`で`--pico` controller生成時だけ一つ作り、
service → runner → voice runtimeへ渡す。

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run tests/resident-voice-monitor.test.ts tests/pico-startup.test.ts tests/extension.test.ts`
Expected: PASS。

### Task 3: Wake payload and five-minute attention

**Files:**
- Create: `src/runtime/voice-addressing.ts`
- Create: `tests/voice-addressing.test.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/modules/session/index.ts`
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `src/runtime/voice-resident.ts`

- [ ] **Step 1: Write address extraction RED tests**

```ts
expect(extractAddressedRequest("ピコ、文書を作って", ["ピコ", "pico"])).toEqual({
  trigger: "ピコ",
  request: "文書を作って"
});
expect(extractAddressedRequest("ピコ", ["ピコ"])).toEqual({ trigger: "ピコ", request: "" });
expect(extractAddressedRequest("文書を作って", ["ピコ"])).toBeUndefined();
```

- [ ] **Step 2: Run RED, implement exact prefix extraction, run GREEN**

Run: `npx vitest run tests/voice-addressing.test.ts`
Expected before code: FAIL。先頭のmatch spanと直後separatorだけを除去し、本文内の同名語を残す。
実装後に同じcommandでPASSを確認する。

- [ ] **Step 3: Write resident wake behavior RED tests**

最初の「ピコ、文書を作って」がprompt input `文書を作って`を一度生成すること、wake-onlyはtaskを
送らずackすること、active sessionの二発目はwakeなしで送られること、ambient transcriptはmonitorへ
出ないことを個別testにする。

- [ ] **Step 4: Add central inactivity suspend/resume with RED tests**

```ts
type SessionLifecycle = {
  suspendInactivity(id: string): SessionRecord;
  resumeInactivity(id: string): SessionRecord;
};
```

fake timersでsuspend中は300,000ms超過してもactive、resume後300,000msでendedになることを先に
失敗させる。timer mutationはsession module内に閉じる。

- [ ] **Step 5: Implement wake payload and five-minute default**

`emptyPicoConfig.session.ending.durationMs`を`300_000`、example YAMLを`300000`へ変更する。
started resultにrequestを含め、空でなければwake ackの代わりに同じuser turnへ渡す。Pi turn中は
inactivityをsuspendし、final playback後にresumeする。

- [ ] **Step 6: Run GREEN**

Run: `npx vitest run tests/voice-addressing.test.ts tests/session.test.ts tests/config.test.ts tests/voice-resident.test.ts`
Expected: PASS。

### Task 4: One-turn preface gate

**Files:**
- Modify: `tests/pi-host-turn.test.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/identity.test.ts`
- Modify: `src/runtime/pi-host-turn.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/identity/system-prompt.ts`

- [ ] **Step 1: Write tool gate RED tests**

`PiAgentTurnClient.prompt` inputへ次のoptional hooksを要求する。

```ts
readonly beforeFirstTool?: (preface: string) => Promise<void>;
readonly onProgress?: (event: PiVoiceTurnProgress) => void;
```

未解決playback promiseを使い、`message_update → tool_call → playback resolve → handler resolve`を
検証する。sibling toolは同じpromiseを共有、textなしは「わかった。今から始めるね。」、final textに
prefaceを含めない、tracked voice turn以外をgateしないcaseを分ける。

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/pi-host-turn.test.ts`
Expected: hooksとtool event handlingが未実装でFAIL。

- [ ] **Step 3: Implement partition and one-shot gate**

`ActiveTurn`へpre-tool chunks、final chunks、toolObserved、gatePromiseを保持する。最初のtracked
`tool_call`でだけhookを開始し、後続callは同じpromiseをawaitする。gate failureはabort-onceして
toolをblockする。tool使用時のresultはfinal chunksだけ、toolなしは全chunksとする。

- [ ] **Step 4: Add model instruction and TTS gate**

system promptへtool前に短い自然な日本語ackを出す英語instructionを追加する。voice runtimeは
`beforeFirstTool`で既存TTS → echo reference → playbackをawaitし、失敗時はthrowする。最終responseは
`agent_settled`後に一度だけ読む。

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/pi-host-turn.test.ts tests/voice-resident.test.ts tests/identity.test.ts`
Expected: PASS。

### Task 5: Busy control lane and cancellation

**Files:**
- Modify: `tests/voice-addressing.test.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `src/runtime/voice-addressing.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-voice-monitor.ts`

- [ ] **Step 1: Write control classification RED tests**

```ts
expect(classifyBusyVoiceControl("今どう？")).toBe("status");
expect(classifyBusyVoiceControl("まだ？")).toBe("status");
expect(classifyBusyVoiceControl("やめて")).toBe("cancel");
expect(classifyBusyVoiceControl("じゃあ終わり")).toBe("end");
expect(classifyBusyVoiceControl("別の文書も作って")).toBe("new_request");
```

- [ ] **Step 2: Write concurrent capture RED tests**

最初のPi promptをbarrierで止めたまま二つ目のutteranceを流し、statusはPi prompt数を増やさない、
cancelはabort一回、new requestはqueueされない、endはsettled後farewell、late outputは読まれないことを
個別testにする。

- [ ] **Step 3: Implement one owned active voice operation**

```ts
type ActiveVoiceTurn = {
  readonly sessionId: string;
  readonly abortController: AbortController;
  readonly completion: Promise<void>;
  terminal: boolean;
  cancelRequested: boolean;
};
```

frame loopはcompletionをawaitせずcaptureを続ける。busy時はdeterministic controlだけを処理し、normal
promptを二つ送らない。completion rejectionは観測し、shutdownはabort後completionをawaitする。

- [ ] **Step 4: Serialize spoken output and project facts**

wake ack、preface、status、busy rejection、final、farewellを単一playback tailへ通す。Pi progressから
phaseとtool nameだけをmonitorへ渡し、args/resultは複製しない。completion/failure/cancelでstatus、
title、Pi UI notificationを更新する。

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/voice-addressing.test.ts tests/voice-resident.test.ts tests/resident-voice-monitor.test.ts`
Expected: PASS、unhandled rejectionなし。

### Task 6: Full verification and live acceptance

**Files:**
- Modify only files required by failures within this feature scope.

- [ ] **Step 1: Run focused suites**

Run: `npx vitest run tests/pico-cli.test.ts tests/resident-development-terminal.test.ts tests/resident-voice-monitor.test.ts tests/voice-addressing.test.ts tests/session.test.ts tests/config.test.ts tests/pi-host-turn.test.ts tests/voice-resident.test.ts tests/pico-startup.test.ts tests/extension.test.ts tests/identity.test.ts`
Expected: all PASS、unhandled rejectionなし。

- [ ] **Step 2: Run repository gates**

Run: `just typecheck && just lint && just ast && just test`
Expected: exit 0。
Run: `just check`
Expected: exit 0。

- [ ] **Step 3: Check scope and repeated identifiers**

Run: `rg -n "beforeFirstTool|classifyBusyVoiceControl|ResidentVoiceMonitor|suspendInactivity" src tests`
Run: `git status --short && git diff --check`
Expected: intended owner/testsだけ、既存user changeを保持、whitespace errorなし。

- [ ] **Step 4: Run provider smoke checks**

Run: `npm run smoke:voice-providers && npm run smoke:pi-runtime`
Expected: Apple Speech STT、Aivis Speech TTS、Pico Pi runtime smokeがPASS。

- [ ] **Step 5: Launch and inspect actual Pico**

旧direct harnessが停止済みであることを確認し、repository rootで `pico` を実行する。Terminal.appに
一つのPi TUIが開き、title/statusが`待機中`、process commandが
`pi --extension ./src/index.ts --pico`を含むことを確認する。

- [ ] **Step 6: Perform live voice acceptance**

「ピコ、短い確認をして」→ wakeなし追質問 → tool使用依頼 → 作業中「今どう？」 → 「やめて」
の順に実マイクで確認する。発話本文、前置き後のtool開始、二重Pi promptなし、abort一回、完了/中止
表示を観測する。機械的event順序と利用者の聴感は分けて記録する。

- [ ] **Step 7: Shut down cleanly**

Pi TUIを終了し、専用Terminal tab/window、今回のPico process、resident lock、launcher processが
残っていないことを確認する。Apple Speech sidecar、Aivis Speech、Stack-chan gateway/tunnelなどの
共有常駐provider/serviceは今回のPico processではないため停止せず、終了前後で同じPIDまたは
health endpointが利用可能であることを確認する。

### Task 7: Pi-level Qdrant recovery (separate owner repository)

**Files:**
- Modify only files required in `/Users/monsoon/Dev/mem0-private/integrations/pi-agent`

- [ ] **Step 1: Establish the failing lifecycle/configuration test**

Pico からQdrantを設定・起動・呼び出ししない。Pi-level memory plugin側で、configured Qdrant endpoint
が利用不能な場合に初期化を無制限に繰り返してTUIへstack traceを流し続けないことと、利用可能な
configured endpointでは一度だけ初期化して通常turnを妨げないことを先に失敗させる。

- [ ] **Step 2: Fix the owner-level root cause**

実環境のQdrant lifecycleとendpointを唯一のsource of truthへ揃え、pluginの初期化をsingle-flightかつ
terminal-state awareにする。provider不在を互換性check無効化だけで隠さず、actionableな一回の診断へ
収束させる。自動fallback vector storeを追加しない。

- [ ] **Step 3: Verify isolation and integration**

memory pluginのfocused testsとPi起動smokeを実行し、Pico repositoryにQdrant/Mem0 client、config、
tool、memory lifecycleが追加されていないことを`rg`で確認する。

### Task 8: Pre-PR gates and convergence

Picoとmemory pluginの対象差分をそれぞれ所有repositoryのgateで検証する。Pico差分はpolishment、
ai-slop-cleanerの順に通し、対象repositoryごとにscopeを分けてPRを作成し、CIとactionable reviewが
収束するまで修正・再検証する。
