import XCTest

@testable import ShellbellCore

final class PowerPolicyTests: XCTestCase {
  func testAllPreferencesRequireFreshDesktopAccessOnAC() {
    // Literal outcomes: an inverted Allow checkbox or missing eligibility gate fails.
    let cases: [(Bool, Bool, Bool, PowerDemand)] = [
      (
        false, false, false,
        .init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
      ),
      (
        false, false, true,
        .init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
      ),
      (
        false, true, false,
        .init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
      ),
      (
        false, true, true,
        .init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
      ),
      (
        true, false, false,
        .init(preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: true)
      ),
      (
        true, false, true,
        .init(preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: false)
      ),
      (
        true, true, false,
        .init(preventIdleSystem: true, preventIdleDisplay: false, requestClosedLid: true)
      ),
      (
        true, true, true,
        .init(preventIdleSystem: true, preventIdleDisplay: false, requestClosedLid: false)
      ),
    ]
    let none = PowerDemand(
      preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
    for (master, display, lid, expected) in cases {
      let p = PowerPreferences(keepAwake: master, allowDisplaySleep: display, allowLidSleep: lid)
      for power in [ExternalPower.ac, .battery, .unknown] {
        for verified in [false, true] {
          for fresh in [false, true] {
            let e = PowerEligibility(
              power: power, desktopServiceVerified: verified,
              statusFresh: fresh, isLaptop: true)
            XCTAssertEqual(powerDemand(p, e), power == .ac && verified && fresh ? expected : none)
          }
        }
      }
    }
  }

  func testDesktopHardwareNeverRequestsLidOverride() {
    let p = PowerPreferences(keepAwake: true, allowDisplaySleep: false, allowLidSleep: false)
    XCTAssertEqual(
      powerDemand(
        p,
        .init(
          power: .ac, desktopServiceVerified: true,
          statusFresh: true, isLaptop: false)),
      .init(preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: false))
  }
}
