import Testing

@testable import PicoMacOSResidentIOCore

@Suite("macOS semantic key mapping")
struct ControlEventTests {
  @Test("preserves pending semantic events in arrival order")
  func preservesPendingEvents() async {
    let channel = ControlEventChannel()

    #expect(channel.send(.talkPressed))
    #expect(channel.send(.talkReleased))
    channel.finish()
    #expect(!channel.send(.cancelPressed))

    var events = channel.events.makeAsyncIterator()
    #expect(await events.next() == .talkPressed)
    #expect(await events.next() == .talkReleased)
    #expect(await events.next() == nil)
  }

  @Test("drains accepted semantic events before sender shutdown")
  func drainsAcceptedEventsBeforeShutdown() async {
    let channel = ControlEventChannel()
    let collector = SemanticEventCollector()
    let sender = Task {
      for await event in channel.events {
        await collector.append(event)
      }
    }

    #expect(channel.send(.talkPressed))
    #expect(channel.send(.talkReleased))
    #expect(
      finishAndDrainControlEvents(
        channel: channel,
        sender: sender,
        timeout: .seconds(1)
      ))
    #expect(await collector.snapshot() == [.talkPressed, .talkReleased])
  }

  @Test("cancels a semantic event sender after the drain deadline")
  func cancelsSenderAfterDrainDeadline() async {
    let channel = ControlEventChannel()
    let sender = Task {
      for await _ in channel.events {
        do {
          try await Task.sleep(for: .seconds(60))
        } catch {
          return
        }
      }
    }

    #expect(channel.send(.cancelPressed))
    #expect(
      !(finishAndDrainControlEvents(
        channel: channel,
        sender: sender,
        timeout: .milliseconds(1)
      )))
    #expect(sender.isCancelled)
    await sender.value
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

private actor SemanticEventCollector {
  private var events: [SemanticControlEvent] = []

  func append(_ event: SemanticControlEvent) {
    events.append(event)
  }

  func snapshot() -> [SemanticControlEvent] {
    events
  }
}
