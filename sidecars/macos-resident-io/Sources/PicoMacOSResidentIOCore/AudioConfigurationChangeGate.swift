public enum AudioConfigurationChangeAction: Equatable, Sendable {
  case ignoreStartupNotification
  case invalidateStartingGeneration
  case recover
}

public struct AudioConfigurationChangeGate: Sendable {
  private var ignoredStartupNotification = false

  public init() {}

  public mutating func action(hasDeliveredFirstCallback: Bool, isEngineRunning: Bool)
    -> AudioConfigurationChangeAction
  {
    if hasDeliveredFirstCallback { return .recover }
    guard isEngineRunning, !ignoredStartupNotification else {
      return .invalidateStartingGeneration
    }
    ignoredStartupNotification = true
    return .ignoreStartupNotification
  }

  public mutating func reset() {
    ignoredStartupNotification = false
  }
}
