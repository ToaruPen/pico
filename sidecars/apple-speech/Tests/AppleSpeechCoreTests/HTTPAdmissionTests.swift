import FlyingFox
import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("HTTP transcription admission")
struct HTTPAdmissionTests {
  @Test("rejects a concurrent request before consuming its body")
  func rejectsBeforeReadingBody() async throws {
    let service = BlockingService()
    let bodyReads = BodyReadCounter()
    let handler = SidecarHTTPHandler(
      service: service,
      bodyReader: { _ in
        await bodyReads.recordRead()
        return try makeValidRequestBody()
      }
    )

    let firstResponse = Task {
      try await handler.handleRequest(makeTranscriptionRequest())
    }
    await service.waitUntilTranscribing()

    let rejected = try await handler.handleRequest(makeTranscriptionRequest())
    let failure = try JSONDecoder().decode(
      TranscriptionFailureResponse.self,
      from: await rejected.bodyData
    )

    #expect(rejected.statusCode == .tooManyRequests)
    #expect(failure.error.code == .backendError)
    #expect(failure.error.message == "speech backend is busy")
    #expect(await bodyReads.count == 1)

    await service.finishTranscribing()
    #expect(try await firstResponse.value.statusCode == .ok)
  }
}

private actor BlockingService: AppleSpeechServing {
  private var entered = false
  private var finished = false
  private var enteredWaiter: CheckedContinuation<Void, Never>?
  private var finishWaiter: CheckedContinuation<Void, Never>?

  func isReady() async -> Bool { true }

  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult {
    entered = true
    enteredWaiter?.resume()
    enteredWaiter = nil

    if !finished {
      await withCheckedContinuation { continuation in
        finishWaiter = continuation
      }
    }

    return TranscriptionResult(
      text: "",
      language: AppleSpeechConstants.locale,
      confidence: 0,
      durationMs: request.durationMilliseconds,
      segments: []
    )
  }

  func waitUntilTranscribing() async {
    guard !entered else { return }
    await withCheckedContinuation { continuation in
      enteredWaiter = continuation
    }
  }

  func finishTranscribing() {
    finished = true
    finishWaiter?.resume()
    finishWaiter = nil
  }
}

private actor BodyReadCounter {
  private(set) var count = 0

  func recordRead() {
    count += 1
  }
}

private func makeTranscriptionRequest() -> HTTPRequest {
  HTTPRequest(
    method: .POST,
    version: .http11,
    path: "/v1/transcriptions",
    query: [],
    headers: [.contentType: "application/json"],
    body: Data()
  )
}

private func makeValidRequestBody() throws -> Data {
  try JSONEncoder().encode(
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
  )
}
