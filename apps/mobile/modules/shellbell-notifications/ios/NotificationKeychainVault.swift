import Foundation
import Security

protocol NotificationKeychainAPI {
    func add(_ query: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func copy(_ query: [String: Any]) -> (OSStatus, Data?)
    func delete(_ query: [String: Any]) -> OSStatus
}
struct SystemNotificationKeychainAPI: NotificationKeychainAPI {
    func add(_ query: [String: Any]) -> OSStatus { SecItemAdd(query as CFDictionary, nil) }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus { SecItemUpdate(query as CFDictionary, attributes as CFDictionary) }
    func copy(_ query: [String: Any]) -> (OSStatus, Data?) {
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        return (status, value as? Data)
    }
    func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
}

/// Narrow notification-only service/group. Pair and identity SecureStore records
/// are deliberately outside this adapter's query space.
final class NotificationKeychainVault: NotificationKeyVault {
    private let group: String
    private let api: NotificationKeychainAPI
    init(accessGroup: String, api: NotificationKeychainAPI = SystemNotificationKeychainAPI()) throws {
        guard !accessGroup.isEmpty, !accessGroup.contains("$(") else { throw NotificationStore.Failure.unavailable }
        group = accessGroup; self.api = api
    }
    private func query(_ account: String? = nil) -> [String: Any] {
        var result: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccessGroup as String: group, kSecAttrService as String: "dev.shellbell.notifications.v1",
            kSecAttrSynchronizable as String: false]
        if let account { result[kSecAttrAccount as String] = account }
        return result
    }
    func put(_ key: Data, account: String) throws {
        guard key.count == 32 else { throw NotificationStore.Failure.unavailable }
        let attributes: [String: Any] = [kSecValueData as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = api.update(query(account), attributes: attributes)
        if status == errSecItemNotFound {
            guard api.add(query(account).merging(attributes) { _, value in value }) == errSecSuccess else { throw NotificationStore.Failure.unavailable }
        } else if status != errSecSuccess { throw NotificationStore.Failure.unavailable }
    }
    func get(_ account: String) throws -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, value) = api.copy(request)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value, value.count == 32 else { throw NotificationStore.Failure.unavailable }
        return value
    }
    func remove(_ account: String) throws { try removeQuery(query(account)) }
    func removeAll() throws { try removeQuery(query()) }
    private func removeQuery(_ query: [String: Any]) throws {
        let status = api.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NotificationStore.Failure.unavailable }
    }
}
