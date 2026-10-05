import Foundation

public struct PowerJournal: Codable, Equatable, Sendable {
  public enum Phase: String, Codable, Sendable {
    case prepared, applied, releasing, recoveryRequired, maintenance
  }
  public let v: Int
  public let leaseID: UUID
  public let ownerUID: UInt32
  public var phase: Phase
  public let originalEnabled: Bool
  public let appliedEnabled: Bool

  public init(leaseID: UUID, ownerUID: UInt32, phase: Phase) {
    v = 1
    self.leaseID = leaseID
    self.ownerUID = ownerUID
    self.phase = phase
    originalEnabled = false
    appliedEnabled = phase != .maintenance
  }
  public var isValid: Bool { v == 1 && ownerUID > 0 && !originalEnabled && (phase == .maintenance ? !appliedEnabled : appliedEnabled) }
}

@MainActor public protocol PowerJournalStore {
  func read() throws -> PowerJournal?
  func publish(_ journal: PowerJournal) throws
  func clear() throws
}

@MainActor public protocol SleepOverrideAdapter {
  func readEnabled() throws -> Bool
  func setEnabled(_ enabled: Bool) throws
}
