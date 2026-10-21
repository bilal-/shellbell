import XCTest

@testable import ShellbellCore

final class TurnSettingTests: XCTestCase {
  private func draft(_ saved: [String: JSONValue]) -> SettingsDraft {
    var result = SettingsDraft()
    result.replace(with: .object(["savedRevision": .string("revision"), "saved": .object(saved)]))
    return result
  }

  func testTurnIsOnUnlessTheSavedSettingsTurnedItOff() {
    XCTAssertEqual(draft([:]).values["turn"], "on")
    XCTAssertEqual(draft(["turn": .bool(true)]).values["turn"], "on")
    XCTAssertEqual(draft(["turn": .bool(false)]).values["turn"], "off")
  }

  func testEverySettingIsSentWhenSaving() {
    XCTAssertEqual(draft([:]).values.count, Wire.configKeys.count)
    XCTAssertTrue(Wire.configKeys.contains("turn"))
    XCTAssertTrue(Wire.configKeys.contains("conversations"))
  }

  func testConversationsRequireExplicitOwnerConsent() {
    XCTAssertEqual(draft([:]).values["conversations"], "off")
    XCTAssertEqual(draft(["showAgentConversations": .bool(false)]).values["conversations"], "off")
    XCTAssertEqual(draft(["showAgentConversations": .bool(true)]).values["conversations"], "on")
  }
}
