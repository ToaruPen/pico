import Testing

@testable import PicoMacOSControlCore

@Suite("macOS semantic key mapping")
struct ControlEventTests {
  @Test("bounds pending semantic events and reports overflow")
  func boundsPendingEvents() {
    let channel = ControlEventChannel()

    #expect(channel.send(.talkPressed))
    #expect(!channel.send(.talkReleased))
    channel.finish()
    #expect(!channel.send(.cancelPressed))
  }

  @Test("maps one talk hold and suppresses repeats")
  func mapsTalkHold() {
    var mapper = ControlEventMapper(talkKeyCode: 105, cancelKeyCode: 107)

    #expect(
      mapper.handle(keyCode: 105, isKeyDown: true, isRepeat: false)
        == KeyboardEventDecision(event: .talkPressed, consume: true))
    #expect(
      mapper.handle(keyCode: 105, isKeyDown: true, isRepeat: true)
        == KeyboardEventDecision(event: nil, consume: true))
    #expect(
      mapper.handle(keyCode: 105, isKeyDown: false, isRepeat: false)
        == KeyboardEventDecision(event: .talkReleased, consume: true))
    #expect(
      mapper.handle(keyCode: 105, isKeyDown: false, isRepeat: false)
        == KeyboardEventDecision(event: nil, consume: true))
  }

  @Test("maps cancel once and passes unrelated keys")
  func mapsCancelAndUnrelatedKeys() {
    var mapper = ControlEventMapper(talkKeyCode: 105, cancelKeyCode: 107)

    #expect(
      mapper.handle(keyCode: 107, isKeyDown: true, isRepeat: false)
        == KeyboardEventDecision(event: .cancelPressed, consume: true))
    #expect(
      mapper.handle(keyCode: 107, isKeyDown: true, isRepeat: true)
        == KeyboardEventDecision(event: nil, consume: true))
    #expect(
      mapper.handle(keyCode: 107, isKeyDown: false, isRepeat: false)
        == KeyboardEventDecision(event: nil, consume: true))
    #expect(
      mapper.handle(keyCode: 107, isKeyDown: true, isRepeat: false)
        == KeyboardEventDecision(event: .cancelPressed, consume: true))
    #expect(
      mapper.handle(keyCode: 0, isKeyDown: true, isRepeat: false)
        == KeyboardEventDecision(event: nil, consume: false))
  }
}
