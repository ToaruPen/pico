import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech wire contract")
struct WireContractTests {
  @Test("decodes the exact fixed-format request")
  func decodesExactRequest() throws {
    let validated = try WireContract.decodeAndValidate(
      Data(
        """
        {"provider":"apple-speech","language":"ja-JP","timeoutMs":25000,"audio":{"encoding":"pcm16le","sampleRateHz":16000,"channels":1,"dataBase64":"AAA="},"normalization":{"targetEncoding":"pcm16le","targetSampleRateHz":16000,"targetChannels":1}}
        """.utf8
      )
    )

    #expect(validated.timeoutMilliseconds == 25_000)
    #expect(validated.audio == Data([0, 0]))
    #expect(validated.durationMilliseconds == 0.0625)
  }

  @Test(
    "rejects deviations from the fixed wire contract",
    arguments: [
      "{\"provider\":\"other\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"AAA=\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"AAA=\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":0,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"AAA=\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":8000,\"channels\":1,\"dataBase64\":\"AAA=\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":2,\"dataBase64\":\"AAA=\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"AA==\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"\"},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}",
      "{\"provider\":\"apple-speech\",\"language\":\"ja-JP\",\"timeoutMs\":25000,\"audio\":{\"encoding\":\"pcm16le\",\"sampleRateHz\":16000,\"channels\":1,\"dataBase64\":\"AAA=\",\"extra\":true},\"normalization\":{\"targetEncoding\":\"pcm16le\",\"targetSampleRateHz\":16000,\"targetChannels\":1}}"
    ]
  )
  func rejectsInvalidRequest(json: String) {
    #expect(throws: SidecarServiceError.invalidRequest) {
      try WireContract.decodeAndValidate(Data(json.utf8))
    }
  }

  @Test("rejects decoded audio larger than four MiB")
  func rejectsOversizedAudio() throws {
    let oversized = Data(repeating: 0, count: WireContract.maximumDecodedAudioBytes + 2)
    let request = TranscriptionRequest(
      provider: "apple-speech",
      language: "ja-JP",
      timeoutMs: 25_000,
      audio: AudioRequest(
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        dataBase64: oversized.base64EncodedString()
      ),
      normalization: AudioNormalization(
        targetEncoding: "pcm16le",
        targetSampleRateHz: 16_000,
        targetChannels: 1
      )
    )

    #expect(throws: SidecarServiceError.invalidRequest) {
      try WireContract.decodeAndValidate(JSONEncoder().encode(request))
    }
  }

  @Test("encodes exact success and failure envelopes")
  func encodesResponseEnvelopes() throws {
    let result = TranscriptionResult(
      text: "こんにちは",
      language: "ja-JP",
      confidence: 0.75,
      durationMs: 125,
      segments: [
        TranscriptSegment(text: "こんにちは", startMs: 0, endMs: 100, confidence: 0.75)
      ]
    )
    let success = try JSONSerialization.jsonObject(
      with: WireContract.encodeSuccess(result),
      options: [.fragmentsAllowed]
    ) as? NSDictionary
    #expect(
      success == [
        "provider": "apple-speech",
        "ok": true,
        "result": [
          "text": "こんにちは",
          "language": "ja-JP",
          "confidence": 0.75,
          "durationMs": 125.0,
          "segments": [
            ["text": "こんにちは", "startMs": 0.0, "endMs": 100.0, "confidence": 0.75]
          ]
        ]
      ]
    )

    let failure = try JSONSerialization.jsonObject(
      with: WireContract.encodeFailure(.timeout),
      options: [.fragmentsAllowed]
    ) as? NSDictionary
    #expect(
      failure == [
        "provider": "apple-speech",
        "ok": false,
        "error": ["code": "timeout", "message": "transcription timed out"]
      ]
    )
  }
}
