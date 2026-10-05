import Foundation

enum NotificationDisposition: String { case rich, generic, stale }
struct NotificationReplayEntry: Codable {
    let sequence: String
    let expiresAt: Int64
}
struct NotificationReplayState: Codable {
    var sessions: [String: NotificationReplayEntry] = [:]
}

enum NotificationPolicy {
    /// Call only after authenticated decryption and enrollment/recipient validation.
    /// Persist the returned state before making a notification visible.
    static func evaluate(_ payload: [String: Any], now: Int64, hideDetails: Bool,
                         state: inout NotificationReplayState) -> NotificationDisposition {
        guard let session = payload["sessionId"] as? String, !session.isEmpty, session.utf16.count <= 128,
              let text = payload["sequence"] as? String, let sequence = UInt64(text), sequence > 0, String(sequence) == text,
              let issued = payload["issuedAt"] as? NSNumber, let expires = payload["expiresAt"] as? NSNumber,
              issued.doubleValue.isFinite, expires.doubleValue.isFinite,
              issued.doubleValue >= 0, issued.doubleValue <= 9_007_199_254_740_991,
              expires.doubleValue >= 0, expires.doubleValue <= 9_007_199_254_740_991,
              issued.doubleValue.rounded(.towardZero) == issued.doubleValue,
              expires.doubleValue.rounded(.towardZero) == expires.doubleValue,
              now >= 0, now <= 9_007_199_254_740_991 else { return .generic }
        let issuedAt = issued.int64Value, expiresAt = expires.int64Value
        guard expiresAt > issuedAt, expiresAt - issuedAt <= 120_000 else { return .generic }
        guard issuedAt <= now + 60_000, expiresAt >= now - 60_000 else { return .stale }
        if let prior = state.sessions[session], let high = UInt64(prior.sequence), sequence <= high { return .stale }
        let live = state.sessions.filter { $0.value.expiresAt >= now }
        guard live[session] != nil || live.count < 500 else { return .generic }
        state.sessions = live
        state.sessions[session] = NotificationReplayEntry(sequence: text, expiresAt: expiresAt + 60_000)
        return hideDetails ? .generic : .rich
    }
}
