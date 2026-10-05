import Foundation
import CryptoKit
import CoreFoundation

enum NotificationCrypto {
    enum Failure: Error { case invalid }
    static func open(key: Data, box: [String: Any]) throws -> Data {
        do {
            guard key.count == 32,
                  Set(box.keys) == Set(headerKeys + ["nonce", "ciphertext"]) else { throw Failure.invalid }
            let header = try routing(box)
            let nonce = try bytes(box["nonce"], min: 12, max: 12)
            let ciphertext = try bytes(box["ciphertext"], min: 17, max: 1552)
            let ad = try JSONSerialization.data(withJSONObject: ["shellbell-notification-v1"] + header,
                                                options: [.withoutEscapingSlashes])
            let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                               ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
            let plaintext = try AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: ad)
            guard plaintext.count <= 1536, String(data: plaintext, encoding: .utf8) != nil,
                  let payload = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
            else { throw Failure.invalid }
            try validate(payload, header: header)
            return plaintext
        } catch { throw Failure.invalid }
    }

    private static let headerKeys = ["computerFp", "phoneFp", "generation", "sessionId", "eventId"]

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    private static func bytes(_ value: Any?, min: Int, max: Int) throws -> Data {
        guard let text = value as? String, text.utf8.count <= (max * 4 + 2) / 3,
              matches(text, "^[A-Za-z0-9_-]+$"), !text.contains("\n") else { throw Failure.invalid }
        let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - text.count % 4) % 4)),
              data.count >= min, data.count <= max,
              data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == text
        else { throw Failure.invalid }
        return data
    }

    private static func routing(_ object: [String: Any]) throws -> [String] {
        let values = try headerKeys.map { name -> String in
            guard let s = object[name] as? String else { throw Failure.invalid }
            return s
        }
        for fp in values.prefix(2) {
            guard fp.utf8.count == 26, matches(fp, "^[a-z2-7]{26}$") else { throw Failure.invalid }
        }
        _ = try bytes(values[2], min: 16, max: 16)
        guard !values[3].isEmpty, (values[3] as NSString).length <= 128 else { throw Failure.invalid }
        _ = try bytes(values[4], min: 16, max: 16)
        return values
    }

    private static func integer(_ value: Any?, nonnegative: Bool = true) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw Failure.invalid }
        let d = number.doubleValue
        guard d.isFinite, d.rounded() == d, abs(d) <= 9_007_199_254_740_991,
              !nonnegative || d >= 0 else { throw Failure.invalid }
        return d
    }

    private static func label(_ value: Any?, limit: Int) throws {
        guard let s = value as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              s.utf8.count <= limit else { throw Failure.invalid }
        for scalar in s.unicodeScalars {
            let n = scalar.value
            if n <= 31 || (127...159).contains(n) || n == 0x61c || (0x200e...0x200f).contains(n)
                || (0x2028...0x202e).contains(n) || (0x2066...0x2069).contains(n) {
                throw Failure.invalid
            }
        }
    }

    private static func validate(_ p: [String: Any], header: [String]) throws {
        let required = Set(headerKeys + ["context", "reason", "issuedAt", "expiresAt", "sequence"])
        guard required.isSubset(of: Set(p.keys)), Set(p.keys).isSubset(of: required.union(["exitCode", "durationMs"])),
              try routing(p) == header, let context = p["context"] as? [String: Any],
              let reason = p["reason"] as? String,
              ["command-finished", "prompt-returned", "agent-finished", "agent-blocked", "quiet"].contains(reason),
              let sequence = p["sequence"] as? String, sequence.utf8.count <= 20,
              let count = UInt64(sequence), count > 0, String(count) == sequence else { throw Failure.invalid }
        let requiredContext: Set<String> = ["computerName", "sessionLabel", "observedAt"]
        let limits = ["computerName": 128, "sessionLabel": 128, "customName": 256, "repository": 256,
                      "branch": 256, "title": 256, "shell": 64, "agentName": 64]
        guard requiredContext.isSubset(of: Set(context.keys)),
              Set(context.keys).isSubset(of: Set(limits.keys).union(["observedAt"])) else { throw Failure.invalid }
        for (name, limit) in limits where context[name] != nil { try label(context[name], limit: limit) }
        let issued = try integer(p["issuedAt"])
        let expires = try integer(p["expiresAt"])
        guard expires > issued, expires - issued <= 120_000,
              try integer(context["observedAt"]) <= issued else { throw Failure.invalid }
        if p["durationMs"] != nil { _ = try integer(p["durationMs"]) }
        if p["exitCode"] != nil { _ = try integer(p["exitCode"], nonnegative: false) }
    }
}
