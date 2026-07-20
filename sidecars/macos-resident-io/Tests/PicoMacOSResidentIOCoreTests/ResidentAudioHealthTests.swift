import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident audio health state")
struct ResidentAudioHealthTests {
  @Test("configuration change invalidates the active turn before rebuilding")
  func configurationChangeInvalidatesTurn() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 4, maximumRecoveryAttempts: 3)

    let effects = try health.handle(.configurationChanged(activeGeneration: 9))

    guard case .recovering(_, attempt: 1) = health.state else {
      Issue.record("expected first recovery attempt")
      return
    }
    #expect(
      effects == [
        .failTurn(9, .configurationChanged),
        .clearGate,
        .emit(.recovering, .configurationChanged),
        .rebuildEngine,
      ])
  }

  @Test("sleep suspends and wake starts same-device recovery")
  func handlesSleepAndWake() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 1, maximumRecoveryAttempts: 2)

    #expect(
      try health.handle(.willSleep(activeGeneration: nil)) == [
        .clearGate, .stopEngine, .emit(.suspended, .sleep),
      ])
    #expect(health.state == .suspended)
    #expect(
      try health.handle(.didWake) == [
        .emit(.recovering, .wake), .rebuildEngine,
      ])
    guard case .recovering(_, attempt: 1) = health.state else {
      Issue.record("expected wake recovery")
      return
    }
  }

  @Test("sleep invalidates an in-flight recovery before wake starts a new cycle")
  func sleepDuringRecoveryStartsFreshCycle() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 1, maximumRecoveryAttempts: 3)
    _ = try health.handle(.configurationChanged(activeGeneration: nil))
    guard case .recovering(let firstCycle, _) = health.state else {
      Issue.record("expected the first recovery cycle")
      return
    }

    _ = try health.handle(.willSleep(activeGeneration: nil))
    #expect(!health.acceptsControls)
    _ = try health.handle(.didWake)
    guard case .recovering(let wakeCycle, let attempt) = health.state else {
      Issue.record("expected wake recovery")
      return
    }

    #expect(wakeCycle != firstCycle)
    #expect(attempt == 1)
    #expect(!health.acceptsControls)
  }

  @Test("device removal never selects a fallback device")
  func handlesDeviceRemoval() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 2, maximumRecoveryAttempts: 2)

    #expect(
      try health.handle(.configuredDeviceMissing(activeGeneration: 8)) == [
        .failTurn(8, .deviceMissing),
        .clearGate,
        .stopEngine,
        .emit(.unavailable, .deviceMissing),
      ])
    #expect(health.state == .unavailable)
    #expect(
      try health.handle(.configuredDeviceAvailable) == [
        .emit(.recovering, .deviceAvailable), .rebuildEngine,
      ])
  }

  @Test("bounded recovery terminates instead of hiding a fallback")
  func boundsRecovery() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 3, maximumRecoveryAttempts: 2)
    _ = try health.handle(.engineStopped(activeGeneration: nil))
    #expect(
      try health.handle(.recoveryFailed) == [
        .emit(.recovering, .recoveryFailed), .rebuildEngine,
      ])
    guard case .recovering(_, attempt: 2) = health.state else {
      Issue.record("expected second recovery attempt")
      return
    }
    #expect(
      try health.handle(.recoveryFailed) == [
        .emit(.unavailable, .recoveryExhausted), .terminate(.recoveryExhausted),
      ])
    #expect(health.state == .unavailable)
  }

  @Test("successful recovery advances the engine generation")
  func completesRecovery() throws {
    var health = ResidentAudioHealth.running(engineGeneration: 3, maximumRecoveryAttempts: 2)
    _ = try health.handle(.engineStopped(activeGeneration: nil))

    #expect(
      try health.handle(.recoverySucceeded(engineGeneration: 4)) == [
        .emit(.running, .engineRestarted)
      ])
    #expect(health.state == .running(engineGeneration: 4))
  }
}
