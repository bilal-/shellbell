import Foundation
import XCTest

@testable import ShellbellPower

final class SystemSleepOverrideTests: XCTestCase {
  @MainActor func testUnsetOverrideIsOffOnlyWithCompletePowerSettingsReadback() throws {
    let output = """
      System-wide power settings:
      Currently in use:
       standby 1
       sleep 1 (sleep prevented by powerd, Shellbell)
       displaysleep 10
      """
    XCTAssertFalse(try SystemSleepOverride { _ in Data(output.utf8) }.readEnabled())
    for incomplete in [
      "System-wide power settings:",
      "Currently in use:\n sleep 1",
      "System-wide power settings:\nCurrently in use:",
      "System-wide power settings:\n SleepDisabled\nCurrently in use:\n sleep 1",
      "System-wide power settings:\nCurrently in use:\n sleep unknown",
    ] {
      XCTAssertThrowsError(try SystemSleepOverride { _ in Data(incomplete.utf8) }.readEnabled())
    }
  }

  @MainActor func testOnlyFixedCommandsAreEmittedAndReadbackMustBeUnambiguous() throws {
    var calls: [[String]] = []
    let adapter = SystemSleepOverride { args in
      calls.append(args)
      return Data(
        "System-wide power settings:\n SleepDisabled 0\nCurrently in use:\n sleep 1\n".utf8)
    }
    XCTAssertFalse(try adapter.readEnabled())
    try adapter.setEnabled(true)
    try adapter.setEnabled(false)
    XCTAssertEqual(calls, [["-g"], ["-a", "disablesleep", "1"], ["-a", "disablesleep", "0"]])
    for text in [
      "", "SleepDisabled 2", "SleepDisabled 1\nSleepDisabled 0", "SleepDisabled true",
      "SleepDisabled 1 extra",
    ] {
      let invalid = SystemSleepOverride { _ in Data(text.utf8) }
      XCTAssertThrowsError(try invalid.readEnabled())
    }
    XCTAssertTrue(try SystemSleepOverride { _ in Data("SleepDisabled 1\n".utf8) }.readEnabled())
  }

  func testBoundedRunnerReturnsOutputAndRejectsExitFailure() throws {
    XCTAssertEqual(
      try BoundedPowerCommand.run(executable: "/usr/bin/printf", arguments: ["hello"]),
      Data("hello".utf8))
    XCTAssertThrowsError(try BoundedPowerCommand.run(executable: "/usr/bin/false", arguments: []))
  }
  func testBoundedRunnerTerminatesExcessOutputAndDeadline() {
    XCTAssertThrowsError(
      try BoundedPowerCommand.run(executable: "/usr/bin/yes", arguments: [], timeout: 1, limit: 128)
    )
    let start = ProcessInfo.processInfo.systemUptime
    XCTAssertThrowsError(
      try BoundedPowerCommand.run(executable: "/bin/sleep", arguments: ["20"], timeout: 0.05))
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2)
  }
}
