import Darwin
import Foundation
import XCTest
@testable import ShellbellCore
@testable import ShellbellPower

final class BSDProcessNameTests: XCTestCase {
  func testKernelTruncatedUTF8NameDoesNotInvalidateHostEvidence() {
    let bytes = Array("abcdefghijklmno界".utf8.prefix(Int(MAXCOMLEN))) + [UInt8(0)]
    let name: String? = bytes.withUnsafeBytes { NativePowerHelperEvents.decodeProcessName($0) }
    let host = powerHelperHost(
      power: .ac, consoleName: "fixture", consoleUID: 501,
      processNames: name.map { [$0] })
    XCTAssertFalse(host.competingController)
    XCTAssertEqual(host.consoleUID, 501)
    XCTAssertEqual(name, "abcdefghijklmno\u{FFFD}")
  }

  func testDecodesBoundedKernelNameAndStopsAtNUL() {
    func decode(_ bytes: [UInt8]) -> String? {
      bytes.withUnsafeBytes { NativePowerHelperEvents.decodeProcessName($0) }
    }
    XCTAssertEqual(decode(Array("Caffeine".utf8) + [0, 255]), "Caffeine")
    XCTAssertEqual(decode(Array("界".utf8) + [0]), "界")
    XCTAssertEqual(decode([0, 255]), "")
    XCTAssertEqual(decode([0xE7, 0x95, 0]), "\u{FFFD}")
  }
}
