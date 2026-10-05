import Foundation

enum NotificationStoreFactory {
    static func open(initialize: Bool = false) throws -> NotificationStore {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ShellbellNotificationAppGroup") as? String,
              group.hasPrefix("group."), !group.contains("$("),
              let keychain = Bundle.main.object(forInfoDictionaryKey: "ShellbellNotificationKeychainGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw NotificationStore.Failure.unavailable
        }
        let store = NotificationStore(directory: container.appendingPathComponent("notifications", isDirectory: true),
                                      vault: try NotificationKeychainVault(accessGroup: keychain))
        if initialize { try store.initialize() }
        return store
    }
}
