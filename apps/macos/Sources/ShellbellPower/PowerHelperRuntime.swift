import ShellbellCore

@MainActor public protocol PowerHelperEvents: AnyObject {
  func start(_ callback: @escaping @MainActor () -> Void)
  func stop()
}

/// Lifetime belongs to the helper, not a client connection. Failed recovery
/// keeps supervision running so a later tick can retry the durable journal.
@MainActor public final class PowerHelperRuntime {
  private let engine: PowerLeaseEngine
  private let events: any PowerHelperEvents
  private var started = false
  public private(set) var recoveryRequired = false

  public init(engine: PowerLeaseEngine, events: any PowerHelperEvents) {
    self.engine = engine
    self.events = events
  }

  public func start() {
    guard !started else { return }
    started = true
    do {
      try engine.recover()
      recoveryRequired = false
    } catch { recoveryRequired = true }
    events.start { [weak self] in self?.check() }
  }

  private func check() {
    guard started else { return }
    do {
      try engine.tick()
      recoveryRequired = false
    } catch { recoveryRequired = true }
  }

  public func stop() throws {
    // Do not discard the recovery timer if restoration failed.
    do {
      try engine.shutdown()
      recoveryRequired = false
    } catch {
      recoveryRequired = true
      throw error
    }
    events.stop()
    started = false
  }
}
