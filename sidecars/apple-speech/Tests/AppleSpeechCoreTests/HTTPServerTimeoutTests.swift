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
}

private struct DelayedTimeoutService: AppleSpeechServing {
  let delay: Duration

  func isReady() async -> Bool { true }

  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult {
    try await Task.sleep(for: delay)
    throw SidecarServiceError.timeout
  }
}
