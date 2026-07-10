import AVFoundation
import Foundation
import Speech

public enum AppleSpeechAssets {
  public static func isReady(localeIdentifier: String) async -> Bool {
    guard
      SpeechTranscriber.isAvailable,
      let transcriber = await makeTranscriberIfSupported(localeIdentifier: localeIdentifier)
    else {
      return false
    }

    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
      return false
    }
    return await supportsFixedInputFormat(transcriber)
  }

  public static func install(localeIdentifier: String) async throws {
    guard
      SpeechTranscriber.isAvailable,
      let supportedLocale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: localeIdentifier)
      )
    else {
      throw SidecarServiceError.modelLoad
    }

    let transcriber = makeTranscriber(locale: supportedLocale)
    try await ensureInstalled(
      initiallyInstalled: await AssetInventory.status(forModules: [transcriber]) == .installed,
      requestDownload: {
        guard
          let installation = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
          )
        else {
          return nil
        }
        return { try await installation.downloadAndInstall() }
      },
      isInstalled: {
        await AssetInventory.status(forModules: [transcriber]) == .installed
      }
    )
  }

  static func ensureInstalled(
    initiallyInstalled: Bool,
    requestDownload: @Sendable () async throws -> (@Sendable () async throws -> Void)?,
    isInstalled: @Sendable () async -> Bool
  ) async throws {
    guard !initiallyInstalled else { return }

    do {
      if let download = try await requestDownload() {
        try await download()
      }
    } catch {
      throw SidecarServiceError.modelLoad
    }

    guard await isInstalled() else {
      throw SidecarServiceError.modelLoad
    }
  }

  static func makeReadyTranscriber(localeIdentifier: String) async throws -> SpeechTranscriber {
    guard
      SpeechTranscriber.isAvailable,
      let transcriber = await makeTranscriberIfSupported(localeIdentifier: localeIdentifier),
      await AssetInventory.status(forModules: [transcriber]) == .installed,
      await supportsFixedInputFormat(transcriber)
    else {
      throw SidecarServiceError.modelLoad
    }
    return transcriber
  }

  private static func makeTranscriberIfSupported(
    localeIdentifier: String
  ) async -> SpeechTranscriber? {
    guard
      localeIdentifier == AppleSpeechConstants.locale,
      let supportedLocale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: localeIdentifier)
      )
    else {
      return nil
    }
    return makeTranscriber(locale: supportedLocale)
  }

  private static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence]
    )
  }

  private static func supportsFixedInputFormat(_ transcriber: SpeechTranscriber) async -> Bool {
    guard let inputFormat = try? PCM16LE.makeFormat() else {
      return false
    }
    return isSelectedInputFormat(
      inputFormat,
      bestAvailableFormat: await SpeechAnalyzer.bestAvailableAudioFormat(
        compatibleWith: [transcriber],
        considering: inputFormat
      )
    )
  }

  static func isSelectedInputFormat(
    _ inputFormat: AVAudioFormat,
    bestAvailableFormat: AVAudioFormat?
  ) -> Bool {
    bestAvailableFormat == inputFormat
  }
}
