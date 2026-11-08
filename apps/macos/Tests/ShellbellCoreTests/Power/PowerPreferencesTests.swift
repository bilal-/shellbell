import Foundation
import XCTest

@testable import ShellbellCore

final class PowerPreferencesTests: XCTestCase {
  private let quitAt = Date(timeIntervalSince1970: 1_800_000_000)
  private var everyChoice: PowerPreferences {
    PowerPreferences(
      keepAwake: true, keepAwakeOnBattery: true, allowDisplaySleep: false, allowLidSleep: false)
  }

  func testClosedLidChoiceClearsBatteryPreference() {
    let preferences = PowerPreferences(
      keepAwake: true, keepAwakeOnBattery: true,
      allowDisplaySleep: false, allowLidSleep: false)
    XCTAssertFalse(preferences.keepAwakeOnBattery)
    XCTAssertTrue(preferences.keepAwake)
    XCTAssertFalse(preferences.allowDisplaySleep)
    XCTAssertFalse(preferences.allowLidSleep)
  }

  func testNormalizationClearsConflictingMutablePreferencesWithoutRestoringBatteryLater() {
    var preferences = PowerPreferences(keepAwake: true, keepAwakeOnBattery: true)
    preferences.allowLidSleep = false
    preferences = preferences.normalized
    XCTAssertFalse(preferences.keepAwakeOnBattery)
    preferences.allowLidSleep = true
    XCTAssertFalse(preferences.normalized.keepAwakeOnBattery)
  }

  func testUpdateHandoffNormalizesOlderConflictingChoices() throws {
    try withStore { defaults in
      let legacy: [String: Any] = [
        "v": 2, "build": "45", "quitAt": quitAt.timeIntervalSince1970,
        "preferences": [
          "keepAwake": true, "keepAwakeOnBattery": true,
          "allowDisplaySleep": false, "allowLidSleep": false,
        ],
      ]
      defaults.set(
        try JSONSerialization.data(withJSONObject: legacy),
        forKey: "shellbell.power.preferences")
      let restored = PowerPreferences.startSession(
        defaults: defaults, build: "46", now: quitAt.addingTimeInterval(60))
      XCTAssertEqual(restored, everyChoice)
      XCTAssertFalse(restored.keepAwakeOnBattery)
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
    }
  }

  func testUpdateHandoffSavesNormalizedChoices() throws {
    try withStore { defaults in
      var preferences = PowerPreferences(keepAwake: true, keepAwakeOnBattery: true)
      preferences.allowLidSleep = false
      PowerPreferences.endSession(preferences, defaults: defaults, build: "45", now: quitAt)
      let bytes = try XCTUnwrap(defaults.data(forKey: "shellbell.power.preferences"))
      let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
      let choices = try XCTUnwrap(saved["preferences"] as? [String: Bool])
      XCTAssertEqual(choices["keepAwakeOnBattery"], false)
      XCTAssertEqual(choices["allowLidSleep"], false)
    }
  }

  func testFreshLaunchDiscardsAllPreviouslyEnabledPowerControls() {
    withStore { defaults in
      defaults.set(
        Data(
          #"{"v":1,"preferences":{"keepAwake":true,"keepAwakeOnBattery":true,"allowDisplaySleep":false,"allowLidSleep":false}}"#
            .utf8), forKey: "shellbell.power.preferences")
      defaults.set("kept", forKey: "unrelated.setting")
      XCTAssertEqual(
        PowerPreferences.startSession(defaults: defaults, build: "46", now: quitAt),
        PowerPreferences())
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
      XCTAssertEqual(defaults.string(forKey: "unrelated.setting"), "kept")
    }
  }
  private func withStore(_ body: (UserDefaults) throws -> Void) rethrows {
    let suite = "ShellbellPowerTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    try body(defaults)
  }

  func testFreshLaunchClearsMalformedLegacyChoicesToo() {
    withStore { defaults in
      for value in [
        Data("garbage".utf8), Data(#"{"v":999,"preferences":{"keepAwake":true}}"#.utf8),
      ] {
        defaults.set(value, forKey: "shellbell.power.preferences")
        XCTAssertEqual(
          PowerPreferences.startSession(defaults: defaults, build: "46", now: quitAt),
          PowerPreferences())
        XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
      }
    }
  }

  func testNewSessionStartsOffAfterPreviousSessionChangedEveryChoice() {
    withStore { defaults in
      var current = PowerPreferences.startSession(defaults: defaults, build: "46", now: quitAt)
      current.keepAwake = true
      current.keepAwakeOnBattery = true
      current.allowDisplaySleep = false
      current.allowLidSleep = false
      let fresh = PowerPreferences.startSession(defaults: defaults, build: "46", now: quitAt)
      XCTAssertEqual(fresh, PowerPreferences())
      XCTAssertNotEqual(fresh, current)
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
    }
  }

  func testAnUpdateSoonAfterQuitKeepsEveryChoiceOnce() {
    withStore { defaults in
      PowerPreferences.endSession(everyChoice, defaults: defaults, build: "45", now: quitAt)
      XCTAssertEqual(
        PowerPreferences.startSession(
          defaults: defaults, build: "46", now: quitAt.addingTimeInterval(60)),
        everyChoice)
      // Only the first launch of the new build: quitting it without saving starts off again.
      XCTAssertEqual(
        PowerPreferences.startSession(
          defaults: defaults, build: "46", now: quitAt.addingTimeInterval(120)),
        PowerPreferences())
    }
  }

  func testReopeningTheSameBuildAfterQuitStartsOff() {
    withStore { defaults in
      PowerPreferences.endSession(everyChoice, defaults: defaults, build: "46", now: quitAt)
      XCTAssertEqual(
        PowerPreferences.startSession(
          defaults: defaults, build: "46", now: quitAt.addingTimeInterval(5)),
        PowerPreferences())
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
    }
  }

  func testAnUpdateLongAfterQuitOrBeforeItByTheClockStartsOff() {
    withStore { defaults in
      for gap: TimeInterval in [15 * 60 + 1, 24 * 60 * 60, -60] {
        PowerPreferences.endSession(everyChoice, defaults: defaults, build: "45", now: quitAt)
        XCTAssertEqual(
          PowerPreferences.startSession(
            defaults: defaults, build: "46", now: quitAt.addingTimeInterval(gap)),
          PowerPreferences(), "gap \(gap)")
        XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
      }
    }
  }

  func testQuittingWithEverythingOffLeavesNothingToCarry() {
    withStore { defaults in
      PowerPreferences.endSession(everyChoice, defaults: defaults, build: "45", now: quitAt)
      PowerPreferences.endSession(PowerPreferences(), defaults: defaults, build: "45", now: quitAt)
      XCTAssertNil(defaults.object(forKey: "shellbell.power.preferences"))
    }
  }
}
