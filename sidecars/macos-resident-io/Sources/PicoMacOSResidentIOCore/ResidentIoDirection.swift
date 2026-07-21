import Foundation

public enum ResidentIoDirectionError: Error, Equatable, Sendable {
  case invalidNodeCommand(ResidentIoMessageKind)
  case invalidSidecarEvent(ResidentIoMessageKind)
}

public func validateNodeCommand(_ message: ResidentIoMessage) throws {
  switch message {
  case .controlResult, .suppressCapture, .resumeCapture, .cancelGeneration, .shutdown:
    return
  case .ready, .controlEvent, .pcmFrame, .tailComplete, .healthEvent, .fatal, .timingEvent:
    throw ResidentIoDirectionError.invalidNodeCommand(message.kind)
  }
}

public func validateSidecarEvent(_ message: ResidentIoMessage) throws {
  switch message {
  case .ready, .controlEvent, .pcmFrame, .tailComplete, .healthEvent, .fatal, .timingEvent,
    .suppressCapture, .resumeCapture, .cancelGeneration:
    return
  case .controlResult, .shutdown:
    throw ResidentIoDirectionError.invalidSidecarEvent(message.kind)
  }
}
