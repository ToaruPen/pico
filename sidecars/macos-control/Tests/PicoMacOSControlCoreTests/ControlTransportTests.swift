import Darwin
import Foundation
import Testing

@testable import PicoMacOSControlCore

@Suite("macOS control transport")
struct ControlTransportTests {
  @Test("builds authenticated event and health requests")
  func buildsRequests() throws {
    let builder = ControlRequestBuilder(
      baseURL: try #require(URL(string: "http://127.0.0.1:8781")),
      token: "secret-token"
    )
    let event = try builder.eventRequest(.talkPressed)
    let health = builder.healthRequest()

    #expect(event.url?.path == "/v1/resident-control/events")
    #expect(event.httpMethod == "POST")
    #expect(event.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
    let body = try #require(event.httpBody)
    #expect(
      try JSONSerialization.jsonObject(with: body) as? [String: String]
        == ["event": "talk_pressed"])
    #expect(health.url?.path == "/v1/resident-control/health")
    #expect(health.httpMethod == "GET")
  }

  @Test("reads only a regular nonempty 0600 token file")
  func readsProtectedToken() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let token = directory.appendingPathComponent("token")
    try Data("secret-token\n".utf8).write(to: token)
    #expect(chmod(token.path, 0o600) == 0)
    #expect(try readControlToken(path: token.path) == "secret-token")
    #expect(chmod(token.path, 0o644) == 0)
    #expect(throws: ControlTransportError.self) {
      try readControlToken(path: token.path)
    }
  }

  @Test("rejects token symbolic links")
  func rejectsSymbolicLink() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let token = directory.appendingPathComponent("token")
    let link = directory.appendingPathComponent("link")
    try Data("secret-token\n".utf8).write(to: token)
    #expect(chmod(token.path, 0o600) == 0)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: token)

    #expect(throws: ControlTransportError.self) {
      try readControlToken(path: link.path)
    }
  }
}
