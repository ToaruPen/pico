import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech streaming wire contract")
struct StreamingWireContractTests {
  @Test("decodes the exact start and finish messages")
  func decodesClientMessages() throws {
    let start = try StreamingWireContract.decodeClientText(
      Data(
        """
        {"type":"start","version":1,"provider":"apple-speech","language":"ja-JP","timeoutMs":25000,"encoding":"pcm16le","sampleRateHz":16000,"channels":1}
        """.utf8
      )
    )
    #expect(
      start == .start(
        StreamingStartMessage(
          timeoutMilliseconds: 25_000
        )
      )
    )

    #expect(
      try StreamingWireContract.decodeClientText(Data("{\"type\":\"finish\"}".utf8))
        == .finish
    )
  }

  @Test(
    "rejects invalid client text messages",
    arguments: [
      "",
      "{\"type\":\"start\",\"version\":1,\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"extra\":true}",
      "{\"type\":\"start\",\"version\":2,\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1}",
      "{\"type\":\"start\",\"version\":1,\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":0,\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1}",
      "{\"type\":\"finish\",\"extra\":true}",
      "{\"type\":\"unknown\"}",
    ]
  )
  func rejectsInvalidClientText(json: String) {
    #expect(throws: SidecarServiceError.invalidRequest) {
      try StreamingWireContract.decodeClientText(Data(json.utf8))
    }
  }

  @Test("validates individual PCM messages without a total four MiB cap")
  func validatesPcmMessages() throws {
    let maximum = Data(repeating: 0, count: StreamingWireContract.maximumBinaryMessageBytes)
    try StreamingWireContract.validateBinary(maximum)

    #expect(throws: SidecarServiceError.invalidRequest) {
      try StreamingWireContract.validateBinary(Data())
    }
    #expect(throws: SidecarServiceError.invalidRequest) {
      try StreamingWireContract.validateBinary(Data([0]))
    }
    #expect(throws: SidecarServiceError.invalidRequest) {
      try StreamingWireContract.validateBinary(
        Data(repeating: 0, count: StreamingWireContract.maximumBinaryMessageBytes + 2)
      )
    }
  }

  @Test("encodes exact ready completed and failed envelopes")
  func encodesServerMessages() throws {
    let ready = try decodeObject(StreamingWireContract.encodeReady())
    #expect(
      ready == [
        "type": "ready",
        "version": 1,
        "provider": "apple-speech",
      ]
    )

    let result = TranscriptionResult(
      text: "こんにちは",
      language: "ja-JP",
      confidence: 0.75,
      durationMs: 125,
      segments: []
    )
    let completed = try decodeObject(StreamingWireContract.encodeCompleted(result))
    #expect(
      completed == [
        "type": "completed",
        "provider": "apple-speech",
        "result": [
          "text": "こんにちは",
          "language": "ja-JP",
          "confidence": 0.75,
          "durationMs": 125.0,
          "segments": [],
        ],
      ]
    )

    let failed = try decodeObject(
      StreamingWireContract.encodeFailed(.inputOverflow)
    )
    #expect(
      failed == [
        "type": "failed",
        "provider": "apple-speech",
        "error": [
          "code": "input_overflow",
          "message": "streaming input overflowed",
        ],
      ]
    )
  }

  @Test("assigns a stable payload to every streaming terminal code")
  func stableFailureCodes() {
    let expected: [(SidecarServiceError, SidecarErrorCode)] = [
      (.invalidRequest, .invalidRequest),
      (.busy, .busy),
      (.inputOverflow, .inputOverflow),
      (.timeout, .timeout),
      (.modelLoad, .modelLoad),
      (.backendError, .backendError),
    ]

    for (error, code) in expected {
      #expect(error.payload.code == code)
    }
  }

  private func decodeObject(_ data: Data) throws -> NSDictionary {
    try #require(
      JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? NSDictionary
    )
  }
}
