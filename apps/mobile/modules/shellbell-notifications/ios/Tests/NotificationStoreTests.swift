import Foundation
import XCTest
@testable import ShellbellNotificationCore

private final class MemoryNotificationVault: NotificationKeyVault {
    var values: [String: Data] = [:]
    var beforePut: (() -> Void)?
    func put(_ key: Data, account: String) throws { beforePut?(); values[account] = key }
    func get(_ account: String) throws -> Data? { values[account] }
    func remove(_ account: String) throws { values.removeValue(forKey: account) }
    func removeAll() throws { values.removeAll() }
}

final class NotificationStoreTests: XCTestCase {
    func testDirectApnsEnvelopeDeliversOnceWithAuthenticatedRouteOrGenericFallback() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/relay-core/test-support/native-push-payloads.json")
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let apns = fixtures["apns"] as! [String: Any]
        let userInfo = apns["body"] as! [String: Any]
        let aps = userInfo["aps"] as! [String: Any]
        XCTAssertEqual(aps["mutable-content"] as? Int, 1)
        let envelope = userInfo["body"] as! [String: Any]
        XCTAssertEqual(envelope["shellbellNotification"] as? String, "notify-context-v1")
        let store = try installed()
        for corrupt in [false, true] {
            var incoming = envelope["context"] as! [String: Any]
            if corrupt { incoming["ciphertext"] = "AAAAAAAAAAAAAAAA" }
            var displayed: [NotificationPresentation] = []
            var route: [String: Any]?
            let coordinator = NotificationServiceCoordinator(
                evaluate: { store.evaluate($0, now: $1) },
                publish: { store.publish($0, now: $1, deliver: $2) },
                deliver: { displayed.append($0) },
                removeOlder: { payload, _ in route = payload })
            coordinator.finish(incoming, now: 1000)
            coordinator.expire()
            XCTAssertEqual(displayed.count, 1)
            if corrupt {
                XCTAssertEqual(displayed, [.generic])
                XCTAssertNil(route)
            } else {
                XCTAssertEqual(displayed[0].title, "shellbell · fix/通知")
                XCTAssertEqual(displayed[0].thread, aps["thread-id"] as? String)
                XCTAssertEqual(route?["computerFp"] as? String, envelope["computerFp"] as? String)
                XCTAssertEqual(route?["sessionId"] as? String, envelope["sessionId"] as? String)
            }
        }
    }

    func testPrivacyPreferenceReadsDurableStateAcrossStoreInstances() throws {
        let store = try installed()
        XCTAssertFalse(try store.hideDetails())
        try store.setHideDetails(true)
        XCTAssertTrue(try NotificationStore(directory: directory, vault: vault).hideDetails())
        try store.setHideDetails(false)
        XCTAssertFalse(try store.hideDetails())
    }
    private var directory: URL!
    private var vault: MemoryNotificationVault!
    private var box: [String: Any]!
    private var key: Data!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        vault = MemoryNotificationVault()
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../../packages/protocol/test/notification-vectors.json")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        box = fixture["box"] as? [String: Any]
        let hex = Array((fixture["key"] as! String).utf8)
        key = Data(stride(from: 0, to: hex.count, by: 2).map { UInt8(String(bytes: hex[$0..<$0+2], encoding: .utf8)!, radix: 16)! })
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func installed() throws -> NotificationStore {
        let store = NotificationStore(directory: directory, vault: vault)
        try store.initialize()
        try store.install(computerFp: box["computerFp"] as! String, phoneFp: box["phoneFp"] as! String,
                          generation: box["generation"] as! String, key: key, now: 1000)
        return store
    }
    func testAuthenticatedReplaySurvivesReconstructionWithoutRetainingLabelsOrKeysInMetadata() throws {
        let store = try installed()
        let accepted = store.evaluate(box, now: 1000)
        XCTAssertEqual(accepted.disposition, .rich)
        XCTAssertEqual((accepted.payload?["context"] as? [String: Any])?["repository"] as? String, "shellbell")
        XCTAssertEqual(NotificationStore(directory: directory, vault: vault).evaluate(box, now: 1000).disposition, .stale)
        let bytes = try Data(contentsOf: directory.appendingPathComponent("state.json"))
        let text = String(data: bytes, encoding: .utf8)!
        XCTAssertFalse(text.contains("MacBook")); XCTAssertFalse(text.contains("repository")); XCTAssertFalse(text.contains(key.base64EncodedString()))
    }
    func testTamperingDoesNotAdvanceReplayAndMissingKeyNeverShowsPrivateContent() throws {
        let store = try installed()
        var tampered = box!; tampered["nonce"] = "AAAAAAAAAAAAAAAA"
        XCTAssertEqual(store.evaluate(tampered, now: 1000).disposition, .generic)
        XCTAssertEqual(store.evaluate(box, now: 1000).disposition, .rich)
        vault.values.removeAll()
        let unavailable = store.evaluate(box, now: 1000)
        XCTAssertEqual(unavailable.disposition, .generic); XCTAssertNil(unavailable.payload)
    }
    func testUnpairAfterDecryptionRevokesPendingPresentationAndDeletesKeys() throws {
        let store = try installed()
        let pending = store.evaluate(box, now: 1000)
        try store.removeComputer(box["computerFp"] as! String)
        var presentations = 0
        XCTAssertFalse(store.publish(pending, now: 1000) { _ in presentations += 1 })
        XCTAssertEqual(presentations, 0); XCTAssertTrue(vault.values.isEmpty)
        XCTAssertEqual(store.evaluate(box, now: 1000).disposition, .stale)
    }
    func testHideDetailsIsRecheckedAtPresentationAndReinstallMetadataCannotReviveKeys() throws {
        let store = try installed()
        let pending = store.evaluate(box, now: 1000)
        try store.setHideDetails(true)
        XCTAssertTrue(store.publish(pending, now: 1000) { result in
            XCTAssertEqual(result.disposition, .generic); XCTAssertNil(result.payload)
        })
        try FileManager.default.removeItem(at: directory.appendingPathComponent("state.json"))
        XCTAssertEqual(store.evaluate(box, now: 1000).disposition, .generic)
        try store.initialize()
        XCTAssertTrue(vault.values.isEmpty)
        XCTAssertEqual(store.evaluate(box, now: 1000).disposition, .stale)
    }
    func testPreviousGenerationExpiresAfterFiveMinutes() throws {
        let store = try installed()
        try store.install(computerFp: box["computerFp"] as! String, phoneFp: box["phoneFp"] as! String,
                          generation: "AgICAgICAgICAgICAgICAg", key: Data(repeating: 9, count: 32), now: 1000)
        XCTAssertEqual(store.evaluate(box, now: 1000).disposition, .rich)
        XCTAssertEqual(store.evaluate(box, now: 301_001).disposition, .stale)
        XCTAssertEqual(vault.values.count, 1)
    }
    func testEnrollmentIsDurablyTrackedBeforeKeyCreationSoCrashesCannotOrphanKeys() throws {
        let store = try installed()
        let generation = "AgICAgICAgICAgICAgICAg"
        vault.beforePut = {
            let bytes = try! Data(contentsOf: self.directory.appendingPathComponent("state.json"))
            let state = try! JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            let computers = state["computers"] as! [String: [String: Any]]
            XCTAssertEqual(computers[self.box["computerFp"] as! String]?["generation"] as? String, generation)
        }
        try store.install(computerFp: box["computerFp"] as! String, phoneFp: box["phoneFp"] as! String,
                          generation: generation, key: Data(repeating: 9, count: 32), now: 1000)
    }
}
