# Resident Apple Speech Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** accepted PTT PCMを1つのApple Speech sessionへ連続投入し、2分超の発話を音声長比例のPCMメモリ増加なしでfinal transcriptへ変換する。

**Architecture:** macOS resident I/O sidecarからNodeへ届くaccepted PCMをbounded channelで逐次処理し、loopback WebSocketを通じてApple Speech sidecarの1つの`SpeechAnalyzer`へ送る。batch routeはwarmup/smoke専用に残し、resident productionからのfallbackは持たない。

**Tech Stack:** TypeScript 6、Node.js 24 WebSocket、Swift 6.2、SpeechAnalyzer、FlyingFox 0.27、Vitest、Swift Testing

---

## File ownership map

- `sidecars/apple-speech/Sources/AppleSpeechCore/StreamingWireContract.swift`: streaming message schemaとstrict validation。
- `sidecars/apple-speech/Sources/AppleSpeechCore/AppleSpeechStreaming.swift`: bounded PCM inputと1 analyzer sessionのlifecycle。
- `sidecars/apple-speech/Sources/AppleSpeechCore/TranscriptionAdmission.swift`: batch/stream共通の単一lease owner。
- `sidecars/apple-speech/Sources/AppleSpeechCore/WebSocketSpeechHandler.swift`: WebSocket順序、admission、terminal収束。
- `sidecars/apple-speech/Sources/AppleSpeechCore/HTTPService.swift`: streaming routeのupgradeだけを追加。
- `src/modules/voice/index.ts`: resident streaming STT public contractとclient実装。
- `src/runtime/macos-resident-io-bridge.ts`: native accepted PCMのbounded channel。
- `src/runtime/voice-resident.ts`: frame全量保持から逐次echo/VAD/STTへ移行。
- 対応するSwift/Node tests: 各contractのbehavior lock。

### Task 1: Lock the streaming wire protocol in Swift

**Files:**
- Create: `sidecars/apple-speech/Sources/AppleSpeechCore/StreamingWireContract.swift`
- Create: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/StreamingWireContractTests.swift`

- [ ] **Step 1: Write failing strict codec tests**

`start`、`finish`、`ready`、`completed`、`failed`のexact field set、version、固定format、
`timeoutMs`、`completed.result`、`failed.error.code`の全許容値、unknown field、
duplicate/invalid kindを試験する。

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/apple-speech --filter StreamingWireContractTests`

Expected: FAIL because the streaming contract does not exist.

- [ ] **Step 3: Implement the minimal codec**

JSON text messageだけをCodableにし、PCMはWebSocket binaryのまま扱う。error messageへ
PCM、transcript、session identifierを含めない。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `swift test --package-path sidecars/apple-speech --filter StreamingWireContractTests`

Expected: all targeted tests PASS.

### Task 2: Stream multiple PCM buffers through one SpeechAnalyzer session

**Files:**
- Create: `sidecars/apple-speech/Sources/AppleSpeechCore/AppleSpeechStreaming.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/AppleSpeechEngine.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/PCM16LE.swift`
- Create: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/AppleSpeechStreamingTests.swift`

- [ ] **Step 1: Write failing sequence lifecycle tests**

複数chunkの同順序投入、finish時finalize、empty input cancel、caller cancel、finish後timeout、
8 MiB byte overflow、4 MiB超total byte countを試験する。overflowしたsendの後に
`completed`へ到達しないことも固定する。Speech framework本体に依存しないpure input
channelと`runAnalysis` seamを使う。

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/apple-speech --filter AppleSpeechStreamingTests`

Expected: FAIL because streaming engine/input types are absent.

- [ ] **Step 3: Implement bounded analyzer input**

専用actor channelは追加前に8 MiB byte上限を検査し、overflowはtyped errorでstream全体を
cancelする。channel内はSendableな`Data`だけを扱い、consumer isolationで1 chunkを1つの
`AVAudioPCMBuffer`へ変換する。total bytesは`Int64`で加算する。

- [ ] **Step 4: Run tests and release build**

Run: `swift test --package-path sidecars/apple-speech --filter AppleSpeechStreamingTests`

Run: `swift build --package-path sidecars/apple-speech -c release -Xswiftc -warnings-as-errors`

Expected: tests and build PASS without warnings.

### Task 3: Unify batch and streaming admission ownership

**Files:**
- Create: `sidecars/apple-speech/Sources/AppleSpeechCore/TranscriptionAdmission.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/HTTPService.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/AppleSpeechEngine.swift`
- Modify: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/HTTPAdmissionTests.swift`
- Create: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/TranscriptionAdmissionTests.swift`

- [ ] **Step 1: Write failing shared-lease tests**

batch中のstream acquire拒否、stream中のbatch拒否、success/failure/cancelの全経路release、
double releaseの無害化を試験する。現行batchのHTTP 429 contractも維持する。

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/apple-speech --filter 'TranscriptionAdmissionTests|HTTPAdmissionTests'`

Expected: FAIL because HTTP handler and engine still own separate guards.

- [ ] **Step 3: Implement one injected admission owner**

shared actorのleaseをbatch operationとstream sessionが使用する。private handler admissionと
`AppleSpeechEngine.requestInFlight`は削除またはshared ownerへ委譲し、二重guardを残さない。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `swift test --package-path sidecars/apple-speech --filter 'TranscriptionAdmissionTests|HTTPAdmissionTests'`

Expected: targeted tests PASS and existing batch busy behavior is unchanged.

### Task 4: Add the WebSocket route without changing batch behavior

**Files:**
- Create: `sidecars/apple-speech/Sources/AppleSpeechCore/WebSocketSpeechHandler.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/HTTPService.swift`
- Modify: `sidecars/apple-speech/Sources/AppleSpeechCore/AppleSpeechEngine.swift`
- Create: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/WebSocketSpeechHandlerTests.swift`
- Modify: `sidecars/apple-speech/Tests/AppleSpeechCoreTests/HTTPRouteTests.swift`

- [ ] **Step 1: Write failing protocol-state tests**

start-before-binary、ready前binary拒否、fragmented text/binary、ping/pong、binary ordering、
finish、terminal、finish前disconnect、finalization中disconnect、busy、odd/oversized binary、
duplicate start/finish、10秒inactivity、active session中のsidecar shutdownを試験する。
HTTP handler timeoutより長いstream接続が生存するroute testも追加する。
ping/pongだけではpre-finish inactivity timerがresetされないことも試験する。

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/apple-speech --filter 'WebSocketSpeechHandlerTests|HTTPRouteTests'`

Expected: new streaming route assertions FAIL.

- [ ] **Step 3: Implement one admitted WebSocket session**

`GET /v1/transcription-stream`だけをupgradeする。FlyingFoxのlow-level `WSHandler`でframeを
逐次consumeし、bounded fragmentation assemblerとsession supervisorを実装する。
共有admissionはstart受理からterminal teardownまで保持し、failure後に別routeを呼ばない。
finish受理時からinput drain、finalize、result consumeを覆うtimeoutを開始する。
disconnect/shutdown/timeoutはcancellation-safe teardownから`cancelAndFinishNow`へ到達させる。

- [ ] **Step 4: Run the Apple Speech focused gate**

Run: `just apple-speech-check`

Expected: existing batch contract and new streaming tests PASS.

### Task 5: Add the Node resident streaming STT client

**Files:**
- Modify: `src/modules/voice/index.ts`
- Modify: `tests/voice.test.ts`

- [ ] **Step 1: Write failing client contract tests**

open/start/ready、ready前write拒否、10 ms frameから3,200 byteへのcoalescing、release端数flush、
256 KiB high-waterの10 ms poll/1秒deadline、finish/result、server failure、close code、
caller abort、1秒connect/ready timeout、finish受理後だけのfinalization timeoutを試験する。
batch `transcribe` testsは維持する。

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/voice.test.ts`

Expected: FAIL because `ResidentStreamingSttClient` does not exist.

- [ ] **Step 3: Implement the minimal Node WebSocket client**

Node 24 standard WebSocketを使い、新依存は追加しない。`binaryType = "arraybuffer"`を
明示し、WHATWG WebSocketにはdrain eventとAbortSignal連携がない前提でpoll/`close()`を
実装する。`finish()`送信後にだけprovider timeoutを開始する。socket failureをbatch callへ
変換しない。

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/voice.test.ts`

Run: `just typecheck`

Expected: targeted tests and typecheck PASS.

### Task 6: Bound the native PCM channel

**Files:**
- Modify: `src/runtime/macos-resident-io-bridge.ts`
- Modify: `tests/macos-resident-io-bridge.test.ts`

- [ ] **Step 1: Write a failing backlog test**

consumerを止めて129 frameを投入し、128 frameまでは保持し、次で
`resident_pcm_backlog` failureへ収束することを試験する。STT `ready`前はconsumerがpullせず、
ready前sampleの唯一の滞留場所がこのchannelであることもlockする。

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- tests/macos-resident-io-bridge.test.ts`

Expected: FAIL because `AsyncFrameChannel` is unbounded.

- [ ] **Step 3: Implement fixed-capacity fail-close behavior**

silent dropはしない。channel failureをactive capture、bridge lifecycle、native generation
cancel、同generationのSTT streamへ伝播する。128 frameは10 ms cadenceで1.28秒のheadroom
であり、STT接続はtalk admission直後、consumer/coalescerは`ready`後に開始する。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/macos-resident-io-bridge.test.ts`

Expected: all targeted tests PASS.

### Task 7: Stream resident frames online instead of retaining the turn audio

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `tests/voice-resident.test.ts`

- [ ] **Step 1: Write failing runtime tests**

release前の逐次write、tail完了までfinishしない、4 MiB超frame列、VAD no-speech cancel、F2、
全echo suppression時のzero-frame cancel、health invalidation、shutdown、write failure、
native backlog時stream cancel/generation invalidation、late terminal resultを試験する。
readyを保留したtestではframeがnative channelだけに滞留し、ready後に順序を保って逐次write
されることも試験する。

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/voice-resident.test.ts`

Expected: new assertions FAIL against `frames[]` and `concatenateAudio`.

- [ ] **Step 3: Implement per-generation streaming ownership**

`ActiveTurn`はframe配列ではなくstream、speech flag、byte count、collection operationを持つ。
echo controlとVADの順序を維持する。echo actionが`suppress`でない時だけ
`echo.frame.audio`をtrimせず1回writeし、全frame suppressionではfinishせずcancelする。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/voice-resident.test.ts`

Expected: all targeted tests PASS.

- [ ] **Step 5: Confirm old accumulation is gone**

Run: `rg -n 'frames: VoicePcmFrame\[\]|concatenateAudio' src/runtime/voice-resident.ts`

Expected: no matches. Then run
`rg -n 'maximumDecodedAudioBytes' sidecars/apple-speech/Sources` and confirm every match is owned by
the batch `WireContract`, never the streaming path.

### Task 8: Update runner, smoke, field, and documentation contracts

**Files:**
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `scripts/smoke/voice-providers.ts`
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `README.md`
- Modify: `TOOLS.md`
- Modify: corresponding tests

- [ ] **Step 1: Write failing integration contract tests**

configured resident STTがstreaming capabilityを持つこと、field harnessがstream lifecycleを
記録し、PCM contentをreportしないことを試験する。

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/resident-voice-runner.test.ts tests/voice-smoke.test.ts tests/resident-hold-to-talk-field-runtime.test.ts`

- [ ] **Step 3: Implement and document the production-only stream path**

batchはwarmup/smokeに限定し、residentはstreamを要求する。2分超、bounded queues、
no-fallback、no-file contractをREADMEとTOOLSへ記載する。batch warmupとstreamingが同じ
SpeechTranscriber構成と`.processLifetime` retentionを使う前提をprovider fixtureで検証する。

- [ ] **Step 4: Run focused Node and Swift gates**

Run: `just apple-speech-check`

Run: `just macos-resident-io-check`

Run: `npm test -- tests/voice.test.ts tests/voice-resident.test.ts tests/macos-resident-io-bridge.test.ts tests/resident-voice-runner.test.ts tests/voice-smoke.test.ts tests/resident-hold-to-talk-field-runtime.test.ts`

### Task 9: Perform the available provider validation

**Files:**
- Modify: `docs/superpowers/research/2026-07-20-resident-avaudioengine-input-validation.md`

- [ ] **Step 1: Inspect exclusive resource ownership**

Run: `pgrep -alf 'pico|resident|ffmpeg.*avfoundation|pico-macos-resident-io'`

Run: `lsof -nP -iTCP:8781 -sTCP:LISTEN`

Do not stop another checkout. Do not open the microphone when ownership is unclear.

- [ ] **Step 2: Run provider preflight**

Run: `just smoke-voice-providers`

Require both Apple Speech and AivisSpeech sections to report `status: passed`; `skipped` stops the
provider ladder.

- [ ] **Step 3: Run a finite fixture comparison when available**

Use the same local fixture/config for batch and streaming final output. Record only hash, duration,
status, latency, queue metadata, and normalized accuracy comparison. Do not record PCM or transcript
content in ordinary telemetry.

- [ ] **Step 4: Record deferred exclusive checks honestly**

If Pico cannot be started or the microphone is unavailable, retain deterministic/provider evidence
and list physical PTT tests as unverified rather than PASS.

このstreaming検証はAVAudioEngine移行と同じproduction turnを対象にするため、意図的に
`2026-07-20-resident-avaudioengine-input-validation.md`へ追記し、別のPASSとして二重計上しない。

### Task 10: Complete review and repository gates

**Files:**
- Modify: only files required by review findings

- [ ] **Step 1: Reconcile the scope ledger**

Confirm: AVAudioEngine always running, strict press cutoff, 250 ms tail, cancel, busy rejection, TTS
clear, health recovery, streaming STT, 2min+, bounded memory, no hidden fallback, #102 phase behavior.

- [ ] **Step 2: Run focused gates in required order**

Run: `just macos-resident-io-check`

Run: `just apple-speech-check`

Run: `just check`

Run: `npx --yes --package secretlint@latest --package @secretlint/secretlint-rule-preset-recommend@latest secretlint .`

Run: `git diff --check`

- [ ] **Step 3: Obtain independent review and fix findings**

Review complete diff against both design specs and repository instructions. Rerun affected focused
gates after each behavior-adjacent fix.

- [ ] **Step 4: Run polishment then the requested ai-slop-cleaner pass**

Lock behavior before cleanup. Remove only concrete dead code, duplication, needless abstraction,
boundary leaks, or missing behavior locks. Rerun the full final gate after cleanup.

- [ ] **Step 5: Commit, push, and create a Draft PR**

ユーザーがDraft PR作成を明示的に承認している場合だけ実行する。Stage only the resident AVAudioEngine/streaming scope, commit intentionally, push the current
`codex/resident-avaudioengine-input` branch, and create a Draft PR against `main`. Include verified
commands, independent verdicts, and deferred exclusive field checks.
