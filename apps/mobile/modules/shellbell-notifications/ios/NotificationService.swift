import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var coordinator: NotificationServiceCoordinator?
    override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            let safe = UNMutableNotificationContent(); safe.title = "Shellbell"; safe.body = "A terminal session needs attention"
            handler(safe); return
        }
        // Never reuse incoming text, attachments or an asserted local-authentication marker.
        content.title = NotificationPresentation.generic.title; content.subtitle = ""
        content.body = NotificationPresentation.generic.body; content.attachments = []
        content.userInfo.removeValue(forKey: "shellbellAuthenticated")
        let data = request.content.userInfo["body"] as? [String: Any] ?? request.content.userInfo as? [String: Any] ?? [:]
        guard data["shellbellNotification"] as? String == "notify-context-v1",
              let box = data["context"] as? [String: Any],
              let store = try? NotificationStoreFactory.open() else { handler(content); return }
        var delivered: [UNNotification] = []
        let center = UNUserNotificationCenter.current()
        let service = NotificationServiceCoordinator(evaluate: { box, now in store.evaluate(box, now: now) },
            publish: { result, now, deliver in store.publish(result, now: now, deliver: deliver) },
            deliver: { presentation in
                content.title = presentation.title; content.subtitle = presentation.subtitle; content.body = presentation.body
                if !presentation.thread.isEmpty { content.threadIdentifier = presentation.thread }
                handler(content)
            }, removeOlder: { payload, _ in
                let routing: [String: Any] = ["computerFp": payload["computerFp"]!, "sessionId": payload["sessionId"]!, "sequence": payload["sequence"]!]
                content.userInfo["shellbellAuthenticated"] = routing
                // Navigation identity comes from authenticated content, not the outer hint.
                var safeData = data; safeData["computerFp"] = payload["computerFp"]; safeData["sessionId"] = payload["sessionId"]
                content.userInfo["body"] = safeData
                let older = delivered.filter { notification in
                    return NotificationPresentation.shouldRemoveDelivered(notification.request.content.userInfo, for: payload)
                }.map { $0.request.identifier }
                center.removeDeliveredNotifications(withIdentifiers: older)
            })
        coordinator = service
        center.getDeliveredNotifications { notifications in
            delivered = notifications
            service.finish(box, now: Int64(Date().timeIntervalSince1970 * 1000))
        }
    }
    override func serviceExtensionTimeWillExpire() { coordinator?.expire() }
}
