import Foundation

public enum ResidentIoMessageKind: UInt8, Codable, CaseIterable, Sendable {
  case ready = 1
  case controlEvent = 2
  case controlResult = 3
  case pcmFrame = 4
  case tailComplete = 5
  case suppressCapture = 6
  case resumeCapture = 7
  case cancelGeneration = 8
  case healthEvent = 9
  case fatal = 10
  case shutdown = 11
  case timingEvent = 12
}

public enum ResidentIoControlKind: String, Codable, Sendable {
  case talkPressed = "talk_pressed"
  case talkReleased = "talk_released"
  case cancelPressed = "cancel_pressed"
}

public enum ResidentIoControlResult: String, Codable, Sendable {
  case accepted
  case ignoredBusy = "ignored_busy"
  case ignoredStale = "ignored_stale"
  case noop
}

public struct ReadyMetadata: Codable, Equatable, Sendable {
  public let engineGeneration: UInt64
  public let sampleRateHz: UInt32
  public let channels: UInt32

  public init(engineGeneration: UInt64, sampleRateHz: UInt32, channels: UInt32) {
    self.engineGeneration = engineGeneration
    self.sampleRateHz = sampleRateHz
    self.channels = channels
  }
}

public struct ControlEventMetadata: Codable, Equatable, Sendable {
  public let sequence: UInt64
  public let kind: ResidentIoControlKind
  public let eventTimestampNanoseconds: String

  public init(sequence: UInt64, kind: ResidentIoControlKind, eventTimestampNanoseconds: String) {
    self.sequence = sequence
    self.kind = kind
    self.eventTimestampNanoseconds = eventTimestampNanoseconds
  }
}

public struct ControlResultMetadata: Codable, Equatable, Sendable {
  public let sequence: UInt64
  public let result: ResidentIoControlResult
  public let generation: UInt64?

  public init(sequence: UInt64, result: ResidentIoControlResult, generation: UInt64?) {
    self.sequence = sequence
    self.result = result
    self.generation = generation
  }
}

public struct PcmFrameMetadata: Codable, Equatable, Sendable {
  public let generation: UInt64
  public let sampleHostTimeNanoseconds: String
  public let sampleRateHz: UInt32
  public let channels: UInt32
  public let frameCount: UInt32

  public init(
    generation: UInt64,
    sampleHostTimeNanoseconds: String,
    sampleRateHz: UInt32,
    channels: UInt32,
    frameCount: UInt32
  ) {
    self.generation = generation
    self.sampleHostTimeNanoseconds = sampleHostTimeNanoseconds
    self.sampleRateHz = sampleRateHz
    self.channels = channels
    self.frameCount = frameCount
  }
}

public struct TailCompleteMetadata: Codable, Equatable, Sendable {
  public let generation: UInt64
  public let releaseEventTimestampNanoseconds: String

  public init(generation: UInt64, releaseEventTimestampNanoseconds: String) {
    self.generation = generation
    self.releaseEventTimestampNanoseconds = releaseEventTimestampNanoseconds
  }
}

public struct CaptureBoundaryMetadata: Codable, Equatable, Sendable {
  public let commandID: UInt64

  private enum CodingKeys: String, CodingKey {
    case commandID = "commandId"
  }

  public init(commandID: UInt64) {
    self.commandID = commandID
  }
}

public struct CancelGenerationMetadata: Codable, Equatable, Sendable {
  public let generation: UInt64

  public init(generation: UInt64) {
    self.generation = generation
  }
}

public struct HealthEventMetadata: Codable, Equatable, Sendable {
  public let state: String
  public let code: String
  public let restartCount: UInt32
  public let droppedFrameCount: UInt64
  public let bufferCadenceMs: Double
  public let outsidePttDroppedFrameCount: UInt64
  public let suppressedDroppedFrameCount: UInt64

  public init(
    state: String,
    code: String,
    restartCount: UInt32,
    droppedFrameCount: UInt64,
    bufferCadenceMs: Double = 0,
    outsidePttDroppedFrameCount: UInt64 = 0,
    suppressedDroppedFrameCount: UInt64 = 0
  ) {
    self.state = state
    self.code = code
    self.restartCount = restartCount
    self.droppedFrameCount = droppedFrameCount
    self.bufferCadenceMs = bufferCadenceMs
    self.outsidePttDroppedFrameCount = outsidePttDroppedFrameCount
    self.suppressedDroppedFrameCount = suppressedDroppedFrameCount
  }
}

public struct FatalMetadata: Codable, Equatable, Sendable {
  public let code: String

  public init(code: String) {
    self.code = code
  }
}

public enum ResidentIoTimingStage: String, Codable, Sendable {
  case keyToAdmission = "key_to_admission"
  case cancelKeyToAdmission = "cancel_key_to_admission"
  case admissionToGate = "admission_to_gate"
  case gateToFirstSample = "gate_to_first_sample"
  case firstSampleToDispatch = "first_sample_to_dispatch"
  case releaseToTailComplete = "release_to_tail_complete"
  case engineStart = "engine_start"
  case engineRestart = "engine_restart"
}

public struct TimingEventMetadata: Codable, Equatable, Sendable {
  public let stage: ResidentIoTimingStage
  public let durationMs: Double
  public let controlResult: ResidentIoControlResult?

  public init(
    stage: ResidentIoTimingStage,
    durationMs: Double,
    controlResult: ResidentIoControlResult? = nil
  ) {
    self.stage = stage
    self.durationMs = durationMs
    self.controlResult = controlResult
  }
}

public enum ResidentIoMessage: Equatable, Sendable {
  case ready(ReadyMetadata)
  case controlEvent(ControlEventMetadata)
  case controlResult(ControlResultMetadata)
  case pcmFrame(PcmFrameMetadata, Data)
  case tailComplete(TailCompleteMetadata)
  case suppressCapture(CaptureBoundaryMetadata)
  case resumeCapture(CaptureBoundaryMetadata)
  case cancelGeneration(CancelGenerationMetadata)
  case healthEvent(HealthEventMetadata)
  case fatal(FatalMetadata)
  case shutdown
  case timingEvent(TimingEventMetadata)

  public var kind: ResidentIoMessageKind {
    switch self {
    case .ready: .ready
    case .controlEvent: .controlEvent
    case .controlResult: .controlResult
    case .pcmFrame: .pcmFrame
    case .tailComplete: .tailComplete
    case .suppressCapture: .suppressCapture
    case .resumeCapture: .resumeCapture
    case .cancelGeneration: .cancelGeneration
    case .healthEvent: .healthEvent
    case .fatal: .fatal
    case .shutdown: .shutdown
    case .timingEvent: .timingEvent
    }
  }
}
