# Resident AVAudioEngine Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-PTT FFmpeg/AVFoundation capture on macOS with one continuously running AVAudioEngine resident I/O sidecar that admits only post-press samples and preserves the existing turn lifecycle.

**Architecture:** Rename the existing macOS control package into a resident I/O package. Keep Node as the control-state and turn-generation owner; use a bounded framed stdin/stdout protocol so Swift can correlate physical CGEvent timestamps with AVAudioTime host timestamps, buffer only until admission, and emit PCM only for an accepted generation. Linux ALSA remains on the existing capture boundary.

**Tech Stack:** Swift 6.2/AVFAudio/CoreAudio/CoreGraphics, TypeScript 6, Node child processes, Vitest, Swift Testing, ast-grep, Just.

**Repository note:** Commit steps are intentionally omitted because repository instructions allow commits only when the user explicitly requests them.

---

### Task 1: Record the pre-implementation macOS measurement evidence

**Files:**
- Create: `scripts/field/macos-resident-audio-probe.swift`
- Create: `docs/superpowers/research/2026-07-20-resident-avaudioengine-input-measurement.md`
- Modify: `Justfile`
- Test: `tests/justfile.test.ts`

- [ ] **Step 1: Write a failing Justfile contract test**

Add a test requiring `macos-resident-audio-probe` to invoke `xcrun swift` with the repository probe source and forwarded bounded probe arguments.

```ts
it("exposes the bounded macOS resident audio probe", () => {
  expect(justfile).toContain("macos-resident-audio-probe *args:");
  expect(justfile).toContain("scripts/field/macos-resident-audio-probe.swift");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/justfile.test.ts`

Expected: FAIL because the recipe is absent.

- [ ] **Step 3: Add the bounded probe and recipe**

The probe must:

```swift
struct ProbeSample: Codable {
  let callbackFrameLength: UInt32
  let callbackHostTime: UInt64
  let callbackMachTime: UInt64
  let sampleRate: Double
}
```

- reject duration outside `1...300` seconds;
- list input device name/UID/rate/channel metadata without PCM;
- request 100 ms tap buffers and record actual cadence/frame length;
- record CGEvent timestamp, surrounding mach times, and audio host time;
- report process CPU time/RSS and dropped-buffer counts;
- write metadata JSON only, never PCM;
- terminate and remove its tap/engine on timeout or signal.

Add:

```make
macos-resident-audio-probe *args:
  xcrun swift scripts/field/macos-resident-audio-probe.swift {{args}}
```

- [ ] **Step 4: Run the test and non-microphone validation**

Run: `npm test -- tests/justfile.test.ts`

Expected: PASS.

Run: `xcrun swiftc -typecheck scripts/field/macos-resident-audio-probe.swift`

Expected: exit 0.

- [ ] **Step 5: Check resource ownership before any capture**

Run:

```bash
pgrep -alf 'pico|resident|ffmpeg.*avfoundation|pico-macos-control'
lsof -nP -iTCP:8781 -sTCP:LISTEN
```

Expected for the current environment: another checkout is active, so do not run the microphone probe. Record the deferred reason in the research document without claiming field PASS.

### Task 2: Define and test the framed resident I/O protocol

**Files:**
- Move: `sidecars/macos-control` to `sidecars/macos-resident-io`
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/ResidentIoMessage.swift`
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/ResidentIoCodec.swift`
- Create: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/ResidentIoCodecTests.swift`
- Modify: `sidecars/macos-resident-io/Package.swift`
- Modify: `scripts/ci/run-macos-control-gates.sh`

- [ ] **Step 1: Write failing codec tests**

Cover fragmented headers/payloads, consecutive frames, maximum metadata/payload lengths, unknown version, unknown kind, and PCM payload rejection on non-PCM messages.

```swift
@Test func fragmentedFrameDecodesOnlyAfterAllBytesArrive() throws {
  let encoded = try ResidentIoCodec.encode(.ready(.init(engineGeneration: 1)))
  var decoder = ResidentIoDecoder()
  #expect(throws: Never.self) { try decoder.append(encoded.prefix(5)) }
  #expect(try decoder.next() == nil)
  try decoder.append(encoded.dropFirst(5))
  #expect(try decoder.next() == .ready(.init(engineGeneration: 1)))
}
```

- [ ] **Step 2: Run Swift tests and verify RED**

Run: `swift test --package-path sidecars/macos-resident-io`

Expected: FAIL because the protocol types do not exist.

- [ ] **Step 3: Implement the minimal protocol**

Use a fixed 16-byte big-endian header:

```swift
struct ResidentIoFrameHeader: Equatable, Sendable {
  static let version: UInt8 = 1
  let kind: ResidentIoMessageKind
  let metadataLength: UInt32
  let payloadLength: UInt32
}
```

Define typed metadata for `ready`, `controlEvent`, `controlResult`, `pcmFrame`, `tailComplete`, `suppressCapture`, `resumeCapture`, `cancelGeneration`, `healthEvent`, `fatal`, and `shutdown`. Enforce 16 KiB metadata and 1 MiB payload limits. Only `pcmFrame` accepts a non-empty payload.

- [ ] **Step 4: Run Swift tests and verify GREEN**

Run: `swift test --package-path sidecars/macos-resident-io`

Expected: codec tests PASS.

- [ ] **Step 5: Refactor the package and gate names**

Rename products/targets to `PicoMacOSResidentIOCore` and `pico-macos-resident-io`. Rename the gate script to `scripts/ci/run-macos-resident-io-gates.sh` and update its expected executable.

Run: `rg -n 'macos-control|PicoMacOSControl|pico-macos-control' sidecars scripts Justfile tests package.json`

Expected: only intentional migration assertions remain.

### Task 3: Implement the host-clock mapper and sample slicer with TDD

**Files:**
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/HostClockMapper.swift`
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/PttSampleGate.swift`
- Create: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/HostClockMapperTests.swift`
- Create: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/PttSampleGateTests.swift`

- [ ] **Step 1: Write failing clock and cutoff tests**

Tests must prove:

```swift
@Test func pressInsideBufferAcceptsOnlySamplesAtOrAfterPress() throws {
  var gate = PttSampleGate(capacityFrames: 48_000, outputRate: 16_000)
  gate.observePress(sequence: 7, hostSeconds: 10.0025)
  gate.acceptAdmission(sequence: 7, generation: 11)
  let accepted = try gate.consume(bufferStartingAt: 10.0, sampleRate: 48_000, samples: ramp(480))
  #expect(accepted.first?.sourceSampleIndex == 120)
  #expect(accepted.allSatisfy { $0.hostSeconds >= 10.0025 })
}
```

Also cover press before/after buffer, exact-boundary press, busy result, admission timeout, ring overflow, release+250 ms cutoff, cancel, suppress/resume clear, invalid timestamp, timestamp regression, and generation mismatch.

- [ ] **Step 2: Run Swift tests and verify RED**

Run: `swift test --package-path sidecars/macos-resident-io --filter 'HostClockMapperTests|PttSampleGateTests'`

Expected: FAIL because mapper/gate are absent.

- [ ] **Step 3: Implement clock calibration and pure gate state**

Use explicit pure value types:

```swift
struct HostClockCalibration: Equatable, Sendable {
  let eventToAudioOffsetSeconds: Double
  let maximumResidualSeconds: Double
}

enum PttGateState: Equatable, Sendable {
  case discarding
  case pendingAdmission(sequence: UInt64, pressedAt: Double)
  case accepting(generation: UInt64, pressedAt: Double)
  case tailing(generation: UInt64, cutoff: Double)
  case suppressed
  case unavailable
}
```

Calculate the first accepted source index with `ceil((cutoff - bufferStart) * sampleRate)` and clamp it to `0...frameLength`. Keep the ring and all output queues bounded. A capacity failure must return a typed terminal error rather than drop accepted samples silently.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `swift test --package-path sidecars/macos-resident-io --filter 'HostClockMapperTests|PttSampleGateTests'`

Expected: all targeted tests PASS.

- [ ] **Step 5: Refactor without changing behavior**

Separate PCM-independent admission state from sample storage and rerun the same tests.

### Task 4: Add stable Core Audio device selection and AVAudioEngine ownership

**Files:**
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/CoreAudioInputDevice.swift`
- Create: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIO/ResidentAudioEngine.swift`
- Create: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/CoreAudioInputDeviceTests.swift`
- Create: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/AudioEngineStateTests.swift`

- [ ] **Step 1: Write failing device and engine-state tests**

Use value snapshots returned by the Core Audio enumeration boundary; do not add a production test provider.

```swift
@Test func resolverSelectsTheSingleInputCapableDeviceWithMatchingUid() throws {
  let devices = [
    CoreAudioInputDevice(id: 2, uid: "speaker", name: "Output", inputChannels: 0),
    CoreAudioInputDevice(id: 7, uid: "usb-mic", name: "Mic", inputChannels: 2),
  ]
  #expect(try resolveInputDevice(uid: "usb-mic", from: devices).id == 7)
}
```

Cover missing UID, duplicate UID, zero input channels, nonzero format requirements, and allowed state transitions.

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/macos-resident-io --filter 'CoreAudioInputDeviceTests|AudioEngineStateTests'`

Expected: FAIL because the device/state types are absent.

- [ ] **Step 3: Implement Core Audio enumeration and the real AVAudioEngine owner**

The executable target implementation must:

```swift
let inputNode = engine.inputNode
try inputNode.auAudioUnit.setDeviceID(selectedDevice.id)
let hardwareFormat = inputNode.inputFormat(forBus: 0)
guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
  throw ResidentAudioEngineError.inputUnavailable
}
```

Check `AVCaptureDevice.authorizationStatus(for: .audio)` before engine start. Install one tap, set `isAutoShutdownEnabled = false`, call `prepare()` and `start()`, and declare ready only after the first callback has valid host/sample timestamps. Convert outside the realtime callback to PCM16LE 16 kHz mono.

- [ ] **Step 4: Run tests and release build**

Run: `swift test --package-path sidecars/macos-resident-io`

Expected: all tests PASS.

Run: `swift build --package-path sidecars/macos-resident-io -c release -Xswiftc -warnings-as-errors`

Expected: exit 0 with no warnings.

### Task 5: Add integrated health and recovery ownership

**Files:**
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIO/ResidentIoOwner.swift`
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/PttSampleGate.swift`
- Modify: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/PttSampleGateTests.swift`
- Modify: `tests/resident-hold-to-talk-field-runtime.test.ts`

- [ ] **Step 1: Write failing invalidation and field-health tests**

Cover pending admission and accepted-generation invalidation, recovery while TTS suppression is active,
and rejection of field PASS after any recovery, timeout, or engine-stop event.

- [ ] **Step 2: Run tests and verify RED**

Run: `just macos-resident-io-check`

Run: `npm test -- tests/resident-hold-to-talk-field-runtime.test.ts`

Expected: the new assertions FAIL against the unintegrated recovery paths.

- [ ] **Step 3: Implement recovery in the real owner**

Observe `AVAudioEngineConfigurationChange`, workspace sleep/wake, and a bounded periodic
`engine.isRunning` check directly in `ResidentIoOwner`. Invalidate pending admission or the active
generation before clearing the gate, reuse only the configured UID, bound recovery attempts, preserve
TTS suppression, and emit fixed health codes. Do not add an unreferenced parallel health state machine.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same focused Swift and Node tests and require them to pass.

### Task 6: Integrate keyboard, engine, gate, and IPC in the Swift executable

**Files:**
- Move/Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIO/PicoMacOSResidentIO.swift`
- Modify: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/ControlEvent.swift`
- Replace: `sidecars/macos-resident-io/Sources/PicoMacOSResidentIOCore/ControlTransport.swift`
- Modify: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/ControlEventTests.swift`
- Replace: `sidecars/macos-resident-io/Tests/PicoMacOSResidentIOCoreTests/ControlTransportTests.swift`

- [ ] **Step 1: Write failing integrated core tests**

Require physical event timestamps and ordered admission:

```swift
let decision = mapper.handle(
  keyCode: talkKey,
  isKeyDown: true,
  isRepeat: false,
  eventTimestampNanoseconds: 12_345
)
#expect(decision.event == .talkPressed(sequence: 1, timestampNanoseconds: 12_345))
```

Test that F2 clears pending/accepted audio before its control message is emitted and that TTS suppression drops PCM without storing content.

- [ ] **Step 2: Run tests and verify RED**

Run: `swift test --package-path sidecars/macos-resident-io --filter 'ControlEventTests|ControlTransportTests'`

Expected: FAIL against the old semantic-event transport.

- [ ] **Step 3: Implement the integrated owner**

The event tap reads `event.timestamp`; the realtime audio callback copies only bounded buffer metadata/audio into the owner queue. The owner serializes control/health/accepted PCM. stdin decoding applies Node results and commands. Remove URLSession, bearer token, host, and port handling from production Swift code.

- [ ] **Step 4: Run all sidecar gates**

Run: `bash scripts/ci/run-macos-resident-io-gates.sh`

Expected: format lint, Swift tests, release build, invalid CLI checks all PASS.

### Task 7: Add the Node framed protocol and managed sidecar bridge

**Files:**
- Create: `src/runtime/macos-resident-io-protocol.ts`
- Rename/Modify: `src/runtime/macos-control-bridge.ts` to `src/runtime/macos-resident-io-bridge.ts`
- Create: `tests/macos-resident-io-protocol.test.ts`
- Rename/Modify: `tests/macos-control-bridge.test.ts` to `tests/macos-resident-io-bridge.test.ts`

- [ ] **Step 1: Write failing Node codec and bridge tests**

Cover fragmented reads, bounds, unknown messages, ordered writes/backpressure, ready handshake, unexpected exit, TERM/KILL settlement, and audio payload ownership.

```ts
it("does not expose PCM until the accepted control result is written", async () => {
  const bridge = createResidentIoBridgeHarness();
  bridge.emitControl({ sequence: 3, kind: "talk_pressed", eventTimestampNs: 10n });
  bridge.emitPcm({ generation: 8, payload: Buffer.alloc(320) });
  await expect(bridge.nextPcm()).resolves.toBeUndefined();
  await bridge.admit({ sequence: 3, result: "accepted", generation: 8 });
  await expect(bridge.nextPcm()).resolves.toHaveLength(320);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/macos-resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts`

Expected: FAIL because the new modules are absent.

- [ ] **Step 3: Implement codec and bridge**

Expose:

```ts
export type MacOSResidentIoBridge = {
  readonly completion: Promise<void>;
  readonly events: AsyncIterable<MacOSResidentIoEvent>;
  readonly send: (command: MacOSResidentIoCommand) => Promise<void>;
  readonly close: () => Promise<void>;
};
```

Never write protocol stdout to process logs. Validate numeric metadata and payload lengths before allocation. Preserve the existing bounded child termination semantics.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/macos-resident-io-protocol.test.ts tests/macos-resident-io-bridge.test.ts`

Expected: all targeted tests PASS.

### Task 8: Replace the macOS capture session with the sidecar stream

**Files:**
- Modify: `src/runtime/resident-audio-io.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-control-controller.ts`
- Modify: `tests/resident-audio-io.test.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/resident-control-controller.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Tests must prove that macOS capture start does not spawn FFmpeg, accepted frames bind to the current generation, pre-press/late frames are rejected, transcribing waits for `tail_complete`, and cancel disposes the gate without closing the resident engine.

```ts
it("waits for the native tail completion before transcribing", async () => {
  const runtime = createResidentRuntimeWithIoBridge();
  await runtime.handleControl(pressedAt(10));
  await runtime.handleControl(releasedAt(11));
  await advanceBy(250);
  expect(sttCalls).toBe(0);
  io.emit({ kind: "tail_complete", generation: 1, cutoffHostSeconds: 11.25 });
  await settled();
  expect(sttCalls).toBe(1);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/resident-audio-io.test.ts tests/resident-control-controller.test.ts tests/voice-resident.test.ts`

Expected: new assertions FAIL against per-hold FFmpeg capture and timer-owned completion.

- [ ] **Step 3: Implement the macOS resident capture adapter**

Keep ALSA behavior unchanged. For macOS, `start()` sends the accepted admission result and returns an async frame view over the already-running sidecar. `stop()` requests/awaits native tail completion; `cancelGeneration` drops it. Replace the 250 ms behavior timer with a completion watchdog whose timeout is greater than the media cutoff.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/resident-audio-io.test.ts tests/resident-control-controller.test.ts tests/voice-resident.test.ts`

Expected: all targeted tests PASS.

### Task 9: Wire TTS suppression and resume acknowledgements

**Files:**
- Modify: `src/runtime/tts-playback-pipeline.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-audio-io.ts`
- Modify: `tests/tts-playback-pipeline.test.ts`
- Modify: `tests/voice-resident.test.ts`

- [ ] **Step 1: Write failing TTS gate tests**

Require `suppress_capture` acknowledgement before playback open, cancel convergence while ack is pending, ring clear on finish/failure/cancel, and `resume_capture` acknowledgement before controller returns to idle.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/tts-playback-pipeline.test.ts tests/voice-resident.test.ts`

Expected: FAIL because playback does not coordinate with the native gate.

- [ ] **Step 3: Implement the capture-suppression boundary**

Extend runtime options with:

```ts
readonly captureGate: {
  readonly suppressForPlayback: (signal: AbortSignal) => Promise<void>;
  readonly resumeAfterPlayback: () => Promise<void>;
};
```

Call suppress before `playback.open()`. On every terminal path, flush echo state, clear native capture, then resume. A gate failure is playback infrastructure failure and must not open an alternative input provider.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/tts-playback-pipeline.test.ts tests/voice-resident.test.ts`

Expected: all targeted tests PASS.

### Task 10: Migrate configuration to stable Core Audio UID

**Files:**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `README.md`
- Modify: `tests/config.test.ts`
- Modify: `tests/resident-audio-io.test.ts`

- [ ] **Step 1: Write failing config tests**

Require exactly:

```yaml
audioInput:
  provider: avaudioengine
  deviceUid: usb-microphone-uid
```

Reject `provider: avfoundation`, positional `device`, empty UID, unknown keys, and `avaudioengine` on non-macOS production plan construction.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/config.test.ts tests/resident-audio-io.test.ts`

Expected: FAIL because only AVFoundation/device is supported.

- [ ] **Step 3: Implement config migration**

Replace the macOS union member with:

```ts
type PicoResidentMacOSAudioInputConfig = {
  readonly provider: "avaudioengine";
  readonly deviceUid: string;
};
```

Do not add an alias or migration fallback. Update examples and documentation to explain UID discovery and the always-on microphone indicator.

- [ ] **Step 4: Run tests and repository identifier scan**

Run: `npm test -- tests/config.test.ts tests/resident-audio-io.test.ts`

Expected: PASS.

Run: `rg -n 'avfoundation|pico-macos-control|macos-control' src sidecars scripts tests config README.md Justfile package.json`

Expected: no production macOS input/control reference remains; field-history documents may retain historical text.

### Task 11: Add privacy-safe health and latency observations

**Files:**
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `tests/voice-stage-probe.test.ts`
- Modify: `tests/resident-voice-runner.test.ts`
- Modify: `tests/telemetry.test.ts`

- [ ] **Step 1: Write failing allowlist/privacy tests**

Add fixed stages for key-to-admission, admission-to-gate, gate-to-first-sample, first-sample-to-dispatch, release-to-tail-complete, and engine start/restart. Add numeric counts for cadence and dropped-outside-PTT frames. Verify raw PCM, UID, key, session/generation/sequence, transcript, and error message are rejected.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/voice-stage-probe.test.ts tests/resident-voice-runner.test.ts tests/telemetry.test.ts`

Expected: FAIL because new stages/attributes are not allowed.

- [ ] **Step 3: Implement fixed observations**

Map sidecar health metadata into existing audit/log/metric fanout with fixed low-cardinality error codes. Keep OTel Logs/Metrics only and do not introduce trace/session identifiers.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/voice-stage-probe.test.ts tests/resident-voice-runner.test.ts tests/telemetry.test.ts`

Expected: all targeted tests PASS.

### Task 12: Update deterministic gates and field validation

**Files:**
- Modify: `Justfile`
- Modify: `TOOLS.md`
- Modify: `package.json`
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `scripts/smoke/resident-audio-input.ts`
- Modify: `tests/justfile.test.ts`
- Modify: `tests/resident-hold-to-talk-field.test.ts`
- Modify: `tests/resident-audio-input-smoke.test.ts`
- Create: `docs/superpowers/research/2026-07-20-resident-avaudioengine-input-validation.md`

- [ ] **Step 1: Write failing gate and field contract tests**

Require the new Swift gate, no FFmpeg macOS smoke, privacy-safe timing fields, zero idle PCM bytes/STT calls, device UID match, and explicit skipped status when exclusive resources are occupied.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/justfile.test.ts tests/resident-hold-to-talk-field.test.ts tests/resident-audio-input-smoke.test.ts`

Expected: FAIL against old command names and AVFoundation smoke.

- [ ] **Step 3: Implement gate and field updates**

Add `just macos-resident-io-check`, update `just check`, and document the exact real-provider ladder in `TOOLS.md`. Field output contains only aggregate timing/count/device-match metadata and a passed/failed/skipped status.

- [ ] **Step 4: Run the non-exclusive verification ladder**

Run in order:

```bash
just macos-resident-io-check
just apple-speech-check
just typecheck
just lint
just ast
just test
just check
npx --yes --package secretlint --package @secretlint/secretlint-rule-preset-recommend secretlint .
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Coordinate and run exclusive real-provider validation**

First rerun process/port/lock checks. If another Pico remains active, stop and ask the user to provide an exclusive window. Once available:

1. map current AVFoundation `:1` device name to its Core Audio UID;
2. run the bounded cadence/clock/CPU probe;
3. run provider preflight and require Apple Speech/Aivis sections `passed`;
4. run one strict full-turn pseudo-audio smoke and require report `passed`;
5. run immediate-speech physical PTT, tail, cancel, busy-talk, TTS-clear, device/configuration recovery checks;
6. without code/config changes, collect at least three sequential real-provider runs;
7. record exact commands, environment, aggregate timings, and unresolved limits in the validation document.

Expected: no pre-press accepted sample, no missing post-press onset, 250 ms media cutoff, zero idle outbound PCM/STT, and no hidden provider fallback.

### Task 13: Final scope and evidence review

**Files:**
- Review: all modified files
- Review: `docs/superpowers/specs/2026-07-20-resident-avaudioengine-input-design.md`
- Review: `docs/superpowers/research/2026-07-20-resident-avaudioengine-input-validation.md`

- [ ] **Step 1: Check the diff against the scope ledger**

Confirm every audio requirement is implemented and no Pi TUI display redesign, OTel Traces, Linux architecture change, provider fallback, or durable content storage entered the diff.

- [ ] **Step 2: Scan repeated identifiers and forbidden paths**

Run:

```bash
rg -n 'avaudioengine|deviceUid|tail_complete|suppress_capture|resume_capture' src sidecars scripts tests config docs/superpowers/specs/2026-07-20-resident-avaudioengine-input-design.md
rg -n 'ffmpeg.*avfoundation|provider: avfoundation|fallback|mock|stub|fake' src sidecars tests config
```

Expected: new identifiers appear only in their intended owner/helper/test scopes; forbidden production paths are absent.

- [ ] **Step 3: Re-run the complete final verification**

Run the complete Task 12 non-exclusive ladder fresh and read every exit code/output before reporting completion. If exclusive field validation remains unavailable, report it as the sole unverified gate and do not claim production completion.
