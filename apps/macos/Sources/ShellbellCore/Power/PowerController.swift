import Combine
import Foundation

public enum PowerStatus: Equatable {
  case off, waitingForPower, waitingForService, checking, active, restoring
  case setupRequired, helperUnavailable, conflict, recoveryRequired, maintenance
}

/// Desktop power orchestration is deliberately independent of window visibility,
/// relay reachability and phone count. The native driver ticks it continuously.
@MainActor public final class PowerController: ObservableObject {
  @Published public private(set) var preferences: PowerPreferences
  @Published public private(set) var status = PowerStatus.off
  @Published public private(set) var lidActive = false
  @Published public private(set) var idleSystemActive = false
  @Published public private(set) var idleDisplayActive = false
  @Published public private(set) var preferenceError: String?
  @Published public private(set) var isLaptop = false
  @Published public private(set) var powerSource: ExternalPower = .unknown
  private let assertions: PowerAssertionController
  private let helperAvailable: () -> Bool
  private let helperFactory: () throws -> any PowerHelperConnection
  private let eligibility: () -> PowerEligibility
  private let refreshService: () -> Void
  private let now: () -> TimeInterval
  private let save: (PowerPreferences) throws -> Void
  private var helper: (any PowerHelperConnection)?
  private var helperState: PowerRemoteState?
  private var lease: UUID?
  private var leaseUntil: TimeInterval = 0
  private var renewAt: TimeInterval = 0
  private var nextRefresh: TimeInterval = 0
  private var nextAttempt: TimeInterval = 0
  private var generation: UInt64 = 0
  private var pending: PowerVerb?
  private var needsRecovery = false
  private var restoring = false
  private var connectionFailed = false
  private var stopping = false
  private var quitCompletions: [(Bool) -> Void] = []

  public init(
    preferences: PowerPreferences, assertions: PowerAssertionController,
    helperAvailable: @escaping () -> Bool,
    helperFactory: @escaping () throws -> any PowerHelperConnection,
    eligibility: @escaping () -> PowerEligibility, refreshService: @escaping () -> Void,
    now: @escaping () -> TimeInterval, save: @escaping (PowerPreferences) throws -> Void
  ) {
    self.preferences = preferences
    self.assertions = assertions
    self.helperAvailable = helperAvailable
    self.helperFactory = helperFactory
    self.eligibility = eligibility
    self.refreshService = refreshService
    self.now = now
    self.save = save
  }

  @discardableResult public func setPreferences(_ value: PowerPreferences) -> Bool {
    do { try save(value) } catch {
      preferenceError = "Could not save power settings. Your previous settings are still in use."
      return false
    }
    preferenceError = nil
    if preferences != value { preferences = value }
    nextAttempt = 0
    tick()
    return true
  }

  public func tick() {
    if preferences.keepAwake && !stopping && now() >= nextRefresh {
      nextRefresh = now() + 5
      refreshService()
    }
    reconcile()
  }

  public func resume() {
    guard quitCompletions.isEmpty else { return }
    stopping = false
    nextRefresh = 0
    nextAttempt = 0
    tick()
  }

  public func prepareToQuit(_ completion: @escaping (Bool) -> Void) {
    stopping = true
    quitCompletions.append(completion)
    nextAttempt = 0
    reconcile()
  }

  /// Use only after verified cleanup when replacing the desktop bridge.
  public func closeConnection() {
    dropHelper()
    updateStatus()
  }

  private var demand: PowerDemand {
    if stopping {
      return .init(preventIdleSystem: false, preventIdleDisplay: false, requestClosedLid: false)
    }
    return powerDemand(preferences, eligibility())
  }

  private func reconcile() {
    let laptop = eligibility().isLaptop
    if isLaptop != laptop { isLaptop = laptop }
    assertions.reconcile(demand)
    if idleSystemActive != assertions.systemActive { idleSystemActive = assertions.systemActive }
    if idleDisplayActive != assertions.displayActive {
      idleDisplayActive = assertions.displayActive
    }
    updateStatus()
    advance()
  }

  private func advance() {
    guard pending == nil else { return }
    let wanted = demand.requestClosedLid
    guard wanted || needsRecovery else {
      finishQuit()
      return
    }
    // Safety cleanup is never delayed by the normal polling/renewal backoff.
    // Try the existing authenticated connection even if approval was revoked.
    if let lease, helper != nil, !wanted || restoring || !helperAvailable() {
      perform(.release, leaseID: lease)
      return
    }
    guard helperAvailable() else {
      updateStatus()
      finishQuit()
      return
    }
    guard now() >= nextAttempt || !quitCompletions.isEmpty else {
      finishQuit()
      return
    }
    if helper == nil {
      do {
        helper = try helperFactory()
        helperState = nil
        connectionFailed = false
      } catch {
        connectionFailed = true
        nextAttempt = now() + 5
        updateStatus()
        finishQuit()
        return
      }
    }
    if let lease {
      if !wanted || restoring {
        perform(.release, leaseID: lease)
      } else if now() >= renewAt {
        perform(.renew, leaseID: lease)
      }
      return
    }
    if helperState == .idle && !needsRecovery && wanted {
      perform(.acquire)
    } else if helperState == .recoveryRequired {
      perform(.recover)
    } else {
      perform(.status)
    }
  }

  private func perform(_ verb: PowerVerb, leaseID: UUID? = nil) {
    guard let helper else { return }
    pending = verb
    if verb == .acquire { needsRecovery = true }
    let sent = now()
    let token = generation
    nextAttempt = sent + 5
    helper.request(verb, leaseID: leaseID) { [weak self] result in
      guard let self, self.generation == token else { return }
      self.pending = nil
      switch result {
      case .failure:
        self.dropHelper()
        self.connectionFailed = true
        self.restoring = self.needsRecovery
        self.updateStatus()
        self.finishQuit()
      case .success(let reply):
        self.connectionFailed = false
        self.helperState = reply.state
        if reply.ok, reply.state == .active, let id = reply.leaseID,
          verb == .acquire || verb == .renew
        {
          self.lease = id
          self.needsRecovery = true
          self.restoring = false
          self.leaseUntil = sent + 15
          self.renewAt = sent + 5
        } else if reply.state == .idle || (reply.state == .conflict && reply.leaseID == nil) {
          // No owned sleep override remains to recover. A conflict can
          // retain an inactive maintenance hold, but never grants authority
          // to release another controller's override.
          self.lease = nil
          self.needsRecovery = false
          self.restoring = false
        } else if reply.ok && reply.state == .maintenance {
          // Maintenance readback proves no override is active. It must remain
          // explicit to cancel, but does not prevent a clean ordinary Quit.
          self.lease = nil
          self.needsRecovery = false
          self.restoring = false
        } else if verb == .acquire && !reply.ok && reply.error == "conflict"
          && (reply.state == .conflict || (reply.state == .active && reply.leaseID == nil))
        {
          // The helper rejects acquire conflicts before mutation. This is not
          // permission to restore another connection's or application's setting.
          self.lease = nil
          self.needsRecovery = false
          self.restoring = false
        } else if self.needsRecovery || reply.state == .recoveryRequired
          || reply.state == .unavailable
        {
          self.needsRecovery = true
          self.restoring = true
        }
        self.updateStatus()
        // Continue only after positive verification, never loop/replay a failed
        // mutation. A late acquire response must be released if intent changed.
        if reply.ok && reply.state == .idle && self.demand.requestClosedLid {
          self.nextAttempt = 0
          self.advance()
        } else if reply.ok && self.lease != nil
          && (!self.demand.requestClosedLid || !self.helperAvailable())
        {
          self.nextAttempt = 0
          self.advance()
        } else {
          self.finishQuit()
        }
      }
    }
  }

  private func dropHelper() {
    generation += 1
    let old = helper
    helper = nil
    helperState = nil
    lease = nil
    pending = nil
    old?.close()
  }

  private func updateStatus() {
    let eligible = eligibility()
    if powerSource != eligible.power { powerSource = eligible.power }
    let requested = demand
    let verifiedLid =
      requested.requestClosedLid && helperAvailable() && lease != nil && !restoring
      && now() < leaseUntil && !connectionFailed && pending != .release
    if lidActive != verifiedLid { lidActive = verifiedLid }
    let next: PowerStatus
    if assertions.hasFailure || restoring {
      next = .recoveryRequired
    } else if needsRecovery && !requested.requestClosedLid {
      next = .restoring
    } else if helperState == .maintenance && !stopping {
      next = .maintenance
    } else if stopping || !preferences.keepAwake {
      next = .off
    } else if !idlePowerAllowed(preferences, eligible.power) {
      next = .waitingForPower
    } else if !eligible.desktopServiceVerified || !eligible.statusFresh {
      next = .waitingForService
    } else if requested.requestClosedLid && !helperAvailable() {
      next = .setupRequired
    } else if requested.requestClosedLid && connectionFailed {
      next = .helperUnavailable
    } else if requested.requestClosedLid
      && (helperState == .conflict || (helperState == .active && lease == nil))
    {
      next = .conflict
    } else if requested.requestClosedLid && !verifiedLid {
      next = .checking
    } else {
      next = .active
    }
    if status != next { status = next }
  }

  private func finishQuit() {
    guard pending == nil, !quitCompletions.isEmpty else { return }
    let success = !needsRecovery && !assertions.systemActive && !assertions.displayActive
    let completions = quitCompletions
    quitCompletions = []
    // Failed cleanup leaves the app running. Resume saved intent on the next
    // tick; outstanding restoration still takes precedence over acquisition.
    // Reconnect, recovery and unsuccessful Quit must not silently pause it.
    if !success { stopping = false }
    for completion in completions { completion(success) }
  }
}
