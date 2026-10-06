import Darwin
import XCTest

@testable import ShellbellCore

final class PowerHostTests: XCTestCase {
  func testRecognizesDarwinByteTruncatedSleepManagerName() {
    let truncated = String(decoding: "Amphetamine Enhancer".utf8.prefix(Int(MAXCOMLEN)), as: UTF8.self)
    let host = powerHelperHost(
      power: .ac, consoleName: "fixture", consoleUID: 501, processNames: [truncated])
    XCTAssertTrue(host.competingController)
  }

  func testOtherSleepManagersAndTruncatedHelperNamesAreRecognized() {
    for name in [
      "Caffeine", "KeepingYouAwake", "NoSleep", "InsomniaX", "Lungo", "Owly",
      "Amphetamine Enha", "amphetamine",
    ] {
      let host = powerHelperHost(
        power: .ac, consoleName: "tester", consoleUID: 501, processNames: [name])
      XCTAssertTrue(host.competingController, name)
    }
    for name in ["caffeinate", "Shellbell", "CaffeineTests", "LungoImporter"] {
      let host = powerHelperHost(
        power: .ac, consoleName: "tester", consoleUID: 501, processNames: [name])
      XCTAssertFalse(host.competingController, name)
    }
  }

  func testConsoleIdentityAndProcessInspectionFailClosed() {
    for (name, uid) in [(nil as String?, UInt32(501)), ("loginwindow", 501), ("root", 0)] {
      let host = powerHelperHost(power: .ac, consoleName: name, consoleUID: uid, processNames: [])
      XCTAssertNil(host.consoleUID)
    }
    let unknown = powerHelperHost(
      power: .ac, consoleName: "bilal", consoleUID: 501, processNames: nil)
    XCTAssertTrue(unknown.competingController)
    XCTAssertNil(unknown.consoleUID)
  }

  func testRecognizedControllerBlocksButUnrelatedIdleAssertionToolDoesNot() {
    let active = powerHelperHost(
      power: .ac, consoleName: "bilal", consoleUID: 501,
      processNames: ["launchd", "Amphetamine", "Shellbell"])
    XCTAssertTrue(active.competingController)
    let normal = powerHelperHost(
      power: .battery, consoleName: "bilal", consoleUID: 501,
      processNames: ["launchd", "caffeinate", "Shellbell"])
    XCTAssertFalse(normal.competingController)
    XCTAssertEqual(normal.consoleUID, 501)
    XCTAssertEqual(normal.power, .battery)
  }
}
