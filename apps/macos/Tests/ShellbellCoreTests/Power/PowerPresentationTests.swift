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
}
