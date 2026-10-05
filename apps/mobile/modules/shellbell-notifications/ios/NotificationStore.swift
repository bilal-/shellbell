import Darwin
import Foundation

protocol NotificationKeyVault {
    func put(_ key: Data, account: String) throws
    func get(_ account: String) throws -> Data?
    func remove(_ account: String) throws
    func removeAll() throws
}
struct NotificationPermit {
    let computerFp: String
    let phoneFp: String
    let generation: String
    let epoch: String
    var sessionId: String? = nil
    var sequence: String? = nil
    var expiresAt: Int64? = nil
}
struct NotificationEvaluation {
    let disposition: NotificationDisposition
    var payload: [String: Any]? = nil
    var permit: NotificationPermit? = nil
}
private struct NotificationRecord: Codable {
    var phoneFp: String
    var generation: String
    var previous: String? = nil
    var previousUntil: Int64? = nil
    var epoch: String = UUID().uuidString
    var replay = NotificationReplayState()
}
private struct NotificationStoreState: Codable {
    var version = 1
    var hideDetails = false
    var computers: [String: NotificationRecord] = [:]
}

/// Shared by the host and extension. Only routing/replay metadata reaches the file;
/// derived notification keys live exclusively behind the scoped Keychain port.
final class NotificationStore {
    enum Failure: Error { case unavailable }
    private let directory: URL
    private let vault: NotificationKeyVault
    private var file: URL { directory.appendingPathComponent("state.json") }
    init(directory: URL, vault: NotificationKeyVault) { self.directory = directory; self.vault = vault }

    private static func fingerprint(_ value: String) -> Bool {
        value.range(of: "^[a-z2-7]{26}$", options: .regularExpression) != nil
    }
    private static func generation(_ value: String) -> Bool {
        guard value.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=="), bytes.count == 16 else { return false }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
    }
    private func account(_ computer: String, _ record: NotificationRecord, _ generation: String) -> String {
        "\(computer).\(record.phoneFp).\(generation)"
    }
    private func locked<T>(_ body: () throws -> T) throws -> T {
        let path = directory.appendingPathComponent("state.lock").path
        let fd = Darwin.open(path, O_RDWR | O_CREAT | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { flock(fd, LOCK_UN); Darwin.close(fd) }
        while flock(fd, LOCK_EX) != 0 { if errno != EINTR { throw Failure.unavailable } }
        return try body()
    }
    private func read() throws -> NotificationStoreState {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 8 * 1024 * 1024 else { throw Failure.unavailable }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= 8 * 1024 * 1024 else { throw Failure.unavailable }
        let state = try JSONDecoder().decode(NotificationStoreState.self, from: bytes)
        guard state.version == 1 else { throw Failure.unavailable }
        for (computer, record) in state.computers {
            guard Self.fingerprint(computer), Self.fingerprint(record.phoneFp), Self.generation(record.generation),
                  !record.epoch.isEmpty, record.replay.sessions.count <= 500 else { throw Failure.unavailable }
            if let previous = record.previous {
                guard Self.generation(previous), let until = record.previousUntil, until >= 0, until <= 9_007_199_254_740_991 else { throw Failure.unavailable }
            }
            for (session, entry) in record.replay.sessions {
                guard !session.isEmpty, session.utf16.count <= 128, let sequence = UInt64(entry.sequence), sequence > 0,
                      String(sequence) == entry.sequence, entry.expiresAt >= 0, entry.expiresAt <= 9_007_199_254_800_991 else { throw Failure.unavailable }
            }
        }
        return state
    }
    private func write(_ state: NotificationStoreState) throws {
        let bytes = try JSONEncoder().encode(state)
        guard bytes.count <= 8 * 1024 * 1024 else { throw Failure.unavailable }
        let staging = directory.appendingPathComponent("state.\(UUID().uuidString).tmp")
        let fd = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { Darwin.close(fd); try? FileManager.default.removeItem(at: staging) }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Failure.unavailable }; offset += count
            }
        }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: staging.path)
        #endif
        guard fsync(fd) == 0, rename(staging.path, file.path) == 0 else { throw Failure.unavailable }
        let parent = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
        guard parent >= 0 else { throw Failure.unavailable }
        defer { Darwin.close(parent) }
        guard fsync(parent) == 0 else { throw Failure.unavailable }
    }
    private func transaction<T>(_ body: (inout NotificationStoreState) throws -> T) throws -> T {
        try locked {
            var state = try read()
            let before = try JSONEncoder().encode(state)
            let result = try body(&state)
            if try JSONEncoder().encode(state) != before { try write(state) }
            return result
        }
    }
    /// Host-only initialization. The extension never initializes a missing record.
    /// Missing app-group state after reinstall must not revive surviving Keychain keys.
    func initialize() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var protectedDirectory = directory; try protectedDirectory.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        try locked {
            if FileManager.default.fileExists(atPath: file.path) { _ = try read(); return }
            try vault.removeAll()
            try write(NotificationStoreState())
        }
    }
    func install(computerFp: String, phoneFp: String, generation: String, key: Data, now: Int64) throws {
        guard Self.fingerprint(computerFp), Self.fingerprint(phoneFp), Self.generation(generation), key.count == 32,
              now >= 0, now <= 9_007_199_254_440_991 else { throw Failure.unavailable }
        try locked {
            var state = try read()
            var record = state.computers[computerFp]
            if let old = record, old.phoneFp != phoneFp {
                try vault.remove(account(computerFp, old, old.generation))
                if let previous = old.previous { try vault.remove(account(computerFp, old, previous)) }
                record = nil
            }
            if var old = record {
                if old.generation == generation {
                    if let existing = try vault.get(account(computerFp, old, generation)), existing != key { throw Failure.unavailable }
                } else {
                    guard generation != old.previous else { throw Failure.unavailable }
                    if let previous = old.previous { try vault.remove(account(computerFp, old, previous)) }
                    old.previous = old.generation; old.previousUntil = now + 300_000; old.generation = generation
                }
                record = old
            } else { record = NotificationRecord(phoneFp: phoneFp, generation: generation) }
            state.computers[computerFp] = record
            // A crash may leave a referenced key missing (generic fallback), never
            // an untracked key that revocation cannot subsequently delete.
            try write(state)
            try vault.put(key, account: account(computerFp, record!, generation))
        }
    }
    func removeComputer(_ computerFp: String) throws {
        try transaction { state in
            guard let record = state.computers.removeValue(forKey: computerFp) else { return }
            try vault.remove(account(computerFp, record, record.generation))
            if let previous = record.previous { try vault.remove(account(computerFp, record, previous)) }
        }
    }
    func setHideDetails(_ hide: Bool) throws { try transaction { $0.hideDetails = hide } }
    func hideDetails() throws -> Bool { try transaction { $0.hideDetails } }
    func evaluate(_ box: [String: Any], now: Int64) -> NotificationEvaluation {
        do {
            return try transaction { state in
                guard let computer = box["computerFp"] as? String, let phone = box["phoneFp"] as? String,
                      let generation = box["generation"] as? String, var record = state.computers[computer], record.phoneFp == phone else { return NotificationEvaluation(disposition: .stale) }
                if let previous = record.previous, (record.previousUntil ?? 0) < now {
                    try vault.remove(account(computer, record, previous)); record.previous = nil; record.previousUntil = nil
                    state.computers[computer] = record
                }
                guard generation == record.generation || generation == record.previous else { return NotificationEvaluation(disposition: .stale) }
                var permit = NotificationPermit(computerFp: computer, phoneFp: phone, generation: generation, epoch: record.epoch)
                guard var key = try vault.get(account(computer, record, generation)) else { return NotificationEvaluation(disposition: .generic, permit: permit) }
                defer { key.resetBytes(in: 0..<key.count) }
                let payload: [String: Any]
                do {
                    let plaintext = try NotificationCrypto.open(key: key, box: box)
                    guard let decoded = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else { throw Failure.unavailable }
                    payload = decoded
                } catch { return NotificationEvaluation(disposition: .generic, permit: permit) }
                let disposition = NotificationPolicy.evaluate(payload, now: now, hideDetails: state.hideDetails, state: &record.replay)
                if disposition == .stale { return NotificationEvaluation(disposition: .stale) }
                let session = payload["sessionId"] as! String, sequence = payload["sequence"] as! String
                if record.replay.sessions[session]?.sequence == sequence {
                    permit.sessionId = session; permit.sequence = sequence
                    permit.expiresAt = (payload["expiresAt"] as! NSNumber).int64Value + 60_000
                }
                state.computers[computer] = record
                return NotificationEvaluation(disposition: disposition, payload: disposition == .rich ? payload : nil, permit: permit)
            }
        } catch { return NotificationEvaluation(disposition: .generic) }
    }
    /// Recheck revocation, newest sequence and privacy under the cross-process lock.
    /// The OS presenter invokes this at its final pre-display boundary.
    func publish(_ result: NotificationEvaluation, now: Int64, deliver: (NotificationEvaluation) -> Void) -> Bool {
        guard result.disposition != .stale else { return false }
        guard let permit = result.permit else { deliver(NotificationEvaluation(disposition: .generic)); return true }
        do {
            return try locked {
                let state = try read()
                guard let record = state.computers[permit.computerFp], record.phoneFp == permit.phoneFp, record.epoch == permit.epoch,
                      permit.generation == record.generation || (permit.generation == record.previous && (record.previousUntil ?? 0) >= now) else { return false }
                if let session = permit.sessionId {
                    guard record.replay.sessions[session]?.sequence == permit.sequence, (permit.expiresAt ?? 0) >= now else { return false }
                }
                deliver(state.hideDetails ? NotificationEvaluation(disposition: .generic, permit: permit) : result)
                return true
            }
        } catch { return false }
    }
}
