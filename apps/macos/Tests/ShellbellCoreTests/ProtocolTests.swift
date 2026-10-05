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
}
