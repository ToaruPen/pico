import FlyingFox
import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("HTTP route errors")
struct HTTPRouteTests {
  @Test("health is live while readiness reports missing assets")
  func healthAndReadiness() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())

    let health = try await handler.handleRequest(request(method: .GET, path: "/health"))
    #expect(health.statusCode == .ok)

    let ready = try await handler.handleRequest(request(method: .GET, path: "/ready"))
    #expect(ready.statusCode == .serviceUnavailable)
    let body = try await decodeObject(ready)
    #expect(body["provider"] as? String == "apple-speech")
    #expect(body["ok"] as? Bool == false)
    #expect((body["error"] as? [String: Any])?["code"] as? String == "model_load")
  }

  @Test("malformed JSON returns the exact invalid-request envelope")
  func malformedRequest() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())
    let response = try await handler.handleRequest(
      request(method: .POST, path: "/v1/transcriptions", body: Data("{".utf8))
    )

    #expect(response.statusCode == .badRequest)
    let body = try await decodeObject(response)
    #expect(body["provider"] as? String == "apple-speech")
    #expect(body["ok"] as? Bool == false)
    #expect((body["error"] as? [String: Any])?["code"] as? String == "invalid_request")
  }

  @Test("accepts case-insensitive JSON media types with OWS and parameters")
  func acceptsJSONMediaTypeParameters() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())
    let response = try await handler.handleRequest(
      request(
        method: .POST,
        path: "/v1/transcriptions",
        contentType: " \tApplication/JSON ; charset=utf-8\t",
        body: Data("{".utf8)
      )
    )

    #expect(response.statusCode == .badRequest)
  }

  @Test("rejects media types that only prefix-match application/json")
  func rejectsJSONPrefixMediaType() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())
    let response = try await handler.handleRequest(
      request(
        method: .POST,
        path: "/v1/transcriptions",
        contentType: "application/jsonp",
        body: Data("{".utf8)
      )
    )

    #expect(response.statusCode == .unsupportedMediaType)
  }

  @Test("oversized bodies are rejected before decoding")
  func oversizedBody() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())
    let response = try await handler.handleRequest(
      request(
        method: .POST,
        path: "/v1/transcriptions",
        body: Data(repeating: 0, count: WireContract.maximumRequestBodyBytes + 1)
      )
    )

    #expect(response.statusCode == .payloadTooLarge)
    let body = try await decodeObject(response)
    #expect((body["error"] as? [String: Any])?["code"] as? String == "invalid_request")
  }

  @Test("unsupported paths and methods return bounded JSON errors")
  func rejectsUnsupportedRoutes() async throws {
    let handler = SidecarHTTPHandler(service: UnreadyService())
    let missing = try await handler.handleRequest(request(method: .GET, path: "/missing"))
    let wrongMethod = try await handler.handleRequest(
      request(method: .GET, path: "/v1/transcriptions")
    )

    #expect(missing.statusCode == .notFound)
    #expect(wrongMethod.statusCode == .methodNotAllowed)
    #expect(try await missing.bodyData.count < 512)
    #expect(try await wrongMethod.bodyData.count < 512)
  }

  private func request(
    method: HTTPMethod,
    path: String,
    contentType: String = "application/json",
    body: Data = Data()
  ) -> HTTPRequest {
    HTTPRequest(
      method: method,
      version: .http11,
      path: path,
      query: [],
      headers: [.contentType: contentType],
      body: body
    )
  }

  private func decodeObject(_ response: HTTPResponse) async throws -> [String: Any] {
    let object = try JSONSerialization.jsonObject(with: await response.bodyData)
    return try #require(object as? [String: Any])
  }
}

private actor UnreadyService: AppleSpeechServing {
  func isReady() async -> Bool { false }

  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult {
    Issue.record("transcribe must not run in route-error tests")
    throw SidecarServiceError.backendError
  }
}
