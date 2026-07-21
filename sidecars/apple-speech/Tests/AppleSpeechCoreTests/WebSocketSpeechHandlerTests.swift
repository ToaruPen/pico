import FlyingFox
import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech streaming WebSocket handler")
struct WebSocketSpeechHandlerTests {
  @Test("admits start, forwards PCM, and emits one completed terminal")
  func completesOneSession() async throws {
    let session = RecordingStreamingSession(result: makeResult())
    let service = RecordingStreamingService(session: session)
    let exchange = try await makeExchange(service: service)

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    exchange.client.yield(.binary(Data([0, 1, 2, 3])))
    exchange.client.yield(.text("{\"type\":\"finish\"}"))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [readyJSON, completedJSON])
    #expect(await session.receivedAudio == [Data([0, 1, 2, 3])])
    #expect(await session.finishCount == 1)
    #expect(await session.cancelCount == 0)
  }

  @Test("fails invalid ordering without creating a provider session")
  func rejectsBinaryBeforeStart() async throws {
    let service = RecordingStreamingService(session: RecordingStreamingSession(result: makeResult()))
    let exchange = try await makeExchange(service: service)

    exchange.client.yield(.binary(Data([0, 0])))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [failedJSON(code: "invalid_request")])
    #expect(await service.makeCount == 0)
  }

  @Test("cancels a zero-frame turn instead of finishing it")
  func cancelsZeroFrameTurn() async throws {
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session)
    )

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    exchange.client.yield(.text("{\"type\":\"finish\"}"))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [readyJSON, failedJSON(code: "invalid_request")])
    #expect(await session.finishCount == 0)
    #expect(await session.cancelCount == 1)
  }

  @Test("maps streaming input overflow to a failed terminal")
  func mapsInputOverflow() async throws {
    let session = RecordingStreamingSession(
      result: makeResult(),
      sendError: SidecarServiceError.inputOverflow
    )
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session)
    )

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    exchange.client.yield(.binary(Data([0, 0])))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [readyJSON, failedJSON(code: "input_overflow")])
    #expect(await session.cancelCount == 1)
  }

  @Test("disconnect during finalization reaches session cancellation")
  func disconnectCancelsFinalization() async throws {
    let session = RecordingStreamingSession(result: makeResult(), blockFinish: true)
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session)
    )

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    exchange.client.yield(.binary(Data([0, 0])))
    exchange.client.yield(.text("{\"type\":\"finish\"}"))
    await session.waitUntilFinishing()
    exchange.client.finish()

    _ = await exchange.server.value
    #expect(await session.cancelCount == 1)
  }

  @Test("disconnect while the provider session is preparing closes promptly")
  func disconnectCancelsPreparation() async throws {
    let service = PreparingStreamingService()
    let exchange = try await makeExchange(service: service)

    exchange.client.yield(.text(startJSON))
    await service.waitUntilPreparing()
    exchange.client.finish()

    try await Task.sleep(for: .milliseconds(20))
    #expect(await exchange.status.finished)

    await service.releasePreparation()
    _ = await exchange.server.value
    await service.waitUntilCreatedSessionWasCancelled()
  }

  @Test("ping does not extend the pre-finish inactivity deadline")
  func pingDoesNotResetInactivity() async throws {
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session),
      inactivityTimeout: .milliseconds(20)
    )

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    for _ in 0..<5 {
      try await Task.sleep(for: .milliseconds(5))
      exchange.client.yield(.ping)
    }

    let frames = await exchange.server.value
    #expect(textPayloads(frames).last == failedJSON(code: "timeout"))
    #expect(await session.cancelCount == 1)
  }

  @Test("an idle connection times out before start")
  func timesOutBeforeStart() async throws {
    let exchange = try await makeExchange(
      service: RecordingStreamingService(
        session: RecordingStreamingSession(result: makeResult())
      ),
      inactivityTimeout: .milliseconds(20)
    )

    let frames = await exchange.server.value
    exchange.client.finish()
    #expect(textPayloads(frames) == [failedJSON(code: "timeout")])
  }

  @Test("preparation timeout releases admission and cancels a late session")
  func timesOutDuringPreparation() async throws {
    let admission = TranscriptionAdmission()
    let service = PreparingStreamingService()
    let exchange = try await makeExchange(
      service: service,
      admission: admission,
      inactivityTimeout: .milliseconds(20)
    )

    exchange.client.yield(.text(startJSON))
    await service.waitUntilPreparing()
    try await Task.sleep(for: .milliseconds(30))
    #expect(await exchange.status.finished)
    let replacementLease = try #require(await admission.acquire())
    await admission.release(replacementLease)

    await service.releasePreparation()
    _ = await exchange.server.value
    await service.waitUntilCreatedSessionWasCancelled()
  }

  @Test("shared admission rejects a concurrent stream through the wire contract")
  func rejectsConcurrentStream() async throws {
    let admission = TranscriptionAdmission()
    let firstSession = RecordingStreamingSession(result: makeResult())
    let first = try await makeExchange(
      service: RecordingStreamingService(session: firstSession),
      admission: admission
    )
    first.client.yield(.text(startJSON))
    await first.status.waitForTextFrames(1)

    let secondService = RecordingStreamingService(
      session: RecordingStreamingSession(result: makeResult())
    )
    let second = try await makeExchange(service: secondService, admission: admission)
    second.client.yield(.text(startJSON))

    let secondFrames = await second.server.value
    #expect(textPayloads(secondFrames) == [failedJSON(code: "busy")])
    #expect(await secondService.makeCount == 0)

    first.client.finish()
    _ = await first.server.value
    #expect(await firstSession.cancelCount == 1)
  }

  @Test("duplicate start fails and cancels the active session")
  func rejectsDuplicateStart() async throws {
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session)
    )
    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)

    exchange.client.yield(.text(startJSON))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [readyJSON, failedJSON(code: "invalid_request")])
    #expect(await session.cancelCount == 1)
  }

  @Test("continuous PCM remains live across repeated inactivity windows")
  func continuousPcmResetsInactivity() async throws {
    let clock = ContinuousClock()
    let startedAt = clock.now
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session),
      inactivityTimeout: .milliseconds(500)
    )
    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)

    for _ in 0..<11 {
      try await Task.sleep(for: .milliseconds(50))
      exchange.client.yield(.binary(Data([0, 0])))
    }
    exchange.client.yield(.text("{\"type\":\"finish\"}"))

    let frames = await exchange.server.value
    #expect(startedAt.duration(to: clock.now) > .milliseconds(500))
    #expect(textPayloads(frames) == [readyJSON, completedJSON])
    #expect(await session.finishCount == 1)
  }

  @Test("registry shutdown cancels an active session")
  func shutdownCancelsSession() async throws {
    let registry = StreamingSessionRegistry()
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session),
      registry: registry
    )

    exchange.client.yield(.text(startJSON))
    await exchange.status.waitForTextFrames(1)
    await registry.cancelAll()

    _ = await exchange.server.value
    #expect(await session.cancelCount == 1)
  }

  @Test("reassembles fragmented text and binary messages in order")
  func reassemblesFragments() async throws {
    let session = RecordingStreamingSession(result: makeResult())
    let exchange = try await makeExchange(
      service: RecordingStreamingService(session: session)
    )
    let startBytes = Data(startJSON.utf8)
    let split = startBytes.count / 2

    exchange.client.yield(
      WSFrame(
        fin: false,
        opcode: .text,
        mask: nil,
        payload: startBytes.prefix(split)
      )
    )
    exchange.client.yield(.continuation(startBytes.suffix(from: split)))
    await exchange.status.waitForTextFrames(1)
    exchange.client.yield(.binary(Data([0, 1]), fin: false))
    exchange.client.yield(.continuation(Data([2, 3])))
    exchange.client.yield(.text("{\"type\":\"finish\"}"))

    let frames = await exchange.server.value
    #expect(textPayloads(frames) == [readyJSON, completedJSON])
    #expect(await session.receivedAudio == [Data([0, 1, 2, 3])])
  }

  private func makeExchange(
    service: any AppleSpeechStreamingServing,
    admission: TranscriptionAdmission = TranscriptionAdmission(),
    registry: StreamingSessionRegistry = StreamingSessionRegistry(),
    inactivityTimeout: Duration = .seconds(10)
  ) async throws -> Exchange {
    var client: AsyncThrowingStream<WSFrame, any Error>.Continuation!
    let incoming = AsyncThrowingStream<WSFrame, any Error> { client = $0 }
    let handler = WebSocketSpeechHandler(
      service: service,
      admission: admission,
      registry: registry,
      inactivityTimeout: inactivityTimeout
    )
    let outgoing = try await handler.makeFrames(for: incoming)
    let status = CollectionStatus()
    let server = Task {
      var frames: [WSFrame] = []
      for await frame in outgoing {
        frames.append(frame)
        await status.record(frame)
      }
      await status.markFinished()
      return frames
    }
    return Exchange(client: client, server: server, status: status)
  }

  private func textPayloads(_ frames: [WSFrame]) -> [String] {
    frames.compactMap { frame in
      guard frame.opcode == .text else { return nil }
      return String(decoding: frame.payload, as: UTF8.self)
    }
  }
}

private struct Exchange {
  let client: AsyncThrowingStream<WSFrame, any Error>.Continuation
  let server: Task<[WSFrame], Never>
  let status: CollectionStatus
}

private actor CollectionStatus {
  private(set) var finished = false
  private var textFrames = 0
  private var textFrameWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

  func record(_ frame: WSFrame) {
    guard frame.opcode == .text else { return }
    textFrames += 1
    let ready = textFrameWaiters.filter { textFrames >= $0.count }
    textFrameWaiters.removeAll { textFrames >= $0.count }
    ready.forEach { $0.continuation.resume() }
  }

  func waitForTextFrames(_ count: Int) async {
    guard textFrames < count else { return }
    await withCheckedContinuation { continuation in
      textFrameWaiters.append((count, continuation))
    }
  }

  func markFinished() {
    finished = true
  }
}

private actor RecordingStreamingService: AppleSpeechStreamingServing {
  private let session: RecordingStreamingSession
  private(set) var makeCount = 0

  init(session: RecordingStreamingSession) {
    self.session = session
  }

  func makeStreamingSession(timeoutMilliseconds: Int) async throws
    -> any AppleSpeechStreamingSession
  {
    #expect(timeoutMilliseconds == 25_000)
    makeCount += 1
    return session
  }
}

private actor RecordingStreamingSession: AppleSpeechStreamingSession {
  private let result: TranscriptionResult
  private let sendError: SidecarServiceError?
  private let blockFinish: Bool
  private var finishing = false
  private var finishWaiters: [CheckedContinuation<Void, Never>] = []
  private var finishContinuation: CheckedContinuation<Void, Never>?

  private(set) var receivedAudio: [Data] = []
  private(set) var finishCount = 0
  private(set) var cancelCount = 0

  init(
    result: TranscriptionResult,
    sendError: SidecarServiceError? = nil,
    blockFinish: Bool = false
  ) {
    self.result = result
    self.sendError = sendError
    self.blockFinish = blockFinish
  }

  func send(_ audio: Data) throws {
    if let sendError { throw sendError }
    receivedAudio.append(audio)
  }

  func finish() async throws -> TranscriptionResult {
    finishCount += 1
    finishing = true
    finishWaiters.forEach { $0.resume() }
    finishWaiters.removeAll()
    if blockFinish {
      await withCheckedContinuation { finishContinuation = $0 }
      try Task.checkCancellation()
    }
    return result
  }

  func cancel() {
    cancelCount += 1
    finishContinuation?.resume()
    finishContinuation = nil
  }

  func waitUntilFinishing() async {
    guard !finishing else { return }
    await withCheckedContinuation { finishWaiters.append($0) }
  }
}

private actor PreparingStreamingService: AppleSpeechStreamingServing {
  private let session = RecordingStreamingSession(result: makeResult())
  private var preparing = false
  private var preparingWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func makeStreamingSession(timeoutMilliseconds: Int) async throws
    -> any AppleSpeechStreamingSession
  {
    preparing = true
    preparingWaiters.forEach { $0.resume() }
    preparingWaiters.removeAll()
    await withCheckedContinuation { releaseContinuation = $0 }
    return session
  }

  func waitUntilPreparing() async {
    guard !preparing else { return }
    await withCheckedContinuation { preparingWaiters.append($0) }
  }

  func releasePreparation() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }

  func waitUntilCreatedSessionWasCancelled() async {
    while await session.cancelCount == 0 {
      await Task.yield()
    }
  }
}

private extension WSFrame {
  static func text(_ text: String, fin: Bool = true) -> WSFrame {
    WSFrame(fin: fin, opcode: .text, mask: nil, payload: Data(text.utf8))
  }

  static func binary(_ data: Data, fin: Bool = true) -> WSFrame {
    WSFrame(fin: fin, opcode: .binary, mask: nil, payload: data)
  }

  static func continuation(_ data: Data) -> WSFrame {
    WSFrame(fin: true, opcode: .continuation, mask: nil, payload: data)
  }

  static var ping: WSFrame {
    WSFrame(fin: true, opcode: .ping, mask: nil, payload: Data())
  }
}

private let startJSON =
  "{\"type\":\"start\",\"version\":1,\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1}"
private let readyJSON = "{\"provider\":\"apple-speech\",\"type\":\"ready\",\"version\":1}"
private let completedJSON =
  "{\"provider\":\"apple-speech\",\"result\":{\"confidence\":0,\"durationMs\":0,\"language\":\"ja-JP\",\"segments\":[],\"text\":\"\"},\"type\":\"completed\"}"

private func failedJSON(code: String) -> String {
  let message: String
  switch code {
  case "invalid_request": message = "request is invalid"
  case "busy": message = "speech backend is busy"
  case "input_overflow": message = "streaming input overflowed"
  case "timeout": message = "transcription timed out"
  default: message = "speech backend failed"
  }
  return
    "{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"},\"provider\":\"apple-speech\",\"type\":\"failed\"}"
}

private func makeResult() -> TranscriptionResult {
  TranscriptionResult(
    text: "",
    language: AppleSpeechConstants.locale,
    confidence: 0,
    durationMs: 0,
    segments: []
  )
}
