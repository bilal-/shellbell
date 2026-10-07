import Foundation
import XCTest

@testable import ShellbellCore

final class PowerPreferencesTests: XCTestCase {
    func testFreshLaunchDiscardsAllPreviouslyEnabledPowerControls() {
        withStore { defaults in
            defaults.set(Data(#"{"v":1,"preferences":{"keepAwake":true,"keepAwakeOnBattery":true,"allowDisplaySleep":false,"allowLidSleep":false}}"#.utf8), forKey: "shellbell.power.preferences")
            defaults.set("kept", forKey: "unrelated.setting")
            XCTAssertEqual(PowerPreferences.startSession(defaults: defaults), PowerPreferences())
            XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
            XCTAssertEqual(defaults.string(forKey: "unrelated.setting"), "kept")
        }
    }
  private func withStore(_ body: (UserDefaults) -> Void) {
    let suite = "ShellbellPowerTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    body(defaults)
  }

  func testFreshLaunchClearsMalformedLegacyChoicesToo() {
    withStore { defaults in
      for value in [Data("garbage".utf8), Data(#"{"v":999,"preferences":{"keepAwake":true}}"#.utf8)] {
        defaults.set(value, forKey: "shellbell.power.preferences")
        XCTAssertEqual(PowerPreferences.startSession(defaults: defaults), PowerPreferences())
        XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
      }
    }
  }

  func testNewSessionStartsOffAfterPreviousSessionChangedEveryChoice() {
    withStore { defaults in
      var current = PowerPreferences.startSession(defaults: defaults)
      current.keepAwake = true
      current.keepAwakeOnBattery = true
      current.allowDisplaySleep = false
      current.allowLidSleep = false
      let fresh = PowerPreferences.startSession(defaults: defaults)
      XCTAssertEqual(fresh, PowerPreferences())
      XCTAssertNotEqual(fresh, current)
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
    }
  }
}
