import Foundation
import Security
import XCTest
@testable import ShellbellNotificationCore

private final class FakeKeychainAPI: NotificationKeychainAPI {
    var writes: [[String: Any]] = []
    var updates: [[String: Any]] = []
    var queries: [[String: Any]] = []
    var deletes: [[String: Any]] = []
    var status: OSStatus = errSecItemNotFound
    var data: Data? = nil
    func add(_ query: [String: Any]) -> OSStatus { writes.append(query); return errSecSuccess }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus { queries.append(query); updates.append(attributes); return status }
    func copy(_ query: [String: Any]) -> (OSStatus, Data?) { queries.append(query); return (status, data) }
    func delete(_ query: [String: Any]) -> OSStatus { deletes.append(query); return errSecSuccess }
}

final class NotificationKeychainTests: XCTestCase {
    func testUsesOnlyNotificationGroupAndDeviceLocalAfterFirstUnlockKeys() throws {
        let api = FakeKeychainAPI()
        let vault = try NotificationKeychainVault(accessGroup: "TEAM.app.notifications", api: api)
        try vault.put(Data(repeating: 7, count: 32), account: "notification-record")
        let write = try XCTUnwrap(api.writes.first)
        XCTAssertEqual(write[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(write[kSecAttrAccessGroup as String] as? String, "TEAM.app.notifications")
        XCTAssertEqual(write[kSecAttrService as String] as? String, "dev.shellbell.notifications.v1")
        XCTAssertEqual(write[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(write[kSecValueData as String] as? Data, Data(repeating: 7, count: 32))
        try vault.removeAll()
        XCTAssertEqual(api.deletes.first?[kSecAttrService as String] as? String, "dev.shellbell.notifications.v1")
        XCTAssertNil(api.deletes.first?[kSecAttrAccount as String])
    }
    func testLockedOrMalformedKeyDoesNotFallBackToAnotherAccessGroup() throws {
        let api = FakeKeychainAPI()
        let vault = try NotificationKeychainVault(accessGroup: "TEAM.app.notifications", api: api)
        api.status = errSecInteractionNotAllowed
        XCTAssertThrowsError(try vault.get("record"))
        XCTAssertThrowsError(try vault.put(Data(repeating: 7, count: 32), account: "record"))
        XCTAssertTrue(api.writes.isEmpty)
        XCTAssertTrue(api.queries.allSatisfy { $0[kSecAttrAccessGroup as String] as? String == "TEAM.app.notifications" })
        api.status = errSecSuccess; api.data = Data(repeating: 0, count: 16)
        XCTAssertThrowsError(try vault.get("record"))
        XCTAssertThrowsError(try NotificationKeychainVault(accessGroup: "$(AppIdentifierPrefix)unresolved", api: api))
    }
}
