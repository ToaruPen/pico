# Hold-to-Talk Lifecycle Convergence Design

## Status

2026-07-17 の PR #99 full review を受けた再brief。既存の
`2026-07-17-hold-to-talk-resident-control-design.md` を置き換えず、非同期所有権と
terminal convergence の不足分を追加する。

## Purpose

Hold-to-talk の accepted generation は、semantic key event、capture、Pi session
bootstrap、prompt、playback、owned child process を terminal settlement まで所有する。
cancel や failure は新規処理を止めるだけでなく、最初の終了原因を保持し、所有する非同期
resource が bounded な手順で収束してから ownership を解放する。

## Central Invariant

1. talk press/release/cancel は、keyboard bridge 内で順序を保ち、欠落させない。
2. state transition observer は通知先であり、controller state の owner ではない。observer
   failure は controller が一度だけ `error` へ terminalize し、再通知しない。timer callback内の
   observer failureはscheduled boundary内で捕捉し、uncaught exceptionへ流さない。
3. subprocess owner は stdin、process completion、TERM/KILL escalationを一体として所有する。
   `close`またはSIGKILL後のbounded terminal errorまではactive ownershipを保持し、terminal
   errorではlistenerを外してownershipを解放する。
4. timeout、caller cancel、provider failure が競合しても、最初に成立した terminal cause を
   immutable に保持する。
5. Pi session bootstrap は背景で安全に settle させつつ、caller cancel の待機境界を塞がない。
6. field acceptance は completed hold 自身の frame を検証し、cancelled hold の frame を
   成功証拠へ流用しない。
7. field captureは一つのterminal operationだけを持つ。停止中にcancelが競合した場合も、停止
   完了時にcontroller terminal stateを一度だけclaimしてからreleased/cancelledの片方だけを
   記録する。cancelled captureはrelease-tail sampleを生成せず、TTS cancelはfailureではなく
   `skipped`となる。
8. Core Graphics callbackが参照する`BridgeContext`はevent tapの有効期間全体でstrongに所有し、
   tap invalidationとsender drainの後だけ解放する。
9. session endはstate更新とended subscriber通知を一つの境界で確定する。auditは副作用であり、
   失敗しても通知済みterminal stateを変えない。
10. loopback control serverのabortと明示closeは同じclose operationを共有する。graceful drainが
    shutdown graceを超えた場合だけactive connectionを強制closeし、そのoperationのsettlementを
    全callerが待つ。
11. Node child processのterminal completionはstdioを含む`close` eventで確定する。spawn
    `error`後に`exit`が来ない経路でもownerをboundedにsettleする。SIGKILL後にも`close`が来ない
    場合はbounded terminal errorを保持し、runtimeのstopとcompletionを同じfailureでsettleする。
    abort後の`exit`だけではplayback成功を確定せず、`close`またはbounded terminal errorを待つ。
12. runtime shutdownはactive turnのcancellation operationもowner境界として待つ。cancellation
    cleanupが失敗した場合は、shared owner cleanupの成否にかかわらずstopとcompletionを同じ
    failureでsettleする。

## State Boundary

1. **State being changed:** `ControlEventChannel` のpending semantic events、
   `ResidentControlController` のactive generation/state/tail timer、managed keyboard bridge
   child、command playback child、Apple Speech request terminal cause、Pi session bootstrap
   promise、field harness のcompleted-hold evidenceとterminal別timing sample、Core Graphics
   `BridgeContext`、session ended subscriber通知、loopback server close operation、audio child
   listener/active owner、runtime completionを変更する。
2. **Lifecycle boundary:** `restart-required`。production owner はstartupからshutdownまで
   これらのresourceを保持する。runtime中のconfig mutationやprovider切替は行わない。
3. **Mutation path inventory:** CoreGraphics callback、semantic event sender、talk/release/cancel
   handler、tail timer、capture/STT/Pi/TTS/playback settlement、caller abort、provider timeout、
   child `error`/`exit`、readiness failure、runtime shutdown、field harness controls、deterministic
   testsに加え、child `close`、event tap teardown、audit sink failure、server abort/明示close、
   active HTTP request drain、SIGKILL後のfinal timeout、shutdown cleanup rejectionが対象。config
   watcher、admin API、migration、rollback job、task auto-resumeは対象外。
4. **Consumer/invariant inventory:** Swift bridge sender、loopback control transport、resident
   control controller、voice runtime cancellation、Pi turn client、Apple Speech client、macOS
   bridge health/close、playback sink、launchd shutdown、field report、audit/probe、native/TypeScript
   test、session ended subscriber、loopback HTTP clientsが対象。各consumerはfirst cause、single
   operation/settlement、ordered delivery、bounded drain、terminal別metric ownershipを前提とする。
5. **Central enforcement point:** semantic eventsは`ControlEventChannel`、stateとobserver
   failureは`ResidentControlController`、bridge childはmanaged bridge closure、playback childは
   playback sinkのactive operation、STT causeはApple Speech request closure、Pi bootstrap waitは
   Pi turn clientのabort-aware acquisition boundaryを必ず通る。field metricは単一のcapture
   terminal operation、Core Graphics contextはevent-tap run-loop scope、session通知は
   `endSession`、HTTP shutdownはcached close operation、audio shutdownはowned terminalizer、
   runtime shutdownはshared stop/completion settlementを必ず通る。caller側の局所guardだけで
   ownershipを補わない。
6. **Forbidden paths:** `.bufferingOldest(1)`によるsemantic event drop、observer exception後の
   非terminal state、SIGTERMだけ送って無期限wait、child exit前の`active = undefined`、mutable
   booleanによるabort cause上書き、session creationを無条件await、cancelled capture frameを
   completed-hold evidenceに加算、cancelled captureをrelease-tail sampleへ加算、進行中の
   capture terminal operationを別のfinalizerで上書きすること、event-tap
   lifetimeより先のcontext解放、audit成功をsubscriber通知の条件にすること、abortと明示closeで
   別々のserver closeを開始すること、`exit`だけをchild terminal条件にすること、final timeout後
   もchild listener/active ownerを残すこと、shutdown failure後にcompletionをpendingのまま残す
   こと、timer observer failureをuncaughtへ流すこと、unhandled background promise rejectionを
   禁止する。
7. **Required tests:** press/release burstのlossless delivery、transition observer failureの
   direct `error` terminalization、SIGTERM非応答時のSIGKILLとfinal timeout、stdin failure後も
   stopが同じchildを対象にすること、timeout後caller abortでも`timeout`維持、session bootstrap
   中cancelの即時settlementと背景promise観測、completed holdが0 frameならcancelled holdに
   frameがあってもfield failureとなること、cancelled tailがrelease sampleを増やさないこと、
   capture stopを遅延させたtail満了後cancelが一度だけcancelledとして計上されること、
   audit failureでもended subscriberが一度通知されること、abort/closeが同じserver closeを待ち
   deadlineでactive connectionを閉じること、spawn error後の`close`でbridgeがsettleすること、
   TTS cancelが`skipped`となること、release timer observer failureがerrorへ収束すること、
   capture/playbackのfinal timeout後にlistenerとownershipが解放されること、shutdown failureで
   stop/completionが同じerrorを返すこと、abort後にchildが`exit`だけを通知する経路、active
   cancellation cleanup failureをshutdownが待つことをdeterministicに検証する。BridgeContextの
   strong lifetimeはnative buildとevent-tap scopeを明示する実装形で検証する。
8. **Async ownership and terminal states:** channelは`finish()`、controller generationはidle/error/
   stopped、bridge/playback childは`close`またはbounded termination error、Apple Speech requestは
   first causeを持つresult、Pi bootstrapはcached session promiseのsettlementでterminalとなる。
   Core Graphics contextはtap invalidation、sessionはended notification、HTTP serverはcached
   close promise、field timingは単一のcapture terminal operationでterminalとなる。ownerは
   acknowledgement、abort、late-result suppression、TERM→KILL、shutdown drainを担当し、
   terminal settlement後だけin-memory ownershipを解放する。

## PR Split

PR #99 は hold-to-talk lifecycle correctness を所有し、stale plan path修正とfield harness、
keyboard event delivery、controller transition、managed bridge、playback child、Apple Speech、
Pi bootstrapの修正を含む。

resident latency observability は PR #99 をbaseとするstacked PRへ分離する。stacked PRは
monotonic wall-clock計測、media duration分離、cancel/error stage settlement、stage registry
契約だけを所有する。PR #99へレイテンシ実装を残さない。

## Acceptance Criteria

- semantic talk press/release/cancel はbridge内で順序どおりlosslessにdeliveryされる。
- observer failure、cancel、timeout、provider failureの競合でterminal state/causeは一度だけ
  決まる。
- bridge childは`close`までownerに残る。audio capture/playback childは`close`またはbounded
  terminal errorまでownerに残り、TERM→KILL後のfinal timeoutではlistenerとownershipを解放する。
- playbackはabort後の`exit`だけでは成功せず、active cancellation cleanupはruntime shutdownの
  owned boundaryとしてsettleされる。
- Pi session bootstrap中のcancelはsession creationを待たずにturn cancellationへ収束する。
- field validationはcompleted hold自身がcaptureしたframeを要求する。
- cancelled holdはrelease-tail sampleを生成せず、TTS cancelは`skipped`として記録される。
- event tap callback context、session ended notification、control server close、bridge child
  completionはそれぞれのowner境界でterminalまで保持・settleされる。
- runtime shutdown failureはstopとcompletionを同じerrorでsettleし、pendingを残さない。
- PR #99のfocused testsと`just check`が通り、current-head reviewのactionable findingが0件になる。
