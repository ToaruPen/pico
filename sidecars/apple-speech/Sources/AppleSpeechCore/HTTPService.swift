import Darwin
import FlyingFox
import Foundation

private let httpServerTimeoutMarginSeconds: TimeInterval = 10

public func makeAppleSpeechHTTPServerConfiguration(
  address: sockaddr_in,
  analysisTimeoutMilliseconds: Int
) -> HTTPServer.Configuration {
  HTTPServer.Configuration(
    address: address,
    timeout: TimeInterval(analysisTimeoutMilliseconds) / 1_000
      + httpServerTimeoutMarginSeconds
  )
}

public protocol AppleSpeechServing: Sendable {
  func isReady() async -> Bool
  func transcribe(_ request: ValidatedTranscriptionRequest) async throws -> TranscriptionResult
}

public struct AppleSpeechHTTPHandler: HTTPHandler {
  private let httpHandler: SidecarHTTPHandler
  private let webSocketHandler: WebSocketHTTPHandler

  public init(
    service: any AppleSpeechServing,
    streamingService: any AppleSpeechStreamingServing,
    admission: TranscriptionAdmission,
    registry: StreamingSessionRegistry
  ) {
    self.httpHandler = SidecarHTTPHandler(service: service, admission: admission)
    self.webSocketHandler = WebSocketHTTPHandler(
      handler: WebSocketSpeechHandler(
        service: streamingService,
        admission: admission,
        registry: registry
      )
    )
  }

  public func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
    if request.method == .GET, request.path == "/v1/transcription-stream" {
      return try await webSocketHandler.handleRequest(request)
    }
    return try await httpHandler.handleRequest(request)
  }
}

public struct SidecarHTTPHandler: HTTPHandler {
  private let service: any AppleSpeechServing
  private let admission: TranscriptionAdmission
  private let bodyReader: @Sendable (HTTPBodySequence) async throws -> Data

  public init(service: any AppleSpeechServing) {
    self.init(service: service, admission: TranscriptionAdmission())
  }

  public init(service: any AppleSpeechServing, admission: TranscriptionAdmission) {
    self.init(service: service, admission: admission, bodyReader: Self.readBoundedBody)
  }

  init(
    service: any AppleSpeechServing,
    admission: TranscriptionAdmission = TranscriptionAdmission(),
    bodyReader: @escaping @Sendable (HTTPBodySequence) async throws -> Data
  ) {
    self.service = service
    self.admission = admission
    self.bodyReader = bodyReader
  }

  public func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
    switch (request.method, request.path) {
    case (.GET, "/health"):
      return jsonResponse(
        status: .ok,
        body: Data(
          "{\"provider\":\"\(AppleSpeechConstants.provider)\",\"status\":\"ok\"}".utf8
        )
      )
    case (.GET, "/ready"):
      if await service.isReady() {
        return jsonResponse(
          status: .ok,
          body: Data(
            "{\"provider\":\"\(AppleSpeechConstants.provider)\",\"ready\":true}".utf8
          )
        )
      }
      return failureResponse(for: .modelLoad, status: .serviceUnavailable)
    case (.POST, "/v1/transcriptions"):
      return try await handleTranscription(request)
    case (_, "/health"), (_, "/ready"), (_, "/v1/transcriptions"),
      (_, "/v1/transcription-stream"):
      return failureResponse(for: .invalidRequest, status: .methodNotAllowed)
    default:
      return failureResponse(for: .invalidRequest, status: .notFound)
    }
  }

  private func handleTranscription(_ request: HTTPRequest) async throws -> HTTPResponse {
    guard isJSONContentType(request.headers[.contentType]) else {
      return failureResponse(for: .invalidRequest, status: .unsupportedMediaType)
    }

    guard
      let response = try await admission.perform({
        try await handleAdmittedTranscription(request)
      })
    else {
      return failureResponse(for: .busy, status: .tooManyRequests)
    }
    return response
  }

  private func isJSONContentType(_ value: String?) -> Bool {
    guard let value else { return false }
    let mediaType =
      value
      .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
      .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
    return mediaType.caseInsensitiveCompare("application/json") == .orderedSame
  }

  private func handleAdmittedTranscription(_ request: HTTPRequest) async throws -> HTTPResponse {
    do {
      let body = try await bodyReader(request.bodySequence)
      let validated = try WireContract.decodeAndValidate(body)
      let result = try await service.transcribe(validated)
      return jsonResponse(status: .ok, body: try WireContract.encodeSuccess(result))
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as BodyReadError {
      switch error {
      case .tooLarge:
        return failureResponse(for: .invalidRequest, status: .payloadTooLarge)
      case .readFailed:
        return failureResponse(for: .backendError, status: .internalServerError)
      }
    } catch let error as SidecarServiceError {
      return failureResponse(for: error, status: status(for: error))
    } catch {
      return failureResponse(for: .backendError, status: .internalServerError)
    }
  }

  private static func readBoundedBody(_ sequence: HTTPBodySequence) async throws -> Data {
    if let count = sequence.count, count > WireContract.maximumRequestBodyBytes {
      throw BodyReadError.tooLarge
    }

    var body = Data()
    do {
      for try await chunk in sequence {
        guard chunk.count <= WireContract.maximumRequestBodyBytes - body.count else {
          throw BodyReadError.tooLarge
        }
        body.append(chunk)
      }
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as BodyReadError {
      throw error
    } catch {
      throw BodyReadError.readFailed
    }
    return body
  }

  private func status(for error: SidecarServiceError) -> HTTPStatusCode {
    switch error {
    case .invalidRequest:
      .badRequest
    case .timeout:
      .gatewayTimeout
    case .modelLoad:
      .serviceUnavailable
    case .backendError:
      .internalServerError
    case .busy:
      .tooManyRequests
    case .inputOverflow:
      .internalServerError
    }
  }

  private func failureResponse(
    for error: SidecarServiceError,
    status: HTTPStatusCode
  ) -> HTTPResponse {
    let body = (try? WireContract.encodeFailure(error)) ?? Data()
    return jsonResponse(status: status, body: body)
  }

  private func jsonResponse(status: HTTPStatusCode, body: Data) -> HTTPResponse {
    HTTPResponse(
      statusCode: status,
      headers: [
        .contentType: "application/json; charset=utf-8",
        .cacheControl: "no-store",
      ],
      body: body
    )
  }
}

private enum BodyReadError: Error {
  case tooLarge
  case readFailed
}
