import Foundation
import XCTest

@testable import ShellbellCore

final class ProtocolTests: XCTestCase {
  func testDecoderRefusesByteOverflowBeforeJSONParsingAndLeadingBOM() {
    XCTAssertThrowsError(
      try Wire.decode(
        Data(repeating: 32, count: 65_537) + Data("{\"v\":1,\"id\":1,\"cmd\":\"hello\"}".utf8),
        kind: "request"))
    XCTAssertThrowsError(
      try Wire.decode(
        Data([0xef, 0xbb, 0xbf]) + Data("{\"v\":1,\"id\":1,\"cmd\":\"hello\"}".utf8),
        kind: "request"))
  }
  func testSharedTypeScriptVectors() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Fixtures/native-protocol.json")
    let vectors = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: file))
    for v in vectors {
      XCTAssertEqual(
        Wire.valid(v["value"], kind: v["kind"].string!, command: v["command"].string),
        v["valid"].bool!, v["name"].string!)
    }
  }

  func testTerminalListsMatchTheServiceSchema() {
    func reply(_ terminals: [JSONValue]) -> JSONValue {
      .object([
        "v": .number(1), "id": .number(1), "ok": .bool(true),
        "data": .object(["supported": .bool(true), "terminals": .array(terminals)]),
      ])
    }
    let iterm: JSONValue = .object(["name": .string("iterm2"), "connected": .bool(true)])
    XCTAssertTrue(Wire.valid(reply([iterm]), kind: "response", command: "terminals"))
    // The service never sends one terminal twice, which would also confuse the list's identity.
    XCTAssertFalse(Wire.valid(reply([iterm, iterm]), kind: "response", command: "terminals"))
    let broken: JSONValue = .object([
      "name": .string("herdr"), "connected": .bool(false), "issue": .string("limited"),
      "detail": .string("two\nlines"),
    ])
    XCTAssertFalse(Wire.valid(reply([broken]), kind: "response", command: "terminals"))
  }
}
