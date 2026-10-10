import XCTest

@testable import ShellbellCore

final class FingerprintFormatTests: XCTestCase {
  func testGroupsMatchThePhone() {
    XCTAssertEqual(formatFingerprint("abcdefghijklmnopqrstuvwxyz"), "abcd efgh ijkl mnop qrst uvwx yz")
    XCTAssertEqual(formatFingerprint(""), "")
  }
}
