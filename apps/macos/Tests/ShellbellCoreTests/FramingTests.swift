import Foundation
import XCTest

@testable import ShellbellCore

final class FramingTests: XCTestCase {
  func testFragmentationCoalescingAndUTF8AcrossChunks() throws {
    var framer = LineFramer()
    XCTAssertEqual(try framer.append(Data([0x22, 0xc3])), [])
    XCTAssertEqual(
      try framer.append(Data([0xa9, 0x22, 10, 123, 125, 10])),
      [Data("\"é\"".utf8), Data("{}".utf8)])
  }
  func testExactByteLimitAndOverflow() throws {
    var good = LineFramer()
    XCTAssertEqual(
      try good.append(Data(repeating: 32, count: 65_536) + Data([10])).first?.count, 65_536)
    var bad = LineFramer()
    XCTAssertThrowsError(try bad.append(Data(repeating: 32, count: 65_537)))
  }
  func testInvalidUTF8AndTruncatedEOFRefuse() throws {
    var bad = LineFramer()
    XCTAssertThrowsError(try bad.append(Data([0xc0, 0x80, 10])))
    var partial = LineFramer()
    _ = try partial.append(Data("{}".utf8))
    XCTAssertThrowsError(try partial.finish())
  }
}
