import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident audio configuration change gate")
struct AudioConfigurationChangeGateTests {
  @Test("ignores only one running startup notification")
  func ignoresOnlyOneRunningStartupNotification() {
    var gate = AudioConfigurationChangeGate()

    #expect(
      gate.action(hasDeliveredFirstCallback: false, isEngineRunning: true)
        == .ignoreStartupNotification)
    #expect(
      gate.action(hasDeliveredFirstCallback: false, isEngineRunning: true)
        == .invalidateStartingGeneration)
  }

  @Test("invalidates a starting generation when configuration change stopped the engine")
  func invalidatesStoppedStartingGeneration() {
    var gate = AudioConfigurationChangeGate()

    #expect(
      gate.action(hasDeliveredFirstCallback: false, isEngineRunning: false)
        == .invalidateStartingGeneration)
  }

  @Test("recovers every configuration change after the current generation first callback")
  func recoversAfterCurrentGenerationFirstCallback() {
    var gate = AudioConfigurationChangeGate()

    #expect(gate.action(hasDeliveredFirstCallback: true, isEngineRunning: true) == .recover)
    #expect(gate.action(hasDeliveredFirstCallback: true, isEngineRunning: false) == .recover)
  }

  @Test("reset permits one startup self-notification for a new engine generation")
  func resetsForNewGeneration() {
    var gate = AudioConfigurationChangeGate()
    _ = gate.action(hasDeliveredFirstCallback: false, isEngineRunning: true)
    gate.reset()

    #expect(
      gate.action(hasDeliveredFirstCallback: false, isEngineRunning: true)
        == .ignoreStartupNotification)
  }
}
