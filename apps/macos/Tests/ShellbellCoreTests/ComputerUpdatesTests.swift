import Foundation
import XCTest
@testable import ShellbellCore

final class ComputerUpdatesTests: XCTestCase {
  @MainActor private func fixture(build: Int = 30, arm64: Bool = true, os: String = "14.0.0") -> (ComputerUpdates, FixtureTransport, FixtureClock) {
    let transport = FixtureTransport(); let clock = FixtureClock()
    let model = ComputerUpdates(version: "0.8.0", build: build, arm64: arm64, osVersion: os,
      clock: clock, makeTransport: { transport })
    return (model, transport, clock)
  }
  private func response(version: String = "0.9.0", build: Int = 31, minimum: String = "13.0", asset: String? = nil) -> Data {
    try! JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "currentVersion": "0.8.0", "release": [
        "version": version, "tag": "shellbell@" + version, "component": "computer", "channel": "stable",
        "platforms": ["macosArm64": ["asset": asset ?? "Shellbell-\(version)-arm64.dmg",
          "buildNumber": build, "minimumOS": minimum, "signed": true, "notarized": true]]]])
  }
  @MainActor func testOnlyExplicitCheckStartsIsolatedCheckerAndOffersOfficialInstaller() {
    let (model, child, clock) = fixture()
    XCTAssertFalse(model.checking); XCTAssertNil(child.onData); XCTAssertTrue(clock.seconds.isEmpty)
    model.check(); model.check()
    XCTAssertEqual(clock.seconds, [35]); XCTAssertTrue(child.writes.isEmpty)
    let bytes = response()
    child.onData?(bytes.prefix(20)); child.onData?(bytes.dropFirst(20)); child.onEnd?()
    XCTAssertFalse(model.checking); XCTAssertTrue(child.closed)
    XCTAssertEqual(model.offer?.download?.absoluteString,
      "https://github.com/bilal-/shellbell/releases/download/shellbell%400.9.0/Shellbell-0.9.0-arm64.dmg")
    XCTAssertTrue(clock.active.isEmpty)
  }
  @MainActor func testNativeBuildUpdatesAndNoDowngrades() {
    for (version, build, available) in [("0.8.0", 31, true), ("0.8.0", 30, false), ("0.7.0", 99, false)] {
      let (model, child, _) = fixture()
      model.check(); child.onData?(response(version: version, build: build)); child.onEnd?()
      XCTAssertEqual(model.offer != nil, available)
    }
  }
  @MainActor func testUnsupportedMachinesAndMalformedAssetsCannotOfferDownload() {
    for (arm64, os, asset) in [(false, "14.0.0", "Shellbell-0.9.0-arm64.dmg"),
      (true, "12.0.0", "Shellbell-0.9.0-arm64.dmg"), (true, "14.0.0", "../../other.dmg")] {
      let (model, child, _) = fixture(arm64: arm64, os: os)
      model.check(); child.onData?(response(asset: asset)); child.onEnd?()
      XCTAssertNotNil(model.offer?.notes); XCTAssertNil(model.offer?.download)
    }
  }
  @MainActor func testTimeoutCancellationRetryAndLateCallbacks() {
    let (model, child, clock) = fixture()
    model.check(); let lateData = child.onData; let lateEnd = child.onEnd
    clock.fire()
    XCTAssertFalse(model.checking); XCTAssertTrue(child.closed); XCTAssertTrue(model.message.contains("timed out"))
    model.check(); lateData?(response()); lateEnd?()
    XCTAssertTrue(model.checking); XCTAssertNil(model.offer)
    model.cancel(); XCTAssertFalse(model.checking); XCTAssertNil(child.onData); XCTAssertTrue(clock.active.isEmpty)
  }
  @MainActor func testInvalidOrOversizedResponseFailsWithoutOffer() {
    for bytes in [Data("not JSON".utf8), Data(repeating: 65, count: 65537)] {
      let (model, child, _) = fixture()
      model.check(); child.onData?(bytes); child.onEnd?()
      XCTAssertFalse(model.checking); XCTAssertNil(model.offer); XCTAssertTrue(child.closed)
    }
  }
  func testUpdatePlanUsesFixedReadOnlyArgumentsAndNoServiceEntrypoint() throws {
    let plan = try LaunchPlan(bundle: "/Applications/Shellbell.app", home: "/Users/fixture", user: "fixture", updateCheck: true)
    XCTAssertEqual(plan.arguments, ["/Applications/Shellbell.app/Contents/Resources/agent/dist/cli.js", "update", "--check", "--json"])
    XCTAssertThrowsError(try LaunchPlan(bundle: "/Applications/Shellbell.app", home: "/Users/fixture", user: "fixture", serviceMode: "desktop", updateCheck: true))
  }
}
