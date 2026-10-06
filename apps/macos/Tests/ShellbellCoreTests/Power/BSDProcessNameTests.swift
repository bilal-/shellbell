import Foundation
import XCTest
@testable import ShellbellPower

final class BSDProcessNameTests: XCTestCase {
  func testDecodesBoundedKernelNameAndStopsAtNUL() {
    func decode(_ bytes: [UInt8]) -> String? {
      bytes.withUnsafeBytes { NativePowerHelperEvents.decodeProcessName($0) }
    }
    XCTAssertEqual(decode(Array("Caffeine".utf8) + [0, 255]), "Caffeine")
    XCTAssertEqual(decode(Array("界".utf8) + [0]), "界")
    XCTAssertEqual(decode([0, 255]), "")
    XCTAssertNil(decode([0xE7, 0x95, 0])) // Existing failure on a truncated UTF-8 scalar.
  }
}
