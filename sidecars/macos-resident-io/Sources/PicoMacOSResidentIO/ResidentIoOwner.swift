import CoreAudio
import Darwin
import Foundation
import PicoMacOSResidentIOCore

final class ResidentIoOwner: @unchecked Sendable {
  private static let maximumAdmissionRingFrames = 192_000
  private static let maximumControlReorderingFrames = 16_384
  private static let maximumControlEventSkewSeconds = 5.0
  let queue = DispatchQueue(label: "jp.toarupen.pico.macos-resident-io.owner")
  private let configuration: ResidentIoConfiguration
  private let writer = ResidentIoWriter()
  private let readySemaphore = DispatchSemaphore(value: 0)
  private let stopRunLoop: @Sendable () -> Void
  private var audioEngine: ResidentAudioEngine!
  private let clockMapper = HostClockMapper()
  private var configurationChangeGate = AudioConfigurationChangeGate()
  private var gate: PttSampleGate
  private let pcmConverter: AVAudioPcm16MonoConverter
  private var assembler: Pcm16FrameAssembler
  private var converterGeneration: UInt64?
  private var converterNextHostSeconds: Double?
  private var nextSequence: UInt64 = 1
  private var pendingControls = PendingControlTracker(maximumCount: 64)
  private var admissionTimeouts = AdmissionTimeoutTracker()
  private var pressHostSecondsByGeneration: [UInt64: Double] = [:]
  private var firstSampleObservedGenerations: Set<UInt64> = []
  private var firstDispatchObservedGenerations: Set<UInt64> = []
  private var releaseTimestampByGeneration: [UInt64: UInt64] = [:]
  private var pendingReleaseTimestamp: UInt64?
  private var readySent = false
  private var stopped = false
  private var suspended = false
  private var recovering = false
  private var recoveryAttempt = 0
  private var recoveryCycle: UInt64 = 0
  private var engineGeneration: UInt64 = 1
  private var activeAudioEngineGeneration: UInt64?
  private var activeAudioEngineHasDeliveredCallback = false
  private var restartCount: UInt32 = 0
  private var droppedFrameCount: UInt64 = 0
  private var outsidePttDroppedFrameCount: UInt64 = 0
  private var suppressedDroppedFrameCount: UInt64 = 0
  private var previousBufferStartHostSeconds: Double?
  private var bufferCadenceTotalSeconds = 0.0
  private var bufferCadenceSamples: UInt64 = 0
  private var healthTimer: DispatchSourceTimer?
  private var startupFailure: Error?
  private var engineStartBeganAt = 0.0

  init(configuration: ResidentIoConfiguration, stopRunLoop: @escaping @Sendable () -> Void) throws {
    self.configuration = configuration
    self.stopRunLoop = stopRunLoop
    gate = PttSampleGate(
      capacityFrames: Self.maximumAdmissionRingFrames,
      reorderingCapacityFrames: Self.maximumControlReorderingFrames,
      releaseTailSeconds: Double(configuration.releaseTailMilliseconds) / 1_000
    )
    pcmConverter = try AVAudioPcm16MonoConverter(
      outputSampleRate: Double(configuration.sampleRateHz))
    assembler = Pcm16FrameAssembler(
      frameCount: Int(configuration.sampleRateHz * configuration.frameMilliseconds / 1_000))
    audioEngine = ResidentAudioEngine(
      ownerQueue: queue,
      onBuffer: { [weak self] snapshot in self?.handleAudio(snapshot) },
      onDroppedBuffer: { [weak self] generation, count in
        self?.recordDroppedBuffer(engineGeneration: generation, count: count)
      },
      onConfigurationChange: { [weak self] generation in
        self?.handleConfigurationChange(engineGeneration: generation)
      },
      onFailure: { [weak self] generation, error in
        self?.reportAudioFailure(engineGeneration: generation, error: error)
      }
    )
  }

  func start() throws {
    try queue.sync {
      let deviceID = try CoreAudioDeviceCatalog.resolveInputDevice(uid: configuration.deviceUID)
      engineStartBeganAt = machHostSeconds()
      configurationChangeGate.reset()
      activeAudioEngineHasDeliveredCallback = false
      activeAudioEngineGeneration = try audioEngine.start(deviceID: deviceID)
      startHealthTimer()
    }
    guard readySemaphore.wait(timeout: .now() + .seconds(5)) == .success else {
      throw ResidentIoRuntimeError.firstAudioCallbackTimedOut
    }
    if let failure = queue.sync(execute: { startupFailure }) {
      throw failure
    }
  }

  func handleControlEvent(
    _ event: SemanticControlEvent,
    eventTimestampNanoseconds: UInt64
  ) {
    queue.async { [weak self] in
      self?.processControlEvent(event, eventTimestampNanoseconds: eventTimestampNanoseconds)
    }
  }

  func receive(_ message: ResidentIoMessage) {
    queue.async { [weak self] in self?.processCommand(message) }
  }

  func reportEventTapFailure() {
    queue.async { [weak self] in
      self?.fatal(code: "event_tap_disabled", error: ResidentIoRuntimeError.eventTapDisabled)
    }
  }

  func reportProtocolFailure(_ error: Error) {
    queue.async { [weak self] in self?.fatal(code: "protocol_decode_failed", error: error) }
  }

  func reportProtocolEof() {
    queue.async { [weak self] in
      self?.fatal(code: "protocol_eof", error: ResidentIoRuntimeError.protocolEof)
    }
  }

  func sleep() {
    queue.async { [weak self] in
      guard let self, !self.stopped else { return }
      self.suspended = true
      self.recovering = false
      self.recoveryAttempt = 0
      self.recoveryCycle += 1
      do {
        try self.invalidateCapture()
      } catch {
        self.fatal(code: "admission_invalidation_backlog", error: error)
        return
      }
      self.assembler.clear()
      self.clearAllGenerationObservations()
      self.activeAudioEngineGeneration = nil
      self.activeAudioEngineHasDeliveredCallback = false
      self.audioEngine.stop()
      self.writeHealth(state: "suspended", code: "sleep")
    }
  }

  func wake() {
    queue.async { [weak self] in
      guard let self, !self.stopped, self.suspended else { return }
      self.suspended = false
      self.beginRecovery(code: "wake")
    }
  }

  func stop() {
    queue.sync {
      guard !stopped else { return }
      stopped = true
      healthTimer?.cancel()
      healthTimer = nil
      recordGateDiscard(gate.markUnavailable().output)
      assembler.clear()
      activeAudioEngineGeneration = nil
      activeAudioEngineHasDeliveredCallback = false
      audioEngine.stop()
    }
  }

  private func handleAudio(_ snapshot: ResidentAudioBufferSnapshot) {
    guard !stopped, snapshot.engineGeneration == activeAudioEngineGeneration else { return }
    do {
      recordBufferCadence(snapshot.startHostSeconds)
      let sourceSamples = snapshot.monoSamples.map(pcm16Sample)
      let output = try gate.consume(
        bufferStartingAt: snapshot.startHostSeconds,
        sampleRate: snapshot.sampleRate,
        samples: sourceSamples
      )
      recordGateDiscard(output)
      try emit(output)
      activeAudioEngineHasDeliveredCallback = true
      if recovering {
        completeRecoveryAfterFirstCallback()
      }
      if !readySent {
        writeTiming(.engineStart, seconds: machHostSeconds() - engineStartBeganAt)
        readySent = true
        writer.write(
          .ready(
            ReadyMetadata(
              engineGeneration: engineGeneration,
              sampleRateHz: configuration.sampleRateHz,
              channels: configuration.channels)))
        writeHealth(state: "running", code: "engine_started")
        readySemaphore.signal()
      }
    } catch {
      if let gateError = error as? PttSampleGateError,
        [.invalidTimestamp, .timestampRegression, .timestampDiscontinuity].contains(gateError)
      {
        beginRecovery(code: "audio_timeline_discontinuity")
      } else {
        fatal(code: "audio_timeline_invalid", error: error)
      }
    }
  }

  private func processControlEvent(
    _ event: SemanticControlEvent,
    eventTimestampNanoseconds: UInt64
  ) {
    guard !stopped, !suspended, readySent, !recovering, gate.state != .unavailable else {
      return
    }
    if gate.state == .suppressed, event != .cancelPressed { return }
    let sequence = nextSequence
    nextSequence += 1
    let kind = residentIoKind(event)
    do {
      let hostSeconds = try clockMapper.audioHostSeconds(
        eventTimestampNanoseconds: eventTimestampNanoseconds,
        currentHostSeconds: machHostSeconds(),
        maximumSkewSeconds: Self.maximumControlEventSkewSeconds)
      switch event {
      case .talkPressed:
        if gate.state == .discarding {
          let output = try gate.observePress(sequence: sequence, hostSeconds: hostSeconds)
          recordGateDiscard(output)
          scheduleAdmissionTimeout(sequence: sequence)
        }
      case .talkReleased:
        if gateAcceptsRelease(gate.state) {
          try gate.observeRelease(hostSeconds: hostSeconds)
          pendingReleaseTimestamp = eventTimestampNanoseconds
          if let generation = activeGeneration(gate.state) {
            releaseTimestampByGeneration[generation] = eventTimestampNanoseconds
          }
        }
      case .cancelPressed:
        recordGateDiscard(gate.cancel())
        assembler.clear()
        pendingReleaseTimestamp = nil
        releaseTimestampByGeneration.removeAll(keepingCapacity: true)
        clearAllGenerationObservations()
      }
      try pendingControls.insert(sequence: sequence, kind: kind, hostSeconds: hostSeconds)
      writer.write(
        .controlEvent(
          ControlEventMetadata(
            sequence: sequence,
            kind: kind,
            eventTimestampNanoseconds: String(eventTimestampNanoseconds))))
    } catch PendingControlTrackerError.backlogExceeded {
      fatal(code: "control_backlog", error: ResidentIoRuntimeError.controlBacklog)
    } catch {
      fatal(code: "control_timeline_invalid", error: error)
    }
  }

  private func recordGateDiscard(_ output: PttGateOutput) {
    droppedFrameCount += UInt64(output.droppedFrameCount)
    outsidePttDroppedFrameCount += UInt64(output.outsidePttDroppedFrameCount)
    suppressedDroppedFrameCount += UInt64(output.suppressedDroppedFrameCount)
  }

  private func processCommand(_ message: ResidentIoMessage) {
    guard !stopped else { return }
    do {
      switch message {
      case .controlResult(let metadata):
        try applyControlResult(metadata)
      case .suppressCapture(let metadata):
        recordGateDiscard(gate.suppress())
        assembler.clear()
        pendingReleaseTimestamp = nil
        releaseTimestampByGeneration.removeAll(keepingCapacity: true)
        clearAllGenerationObservations()
        writer.write(.suppressCapture(metadata))
      case .resumeCapture(let metadata):
        gate.resume()
        resetPcmConversion()
        assembler.clear()
        writer.write(.resumeCapture(metadata))
      case .cancelGeneration(let metadata):
        if activeGeneration(gate.state) == metadata.generation {
          recordGateDiscard(gate.cancel())
          assembler.clear()
          releaseTimestampByGeneration[metadata.generation] = nil
          clearGenerationObservations(metadata.generation)
        }
      case .shutdown:
        stopped = true
        healthTimer?.cancel()
        audioEngine.stop()
        stopRunLoop()
      case .ready, .controlEvent, .pcmFrame, .tailComplete, .healthEvent, .fatal, .timingEvent:
        throw ResidentIoRuntimeError.unexpectedCommand(message.kind)
      }
    } catch {
      fatal(code: "protocol_command_invalid", error: error)
    }
  }

  private func applyControlResult(_ metadata: ControlResultMetadata) throws {
    guard let pending = pendingControls.remove(sequence: metadata.sequence) else {
      throw ResidentIoRuntimeError.unmatchedControlResult
    }
    switch pending.kind {
    case .cancelPressed:
      writeTiming(
        .cancelKeyToAdmission,
        seconds: machHostSeconds() - pending.hostSeconds,
        controlResult: metadata.result)
      return
    case .talkReleased:
      return
    case .talkPressed:
      writeTiming(
        .keyToAdmission,
        seconds: machHostSeconds() - pending.hostSeconds,
        controlResult: metadata.result)
    }
    guard case .pendingAdmission(let sequence, _, _) = gate.state, sequence == metadata.sequence
    else {
      if let generation = admissionTimeouts.invalidatedGeneration(
        sequence: metadata.sequence,
        result: metadata.result,
        generation: metadata.generation)
      {
        writer.write(.cancelGeneration(CancelGenerationMetadata(generation: generation)))
      }
      return
    }
    let admissionAt = machHostSeconds()
    let output = try gate.resolveAdmission(
      sequence: metadata.sequence,
      result: metadata.result,
      generation: metadata.generation
    )
    recordGateDiscard(output)
    if metadata.result == .accepted {
      writeTiming(
        .admissionToGate,
        seconds: machHostSeconds() - admissionAt,
        controlResult: metadata.result)
    }
    if metadata.result == .accepted, let generation = metadata.generation {
      pressHostSecondsByGeneration[generation] = pending.hostSeconds
    }
    if let generation = metadata.generation, let pendingReleaseTimestamp {
      releaseTimestampByGeneration[generation] = pendingReleaseTimestamp
      self.pendingReleaseTimestamp = nil
    }
    try emit(output)
  }

  private func emit(_ output: PttGateOutput) throws {
    for segment in output.segments {
      let start =
        segment.bufferStartHostSeconds
        + (Double(segment.sourceSampleIndex) / segment.sampleRate)
      if firstSampleObservedGenerations.insert(segment.generation).inserted,
        let pressedAt = pressHostSecondsByGeneration[segment.generation]
      {
        writeTiming(.gateToFirstSample, seconds: start - pressedAt)
      }
      if converterGeneration != segment.generation {
        resetPcmConversion()
        converterGeneration = segment.generation
        converterNextHostSeconds = start
      }
      let converted = try pcmConverter.convert(
        samples: segment.samples, sampleRate: segment.sampleRate)
      let convertedStart = converterNextHostSeconds ?? start
      let frames = try assembler.append(
        generation: segment.generation,
        samples: converted,
        startingAtHostSeconds: convertedStart,
        sampleRate: Double(configuration.sampleRateHz)
      )
      converterNextHostSeconds =
        convertedStart + (Double(converted.count) / Double(configuration.sampleRateHz))
      frames.forEach(writePcmFrame)
    }
    guard let generation = output.tailCompletedGeneration else { return }
    if converterGeneration == generation, let convertedStart = converterNextHostSeconds {
      let tailSamples = try pcmConverter.finish()
      if !tailSamples.isEmpty {
        let tailFrames = try assembler.append(
          generation: generation,
          samples: tailSamples,
          startingAtHostSeconds: convertedStart,
          sampleRate: Double(configuration.sampleRateHz))
        tailFrames.forEach(writePcmFrame)
      }
    }
    assembler.flush(generation: generation).forEach(writePcmFrame)
    let releaseTimestamp = releaseTimestampByGeneration.removeValue(forKey: generation) ?? 0
    if releaseTimestamp > 0 {
      writeTiming(
        .releaseToTailComplete,
        seconds: machHostSeconds()
          - clockMapper.audioHostSeconds(eventTimestampNanoseconds: releaseTimestamp))
    }
    writer.write(
      .tailComplete(
        TailCompleteMetadata(
          generation: generation,
          releaseEventTimestampNanoseconds: String(releaseTimestamp))))
    clearGenerationObservations(generation)
    resetPcmConversion()
  }

  private func writePcmFrame(_ frame: AssembledPcmFrame) {
    if firstDispatchObservedGenerations.insert(frame.generation).inserted {
      writeTiming(.firstSampleToDispatch, seconds: machHostSeconds() - frame.startHostSeconds)
    }
    writer.write(
      .pcmFrame(
        PcmFrameMetadata(
          generation: frame.generation,
          sampleHostTimeNanoseconds: String(UInt64(frame.startHostSeconds * 1_000_000_000)),
          sampleRateHz: UInt32(frame.sampleRate),
          channels: configuration.channels,
          frameCount: UInt32(frame.samples.count)
        ),
        pcm16leData(frame.samples)
      ))
  }

  private func recordDroppedBuffer(engineGeneration: UInt64, count: UInt32) {
    guard engineGeneration == activeAudioEngineGeneration else { return }
    droppedFrameCount += UInt64(count)
    switch gate.state {
    case .pendingAdmission, .accepting, .tailing:
      beginRecovery(code: "audio_callback_overrun")
    case .discarding, .suppressed, .unavailable:
      break
    }
  }

  private func reportAudioFailure(engineGeneration: UInt64, error: Error) {
    guard engineGeneration == activeAudioEngineGeneration else { return }
    fatal(code: "audio_callback_failed", error: error)
  }

  private func handleConfigurationChange(engineGeneration: UInt64) {
    guard engineGeneration == activeAudioEngineGeneration else { return }
    switch configurationChangeGate.action(
      hasDeliveredFirstCallback: activeAudioEngineHasDeliveredCallback,
      isEngineRunning: audioEngine.isRunning
    ) {
    case .ignoreStartupNotification:
      return
    case .invalidateStartingGeneration:
      if recovering {
        activeAudioEngineGeneration = nil
        activeAudioEngineHasDeliveredCallback = false
        audioEngine.stop()
      } else {
        fatal(
          code: "configuration_changed_during_startup",
          error: ResidentIoRuntimeError.startupConfigurationChanged)
      }
    case .recover:
      beginRecovery(engineGeneration: engineGeneration, code: "configuration_changed")
    }
  }

  private func beginRecovery(engineGeneration: UInt64? = nil, code: String) {
    if let engineGeneration, engineGeneration != activeAudioEngineGeneration { return }
    guard !stopped, !suspended, !recovering else { return }
    recovering = true
    recoveryAttempt = 0
    recoveryCycle += 1
    do {
      try invalidateCapture()
    } catch {
      fatal(code: "admission_invalidation_backlog", error: error)
      return
    }
    assembler.clear()
    clearAllGenerationObservations()
    activeAudioEngineGeneration = nil
    activeAudioEngineHasDeliveredCallback = false
    audioEngine.stop()
    writeHealth(state: "recovering", code: code)
    attemptRecovery()
  }

  private func attemptRecovery() {
    guard recovering else { return }
    recoveryAttempt += 1
    let cycle = recoveryCycle
    do {
      let deviceID = try CoreAudioDeviceCatalog.resolveInputDevice(uid: configuration.deviceUID)
      resetPcmConversion()
      engineStartBeganAt = machHostSeconds()
      configurationChangeGate.reset()
      activeAudioEngineHasDeliveredCallback = false
      activeAudioEngineGeneration = try audioEngine.start(deviceID: deviceID)
      let attempt = recoveryAttempt
      queue.asyncAfter(deadline: .now() + .seconds(1)) { [weak self] in
        guard let self, self.recovering, self.recoveryCycle == cycle,
          self.recoveryAttempt == attempt
        else { return }
        self.activeAudioEngineGeneration = nil
        self.activeAudioEngineHasDeliveredCallback = false
        self.audioEngine.stop()
        if attempt >= 3 {
          self.fatal(
            code: "recovery_exhausted", error: ResidentIoRuntimeError.recoveryCallbackTimedOut)
          return
        }
        self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
          guard self?.recoveryCycle == cycle else { return }
          self?.attemptRecovery()
        }
      }
    } catch {
      if recoveryAttempt >= 3 {
        fatal(code: "recovery_exhausted", error: error)
        return
      }
      queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
        guard self?.recoveryCycle == cycle else { return }
        self?.attemptRecovery()
      }
    }
  }

  private func completeRecoveryAfterFirstCallback() {
    recovering = false
    gate.restoreAvailability()
    writeTiming(.engineRestart, seconds: machHostSeconds() - engineStartBeganAt)
    engineGeneration += 1
    restartCount += 1
    writeHealth(state: "running", code: "engine_restarted")
  }

  private func startHealthTimer() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
    timer.setEventHandler { [weak self] in
      guard let self, !self.stopped, !self.suspended, !self.recovering else { return }
      guard self.audioEngine.isRunning else {
        self.beginRecovery(code: "engine_stopped")
        return
      }
      self.writeHealthSample()
    }
    timer.resume()
    healthTimer = timer
  }

  private func scheduleAdmissionTimeout(sequence: UInt64) {
    queue.asyncAfter(
      deadline: .now() + .milliseconds(AdmissionTimeoutTracker.timeoutMilliseconds)
    ) { [weak self] in
      guard let self,
        case .pendingAdmission(let pendingSequence, _, _) = self.gate.state,
        pendingSequence == sequence
      else { return }
      do {
        let output = try self.gate.resolveAdmission(
          sequence: sequence, result: .ignoredStale, generation: nil)
        self.recordGateDiscard(output)
        do {
          try self.admissionTimeouts.expire(sequence: sequence)
        } catch AdmissionTimeoutTrackerError.backlogExceeded {
          self.fatal(
            code: "admission_timeout_backlog",
            error: ResidentIoRuntimeError.admissionTimeoutBacklog)
          return
        }
        self.pendingReleaseTimestamp = nil
        self.writeHealth(state: "running", code: "admission_timeout")
      } catch {
        self.fatal(code: "admission_timeout_failed", error: error)
      }
    }
  }

  private func fatal(code: String, error: Error) {
    guard !stopped else { return }
    if !readySent {
      startupFailure = error
    }
    stopped = true
    healthTimer?.cancel()
    healthTimer = nil
    recordGateDiscard(gate.markUnavailable().output)
    assembler.clear()
    audioEngine.stop()
    FileHandle.standardError.write(Data("pico macOS resident I/O: \(error)\n".utf8))
    writer.write(.fatal(FatalMetadata(code: code)))
    readySemaphore.signal()
    stopRunLoop()
  }

  private func writeTiming(
    _ stage: ResidentIoTimingStage,
    seconds: Double,
    controlResult: ResidentIoControlResult? = nil
  ) {
    guard seconds.isFinite, seconds >= 0 else { return }
    writer.write(
      .timingEvent(
        TimingEventMetadata(
          stage: stage,
          durationMs: seconds * 1_000,
          controlResult: controlResult)))
  }

  private func recordBufferCadence(_ startHostSeconds: Double) {
    if let previousBufferStartHostSeconds {
      let cadence = startHostSeconds - previousBufferStartHostSeconds
      if cadence.isFinite, cadence >= 0 {
        bufferCadenceTotalSeconds += cadence
        bufferCadenceSamples += 1
      }
    }
    previousBufferStartHostSeconds = startHostSeconds
  }

  private func writeHealthSample() {
    let cadenceMs =
      bufferCadenceSamples == 0
      ? 0 : (bufferCadenceTotalSeconds / Double(bufferCadenceSamples)) * 1_000
    writeHealth(state: "running", code: "health_sample", bufferCadenceMs: cadenceMs)
    bufferCadenceTotalSeconds = 0
    bufferCadenceSamples = 0
  }

  private func writeHealth(state: String, code: String, bufferCadenceMs: Double = 0) {
    writer.write(
      .healthEvent(
        HealthEventMetadata(
          state: state,
          code: code,
          restartCount: restartCount,
          droppedFrameCount: droppedFrameCount,
          bufferCadenceMs: bufferCadenceMs,
          outsidePttDroppedFrameCount: outsidePttDroppedFrameCount,
          suppressedDroppedFrameCount: suppressedDroppedFrameCount)))
  }

  private func clearGenerationObservations(_ generation: UInt64) {
    pressHostSecondsByGeneration[generation] = nil
    firstSampleObservedGenerations.remove(generation)
    firstDispatchObservedGenerations.remove(generation)
  }

  private func clearAllGenerationObservations() {
    pressHostSecondsByGeneration.removeAll(keepingCapacity: true)
    firstSampleObservedGenerations.removeAll(keepingCapacity: true)
    firstDispatchObservedGenerations.removeAll(keepingCapacity: true)
  }

  private func resetPcmConversion() {
    pcmConverter.reset()
    converterGeneration = nil
    converterNextHostSeconds = nil
  }

  private func invalidateCapture() throws {
    let transition = gate.markUnavailable()
    recordGateDiscard(transition.output)
    switch transition.invalidation {
    case .pendingAdmission(let sequence):
      try admissionTimeouts.expire(sequence: sequence)
    case .activeGeneration(let generation):
      writer.write(.cancelGeneration(CancelGenerationMetadata(generation: generation)))
    case nil:
      break
    }
  }
}

private final class ResidentIoWriter: @unchecked Sendable {
  private let lock = NSLock()

  func write(_ message: ResidentIoMessage) {
    do {
      let data = try ResidentIoCodec.encode(message)
      lock.lock()
      defer { lock.unlock() }
      try FileHandle.standardOutput.write(contentsOf: data)
    } catch {
      FileHandle.standardError.write(Data("pico resident I/O write failed: \(error)\n".utf8))
    }
  }
}

enum ResidentIoRuntimeError: Error, LocalizedError {
  case firstAudioCallbackTimedOut
  case startupConfigurationChanged
  case eventTapDisabled
  case recoveryCallbackTimedOut
  case protocolEof
  case admissionTimeoutBacklog
  case controlBacklog
  case unmatchedControlResult
  case unexpectedCommand(ResidentIoMessageKind)

  var errorDescription: String? {
    switch self {
    case .firstAudioCallbackTimedOut:
      "AVAudioEngine did not deliver its first input callback before timeout"
    case .startupConfigurationChanged:
      "AVAudioEngine configuration changed before its first input callback"
    case .eventTapDisabled:
      "Core Graphics disabled the resident I/O event tap"
    case .recoveryCallbackTimedOut:
      "AVAudioEngine recovery did not deliver an input callback before timeout"
    case .protocolEof:
      "Node closed the resident I/O command stream"
    case .admissionTimeoutBacklog:
      "Node did not converge bounded resident I/O admission timeouts"
    case .controlBacklog:
      "Node did not converge bounded resident I/O control events"
    case .unmatchedControlResult:
      "Node returned a control result with no pending event"
    case .unexpectedCommand(let kind):
      "Node sent unexpected resident I/O command \(kind)"
    }
  }
}

private func residentIoKind(_ event: SemanticControlEvent) -> ResidentIoControlKind {
  switch event {
  case .talkPressed: .talkPressed
  case .talkReleased: .talkReleased
  case .cancelPressed: .cancelPressed
  }
}

private func gateAcceptsRelease(_ state: PttGateState) -> Bool {
  switch state {
  case .pendingAdmission, .accepting, .tailing:
    true
  default:
    false
  }
}

private func activeGeneration(_ state: PttGateState) -> UInt64? {
  switch state {
  case .accepting(let generation, _), .tailing(let generation, _):
    generation
  default:
    nil
  }
}

private func pcm16leData(_ samples: [Int16]) -> Data {
  var data = Data(capacity: samples.count * 2)
  for sample in samples {
    let value = UInt16(bitPattern: sample)
    data.append(UInt8(value & 0xFF))
    data.append(UInt8((value >> 8) & 0xFF))
  }
  return data
}

private func pcm16Sample(_ sample: Float) -> Int16 {
  let clamped = min(1, max(-1, sample))
  if clamped >= 0 {
    return Int16(min(Float(Int16.max), (clamped * Float(Int16.max)).rounded()))
  }
  return Int16(max(Float(Int16.min), (clamped * -Float(Int16.min)).rounded()))
}

private func machHostSeconds() -> Double {
  var information = mach_timebase_info_data_t()
  mach_timebase_info(&information)
  return Double(mach_absolute_time()) * Double(information.numer) / Double(information.denom)
    / 1_000_000_000
}
