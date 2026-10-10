import XCTest

@testable import ShellbellCore

final class RelayTrustTests: XCTestCase {
  private func draft(_ relay: String) -> SettingsDraft {
    var result = SettingsDraft()
    result.replace(
      with: .object([
        "savedRevision": .string("revision"),
        "saved": .object(["relayUrl": .string(relay)]),
      ]))
    return result
  }

  func testExistingCustomRelayDoesNotPromptWhenOtherSettingsChange() {
    var value = draft("wss://private.example.com")
    value.values["name"] = "New name"
    XCTAssertNil(value.customRelayToConfirm)
    value.values["relay"] = "wss://another.example.com"
    XCTAssertEqual(value.customRelayToConfirm, "wss://another.example.com")
  }

  func testOnlyTheSecureProjectOriginSkipsCustomConfirmation() {
    var value = draft("wss://private.example.com")
    for origin in ["wss://relay.shellbell.dev", " wss://RELAY.shellbell.dev:443/ "] {
      value.values["relay"] = origin
      XCTAssertNil(value.customRelayToConfirm)
    }
    for origin in [
      "ws://relay.shellbell.dev", "wss://relay.shellbell.dev.evil.test",
      "wss://relay.shellbell.dev:444", "wss://relay.shellbell.dev/path",
      "wss://user@relay.shellbell.dev",
    ] {
      value.values["relay"] = origin
      XCTAssertEqual(value.customRelayToConfirm, origin)
    }
  }

  func testReloadReplacesTheSavedRelayForFutureConfirmation() {
    var value = draft("wss://first.example.com")
    value.values["relay"] = "wss://second.example.com"
    value.replace(
      with: .object([
        "savedRevision": .string("next"),
        "saved": .object(["relayUrl": .string("wss://second.example.com")]),
      ]))
    XCTAssertNil(value.customRelayToConfirm)
    XCTAssertEqual(value.revision, .string("next"))
  }
}
