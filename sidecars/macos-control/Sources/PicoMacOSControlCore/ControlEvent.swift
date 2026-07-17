import Foundation

public enum SemanticControlEvent: String, Codable, Sendable {
  case talkPressed = "talk_pressed"
  case talkReleased = "talk_released"
  case cancelPressed = "cancel_pressed"
}

public struct ControlEventChannel: Sendable {
  public let events: AsyncStream<SemanticControlEvent>
  private let continuation: AsyncStream<SemanticControlEvent>.Continuation

  public init() {
    let (events, continuation) = AsyncStream<SemanticControlEvent>.makeStream(
      bufferingPolicy: .unbounded)
    self.events = events
    self.continuation = continuation
  }

  public func send(_ event: SemanticControlEvent) -> Bool {
    switch continuation.yield(event) {
    case .enqueued:
      true
    case .dropped, .terminated:
      false
    @unknown default:
      false
    }
  }

  public func finish() {
    continuation.finish()
  }
}

public struct KeyboardEventDecision: Equatable, Sendable {
  public let event: SemanticControlEvent?
  public let consume: Bool

  public init(event: SemanticControlEvent?, consume: Bool) {
    self.event = event
    self.consume = consume
  }
}

public struct ControlEventMapper: Sendable {
  public let talkKeyCode: UInt16
  public let cancelKeyCode: UInt16
  private var talkHeld = false
  private var cancelHeld = false

  public init(talkKeyCode: UInt16, cancelKeyCode: UInt16) {
    self.talkKeyCode = talkKeyCode
    self.cancelKeyCode = cancelKeyCode
  }

  public mutating func handle(keyCode: UInt16, isKeyDown: Bool, isRepeat: Bool)
    -> KeyboardEventDecision
  {
    if keyCode == talkKeyCode {
      return handleTalk(isKeyDown: isKeyDown, isRepeat: isRepeat)
    }

    if keyCode == cancelKeyCode {
      return handleCancel(isKeyDown: isKeyDown, isRepeat: isRepeat)
    }

    return KeyboardEventDecision(event: nil, consume: false)
  }

  private mutating func handleTalk(isKeyDown: Bool, isRepeat: Bool) -> KeyboardEventDecision {
    if isKeyDown {
      guard !talkHeld, !isRepeat else {
        return KeyboardEventDecision(event: nil, consume: true)
      }

      talkHeld = true
      return KeyboardEventDecision(event: .talkPressed, consume: true)
    }

    guard talkHeld else {
      return KeyboardEventDecision(event: nil, consume: true)
    }

    talkHeld = false
    return KeyboardEventDecision(event: .talkReleased, consume: true)
  }

  private mutating func handleCancel(isKeyDown: Bool, isRepeat: Bool) -> KeyboardEventDecision {
    if isKeyDown {
      guard !cancelHeld, !isRepeat else {
        return KeyboardEventDecision(event: nil, consume: true)
      }

      cancelHeld = true
      return KeyboardEventDecision(event: .cancelPressed, consume: true)
    }

    cancelHeld = false
    return KeyboardEventDecision(event: nil, consume: true)
  }
}
