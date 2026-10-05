import XCTest

@testable import ShellbellCore

final class PowerHelperEntryTests: XCTestCase {
  func testOnlyArgumentFreeRootDaemonInvocationIsAccepted() throws {
    XCTAssertNoThrow(try PowerHelperAdmission.validate(arguments: [], realUID: 0, effectiveUID: 0))
    for (real, effective) in [(UInt32(501), UInt32(501)), (501, 0), (0, 501)] {
      XCTAssertThrowsError(
        try PowerHelperAdmission.validate(arguments: [], realUID: real, effectiveUID: effective))
    }
    for args in [["--team", "ABCDEFGHIJ"], ["--path", "/tmp/evil"], ["recover"], ["--help"]] {
      XCTAssertThrowsError(
        try PowerHelperAdmission.validate(arguments: args, realUID: 0, effectiveUID: 0))
    }
  }
}
