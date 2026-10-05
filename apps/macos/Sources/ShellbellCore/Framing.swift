import Foundation

public enum BridgeFailure: String, Error, Sendable {
  case badRequest = "bad-request"
  case unsupportedVersion = "unsupported-version"
  case handshakeRequired = "handshake-required"
  case busy, unavailable, conflict
  case unsafeState = "unsafe-state"
  case invalidConfig = "invalid-config"
  case upgradeRequired = "upgrade-required"
  case startupUnavailable = "startup-unavailable"
  case deliveryUnknown = "delivery-unknown"
  case approvalRequired = "approval-required"
  case recoveryRequired = "recovery-required"
  case operationFailed = "operation-failed"
  case responseTooLarge = "response-too-large"
  case timeout
}

public struct LineFramer {
  public static let lineLimit = 65_536
  public static let queueLimit = 262_144
  private var bytes = Data()
  private var failed = false
  public init() {}
  public mutating func append(_ data: Data) throws -> [Data] {
    guard !failed, data.count <= Self.queueLimit else { throw BridgeFailure.badRequest }
    var lines: [Data] = []
    for byte in data {
      if byte == 10 {
        guard !bytes.isEmpty, String(data: bytes, encoding: .utf8) != nil else {
          failed = true
          throw BridgeFailure.badRequest
        }
        lines.append(bytes)
        bytes.removeAll(keepingCapacity: true)
      } else {
        guard bytes.count < Self.lineLimit else {
          failed = true
          throw BridgeFailure.responseTooLarge
        }
        bytes.append(byte)
      }
    }
    return lines
  }
  public mutating func finish() throws {
    guard !failed, bytes.isEmpty else { throw BridgeFailure.badRequest }
  }
}
