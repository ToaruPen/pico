import Foundation

public enum ResidentAudioHealthState: Equatable, Sendable {
  case starting
  case running(engineGeneration: UInt64)
  case recovering(cycle: UInt64, attempt: Int)
  case suspended
  case unavailable
  case stopped
}

public enum ResidentAudioHealthStatus: String, Equatable, Sendable {
  case starting
  case running
  case recovering
  case suspended
  case unavailable
  case stopped
}

public enum ResidentAudioHealthCode: String, Equatable, Sendable {
  case configurationChanged = "configuration_changed"
  case engineStopped = "engine_stopped"
  case engineRestarted = "engine_restarted"
  case sleep
  case wake
  case deviceMissing = "device_missing"
  case deviceAvailable = "device_available"
  case recoveryFailed = "recovery_failed"
  case recoveryExhausted = "recovery_exhausted"
  case shutdown
}

public enum ResidentAudioHealthEvent: Equatable, Sendable {
  case configurationChanged(activeGeneration: UInt64?)
  case engineStopped(activeGeneration: UInt64?)
  case willSleep(activeGeneration: UInt64?)
  case didWake
  case configuredDeviceMissing(activeGeneration: UInt64?)
  case configuredDeviceAvailable
  case recoverySucceeded(engineGeneration: UInt64)
  case recoveryFailed
  case shutdown
}

public enum ResidentAudioHealthEffect: Equatable, Sendable {
  case failTurn(UInt64, ResidentAudioHealthCode)
  case clearGate
  case stopEngine
  case rebuildEngine
  case emit(ResidentAudioHealthStatus, ResidentAudioHealthCode)
  case terminate(ResidentAudioHealthCode)
}

public enum ResidentAudioHealthError: Error, Equatable, Sendable {
  case invalidMaximumRecoveryAttempts
  case invalidTransition
}

public struct ResidentAudioHealth: Equatable, Sendable {
  public private(set) var state: ResidentAudioHealthState
  private let maximumRecoveryAttempts: Int
  private var nextRecoveryCycle: UInt64 = 1

  public var acceptsControls: Bool {
    if case .running = state { return true }
    return false
  }

  public static func running(engineGeneration: UInt64, maximumRecoveryAttempts: Int)
    -> ResidentAudioHealth
  {
    ResidentAudioHealth(
      state: .running(engineGeneration: engineGeneration),
      maximumRecoveryAttempts: maximumRecoveryAttempts
    )
  }

  public mutating func handle(_ event: ResidentAudioHealthEvent) throws
    -> [ResidentAudioHealthEffect]
  {
    guard maximumRecoveryAttempts > 0 else {
      throw ResidentAudioHealthError.invalidMaximumRecoveryAttempts
    }
    switch event {
    case .configurationChanged(let activeGeneration):
      return try beginRecovery(code: .configurationChanged, activeGeneration: activeGeneration)
    case .engineStopped(let activeGeneration):
      return try beginRecovery(code: .engineStopped, activeGeneration: activeGeneration)
    case .willSleep(let activeGeneration):
      guard isOperational else { throw ResidentAudioHealthError.invalidTransition }
      nextRecoveryCycle += 1
      state = .suspended
      return failTurnEffect(activeGeneration, code: .sleep)
        + [.clearGate, .stopEngine, .emit(.suspended, .sleep)]
    case .didWake:
      guard state == .suspended else { throw ResidentAudioHealthError.invalidTransition }
      state = beginRecoveryCycle()
      return [.emit(.recovering, .wake), .rebuildEngine]
    case .configuredDeviceMissing(let activeGeneration):
      guard isOperational else { throw ResidentAudioHealthError.invalidTransition }
      state = .unavailable
      return failTurnEffect(activeGeneration, code: .deviceMissing)
        + [.clearGate, .stopEngine, .emit(.unavailable, .deviceMissing)]
    case .configuredDeviceAvailable:
      guard state == .unavailable else { throw ResidentAudioHealthError.invalidTransition }
      state = beginRecoveryCycle()
      return [.emit(.recovering, .deviceAvailable), .rebuildEngine]
    case .recoverySucceeded(let engineGeneration):
      guard case .recovering = state else { throw ResidentAudioHealthError.invalidTransition }
      state = .running(engineGeneration: engineGeneration)
      return [.emit(.running, .engineRestarted)]
    case .recoveryFailed:
      guard case .recovering(let cycle, let attempt) = state else {
        throw ResidentAudioHealthError.invalidTransition
      }
      if attempt >= maximumRecoveryAttempts {
        state = .unavailable
        return [
          .emit(.unavailable, .recoveryExhausted),
          .terminate(.recoveryExhausted),
        ]
      }
      state = .recovering(cycle: cycle, attempt: attempt + 1)
      return [.emit(.recovering, .recoveryFailed), .rebuildEngine]
    case .shutdown:
      state = .stopped
      return [.clearGate, .stopEngine, .emit(.stopped, .shutdown)]
    }
  }

  private var isOperational: Bool {
    switch state {
    case .running, .recovering:
      true
    default:
      false
    }
  }

  private mutating func beginRecovery(
    code: ResidentAudioHealthCode,
    activeGeneration: UInt64?
  ) throws -> [ResidentAudioHealthEffect] {
    guard isOperational else { throw ResidentAudioHealthError.invalidTransition }
    state = beginRecoveryCycle()
    return failTurnEffect(activeGeneration, code: code)
      + [.clearGate, .emit(.recovering, code), .rebuildEngine]
  }

  private func failTurnEffect(_ generation: UInt64?, code: ResidentAudioHealthCode)
    -> [ResidentAudioHealthEffect]
  {
    generation.map { [.failTurn($0, code)] } ?? []
  }

  private mutating func beginRecoveryCycle() -> ResidentAudioHealthState {
    let cycle = nextRecoveryCycle
    nextRecoveryCycle += 1
    return .recovering(cycle: cycle, attempt: 1)
  }
}
