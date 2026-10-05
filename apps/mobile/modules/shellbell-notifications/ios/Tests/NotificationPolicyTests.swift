import XCTest
@testable import ShellbellNotificationCore

final class NotificationPolicyTests: XCTestCase {
    private func payload(_ sequence: String = "1", session: String = "session", issued: Int64 = 100_000) -> [String: Any] {
        ["sessionId": session, "sequence": sequence, "issuedAt": issued, "expiresAt": issued + 120_000]
    }
    func testExpiryAndSixtySecondSkewBoundaries() {
        for (now, expected): (Int64, NotificationDisposition) in [(40_000, .rich), (39_999, .stale), (280_000, .rich), (280_001, .stale)] {
            var state = NotificationReplayState()
            XCTAssertEqual(NotificationPolicy.evaluate(payload(), now: now, hideDetails: false, state: &state), expected)
        }
    }
    func testReversedAndDuplicateSequencesCannotReplaceNewerContent() {
        var state = NotificationReplayState()
        XCTAssertEqual(NotificationPolicy.evaluate(payload("2"), now: 100_000, hideDetails: false, state: &state), .rich)
        for sequence in ["1", "2"] {
            XCTAssertEqual(NotificationPolicy.evaluate(payload(sequence), now: 100_000, hideDetails: false, state: &state), .stale)
        }
        XCTAssertEqual(state.sessions["session"]?.sequence, "2")
    }
    func testCapacityFailsClosedWithoutEvictingLiveHighWaterMarks() {
        var state = NotificationReplayState()
        for i in 0..<500 { XCTAssertEqual(NotificationPolicy.evaluate(payload(session: "s\(i)"), now: 100_000, hideDetails: false, state: &state), .rich) }
        XCTAssertEqual(NotificationPolicy.evaluate(payload(session: "overflow"), now: 100_000, hideDetails: false, state: &state), .generic)
        XCTAssertEqual(state.sessions.count, 500)
        XCTAssertEqual(NotificationPolicy.evaluate(payload(session: "new", issued: 300_000), now: 300_000, hideDetails: false, state: &state), .rich)
        XCTAssertEqual(state.sessions.count, 1)
    }
    func testHiddenDetailsStillAdvanceReplayAndInvalidSequenceDoesNot() {
        var state = NotificationReplayState()
        XCTAssertEqual(NotificationPolicy.evaluate(payload(), now: 100_000, hideDetails: true, state: &state), .generic)
        XCTAssertEqual(NotificationPolicy.evaluate(payload(), now: 100_000, hideDetails: false, state: &state), .stale)
        for invalid in ["0", "01", "-1", "18446744073709551616"] {
            XCTAssertEqual(NotificationPolicy.evaluate(payload(invalid), now: 100_000, hideDetails: false, state: &state), .generic)
        }
        XCTAssertEqual(state.sessions["session"]?.sequence, "1")
    }
}
