import CryptoKit
import Foundation

struct NotificationPresentation: Equatable {
    let title: String
    let subtitle: String
    let body: String
    let thread: String
    static let generic = NotificationPresentation(title: "Shellbell", subtitle: "", body: "A terminal session needs attention", thread: "")
    static func sessionGroup(computer: String, session: String) -> String {
        // Same tuple encoding as relay pushSessionGroup; no private labels in identifiers.
        let bytes = try! JSONSerialization.data(withJSONObject: ["shellbell-push-session-v1", computer, session], options: [.withoutEscapingSlashes])
        return "sb1_" + Data(SHA256.hash(data: bytes)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    /// Only call with a payload that passed NotificationCrypto and NotificationPolicy.
    static func authenticated(_ value: [String: Any]) -> NotificationPresentation {
        guard let c = value["context"] as? [String: Any], let app = c["sessionLabel"] as? String,
              let computer = c["computerName"] as? String, let fp = value["computerFp"] as? String,
              let sid = value["sessionId"] as? String else { return .generic }
        // What it's working on, where, and what happened: the same for every terminal and agent.
        // Where is the computer, the terminal app the computer names, and the agent or shell.
        let repository = c["repository"] as? String
        let title = c["customName"] as? String ?? repository.map { [$0, c["branch"] as? String].compactMap { $0 }.joined(separator: " · ") } ?? c["title"] as? String ?? "Terminal"
        let subtitle = [computer, app, c["agentName"] as? String ?? c["shell"] as? String].compactMap { $0 }.joined(separator: " · ")
        let agent = c["agentName"] as? String ?? "An agent"
        var body: String
        switch value["reason"] as? String {
        case "agent-blocked": body = "\(agent) needs your answer"
        case "agent-finished": body = "\(agent) finished"
        case "quiet": body = "Went quiet. Waiting for you?"
        case "prompt-returned": body = "Back at the prompt"
        case "command-finished":
            let code = (value["exitCode"] as? NSNumber)?.int64Value ?? 0
            body = code == 0 ? "Command finished" : "Command failed (exit \(code))"
            if let ms = value["durationMs"] as? NSNumber { body += " after \(duration(ms.int64Value))" }
        default: return .generic
        }
        return NotificationPresentation(title: title, subtitle: subtitle, body: body, thread: sessionGroup(computer: fp, session: sid))
    }
    /// As the relay's `formatDuration`: `45s`, `1m 35s`, `1h 02m`.
    static func duration(_ ms: Int64) -> String {
        let s = (ms + 500) / 1000
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m " + String(format: "%02lld", s % 60) + "s" }
        return "\(m / 60)h " + String(format: "%02lld", m % 60) + "m"
    }
    static func shouldRemoveDelivered(_ info: [AnyHashable: Any], for current: [String: Any]) -> Bool {
        if let authenticated = info["shellbellAuthenticated"] as? [String: Any] {
            return isOlder(authenticated, than: current)
        }
        let data = info["body"] as? [AnyHashable: Any] ?? info
        // Unauthenticated rich routing is not a sequence proof. Only migrate legacy format.
        guard data["shellbellNotification"] == nil,
              let computer = current["computerFp"] as? String,
              let session = current["sessionId"] as? String else { return false }
        return data["computerFp"] as? String == computer && data["sessionId"] as? String == session
    }
    static func isOlder(_ old: [String: Any], than current: [String: Any]) -> Bool {
        guard let computer = current["computerFp"] as? String, let session = current["sessionId"] as? String,
              old["computerFp"] as? String == computer, old["sessionId"] as? String == session,
              let oldText = old["sequence"] as? String, let oldSequence = UInt64(oldText), oldSequence > 0, String(oldSequence) == oldText,
              let text = current["sequence"] as? String, let sequence = UInt64(text), String(sequence) == text else { return false }
        return oldSequence < sequence
    }
}

/// Platform-independent exactly-once gate shared by decrypt completion and OS expiry.
/// No networking, JS, or private context cache is involved.
final class NotificationServiceCoordinator {
    typealias Publish = (NotificationEvaluation, Int64, (NotificationEvaluation) -> Void) -> Bool
    private let lock = NSLock()
    private var finished = false
    private let evaluate: ([String: Any], Int64) -> NotificationEvaluation
    private let publish: Publish
    private let deliver: (NotificationPresentation) -> Void
    private let removeOlder: ([String: Any], Int64) -> Void
    init(evaluate: @escaping ([String: Any], Int64) -> NotificationEvaluation,
         publish: @escaping Publish, deliver: @escaping (NotificationPresentation) -> Void,
         removeOlder: @escaping ([String: Any], Int64) -> Void = { _, _ in }) {
        self.evaluate = evaluate; self.publish = publish; self.deliver = deliver; self.removeOlder = removeOlder
    }
    func expire() {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }; finished = true
        deliver(.generic)
    }
    func finish(_ box: [String: Any], now: Int64) {
        lock.lock(); let alreadyFinished = finished; lock.unlock()
        guard !alreadyFinished else { return }
        let result = evaluate(box, now)
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }; finished = true
        guard result.disposition != .stale else { deliver(.generic); return }
        let accepted = publish(result, now) { current in
            guard current.disposition == .rich, let payload = current.payload else { deliver(.generic); return }
            removeOlder(payload, now)
            deliver(NotificationPresentation.authenticated(payload))
        }
        if !accepted { deliver(.generic) }
    }
}
