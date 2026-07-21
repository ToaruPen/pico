import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident I/O message direction")
struct ResidentIoDirectionTests {
  @Test("accepts only commands owned by Node")
  func acceptsNodeCommands() throws {
    try validateNodeCommand(
      .controlResult(ControlResultMetadata(sequence: 1, result: .accepted, generation: 2)))
    try validateNodeCommand(.suppressCapture(CaptureBoundaryMetadata(commandID: 3)))
    try validateNodeCommand(.resumeCapture(CaptureBoundaryMetadata(commandID: 4)))
    try validateNodeCommand(.cancelGeneration(CancelGenerationMetadata(generation: 2)))
    try validateNodeCommand(.shutdown)
  }

  @Test("rejects sidecar events sent in the Node command direction")
  func rejectsInvalidNodeCommands() {
    #expect(throws: ResidentIoDirectionError.invalidNodeCommand(.ready)) {
      try validateNodeCommand(
        .ready(ReadyMetadata(engineGeneration: 1, sampleRateHz: 16_000, channels: 1)))
    }
  }

  @Test("permits only boundary acknowledgements in both directions")
  func permitsBoundaryAcknowledgements() throws {
    try validateSidecarEvent(.suppressCapture(CaptureBoundaryMetadata(commandID: 1)))
    try validateSidecarEvent(.resumeCapture(CaptureBoundaryMetadata(commandID: 2)))
    #expect(throws: ResidentIoDirectionError.invalidSidecarEvent(.shutdown)) {
      try validateSidecarEvent(.shutdown)
    }
  }
}
