import Foundation

public struct PowerPeer: Equatable, Sendable {
  public let uid: UInt32
  public let connectionID: UUID
  public init(uid: UInt32, connectionID: UUID) {
    self.uid = uid
    self.connectionID = connectionID
  }
}

public struct PowerLeaseHost: Sendable {
  public let power: ExternalPower
  public let consoleUID: UInt32?
  public let competingController: Bool
  public init(power: ExternalPower, consoleUID: UInt32?, competingController: Bool) {
    self.power = power
    self.consoleUID = consoleUID
    self.competingController = competingController
  }
}

public enum PowerLeaseFailure: String, Error, Sendable {
  case ineligible, conflict, recoveryRequired, unauthorized, expired, readback, invalidState, interrupted
}

/// Serialized on the main actor. Only the helper's authenticated transport creates peers.
/// Synchronous adapters must be bounded; the deadline is checked again after their effects.
@MainActor public final class PowerLeaseEngine {
  private struct Lease {
    let id: UUID
    let peer: PowerPeer
    var deadline: TimeInterval
  }
  private let adapter: any SleepOverrideAdapter
  private let store: any PowerJournalStore
  private let now: () -> TimeInterval
  private let host: () -> PowerLeaseHost
  private var lease: Lease?
  private var completed: Lease?
  private var interrupted: Lease?
  private var maintenance: (id: UUID, peer: PowerPeer)?
  private var restoring = false

  public init(
    adapter: any SleepOverrideAdapter, store: any PowerJournalStore,
    now: @escaping () -> TimeInterval, host: @escaping () -> PowerLeaseHost
  ) {
    self.adapter = adapter
    self.store = store
    self.now = now
    self.host = host
  }

  private func eligible(_ peer: PowerPeer) -> Bool {
    let observed = host()
    return peer.uid > 0 && observed.power == .ac && observed.consoleUID == peer.uid
      && !observed.competingController
  }

  private func timestamp() throws -> TimeInterval {
    let value = now()
    guard value.isFinite && value >= 0 else { throw PowerLeaseFailure.invalidState }
    return value
  }

  public func acquire(_ peer: PowerPeer) throws -> UUID {
    guard lease == nil else { throw PowerLeaseFailure.conflict }
    guard try store.read() == nil else { throw PowerLeaseFailure.recoveryRequired }
    guard eligible(peer) else { throw PowerLeaseFailure.ineligible }
    guard try !adapter.readEnabled() else { throw PowerLeaseFailure.conflict }
    let deadline = try timestamp() + 15
    let id = UUID()
    var journal = PowerJournal(leaseID: id, ownerUID: peer.uid, phase: .prepared)
    try store.publish(journal)
    do {
      guard eligible(peer) else { throw PowerLeaseFailure.ineligible }
      try adapter.setEnabled(true)
      guard try adapter.readEnabled() else { throw PowerLeaseFailure.readback }
      guard eligible(peer), try timestamp() < deadline else { throw PowerLeaseFailure.ineligible }
      journal.phase = .applied
      try store.publish(journal)
      guard eligible(peer), try timestamp() < deadline else { throw PowerLeaseFailure.ineligible }
      lease = Lease(id: id, peer: peer, deadline: deadline)
      restoring = false
      completed = nil
      interrupted = nil
      return id
    } catch {
      let original = error
      do { try restore() } catch { throw PowerLeaseFailure.recoveryRequired }
      throw original
    }
  }

  public func renew(_ id: UUID, peer: PowerPeer) throws {
    guard !restoring else { throw PowerLeaseFailure.recoveryRequired }
    if interrupted?.id == id, interrupted?.peer == peer { throw PowerLeaseFailure.interrupted }
    guard var active = lease, active.id == id, active.peer == peer else {
      throw PowerLeaseFailure.unauthorized
    }
    let time = try timestamp()
    guard time < active.deadline else {
      try restore()
      throw PowerLeaseFailure.expired
    }
    guard eligible(peer) else {
      try restore()
      throw PowerLeaseFailure.ineligible
    }
    guard try adapter.readEnabled() else {
      try interrupt(active)
      throw PowerLeaseFailure.interrupted
    }
    // Native readback can block. Recheck before extending the old deadline.
    guard eligible(peer) else {
      try restore()
      throw PowerLeaseFailure.ineligible
    }
    guard try timestamp() < active.deadline else {
      try restore()
      throw PowerLeaseFailure.expired
    }
    active.deadline = time + 15
    lease = active
  }

  public func release(_ id: UUID, peer: PowerPeer) throws {
    if let maintenance {
      guard maintenance.id == id, maintenance.peer == peer else {
        throw PowerLeaseFailure.unauthorized
      }
      guard let journal = try store.read(), journal.isValid, journal.phase == .maintenance,
        journal.leaseID == id, journal.ownerUID == peer.uid
      else { throw PowerLeaseFailure.recoveryRequired }
      // A maintenance hold never enabled the setting, so it has no authority to
      // clear an override another application enabled during maintenance.
      guard try !adapter.readEnabled() else { throw PowerLeaseFailure.conflict }
      try store.clear()
      self.maintenance = nil
      completed = Lease(id: id, peer: peer, deadline: 0)
      return
    }
    if lease == nil, completed?.id == id, completed?.peer == peer { return }
    guard let active = lease, active.id == id, active.peer == peer else {
      throw PowerLeaseFailure.unauthorized
    }
    try restore()
  }

  public func disconnected(_ peer: PowerPeer) throws {
    // Losing a caller must not reopen acquisition while its OS unregister may
    // still be running. The durable hold survives until explicit cancellation.
    if maintenance?.peer == peer { maintenance = nil }
    if lease?.peer == peer { try restore() }
  }

  /// Restores first, then durably freezes acquisition before managed removal.
  /// No sleep setting is enabled by this operation. An orphaned hold can only
  /// be adopted by a newly authenticated current-console caller.
  public func prepareRemoval(_ peer: PowerPeer) throws -> UUID {
    guard peer.uid > 0, host().consoleUID == peer.uid else { throw PowerLeaseFailure.unauthorized }
    guard lease == nil, maintenance == nil || maintenance?.peer == peer else {
      throw PowerLeaseFailure.conflict
    }
    try restore()
    let existing = try store.read()
    guard existing == nil || (existing?.isValid == true && existing?.phase == .maintenance)
    else { throw PowerLeaseFailure.recoveryRequired }
    guard try !adapter.readEnabled() else { throw PowerLeaseFailure.conflict }
    let id = existing?.leaseID ?? UUID()
    try store.publish(.init(leaseID: id, ownerUID: peer.uid, phase: .maintenance))
    guard host().consoleUID == peer.uid, try !adapter.readEnabled() else {
      throw PowerLeaseFailure.recoveryRequired
    }
    maintenance = (id, peer)
    completed = nil
    return id
  }

  public func observation(for peer: PowerPeer) -> (PowerRemoteState, UUID?) {
    do {
      let journal = try store.read()
      if let journal, journal.isValid, journal.phase == .maintenance {
        guard try !adapter.readEnabled() else { return (.conflict, nil) }
        return (.maintenance, maintenance?.peer == peer ? maintenance?.id : nil)
      }
      if restoring { return (.recoveryRequired, nil) }
      if let active = lease {
        guard let journal, journal.isValid, journal.phase == .applied,
          journal.leaseID == active.id, journal.ownerUID == active.peer.uid
        else { return (.recoveryRequired, nil) }
        guard try adapter.readEnabled() else {
          try interrupt(active)
          return (.idle, nil)
        }
        guard eligible(active.peer),
          try timestamp() < active.deadline
        else {
          try restore()
          return (.recoveryRequired, nil)
        }
        return (.active, active.peer == peer ? active.id : nil)
      }
      if journal != nil { return (.recoveryRequired, nil) }
      if try adapter.readEnabled() || host().competingController { return (.conflict, nil) }
      return (.idle, nil)
    } catch { return (.unavailable, nil) }
  }

  public func tick() throws {
    if restoring {
      try restore()
      return
    }
    guard let active = lease else {
      if try store.read() != nil { try restore() }
      return
    }
    guard eligible(active.peer), try timestamp() < active.deadline else {
      try restore()
      return
    }
    if try !adapter.readEnabled() {
      try interrupt(active)
    } else if try !eligible(active.peer) || timestamp() >= active.deadline {
      try restore()
    }
  }

  /// Boot/reconnect recovery never resumes a persisted lease.
  /// Local helper shutdown only; not exposed as an unauthenticated wire verb.
  public func shutdown() throws { try restore() }

  public func recover() throws {
    guard lease == nil else { throw PowerLeaseFailure.conflict }
    try restore()
  }

  public func wasInterrupted(for peer: PowerPeer) -> Bool { interrupted?.peer == peer }

  private func interrupt(_ active: Lease) throws {
    try restore()
    // Observe the effect without claiming to know which app or command caused it.
    // The result belongs only to the authenticated connection that held this lease.
    interrupted = active
  }

  private func restore() throws {
    restoring = true
    guard var journal = try store.read() else {
      // Missing durable ownership is not authority to modify a global setting.
      guard lease == nil else { throw PowerLeaseFailure.recoveryRequired }
      restoring = false
      return
    }
    guard journal.isValid else { throw PowerLeaseFailure.invalidState }
    if journal.phase == .maintenance {
      // Preserve a removal hold across crashes/reboots. It owns no OS override
      // and must never be interpreted as permission to write disablesleep=0.
      guard lease == nil else { throw PowerLeaseFailure.recoveryRequired }
      restoring = false
      return
    }
    do {
      journal.phase = .releasing
      try store.publish(journal)
      if try adapter.readEnabled() { try adapter.setEnabled(false) }
      guard try !adapter.readEnabled() else { throw PowerLeaseFailure.readback }
      try store.clear()
      completed = lease
      lease = nil
      restoring = false
    } catch {
      journal.phase = .recoveryRequired
      try? store.publish(journal)
      throw error
    }
  }
}
