import Darwin
import FlyingFox
import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("HTTP server timeout")
struct HTTPServerTimeoutTests {
  @Test("service timeout envelope wins before the HTTP server deadline")
  func serviceTimeoutEnvelopeWins() async throws {
    let analysisTimeoutMilliseconds = 25_000
    let configuration = makeAppleSpeechHTTPServerConfiguration(
      address: try sockaddr_in.inet(ip4: "127.0.0.1", port: 0),
      analysisTimeoutMilliseconds: analysisTimeoutMilliseconds
    )
    #expect(
      configuration.timeout
        == TimeInterval(analysisTimeoutMilliseconds) / 1_000 + 10
    )

    let handler = SidecarHTTPHandler(
      service: DelayedTimeoutService(delay: .milliseconds(25))
    )
    let server = HTTPServer(config: configuration, handler: handler)
    let serverTask = Task { try await server.run() }

    do {
      try await server.waitUntilListening()
      let listeningAddress = await server.listeningAddress
      let port: UInt16
      if case let .ip4(_, listeningPort)? = listeningAddress {
        port = listeningPort
      } else {
        Issue.record("Apple Speech test server did not bind an IPv4 loopback port")
        await stop(server: server, task: serverTask)
        return
      }

      var request = URLRequest(
        url: try #require(URL(string: "http://127.0.0.1:\(port)/v1/transcriptions"))
      )
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONEncoder().encode(validRequest())
      request.timeoutInterval = 2

      let (data, response) = try await URLSession.shared.data(for: request)
      let httpResponse = try #require(response as? HTTPURLResponse)
      let envelope = try JSONDecoder().decode(TranscriptionFailureResponse.self, from: data)

      #expect(httpResponse.statusCode == 504)
      #expect(
        envelope
          == TranscriptionFailureResponse(
            provider: AppleSpeechConstants.provider,
            ok: false,
            error: SidecarServiceError.timeout.payload
          )
      )
      await stop(server: server, task: serverTask)
    } catch {
      await stop(server: server, task: serverTask)
      throw error
    }
  }

  @Test("WebSocket processing continues beyond the HTTP handler timeout")
  func webSocketOutlivesHTTPTimeout() async throws {
    let address = try sockaddr_in.inet(ip4: "127.0.0.1", port: 0)
    let handler = AppleSpeechHTTPHandler(
      service: ReadyBatchService(),
      streamingService: ImmediateStreamingService(),
      admission: TranscriptionAdmission(),
      registry: StreamingSessionRegistry()
    )
    let server = HTTPServer(
      config: HTTPServer.Configuration(address: address, timeout: 0.02),
      handler: handler
    )
    let serverTask = Task { try await server.run() }

    do {
      try await server.waitUntilListening()
      let listeningAddress = await server.listeningAddress
      let port: UInt16
      if case let .ip4(_, listeningPort)? = listeningAddress {
        port = listeningPort
      } else {
        Issue.record("Apple Speech WebSocket test server did not bind an IPv4 loopback port")
        await stop(server: server, task: serverTask)
        return
      }

      let session = URLSession(configuration: .ephemeral)
      defer { session.invalidateAndCancel() }
      let url = try #require(URL(string: "ws://127.0.0.1:\(port)/v1/transcription-stream"))
      let socket = session.webSocketTask(with: url)
      socket.resume()
      try await socket.send(.string(streamingStartJSON))
      let ready = try await socket.receive()
      #expect(try text(from: ready).contains("\"type\":\"ready\""))

      try await Task.sleep(for: .milliseconds(50))
      try await socket.send(.data(Data([0, 0])))
      try await socket.send(.string("{\"type\":\"finish\"}"))
      let completed = try await socket.receive()
      #expect(try text(from: completed).contains("\"type\":\"completed\""))
      socket.cancel(with: .normalClosure, reason: nil)

      await stop(server: server, task: serverTask)
    } catch {
      await stop(server: server, task: serverTask)
      throw error
    }
  }

  private func validRequest() -> TranscriptionRequest {
    TranscriptionRequest(
      provider: AppleSpeechConstants.provider,
      language: AppleSpeechConstants.locale,
      timeoutMs: 25_000,
      audio: AudioRequest(
        encoding: AppleSpeechConstants.encoding,
        sampleRateHz: AppleSpeechConstants.sampleRateHz,
        channels: AppleSpeechConstants.channels,
        dataBase64: "AAA="
      ),
      normalization: AudioNormalization(
        targetEncoding: AppleSpeechConstants.encoding,
        targetSampleRateHz: AppleSpeechConstants.sampleRateHz,
        targetChannels: AppleSpeechConstants.channels
      )
    )
  }

  private func stop(server: HTTPServer, task: Task<Void, any Error>) async {
    await server.stop(timeout: 0)
    task.cancel()
    _ = await task.result
  }

  private func text(from message: URLSessionWebSocketTask.Message) throws -> String {
    guard case .string(let text) = message else {
      throw SidecarServiceError.backendError
    }
    return text
  }
}

private struct DelayedTimeoutService: AppleSpeechServing {
  let delay: Duration

  func isReady() async -> Bool { true }

  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult {
    try await Task.sleep(for: delay)
    throw SidecarServiceError.timeout
  }
}

private struct ReadyBatchService: AppleSpeechServing {
  func isReady() async -> Bool { true }

  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult {
    makeImmediateResult()
  }
}

private struct ImmediateStreamingService: AppleSpeechStreamingServing {
  func makeStreamingSession(timeoutMilliseconds: Int) async throws
    -> any AppleSpeechStreamingSession
  {
    ImmediateStreamingSession()
  }
}

private actor ImmediateStreamingSession: AppleSpeechStreamingSession {
  func send(_ audio: Data) throws {}

  func finish() async throws -> TranscriptionResult {
    makeImmediateResult()
  }

  func cancel() {}
}

private let streamingStartJSON =
  "{\"type\":\"start\",\"version\":1,\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1}"

private func makeImmediateResult() -> TranscriptionResult {
  TranscriptionResult(
    text: "",
    language: AppleSpeechConstants.locale,
    confidence: 0,
    durationMs: 0,
    segments: []
  )
}
