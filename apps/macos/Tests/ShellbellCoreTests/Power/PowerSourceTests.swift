import XCTest

@testable import ShellbellCore

final class PowerSourceTests: XCTestCase {
  func testACClassificationDoesNotUseChargingAndUPSIsNotAC() {
    XCTAssertEqual(
      classifyPowerSource(.init(source: .ac, internalBatteryPresent: true)),
      .init(power: .ac, isLaptop: true))
    XCTAssertEqual(
      classifyPowerSource(.init(source: .ac, internalBatteryPresent: false)),
      .init(power: .ac, isLaptop: false))
    XCTAssertEqual(
      classifyPowerSource(.init(source: .battery, internalBatteryPresent: true)),
      .init(power: .battery, isLaptop: true))
    for source in [PowerSourceSnapshot.Source.ups, .unknown] {
      XCTAssertEqual(
        classifyPowerSource(.init(source: source, internalBatteryPresent: true)).power, .unknown)
    }
  }
  func testAmbiguousHardwareFailsClosedEvenWithACReading() {
    XCTAssertEqual(
      classifyPowerSource(.init(source: .ac, internalBatteryPresent: nil)),
      .init(power: .unknown, isLaptop: false))
  }
}
