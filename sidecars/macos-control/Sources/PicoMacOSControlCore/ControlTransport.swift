import Darwin
import Foundation

public enum ControlTransportError: Error, LocalizedError {
  case tokenSymbolicLink
  case tokenNotRegularFile
  case tokenPermissions(UInt16)
  case tokenEmpty
  case invalidResponse
  case rejected(Int)

  public var errorDescription: String? {
    switch self {
    case .tokenSymbolicLink:
      "control token file must not be a symbolic link"
    case .tokenNotRegularFile:
      "control token file must be a regular file"
    case .tokenPermissions(let mode):
      "control token file must have 0600 permissions, found \(String(mode, radix: 8))"
    case .tokenEmpty:
      "control token file must not be empty"
    case .invalidResponse:
      "control server returned a non-HTTP response"
    case .rejected(let status):
      "control server returned HTTP \(status)"
    }
  }
}

public struct ControlRequestBuilder: Sendable {
  private let baseURL: URL
  private let token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  public func eventRequest(_ event: SemanticControlEvent) throws -> URLRequest {
    var request = URLRequest(url: baseURL.appendingPathComponent("v1/resident-control/events"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(["event": event.rawValue])
    return request
  }

  public func healthRequest() -> URLRequest {
    var request = URLRequest(url: baseURL.appendingPathComponent("v1/resident-control/health"))
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return request
  }
}

public final class ControlTransport: @unchecked Sendable {
  private let requests: ControlRequestBuilder
  private let session: URLSession

  public init(requests: ControlRequestBuilder, session: URLSession = .shared) {
    self.requests = requests
    self.session = session
  }

  public func checkHealth() async throws {
    try await send(requests.healthRequest())
  }

  public func send(_ event: SemanticControlEvent) async throws {
    try await send(requests.eventRequest(event))
  }

  private func send(_ request: URLRequest) async throws {
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw ControlTransportError.invalidResponse
    }

    guard (200...299).contains(http.statusCode) else {
      throw ControlTransportError.rejected(http.statusCode)
    }
  }
}

public func readControlToken(path: String) throws -> String {
  var metadata = stat()
  guard lstat(path, &metadata) == 0 else {
    throw CocoaError(.fileReadNoSuchFile)
  }

  if (metadata.st_mode & S_IFMT) == S_IFLNK {
    throw ControlTransportError.tokenSymbolicLink
  }

  if (metadata.st_mode & S_IFMT) != S_IFREG {
    throw ControlTransportError.tokenNotRegularFile
  }

  let permissions = UInt16(metadata.st_mode & 0o777)
  guard permissions == 0o600 else {
    throw ControlTransportError.tokenPermissions(permissions)
  }

  let token = try String(contentsOfFile: path, encoding: .utf8)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !token.isEmpty else {
    throw ControlTransportError.tokenEmpty
  }

  return token
}
