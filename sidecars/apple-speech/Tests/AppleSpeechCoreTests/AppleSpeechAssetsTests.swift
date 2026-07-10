import AVFoundation
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech asset installation")
struct AppleSpeechAssetsTests {
  @Test("requires Apple's compatibility resolver to select the fixed PCM format")
  func requiresResolvedFixedInputFormat() throws {
    let fixedFormat = try #require(
      AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      )
    )
    let equivalentFixedFormat = try #require(
      AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      )
    )
    let incompatibleFormat = try #require(
      AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 8_000,
        channels: 1,
        interleaved: false
      )
    )

    #expect(
      AppleSpeechAssets.isSelectedInputFormat(
        fixedFormat,
        bestAvailableFormat: equivalentFixedFormat
      )
    )
    #expect(
      !AppleSpeechAssets.isSelectedInputFormat(
        fixedFormat,
        bestAvailableFormat: incompatibleFormat
      )
    )
    #expect(!AppleSpeechAssets.isSelectedInputFormat(fixedFormat, bestAvailableFormat: nil))
  }

  @Test("accepts no installation request only after installed status is confirmed")
  func acceptsNoRequestAfterConcurrentInstallation() async throws {
    let requests = CallCounter()

    try await AppleSpeechAssets.ensureInstalled(
      initiallyInstalled: false,
      requestDownload: {
        await requests.recordCall()
        return nil
      },
      isInstalled: { true }
    )

    #expect(await requests.count == 1)
  }

  @Test("rejects no installation request while assets remain unavailable")
  func rejectsNoRequestWithoutInstalledStatus() async {
    do {
      try await AppleSpeechAssets.ensureInstalled(
        initiallyInstalled: false,
        requestDownload: { nil },
        isInstalled: { false }
      )
      Issue.record("asset installation must fail until installed status is confirmed")
    } catch let error as SidecarServiceError {
      #expect(error == .modelLoad)
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

private actor CallCounter {
  private(set) var count = 0

  func recordCall() {
    count += 1
  }
}
