import ExpoModulesCore
import Foundation
import UserNotifications

public class ShellbellNotificationsModule: Module {
    private func dismiss(_ computer: String, session: String? = nil) async {
        let center = UNUserNotificationCenter.current()
        let notifications = await center.deliveredNotifications()
        let ids = notifications.filter { notification in
            let info = notification.request.content.userInfo
            let data = info["body"] as? [AnyHashable: Any] ?? info
            return data["computerFp"] as? String == computer &&
                (session == nil || data["sessionId"] as? String == session)
        }.map { $0.request.identifier }
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
    public func definition() -> ModuleDefinition {
        Name("ShellbellNotifications")
        AsyncFunction("installNotificationKey") { (computer: String, phone: String, generation: String, encoded: String) in
            guard encoded.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  var key = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="),
                  key.count == 32,
                  key.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == encoded else {
                throw NotificationStore.Failure.unavailable
            }
            defer { key.resetBytes(in: 0..<key.count) }
            try NotificationStoreFactory.open(initialize: true).install(computerFp: computer, phoneFp: phone,
                generation: generation, key: key, now: Int64(Date().timeIntervalSince1970 * 1000))
        }
        AsyncFunction("removeNotificationComputer") { (computer: String) async throws in
            try NotificationStoreFactory.open(initialize: true).removeComputer(computer)
            await self.dismiss(computer)
        }
        AsyncFunction("setHideNotificationDetails") { (hide: Bool) in
            try NotificationStoreFactory.open(initialize: true).setHideDetails(hide)
        }
        AsyncFunction("getHideNotificationDetails") { () -> Bool in
            try NotificationStoreFactory.open(initialize: true).hideDetails()
        }
        AsyncFunction("dismissNotificationSession") { (computer: String, session: String) async in
            await self.dismiss(computer, session: session)
        }
        AsyncFunction("notificationReadiness") { () -> [String: Bool] in
            let storage = (try? NotificationStoreFactory.open(initialize: true)) != nil
            return ["crypto": true, "storage": storage, "receiver": true]
        }
    }
}
