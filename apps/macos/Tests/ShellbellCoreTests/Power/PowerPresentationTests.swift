import XCTest

@testable import ShellbellCore

final class PowerPresentationTests: XCTestCase {
  func testOrdinaryAndClosedLidProtectionAreDistinguished() {
    let ordinary = PowerPresentation(
      status: .active, lidActive: false, idleSystemActive: true, idleDisplayActive: false)
    XCTAssertEqual(ordinary.title, "Idle sleep is prevented")
    XCTAssertTrue(ordinary.detail.contains("closed-lid protection is off"))
    XCTAssertTrue(ordinary.detail.contains("allows display sleep"))
    let lid = PowerPresentation(
      status: .active, lidActive: true, idleSystemActive: true, idleDisplayActive: true)
    XCTAssertEqual(lid.title, "Closed-lid access is active")
    XCTAssertTrue(lid.detail.contains("override is verified"))
    XCTAssertTrue(lid.detail.contains("Display sleep is prevented"))
  }

  func testPendingApprovalDoesNotImplyFailureOrActiveProtection() {
    let pending = PowerPresentation(
      status: .setupRequired, lidActive: false, idleSystemActive: true,
      idleDisplayActive: false, approvalPending: true)
    XCTAssertEqual(pending.title, "Waiting for macOS approval")
    XCTAssertTrue(pending.detail.contains("Closed-lid access is not active"))
    XCTAssertTrue(pending.detail.contains("Idle sleep is prevented"))
  }

  func testTurningOffDoesNotPromiseAnotherAppsSleepControlsAreGone() {
    let off = PowerPresentation(
      status: .off, lidActive: false, idleSystemActive: false, idleDisplayActive: false)
    XCTAssertTrue(off.detail.contains("other apps can still keep this Mac awake"))
    let restoring = PowerPresentation(
      status: .restoring, lidActive: false, idleSystemActive: false, idleDisplayActive: false)
    XCTAssertEqual(restoring.title, "Turning off closed-lid access…")
    XCTAssertTrue(restoring.detail.contains("Waiting for the helper"))
  }
  func testBatteryAndUnknownPowerExplainWhichControlsArePaused() {
    let paused = PowerPresentation(
      status: .waitingForPower, lidActive: false, idleSystemActive: false,
      idleDisplayActive: false, powerSource: .battery)
    XCTAssertEqual(paused.title, "Keep-awake is paused on battery")
    XCTAssertTrue(paused.detail.contains("enable Keep awake on battery"))
    let unknown = PowerPresentation(
      status: .waitingForPower, lidActive: false, idleSystemActive: false,
      idleDisplayActive: false, powerSource: .unknown)
    XCTAssertEqual(unknown.title, "Power source unavailable")
    XCTAssertTrue(unknown.detail.contains("can be verified"))
    let active = PowerPresentation(
      status: .active, lidActive: false, idleSystemActive: true, idleDisplayActive: false,
      powerSource: .battery, closedLidRequested: true)
    XCTAssertEqual(active.title, "Idle sleep prevented on battery")
    XCTAssertTrue(active.detail.contains("uses battery power"))
    XCTAssertTrue(active.detail.contains("Closed-lid access is paused on battery"))
    XCTAssertTrue(active.detail.contains("allows display sleep"))
  }

}
