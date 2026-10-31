import Foundation
import XCTest
@testable import ShellbellNotificationCore

final class NotificationServiceTests: XCTestCase {
    func testMigrationRemovesOnlyExactLegacySessionOrOlderAuthenticatedAlert() {
        let current: [String: Any] = ["computerFp": "computer", "sessionId": "one", "sequence": "3"]
        XCTAssertTrue(NotificationPresentation.shouldRemoveDelivered(["body": ["computerFp": "computer", "sessionId": "one", "kind": "idle"]], for: current))
        XCTAssertFalse(NotificationPresentation.shouldRemoveDelivered(["body": ["computerFp": "computer", "sessionId": "two"]], for: current))
        XCTAssertFalse(NotificationPresentation.shouldRemoveDelivered(["body": ["computerFp": "other", "sessionId": "one"]], for: current))
        XCTAssertFalse(NotificationPresentation.shouldRemoveDelivered(["body": ["computerFp": "computer", "sessionId": "one", "shellbellNotification": "notify-context-v1"]], for: current))
        XCTAssertFalse(NotificationPresentation.shouldRemoveDelivered(["shellbellAuthenticated": ["computerFp": "computer", "sessionId": "one", "sequence": "4"]], for: current))
        XCTAssertTrue(NotificationPresentation.shouldRemoveDelivered(["shellbellAuthenticated": ["computerFp": "computer", "sessionId": "one", "sequence": "2"]], for: current))
    }
    func testThreadIdentifierMatchesRelayTupleHash() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/protocol/test/notification-presentation-vectors.json")
        let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: String]]
        for vector in vectors {
            XCTAssertEqual(NotificationPresentation.sessionGroup(computer: vector["computerFp"]!, session: vector["sessionId"]!), vector["sessionTag"])
        }
    }
    private func payload() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/protocol/test/notification-vectors.json")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        return fixture["payload"] as! [String: Any]
    }
    func testSameTitleSubtitleAndBodyAsAndroidForEveryCase() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/protocol/test/notification-text-vectors.json")
        let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        XCTAssertFalse(cases.isEmpty)
        for v in cases {
            var value = try payload(); let name = v["name"] as! String
            value["context"] = v["context"]; value["reason"] = v["reason"]
            for key in ["exitCode", "durationMs"] { if let n = v[key] { value[key] = n } }
            let shown = NotificationPresentation.authenticated(value)
            XCTAssertEqual(shown.title, v["title"] as? String, name)
            XCTAssertEqual(shown.subtitle, v["subtitle"] as? String, name)
            XCTAssertEqual(shown.body, v["body"] as? String, name)
        }
    }
    func testTimeoutWinsExactlyOnceOverLaterDecryption() throws {
        let value = try payload(); var contents: [NotificationPresentation] = []
        let service = NotificationServiceCoordinator(evaluate: { _, _ in NotificationEvaluation(disposition: .rich, payload: value) },
            publish: { result, _, deliver in deliver(result); return true }, deliver: { contents.append($0) })
        service.expire(); service.finish([:], now: 1000); service.expire()
        XCTAssertEqual(contents.count, 1); XCTAssertEqual(contents[0], .generic)
    }
    func testValidDecryptWinsExactlyOnceOverTimeout() throws {
        let value = try payload(); var contents: [NotificationPresentation] = []
        let service = NotificationServiceCoordinator(evaluate: { _, _ in NotificationEvaluation(disposition: .rich, payload: value) },
            publish: { result, _, deliver in deliver(result); return true }, deliver: { contents.append($0) })
        service.finish([:], now: 1000); service.expire(); service.finish([:], now: 1000)
        XCTAssertEqual(contents.count, 1); XCTAssertEqual(contents[0].title, "shellbell · fix/通知")
    }
    func testTimeoutDuringInFlightDecryptionDoesNotLaterRevealLabels() throws {
        let value = try payload()
        let entered = expectation(description: "decrypt entered")
        let completed = expectation(description: "decrypt completed")
        let release = DispatchSemaphore(value: 0)
        var contents: [NotificationPresentation] = []; var removals = 0
        let service = NotificationServiceCoordinator(evaluate: { _, _ in
            entered.fulfill(); release.wait()
            return NotificationEvaluation(disposition: .rich, payload: value)
        }, publish: { result, _, deliver in deliver(result); return true }, deliver: { contents.append($0) },
        removeOlder: { _, _ in removals += 1 })
        DispatchQueue.global().async { service.finish([:], now: 1000); completed.fulfill() }
        wait(for: [entered], timeout: 2)
        service.expire(); release.signal()
        wait(for: [completed], timeout: 2)
        XCTAssertEqual(contents, [.generic]); XCTAssertEqual(removals, 0)
    }
    func testMissingKeyBadTagAndStaleNeverPromotePrivateContentOrRemoveAlerts() throws {
        let value = try payload()
        for disposition in [NotificationDisposition.generic, .stale] {
            var contents: [NotificationPresentation] = []; var removals = 0
            let service = NotificationServiceCoordinator(evaluate: { _, _ in NotificationEvaluation(disposition: disposition, payload: value) },
                publish: { result, _, deliver in deliver(result); return true }, deliver: { contents.append($0) },
                removeOlder: { _, _ in removals += 1 })
            service.finish([:], now: 1000)
            XCTAssertEqual(contents, [.generic]); XCTAssertEqual(removals, 0)
        }
    }
    func testRevocationAtFinalPublishReturnsGenericWithoutRemovingDeliveredAlerts() throws {
        let value = try payload(); var contents: [NotificationPresentation] = []; var removals = 0
        let service = NotificationServiceCoordinator(evaluate: { _, _ in NotificationEvaluation(disposition: .rich, payload: value) },
            publish: { _, _, _ in false }, deliver: { contents.append($0) }, removeOlder: { _, _ in removals += 1 })
        service.finish([:], now: 1000)
        XCTAssertEqual(contents, [.generic]); XCTAssertEqual(removals, 0)
    }
    func testRemovalRequiresSameComputerSessionAndStrictlyOlderSequence() {
        let incoming: [String: Any] = ["computerFp": "computer", "sessionId": "one", "sequence": "2"]
        XCTAssertTrue(NotificationPresentation.isOlder(["computerFp": "computer", "sessionId": "one", "sequence": "1"], than: incoming))
        for old in [ ["computerFp": "other", "sessionId": "one", "sequence": "1"],
                     ["computerFp": "computer", "sessionId": "two", "sequence": "1"],
                     ["computerFp": "computer", "sessionId": "one", "sequence": "2"],
                     ["computerFp": "computer", "sessionId": "one", "sequence": "3"] ] {
            XCTAssertFalse(NotificationPresentation.isOlder(old, than: incoming))
        }
    }
}
