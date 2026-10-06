public enum IdleAssertionKind: Equatable, Sendable { case system, display }

@MainActor public protocol IdleAssertionAdapterProtocol {
  func acquire(_ kind: IdleAssertionKind) throws -> UInt32
  func release(_ id: UInt32) throws
  func isActive(_ id: UInt32, kind: IdleAssertionKind) throws -> Bool
}

@MainActor public protocol PowerAssertionControlling {
  func reconcile(_ demand: PowerDemand)
  func releaseAll() -> Bool
}

@MainActor public final class PowerAssertionController: PowerAssertionControlling {
  private let adapter: any IdleAssertionAdapterProtocol
  private struct Assertion {
    var id: UInt32?
    var active = false
  }
  private var system = Assertion()
  private var display = Assertion()
  public var systemActive: Bool { system.active }
  public var displayActive: Bool { display.active }
  public var hasOwnedAssertions: Bool { system.id != nil || display.id != nil }
  public private(set) var hasFailure = false

  public init(adapter: any IdleAssertionAdapterProtocol) { self.adapter = adapter }
  public func reconcile(_ demand: PowerDemand) {
    hasFailure = false
    reconcile(.system, wanted: demand.preventIdleSystem, assertion: &system)
    reconcile(.display, wanted: demand.preventIdleDisplay, assertion: &display)
  }
  private func reconcile(_ kind: IdleAssertionKind, wanted: Bool, assertion: inout Assertion) {
    // Retain ownership after failed verification, but never retain an active claim.
    assertion.active = false
    do {
      if let owned = assertion.id {
        if wanted, (try? adapter.isActive(owned, kind: kind)) == true {
          assertion.active = true
          return
        }
        // A missing/unreadable assertion cannot prove protection. Release only
        // our exact handle before replacing it; failed release retains ownership.
        try adapter.release(owned)
        assertion.id = nil
      }
      if wanted {
        let owned = try adapter.acquire(kind)
        assertion.id = owned
        assertion.active = try adapter.isActive(owned, kind: kind)
        if !assertion.active { hasFailure = true }
      }
    } catch {
      hasFailure = true
      if let owned = assertion.id {
        assertion.active = (try? adapter.isActive(owned, kind: kind)) == true
      }
    }
  }
  public func releaseAll() -> Bool {
    reconcile(.init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false))
    return !hasOwnedAssertions
  }
}
