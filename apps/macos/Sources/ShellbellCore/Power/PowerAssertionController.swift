public enum IdleAssertionKind: Equatable, Sendable { case system, display }

@MainActor public protocol IdleAssertionAdapterProtocol {
  func acquire(_ kind: IdleAssertionKind) throws -> UInt32
  func release(_ id: UInt32) throws
}

@MainActor public protocol PowerAssertionControlling {
  func reconcile(_ demand: PowerDemand)
  func releaseAll() -> Bool
}

@MainActor public final class PowerAssertionController: PowerAssertionControlling {
  private let adapter: any IdleAssertionAdapterProtocol
  private var systemID: UInt32?
  private var displayID: UInt32?
  public var systemActive: Bool { systemID != nil }
  public var displayActive: Bool { displayID != nil }
  public private(set) var hasFailure = false

  public init(adapter: any IdleAssertionAdapterProtocol) { self.adapter = adapter }
  public func reconcile(_ demand: PowerDemand) {
    hasFailure = false
    reconcile(.system, wanted: demand.preventIdleSystem, id: &systemID)
    reconcile(.display, wanted: demand.preventIdleDisplay, id: &displayID)
  }
  private func reconcile(_ kind: IdleAssertionKind, wanted: Bool, id: inout UInt32?) {
    do {
      if wanted, id == nil { id = try adapter.acquire(kind) }
      if !wanted, let owned = id {
        try adapter.release(owned)
        id = nil
      }
    } catch { hasFailure = true }
  }
  public func releaseAll() -> Bool {
    reconcile(.init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false))
    return !systemActive && !displayActive
  }
}
