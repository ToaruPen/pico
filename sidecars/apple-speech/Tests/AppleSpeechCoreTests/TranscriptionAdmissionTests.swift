import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech shared admission")
struct TranscriptionAdmissionTests {
  @Test("admits exactly one batch or streaming lease")
  func admitsOneLease() async throws {
    let admission = TranscriptionAdmission()
    let first = try #require(await admission.acquire())

    #expect(await admission.acquire() == nil)

    await admission.release(first)
    #expect(await admission.acquire() != nil)
  }

  @Test("a stale or duplicate release cannot release a newer lease")
  func ignoresStaleRelease() async throws {
    let admission = TranscriptionAdmission()
    let first = try #require(await admission.acquire())
    await admission.release(first)
    let second = try #require(await admission.acquire())

    await admission.release(first)
    #expect(await admission.acquire() == nil)

    await admission.release(second)
    #expect(await admission.acquire() != nil)
  }

  @Test("perform releases admission after success and failure")
  func performAlwaysReleases() async throws {
    let admission = TranscriptionAdmission()

    #expect(await admission.perform { 42 } == 42)
    #expect(await admission.acquire() != nil)

    let failureAdmission = TranscriptionAdmission()
    await #expect(throws: SidecarServiceError.backendError) {
      _ = try await failureAdmission.perform {
        throw SidecarServiceError.backendError
      } as Int?
    }
    #expect(await failureAdmission.acquire() != nil)
  }
}
