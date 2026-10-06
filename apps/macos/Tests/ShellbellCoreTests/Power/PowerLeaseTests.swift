import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

@MainActor private final class LeaseFixture: SleepOverrideAdapter, PowerJournalStore {
  var enabled = false
  var writes: [Bool] = []
  var journal: PowerJournal?
  var rejectPhase: PowerJournal.Phase?
  var rejectClear = false
  var rejectDisable = false
  var ignoreEnable = false
  var afterEnable: (() -> Void)?
  var reads = 0
  var afterRead: ((Int) -> Void)?
  var time: TimeInterval = 0
  var host = PowerLeaseHost(power: .ac, consoleUID: 501, competingController: false)
  enum Failure: Error { case injected }
  func readEnabled() throws -> Bool {
    reads += 1
    let result = enabled
    afterRead?(reads)
    return result
  }
  func setEnabled(_ value: Bool) throws {
    writes.append(value)
    if !value && rejectDisable { throw Failure.injected }
    if !value || !ignoreEnable { enabled = value }
    if value { afterEnable?() }
  }
  func read() throws -> PowerJournal? { journal }
  func publish(_ value: PowerJournal) throws {
    if rejectPhase == value.phase { throw Failure.injected }
    journal = value
  }
  func clear() throws {
    if rejectClear { throw Failure.injected }
    journal = nil
  }
  func engine() -> PowerLeaseEngine {
    PowerLeaseEngine(adapter: self, store: self, now: { self.time }, host: { self.host })
  }
}

@MainActor private final class LeaseAssertions: IdleAssertionAdapterProtocol {
  private var active: Set<UInt32> = []
  func acquire(_ kind: IdleAssertionKind) throws -> UInt32 {
    let id: UInt32 = kind == .system ? 1 : 2
    active.insert(id)
    return id
  }
  func release(_ id: UInt32) throws { active.remove(id) }
  func isActive(_ id: UInt32, kind: IdleAssertionKind) throws -> Bool { active.contains(id) }
}

@MainActor private final class SessionConnection: PowerHelperConnection {
  let session: PowerRequestSession
  private var nextID: UInt64 = 1
  init(engine: PowerLeaseEngine) {
    session = PowerRequestSession(peer: .init(uid: 501, connectionID: UUID()), engine: engine)
  }
  func request(
    _ verb: PowerVerb, leaseID: UUID?,
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void
  ) {
    let request = PowerRequest(requestID: nextID, verb: verb, leaseID: leaseID)
    nextID += 1
    do { completion(.success(try session.handle(JSONEncoder().encode(request)))) }
    catch { completion(.failure(.unavailable)) }
  }
  func close() { try? session.close() }
}

final class PowerLeaseTests: XCTestCase {
  @MainActor func testControllerRetriesAgainstRealSessionAfterExternalDisable() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let controller = PowerController(
      preferences: .init(keepAwake: true, allowLidSleep: false),
      assertions: PowerAssertionController(adapter: LeaseAssertions()),
      helperAvailable: { true }, helperFactory: { SessionConnection(engine: engine) },
      eligibility: { .init(power: .ac, desktopServiceVerified: true, statusFresh: true, isLaptop: true) },
      observation: {
        .init(snapshot: .init(sleepDisabled: f.enabled,
          otherIdleSleepRequests: false, otherDisplaySleepRequests: false), capturedAt: f.time)
      },
      refreshService: {}, now: { f.time }, save: { _ in })
    controller.tick()
    XCTAssertTrue(controller.lidActive)
    f.enabled = false
    try engine.tick()
    f.time = 5
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(controller.closedLidInterrupted)
    XCTAssertEqual(f.writes, [true])
    controller.retryClosedLid()
    XCTAssertTrue(controller.lidActive)
    XCTAssertFalse(controller.closedLidInterrupted)
    XCTAssertEqual(f.writes, [true, true])
    var quit: Bool?
    controller.prepareToQuit { quit = $0 }
    XCTAssertEqual(quit, true)
    XCTAssertEqual(f.writes, [true, true, false])
  }

  @MainActor func testExternalDisableDuringStatusOrRenewReturnsInterruptionWithoutAWrite() throws {
    for verb in [PowerVerb.status, .renew] {
      let f = LeaseFixture()
      let engine = f.engine()
      let session = PowerRequestSession(peer: owner, engine: engine)
      let acquired = try session.handle(JSONEncoder().encode(PowerRequest(requestID: 1, verb: .acquire)))
      f.enabled = false
      let reply = try session.handle(JSONEncoder().encode(PowerRequest(
        requestID: 2, verb: verb, leaseID: verb == .renew ? acquired.leaseID : nil)))
      XCTAssertFalse(reply.ok)
      XCTAssertEqual(reply.state, .idle)
      XCTAssertEqual(reply.error, "interrupted")
      XCTAssertEqual(f.writes, [true])
      XCTAssertNil(f.journal)
    }
  }

  @MainActor func testExternalDisableIsReportedAfterWatchdogRestoresOwnership() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let session = PowerRequestSession(peer: owner, engine: engine)
    let acquired = try session.handle(JSONEncoder().encode(PowerRequest(requestID: 1, verb: .acquire)))
    let id = try XCTUnwrap(acquired.leaseID)
    f.enabled = false // Effect of an external command, not a Shellbell write.
    try engine.tick()
    let reply = try session.handle(JSONEncoder().encode(
      PowerRequest(requestID: 2, verb: .renew, leaseID: id)))
    XCTAssertFalse(reply.ok)
    XCTAssertEqual(reply.state, .idle)
    XCTAssertEqual(reply.error, "interrupted")
    XCTAssertNil(f.journal)
    XCTAssertEqual(f.writes, [true])
    let other = PowerPeer(uid: owner.uid, connectionID: UUID())
    let otherSession = PowerRequestSession(peer: other, engine: engine)
    let otherReply = try otherSession.handle(JSONEncoder().encode(
      PowerRequest(requestID: 1, verb: .status)))
    XCTAssertTrue(otherReply.ok)
    XCTAssertNil(otherReply.error)
    let retried = try session.handle(JSONEncoder().encode(PowerRequest(requestID: 3, verb: .acquire)))
    XCTAssertTrue(retried.ok)
    XCTAssertEqual(retried.state, .active)
  }

  @MainActor func testMaintenanceWithExternalOverrideReportsConflictWithoutMutation() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let peer = PowerPeer(uid: 501, connectionID: UUID())
    _ = try engine.prepareRemoval(peer)
    f.enabled = true
    let session = PowerRequestSession(peer: peer, engine: engine)
    for (offset, verb) in [PowerVerb.status, .recover].enumerated() {
      let request = PowerRequest(requestID: UInt64(offset + 1), verb: verb)
      let reply = try session.handle(JSONEncoder().encode(request))
      XCTAssertTrue(reply.ok)
      XCTAssertEqual(reply.state, .conflict)
      XCTAssertNil(reply.leaseID)
      XCTAssertTrue(f.enabled)
      XCTAssertTrue(f.writes.isEmpty)
      XCTAssertEqual(f.journal?.phase, .maintenance)
    }
  }

  @MainActor func testDetectedManagerReportsConflictBeforeAnyEnableAttempt() {
    let f = LeaseFixture()
    f.host = .init(power: .ac, consoleUID: 501, competingController: true)
    let engine = f.engine()
    let peer = PowerPeer(uid: 501, connectionID: UUID())
    XCTAssertEqual(engine.observation(for: peer).0, .conflict)
    XCTAssertTrue(f.writes.isEmpty)
    XCTAssertNil(f.journal)
  }

  @MainActor func testWatchdogReadbackCannotLeaveAnExpiredLeaseActive() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    _ = try engine.acquire(owner)
    f.time = 14
    f.afterRead = { _ in f.time = 16 }
    try engine.tick()
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testFinalAcquireReadbackRevalidatesHostAndDeadlineBeforeAcknowledgement() throws {
    for scenario in 0..<4 {
      let f = LeaseFixture()
      let session = PowerRequestSession(peer: owner, engine: f.engine())
      f.afterRead = { count in
        guard count == 3 else { return }  // final session observation, after acquire
        switch scenario {
        case 0: f.host = .init(power: .battery, consoleUID: 501, competingController: false)
        case 1: f.host = .init(power: .ac, consoleUID: 502, competingController: false)
        case 2: f.host = .init(power: .ac, consoleUID: 501, competingController: true)
        default: f.time = 16
        }
      }
      let reply = try session.handle(
        JSONEncoder().encode(
          PowerRequest(requestID: 1, verb: .acquire)))
      XCTAssertFalse(reply.ok, "scenario \(scenario)")
      XCTAssertNotEqual(reply.state, .active)
      XCTAssertFalse(f.enabled)
      XCTAssertNil(f.journal)
    }
  }

  @MainActor func testRenewReadbackCannotExtendAnAlreadyExpiredLease() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let lease = try engine.acquire(owner)
    f.time = 14
    f.afterRead = { _ in f.time = 16 }
    XCTAssertThrowsError(try engine.renew(lease, peer: owner))
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testRenewReadbackRechecksConsoleAndPower() throws {
    for power in [ExternalPower.battery, .unknown] {
      let f = LeaseFixture()
      let engine = f.engine()
      let lease = try engine.acquire(owner)
      f.afterRead = { _ in
        f.host = .init(power: power, consoleUID: 502, competingController: false)
      }
      XCTAssertThrowsError(try engine.renew(lease, peer: owner))
      XCTAssertFalse(f.enabled)
      XCTAssertNil(f.journal)
    }
  }

  @MainActor func testExplicitRemovalRequestHoldsUntilOwnerReleases() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let session = PowerRequestSession(peer: owner, engine: engine)
    let reply = try session.handle(
      Data(
        #"{"v":1,"requestID":1,"verb":"recover","holdForRemoval":true}"#.utf8))
    XCTAssertTrue(reply.ok)
    XCTAssertEqual(reply.state, .maintenance)
    let token = try XCTUnwrap(reply.leaseID)
    XCTAssertThrowsError(try engine.acquire(owner))
    let ordinaryRecovery = try session.handle(
      JSONEncoder().encode(PowerRequest(requestID: 2, verb: .recover)))
    XCTAssertEqual(ordinaryRecovery.state, .maintenance)
    let released = try session.handle(
      JSONEncoder().encode(PowerRequest(requestID: 3, verb: .release, leaseID: token)))
    XCTAssertTrue(released.ok)
    XCTAssertEqual(released.state, .idle)
    XCTAssertNil(f.journal)
    XCTAssertTrue(f.writes.isEmpty)
  }

  @MainActor func testMaintenanceHoldSurvivesDisconnectAndHelperRestartUntilExplicitRelease() throws
  {
    let f = LeaseFixture()
    let engine = f.engine()
    let other = PowerPeer(uid: owner.uid, connectionID: UUID())
    let lease = try engine.acquire(owner)
    XCTAssertThrowsError(try engine.prepareRemoval(owner))
    try engine.release(lease, peer: owner)
    _ = try engine.prepareRemoval(owner)
    XCTAssertFalse(f.enabled)
    XCTAssertThrowsError(try engine.acquire(other))
    XCTAssertThrowsError(try engine.acquire(owner))
    XCTAssertThrowsError(try engine.prepareRemoval(other))
    try engine.disconnected(other)
    XCTAssertThrowsError(try engine.acquire(other))
    try engine.disconnected(owner)
    XCTAssertThrowsError(try engine.acquire(other))
    let restarted = f.engine()
    try restarted.recover()
    XCTAssertEqual(f.journal?.phase, .maintenance)
    XCTAssertThrowsError(try restarted.acquire(other))
    let hold = try restarted.prepareRemoval(other)
    try restarted.release(hold, peer: other)
    XCTAssertNil(f.journal)
    XCTAssertNoThrow(try restarted.acquire(other))
  }

  @MainActor func testInactiveConsoleUserCannotHoldMaintenanceBarrier() throws {
    let f = LeaseFixture()
    XCTAssertThrowsError(try f.engine().prepareRemoval(.init(uid: 502, connectionID: UUID())))
    XCTAssertTrue(f.writes.isEmpty)
  }

  @MainActor func testMaintenanceDoesNotClearAnExternalOverrideOrLoseFailedJournal() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    f.rejectPhase = .maintenance
    XCTAssertThrowsError(try engine.prepareRemoval(owner))
    XCTAssertNil(f.journal)
    f.rejectPhase = nil
    let hold = try engine.prepareRemoval(owner)
    f.enabled = true
    XCTAssertThrowsError(try engine.release(hold, peer: owner))
    try engine.recover()
    XCTAssertTrue(f.enabled)
    XCTAssertTrue(f.writes.isEmpty)
    XCTAssertEqual(f.journal?.phase, .maintenance)
  }

  @MainActor func testHelperRuntimeRecoversBeforeServingAndRetriesFailedRestoration() throws {
    let f = LeaseFixture()
    f.enabled = true
    f.journal = PowerJournal(leaseID: UUID(), ownerUID: 501, phase: .applied)
    f.rejectDisable = true
    let events = ManualPowerEvents()
    let runtime = PowerHelperRuntime(engine: f.engine(), events: events)
    runtime.start()
    XCTAssertTrue(runtime.recoveryRequired)
    XCTAssertNotNil(f.journal)
    f.rejectDisable = false
    events.fire()
    XCTAssertFalse(runtime.recoveryRequired)
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
    try runtime.stop()
  }

  @MainActor func testHelperRuntimeExpiresWithoutClientTrafficAndStopsWithRestoration() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let events = ManualPowerEvents()
    let runtime = PowerHelperRuntime(engine: engine, events: events)
    runtime.start()
    _ = try engine.acquire(owner)
    f.time = 15
    events.fire()
    XCTAssertFalse(f.enabled)
    _ = try engine.acquire(owner)
    try runtime.stop()
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
    XCTAssertFalse(events.running)
  }

  @MainActor func testHelperListenerRefusesUnsignedTestHostBeforeOpeningService() {
    let f = LeaseFixture()
    XCTAssertThrowsError(try PowerHelperListener(engine: f.engine()))
    XCTAssertTrue(f.writes.isEmpty)
  }

  @MainActor func testExportedRequestBoundaryClosesLeaseOnMalformedTraffic() async throws {
    let f = LeaseFixture()
    let session = PowerRequestSession(peer: owner, engine: f.engine())
    let exported = PowerXPCExport(session: session, invalidate: {})
    let request = try JSONEncoder().encode(PowerRequest(requestID: 1, verb: .acquire))
    let response: Data = await withCheckedContinuation { c in
      exported.request(request) { c.resume(returning: $0) }
    }
    XCTAssertTrue(try JSONDecoder().decode(PowerReply.self, from: response).ok)
    XCTAssertTrue(f.enabled)
    let invalid: Data = await withCheckedContinuation { c in
      exported.request(Data("malformed".utf8)) { c.resume(returning: $0) }
    }
    XCTAssertTrue(invalid.isEmpty)
    XCTAssertFalse(f.enabled)
  }
  @MainActor func testRequestSessionsBindLeaseToConnectionAndRejectReplay() throws {
    let f = LeaseFixture()
    let engine = f.engine()
    let first = PowerRequestSession(peer: owner, engine: engine)
    let other = PowerRequestSession(
      peer: .init(uid: owner.uid, connectionID: UUID()), engine: engine)
    let acquired = try first.handle(
      JSONEncoder().encode(PowerRequest(requestID: 1, verb: .acquire)))
    XCTAssertTrue(acquired.ok)
    XCTAssertEqual(acquired.state, .active)
    let id = try XCTUnwrap(acquired.leaseID)
    let refused = try other.handle(
      JSONEncoder().encode(PowerRequest(requestID: 1, verb: .release, leaseID: id)))
    XCTAssertFalse(refused.ok)
    XCTAssertNil(refused.leaseID)
    XCTAssertTrue(f.enabled)
    XCTAssertThrowsError(
      try first.handle(JSONEncoder().encode(PowerRequest(requestID: 1, verb: .renew, leaseID: id))))
    XCTAssertFalse(f.enabled)  // invalid/replayed delivery closes its owning session
    XCTAssertThrowsError(
      try first.handle(JSONEncoder().encode(PowerRequest(requestID: 2, verb: .acquire))))
  }

  @MainActor func testFailedReleaseReportsRecoveryRatherThanActiveSuccess() throws {
    let f = LeaseFixture()
    let session = PowerRequestSession(peer: owner, engine: f.engine())
    let acquired = try session.handle(
      JSONEncoder().encode(PowerRequest(requestID: 1, verb: .acquire)))
    f.rejectDisable = true
    let reply = try session.handle(
      JSONEncoder().encode(PowerRequest(requestID: 2, verb: .release, leaseID: acquired.leaseID)))
    XCTAssertFalse(reply.ok)
    XCTAssertEqual(reply.state, .recoveryRequired)
    XCTAssertNotNil(f.journal)
    f.rejectDisable = false
    try session.close()
    XCTAssertFalse(f.enabled)
  }

  private let owner = PowerPeer(uid: 501, connectionID: UUID())

  @MainActor func testExternalOverrideOrCompetingControllerIsNeverAdopted() {
    let f = LeaseFixture()
    f.enabled = true
    XCTAssertThrowsError(try f.engine().acquire(owner))
    XCTAssertTrue(f.enabled)
    XCTAssertTrue(f.writes.isEmpty)
    XCTAssertNil(f.journal)
    f.enabled = false
    f.host = .init(power: .ac, consoleUID: 501, competingController: true)
    XCTAssertThrowsError(try f.engine().acquire(owner))
    XCTAssertTrue(f.writes.isEmpty)
  }

  @MainActor func testDurableIntentMustPrecedeAnyGlobalMutation() {
    let f = LeaseFixture()
    f.rejectPhase = .prepared
    XCTAssertThrowsError(try f.engine().acquire(owner))
    XCTAssertTrue(f.writes.isEmpty)
    XCTAssertNil(f.journal)
  }

  @MainActor func testMatchingLeaseRenewsButOtherConnectionsAndUsersCannot() throws {
    let f = LeaseFixture()
    let e = f.engine()
    let id = try e.acquire(owner)
    XCTAssertTrue(f.enabled)
    XCTAssertEqual(f.journal?.phase, .applied)
    f.time = 10
    XCTAssertThrowsError(try e.renew(id, peer: .init(uid: 501, connectionID: UUID())))
    XCTAssertThrowsError(try e.release(id, peer: .init(uid: 502, connectionID: owner.connectionID)))
    try e.renew(id, peer: owner)
    f.time = 15
    try e.tick()
    XCTAssertTrue(f.enabled)
    f.time = 25
    try e.tick()
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testExpiredLeaseCannotBeRenewedAndDisconnectRestores() throws {
    let f = LeaseFixture()
    let e = f.engine()
    let id = try e.acquire(owner)
    f.time = 15
    XCTAssertThrowsError(try e.renew(id, peer: owner))
    XCTAssertFalse(f.enabled)
    let next = try e.acquire(owner)
    XCTAssertNotEqual(id, next)
    try e.disconnected(owner)
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
    try e.release(next, peer: owner)  // idempotent, same completed lease owner only
  }

  @MainActor func testPowerAndConsoleChangesDuringApplyRestoreBeforeSuccess() {
    for host in [
      PowerLeaseHost(power: .battery, consoleUID: 501, competingController: false),
      .init(power: .unknown, consoleUID: 501, competingController: false),
      .init(power: .ac, consoleUID: 502, competingController: false),
    ] {
      let f = LeaseFixture()
      f.afterEnable = { f.host = host }
      XCTAssertThrowsError(try f.engine().acquire(owner))
      XCTAssertFalse(f.enabled)
      XCTAssertNil(f.journal)
      XCTAssertEqual(f.writes, [true, false])
    }
  }

  @MainActor func testPublicationAfterEffectFailureRestoresOrRetainsRecoveryEvidence() {
    let f = LeaseFixture()
    f.rejectPhase = .applied
    f.rejectDisable = true
    let e = f.engine()
    XCTAssertThrowsError(try e.acquire(owner))
    XCTAssertTrue(f.enabled)
    XCTAssertNotNil(f.journal)
    XCTAssertThrowsError(try e.acquire(owner))
    f.rejectDisable = false
    f.rejectPhase = nil
    XCTAssertNoThrow(try e.recover())
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testReadbackMismatchNeverAcknowledgesProtection() {
    let f = LeaseFixture()
    f.ignoreEnable = true
    XCTAssertThrowsError(try f.engine().acquire(owner))
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testReleaseFailureRetainsJournalAndRetryRestores() throws {
    let f = LeaseFixture()
    let e = f.engine()
    let id = try e.acquire(owner)
    f.rejectDisable = true
    XCTAssertThrowsError(try e.release(id, peer: owner))
    XCTAssertNotNil(f.journal)
    XCTAssertThrowsError(try e.renew(id, peer: owner))
    f.rejectDisable = false
    try e.release(id, peer: owner)
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }

  @MainActor func testEveryPersistedPhaseRecoversWithoutResumingLease() throws {
    for phase in [PowerJournal.Phase.prepared, .applied, .releasing, .recoveryRequired] {
      for enabled in [false, true] {
        let f = LeaseFixture()
        f.enabled = enabled
        f.journal = PowerJournal(leaseID: UUID(), ownerUID: 501, phase: phase)
        let e = f.engine()
        XCTAssertThrowsError(try e.acquire(owner))
        try e.recover()
        XCTAssertFalse(f.enabled)
        XCTAssertNil(f.journal)
        XCTAssertEqual(f.writes, enabled ? [false] : [])
      }
    }
  }

  @MainActor func testSameValueExternalWriteCannotBeDistinguishedDuringRelease() throws {
    let f = LeaseFixture()
    let e = f.engine()
    let id = try e.acquire(owner)
    f.enabled = true  // another controller's undetectable same-value write
    try e.release(id, peer: owner)
    XCTAssertFalse(f.enabled)  // documented original-value restoration, not reference counting
  }

  @MainActor func testTickReleasesWhenConsolePowerOrCompetitionChanges() throws {
    let f = LeaseFixture()
    let e = f.engine()
    _ = try e.acquire(owner)
    f.host = .init(power: .ac, consoleUID: nil, competingController: false)
    try e.tick()
    XCTAssertFalse(f.enabled)
    XCTAssertNil(f.journal)
  }
}
