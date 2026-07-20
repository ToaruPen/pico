@preconcurrency import AVFAudio
import AVFoundation
import CoreAudio
import Foundation

struct ResidentAudioBufferSnapshot: Sendable {
  let engineGeneration: UInt64
  let startHostSeconds: Double
  let sampleRate: Double
  let monoSamples: [Float]
}

enum ResidentAudioEngineError: Error, LocalizedError {
  case microphonePermissionDenied
  case inputFormatUnavailable
  case invalidAudioTimestamp
  case unsupportedAudioBuffer
  case coreAudio(operation: String, status: OSStatus)

  var errorDescription: String? {
    switch self {
    case .microphonePermissionDenied:
      "Microphone permission is required for pico-macos-resident-io"
    case .inputFormatUnavailable:
      "configured Core Audio device has no usable input format"
    case .invalidAudioTimestamp:
      "AVAudioEngine input callback has no valid host timestamp"
    case .unsupportedAudioBuffer:
      "AVAudioEngine input callback did not provide Float32 channel data"
    case .coreAudio(let operation, let status):
      "\(operation) failed with Core Audio status \(status)"
    }
  }
}

final class ResidentAudioEngine: @unchecked Sendable {
  private let ownerQueue: DispatchQueue
  private let availableBufferSlots = DispatchSemaphore(value: 4)
  private let onBuffer: @Sendable (ResidentAudioBufferSnapshot) -> Void
  private let onDroppedBuffer: @Sendable (UInt64, UInt32) -> Void
  private let onConfigurationChange: @Sendable (UInt64) -> Void
  private let onFailure: @Sendable (UInt64, Error) -> Void
  private var engine: AVAudioEngine?
  private var configurationObserver: NSObjectProtocol?
  private var nextGeneration: UInt64 = 1

  init(
    ownerQueue: DispatchQueue,
    onBuffer: @escaping @Sendable (ResidentAudioBufferSnapshot) -> Void,
    onDroppedBuffer: @escaping @Sendable (UInt64, UInt32) -> Void,
    onConfigurationChange: @escaping @Sendable (UInt64) -> Void,
    onFailure: @escaping @Sendable (UInt64, Error) -> Void
  ) {
    self.ownerQueue = ownerQueue
    self.onBuffer = onBuffer
    self.onDroppedBuffer = onDroppedBuffer
    self.onConfigurationChange = onConfigurationChange
    self.onFailure = onFailure
  }

  var isRunning: Bool { engine?.isRunning == true }

  func start(deviceID: AudioDeviceID) throws -> UInt64 {
    try requireMicrophonePermission()
    let engine = AVAudioEngine()
    let generation = nextGeneration
    nextGeneration += 1
    engine.isAutoShutdownEnabled = false
    let input = engine.inputNode
    try input.auAudioUnit.setDeviceID(deviceID)
    let format = input.inputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw ResidentAudioEngineError.inputFormatUnavailable
    }
    input.installTap(onBus: 0, bufferSize: 4_096, format: nil) { [weak self] buffer, time in
      self?.capture(buffer: buffer, time: time, generation: generation)
    }
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      let callback = self.onConfigurationChange
      self.ownerQueue.async { callback(generation) }
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
    return generation
  }

  func stop() {
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
      self.configurationObserver = nil
    }
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
  }

  private func capture(buffer: AVAudioPCMBuffer, time: AVAudioTime, generation: UInt64) {
    guard availableBufferSlots.wait(timeout: .now()) == .success else {
      let frameLength = buffer.frameLength
      ownerQueue.async { [onDroppedBuffer] in onDroppedBuffer(generation, frameLength) }
      return
    }
    do {
      let snapshot = try copySnapshot(buffer: buffer, time: time, generation: generation)
      ownerQueue.async { [weak self] in
        guard let self else { return }
        self.onBuffer(snapshot)
        self.availableBufferSlots.signal()
      }
    } catch {
      availableBufferSlots.signal()
      ownerQueue.async { [onFailure] in onFailure(generation, error) }
    }
  }

  private func copySnapshot(
    buffer: AVAudioPCMBuffer,
    time: AVAudioTime,
    generation: UInt64
  ) throws
    -> ResidentAudioBufferSnapshot
  {
    guard time.isHostTimeValid else { throw ResidentAudioEngineError.invalidAudioTimestamp }
    guard let channelData = buffer.floatChannelData else {
      throw ResidentAudioEngineError.unsupportedAudioBuffer
    }
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    var mono = [Float](repeating: 0, count: frames)
    for channel in 0..<channels {
      let values = channelData[channel]
      for frame in 0..<frames {
        mono[frame] += values[frame] / Float(channels)
      }
    }
    return ResidentAudioBufferSnapshot(
      engineGeneration: generation,
      startHostSeconds: AVAudioTime.seconds(forHostTime: time.hostTime),
      sampleRate: buffer.format.sampleRate,
      monoSamples: mono
    )
  }
}

private func requireMicrophonePermission() throws {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return
  case .notDetermined:
    let semaphore = DispatchSemaphore(value: 0)
    let result = PermissionResult()
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      result.store(granted)
      semaphore.signal()
    }
    semaphore.wait()
    guard result.load() else { throw ResidentAudioEngineError.microphonePermissionDenied }
  case .denied, .restricted:
    throw ResidentAudioEngineError.microphonePermissionDenied
  @unknown default:
    throw ResidentAudioEngineError.microphonePermissionDenied
  }
}

private final class PermissionResult: @unchecked Sendable {
  private let lock = NSLock()
  private var granted = false

  func store(_ value: Bool) {
    lock.withLock { granted = value }
  }

  func load() -> Bool {
    lock.withLock { granted }
  }
}

extension NSLock {
  fileprivate func withLock<T>(_ operation: () -> T) -> T {
    lock()
    defer { unlock() }
    return operation()
  }
}
