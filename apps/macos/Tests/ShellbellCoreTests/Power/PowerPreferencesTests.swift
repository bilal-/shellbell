import Foundation
import XCTest

@testable import ShellbellCore

final class PowerPreferencesTests: XCTestCase {
  private func withStore(_ body: (PowerPreferencesStore, UserDefaults) throws -> Void) rethrows {
    let suite = "ShellbellPowerTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    try body(PowerPreferencesStore(defaults: defaults), defaults)
  }

  func testDefaultsNeverPreventSleepAndSavedChoicesSurviveReload() throws {
    try withStore { store, defaults in
      XCTAssertEqual(store.load(), PowerPreferences())
      let value = PowerPreferences(keepAwake: true, allowDisplaySleep: false, allowLidSleep: false)
      try store.save(value)
      XCTAssertEqual(PowerPreferencesStore(defaults: defaults).load(), value)
      XCTAssertEqual(
        defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("shellbell.power") },
        ["shellbell.power.preferences"])
    }
  }

  func testMissingAllowKeysDefaultToAllowSleep() {
    withStore { store, defaults in
      defaults.set(
        Data(#"{"v":1,"preferences":{"keepAwake":true}}"#.utf8),
        forKey: "shellbell.power.preferences")
      XCTAssertEqual(
        store.load(), .init(keepAwake: true, allowDisplaySleep: true, allowLidSleep: true))
    }
  }

  func testMalformedOrUnknownVersionsFailClosedWithoutRewriting() {
    withStore { store, defaults in
      for raw in [
        "garbage", #"{"v":2,"preferences":{"keepAwake":true}}"#,
        #"{"v":1,"preferences":{"keepAwake":"yes"}}"#,
        #"{"v":1,"preferences":{"keepAwake":true,"allowDisplaySleep":null}}"#,
      ] {
        let bytes = Data(raw.utf8)
        defaults.set(bytes, forKey: "shellbell.power.preferences")
        XCTAssertEqual(store.load(), PowerPreferences())
        XCTAssertEqual(defaults.data(forKey: "shellbell.power.preferences"), bytes)
      }
    }
  }
  func testBatteryPreferenceRequiresExplicitOptInAndRejectsMalformedValues() throws {
    try withStore { store, defaults in
      defaults.set(
        Data(#"{"v":1,"preferences":{"keepAwake":true}}"#.utf8),
        forKey: "shellbell.power.preferences")
      XCTAssertFalse(store.load().keepAwakeOnBattery)
      let enabled = PowerPreferences(keepAwake: true, keepAwakeOnBattery: true)
      try store.save(enabled)
      XCTAssertEqual(PowerPreferencesStore(defaults: defaults).load(), enabled)
      for raw in [
        #"{"v":1,"preferences":{"keepAwake":true,"keepAwakeOnBattery":null}}"#,
        #"{"v":1,"preferences":{"keepAwake":true,"keepAwakeOnBattery":"yes"}}"#,
      ] {
        let bytes = Data(raw.utf8)
        defaults.set(bytes, forKey: "shellbell.power.preferences")
        XCTAssertEqual(store.load(), PowerPreferences())
        XCTAssertEqual(defaults.data(forKey: "shellbell.power.preferences"), bytes)
      }
    }
  }

}
