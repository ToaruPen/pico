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
   failure は controller が一度だけ `error` へ terminalize し、再通知しない。
3. subprocess owner は stdin、process completion、TERM/KILL escalation を一体として所有し、
   child の exit 前に active ownership を解放しない。
4. timeout、caller cancel、provider failure が競合しても、最初に成立した terminal cause を
   immutable に保持する。
5. Pi session bootstrap は背景で安全に settle させつつ、caller cancel の待機境界を塞がない。
6. field acceptance は completed hold 自身の frame を検証し、cancelled hold の frame を
   成功証拠へ流用しない。

## State Boundary

1. **State being changed:** `ControlEventChannel` のpending semantic events、
   `ResidentControlController` のactive generation/state/tail timer、managed keyboard bridge
   child、command playback child、Apple Speech request terminal cause、Pi session bootstrap
   promise、field harness のcompleted-hold evidenceを変更する。
2. **Lifecycle boundary:** `restart-required`。production owner はstartupからshutdownまで
   これらのresourceを保持する。runtime中のconfig mutationやprovider切替は行わない。
3. **Mutation path inventory:** CoreGraphics callback、semantic event sender、talk/release/cancel
   handler、tail timer、capture/STT/Pi/TTS/playback settlement、caller abort、provider timeout、
   child `error`/`exit`、readiness failure、runtime shutdown、field harness controls、deterministic
   testsが対象。config watcher、admin API、migration、rollback job、task auto-resumeは対象外。
4. **Consumer/invariant inventory:** Swift bridge sender、loopback control transport、resident
   control controller、voice runtime cancellation、Pi turn client、Apple Speech client、macOS
   bridge health/close、playback sink、launchd shutdown、field report、audit/probe、native/TypeScript
   testが対象。各consumerはfirst cause、single settlement、ordered delivery、bounded drainを
   前提とする。
5. **Central enforcement point:** semantic eventsは`ControlEventChannel`、stateとobserver
   failureは`ResidentControlController`、bridge childはmanaged bridge closure、playback childは
   playback sinkのactive operation、STT causeはApple Speech request closure、Pi bootstrap waitは
   Pi turn clientのabort-aware acquisition boundaryを必ず通る。caller側の局所guardだけで
   ownershipを補わない。
6. **Forbidden paths:** `.bufferingOldest(1)`によるsemantic event drop、observer exception後の
   非terminal state、SIGTERMだけ送って無期限wait、child exit前の`active = undefined`、mutable
   booleanによるabort cause上書き、session creationを無条件await、cancelled capture frameを
   completed-hold evidenceに加算、unhandled background promise rejectionを禁止する。
7. **Required tests:** press/release burstのlossless delivery、transition observer failureの
   direct `error` terminalization、SIGTERM非応答時のSIGKILLとfinal timeout、stdin failure後も
   stopが同じchildを対象にすること、timeout後caller abortでも`timeout`維持、session bootstrap
   中cancelの即時settlementと背景promise観測、completed holdが0 frameならcancelled holdに
   frameがあってもfield failureとなることをdeterministicに検証する。
8. **Async ownership and terminal states:** channelは`finish()`、controller generationはidle/error/
   stopped、bridge/playback childは`exit`またはbounded termination error、Apple Speech requestは
   first causeを持つresult、Pi bootstrapはcached session promiseのsettlementでterminalとなる。
   ownerはacknowledgement、abort、late-result suppression、TERM→KILL、shutdown drainを担当し、
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
- bridgeとplayback childはexitまでownerに残り、bounded TERM→KILLでshutdownする。
- Pi session bootstrap中のcancelはsession creationを待たずにturn cancellationへ収束する。
- field validationはcompleted hold自身がcaptureしたframeを要求する。
- PR #99のfocused testsと`just check`が通り、current-head reviewのactionable findingが0件になる。
