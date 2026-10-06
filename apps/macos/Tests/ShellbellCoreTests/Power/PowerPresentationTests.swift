import XCTest
@testable import ShellbellCore

final class PowerPresentationTests: XCTestCase {
  func testIdleDisplayAndLidClaimsAreDistinctFromIntentAndApproval() {
    let ordinary = PowerPresentation(
      status: .active, closedLidStatus: .off, idleSystemHealth: .active,
      idleDisplayHealth: .off, powerSource: .ac)
    XCTAssertEqual(ordinary.idle, "Active")
    XCTAssertEqual(ordinary.display, "May sleep")
    XCTAssertEqual(ordinary.lid, "Off")
    let pending = PowerPresentation(
      status: .setupRequired, closedLidStatus: .setupRequired, idleSystemHealth: .active,
      idleDisplayHealth: .off, powerSource: .ac, approvalPending: true)
    XCTAssertEqual(pending.lid, "Approval needed")
    XCTAssertEqual(pending.idle, "Active")
    XCTAssertTrue(pending.detail.contains("System Settings"))
    let partial = PowerPresentation(
      status: .recoveryRequired, closedLidStatus: .active, idleSystemHealth: .active,
      idleDisplayHealth: .unverified, powerSource: .ac)
    XCTAssertEqual(partial.lid, "Active")
    XCTAssertEqual(partial.idle, "Active")
    XCTAssertEqual(partial.display, "Not verified")
  }

  func testTurningOffDoesNotPromiseAnotherAppsSleepControlsAreGone() {
    let observation = PowerSystemObservation(snapshot: .init(
      sleepDisabled: true, otherIdleSleepRequests: true, otherDisplaySleepRequests: false), capturedAt: 10)
    let off = PowerPresentation(
      status: .off, closedLidStatus: .off, idleSystemHealth: .off, idleDisplayHealth: .off,
      powerSource: .ac, systemObservation: observation)
    XCTAssertEqual(off.idle, "Off")
    XCTAssertEqual(off.systemSleep, "On")
    XCTAssertEqual(off.otherIdle, "Present")
    XCTAssertEqual(off.otherDisplay, "None observed")
    XCTAssertNotNil(off.systemWarning)
    let restoring = PowerPresentation(
      status: .restoring, closedLidStatus: .restoring, idleSystemHealth: .off,
      idleDisplayHealth: .off, powerSource: .ac, systemObservation: observation)
    XCTAssertEqual(restoring.lid, "Turning off…")
    XCTAssertNil(restoring.systemWarning)
  }

  func testBatteryAndUnknownPowerExplainWhichControlsArePaused() {
    let paused = PowerPresentation(
      status: .waitingForPower, closedLidStatus: .waitingForPower,
      idleSystemHealth: .off, idleDisplayHealth: .off, powerSource: .battery)
    XCTAssertEqual(paused.title, "Paused on battery")
    XCTAssertTrue(paused.detail.contains("Include battery power"))
    let active = PowerPresentation(
      status: .active, closedLidStatus: .waitingForPower,
      idleSystemHealth: .active, idleDisplayHealth: .off, powerSource: .battery)
    XCTAssertEqual(active.title, "Keeping awake on battery")
    XCTAssertEqual(active.idle, "Active")
    XCTAssertEqual(active.lid, "Plug in to enable")
    let unknown = PowerPresentation(
      status: .waitingForPower, closedLidStatus: .waitingForPower,
      idleSystemHealth: .off, idleDisplayHealth: .off, powerSource: .unknown)
    XCTAssertEqual(unknown.lid, "Power source unknown")
    XCTAssertEqual(unknown.systemSleep, "Not verified")
    XCTAssertEqual(unknown.otherIdle, "Not verified")
  }

  func testFailedTurnOffPreservesKnownActivityAndNamesTheFailedChange() {
    let value = PowerPresentation(
      status: .recoveryRequired, closedLidStatus: .off,
      idleSystemHealth: .active, idleDisplayHealth: .activeWithFailure, powerSource: .ac)
    XCTAssertEqual(value.idle, "Active")
    XCTAssertEqual(value.display, "Still active; change failed")
    XCTAssertEqual(value.lid, "Off")
  }

  func testConflictAndInterruptionExplainManualCommandsWithoutGuessingTheirSource() {
    let conflict = PowerPresentation(
      status: .conflict, closedLidStatus: .conflict,
      idleSystemHealth: .active, idleDisplayHealth: .off, powerSource: .ac)
    XCTAssertTrue(conflict.detail.contains("manual power changes"))
    XCTAssertTrue(conflict.detail.contains("other sleep-management apps"))
    let interrupted = PowerPresentation(
      status: .interrupted, closedLidStatus: .interrupted,
      idleSystemHealth: .active, idleDisplayHealth: .off, powerSource: .ac)
    XCTAssertEqual(interrupted.lid, "Paused after a power change")
    XCTAssertTrue(interrupted.detail.contains("then retry"))
    XCTAssertEqual(interrupted.idle, "Active")
  }
}
