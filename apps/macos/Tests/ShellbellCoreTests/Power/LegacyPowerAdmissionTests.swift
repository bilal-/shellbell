import Foundation
import XCTest
@testable import ShellbellPower

final class LegacyPowerAdmissionTests: XCTestCase {
  func testInstalledOrLoadedLegacyHelperBlocks() throws {
    XCTAssertTrue(try LegacyPowerAdmission.isPresent(installed: { true }, inspect: { _ in
      XCTFail("Installed helper needs no subprocess"); return Data()
    }))
    XCTAssertTrue(try LegacyPowerAdmission.isPresent(installed: { false }, inspect: { _ in Data() }))
  }

  func testOnlyConfirmedAbsentWithoutOverrideIsAdmitted() throws {
    for record in ["", "\"dev.bilalahmad.shellbell.power\" => false"] {
      let present = try LegacyPowerAdmission.isPresent(installed: { false }, inspect: { arguments in
        if arguments.first == "print" { throw BoundedPowerCommand.Failure.exit(113 << 8) }
        XCTAssertEqual(arguments, ["print-disabled", "system"])
        return Data("disabled services = {\n\(record)\n}\n".utf8)
      })
      XCTAssertEqual(present, !record.isEmpty)
    }
  }

  func testUnknownInspectionFailsClosed() {
    XCTAssertThrowsError(try LegacyPowerAdmission.isPresent(installed: { false }, inspect: { _ in
      throw BoundedPowerCommand.Failure.exit(1 << 8)
    }))
    XCTAssertThrowsError(try LegacyPowerAdmission.isPresent(installed: { false }, inspect: { args in
      if args.first == "print" { throw BoundedPowerCommand.Failure.exit(113 << 8) }
      return Data("unexpected output".utf8)
    }))
    XCTAssertThrowsError(try LegacyPowerAdmission.isPresent(installed: {
      throw BoundedPowerCommand.Failure.io(13)
    }, inspect: { _ in XCTFail("Unknown filesystem status must stop setup"); return Data() }))
  }
}
