import Foundation
import XCTest

@testable import ShellbellCore

@MainActor private final class ControllerAssertions: IdleAssertionAdapterProtocol {
  var active: Set<UInt32> = []
  var rejectRelease = false
  var rejectAcquire: IdleAssertionKind?
  func isActive(_ id: UInt32, kind: IdleAssertionKind) throws -> Bool { active.contains(id) }
  func acquire(_ kind: IdleAssertionKind) throws -> UInt32 {
    if kind == rejectAcquire { throw PowerClientFailure.unavailable }
    let id: UInt32 = kind == .system ? 1 : 2
    active.insert(id)
    return id
  }
  func release(_ id: UInt32) throws {
    if rejectRelease { throw PowerClientFailure.unavailable }
    active.remove(id)
  }
}

@MainActor private final class ControllerHelper: PowerHelperConnection {
  var requests: [(PowerVerb, UUID?)] = []
  var pending: ((Result<PowerReply, PowerClientFailure>) -> Void)?
  var closed = false
  func request(
    _ verb: PowerVerb, leaseID: UUID?,
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void
  ) {
    XCTAssertNil(pending)
    requests.append((verb, leaseID))
    pending = completion
  }
  func close() { closed = true }
  func finish(state: PowerRemoteState, lease: UUID? = nil, ok: Bool = true, error: String? = nil) {
    let completion = pending
    pending = nil
    completion?(
      .success(
        PowerReply(
          v: 1, requestID: UInt64(requests.count), ok: ok,
          state: state, leaseID: lease, error: ok ? nil : (error ?? "recoveryRequired"))))
  }
}

@MainActor private final class PowerControllerFixture {
  var time: TimeInterval = 0
  var refreshes = 0
  var available = true
  var eligibility = PowerEligibility(
    power: .ac, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
  let assertions = ControllerAssertions()
  var helper = ControllerHelper()
  var systemOverride: Bool? = true
  var observationAt: TimeInterval?
  func controller(lid: Bool = true) -> PowerController {
    PowerController(
      preferences: .init(keepAwake: true, allowDisplaySleep: true, allowLidSleep: !lid),
      assertions: PowerAssertionController(adapter: assertions),
      helperAvailable: { self.available }, helperFactory: { self.helper },
      eligibility: { self.eligibility },
      observation: {
        .init(snapshot: .init(sleepDisabled: self.systemOverride,
          otherIdleSleepRequests: false, otherDisplaySleepRequests: false),
          capturedAt: self.observationAt ?? self.time)
      }, refreshService: { self.refreshes += 1 },
      now: { self.time }
    )
  }
}

final class PowerControllerTests: XCTestCase {
    @MainActor func testInactiveClosedLidHoldDoesNotPauseOrdinaryKeepAwakeOrFreshLaunch() {
        for enabled in [false, true] {
            let f = PowerControllerFixture()
            let controller = f.controller()
            controller.tick()
            f.helper.finish(state: .maintenance)
            controller.setPreferences(.init(keepAwake: enabled))
            XCTAssertEqual(controller.status, enabled ? .active : .off)
            XCTAssertEqual(controller.closedLidStatus, .off)
            XCTAssertFalse(controller.lidActive)
            XCTAssertEqual(f.helper.requests.map(\.0), [.status])
        }
    }
  @MainActor func testLateInterruptionAcknowledgesOffButPreservesPauseThroughQuit() {
    for action in 0..<3 {
      let f = PowerControllerFixture()
      let controller = f.controller()
      controller.tick()
      f.helper.finish(state: .idle)
      f.helper.finish(state: .active, lease: UUID())
      f.time = 5
      controller.tick()
      var preferences = controller.preferences
      if action == 0 { preferences.allowLidSleep = true }
      if action == 1 { preferences.keepAwake = false }
      if action < 2 { controller.setPreferences(preferences) }
      var quit: Bool?
      if action == 2 { controller.prepareToQuit { quit = $0 } }
      f.helper.finish(state: .idle, ok: false, error: "interrupted")
      XCTAssertEqual(controller.closedLidInterrupted, action == 2)
      XCTAssertEqual(controller.closedLidStatus, .off)
      if action == 2 {
        XCTAssertEqual(quit, true)
        controller.resume()
        XCTAssertEqual(controller.closedLidStatus, .interrupted)
        XCTAssertNil(f.helper.pending)
      }
    }
  }

  @MainActor func testFailedDisplayReleaseReportsKnownActivityAndTheFailedChange() {
    let f = PowerControllerFixture()
    let controller = f.controller(lid: false)
    var preferences = controller.preferences
    preferences.allowDisplaySleep = false
    controller.setPreferences(preferences)
    f.assertions.rejectRelease = true
    preferences.allowDisplaySleep = true
    controller.setPreferences(preferences)
    XCTAssertEqual(controller.status, .recoveryRequired)
    XCTAssertEqual(controller.idleSystemHealth, .active)
    XCTAssertTrue(controller.idleDisplayActive)
    XCTAssertNotEqual(controller.idleDisplayHealth, .active)
    XCTAssertEqual(controller.idleDisplayHealth, .activeWithFailure)
  }

  @MainActor func testControlHealthSeparatesIdleDisplayAndLidFailures() {
    let f = PowerControllerFixture()
    f.available = false
    let controller = f.controller()
    controller.tick()
    XCTAssertEqual(controller.idleSystemHealth, .active)
    XCTAssertEqual(controller.idleDisplayHealth, .off)
    XCTAssertEqual(controller.closedLidStatus, .setupRequired)
    f.assertions.rejectAcquire = .display
    var preferences = controller.preferences
    preferences.allowDisplaySleep = false
    controller.setPreferences(preferences)
    XCTAssertEqual(controller.status, .recoveryRequired)
    XCTAssertEqual(controller.idleSystemHealth, .active)
    XCTAssertEqual(controller.idleDisplayHealth, .unverified)
    XCTAssertEqual(controller.closedLidStatus, .setupRequired)
    preferences.allowLidSleep = true
    controller.setPreferences(preferences)
    XCTAssertEqual(controller.closedLidStatus, .off)
    XCTAssertEqual(controller.idleDisplayHealth, .unverified)
  }

  @MainActor func testBatteryIdleHealthIsIndependentOfPausedClosedLidAccess() {
    let f = PowerControllerFixture()
    f.eligibility = .init(power: .battery, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    let controller = f.controller()
    var preferences = controller.preferences
    preferences.keepAwakeOnBattery = true
    controller.setPreferences(preferences)
    XCTAssertEqual(controller.status, .active)
    XCTAssertEqual(controller.idleSystemHealth, .active)
    XCTAssertEqual(controller.closedLidStatus, .waitingForPower)
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(f.helper.requests.isEmpty)
  }

  @MainActor func testLidClaimRequiresFreshIndependentSystemReadback() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertTrue(controller.lidActive)
    f.systemOverride = false
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(controller.idleSystemActive)
    f.systemOverride = nil
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    f.systemOverride = true
    controller.tick()
    XCTAssertTrue(controller.lidActive)
    f.observationAt = 0
    f.time = 6
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(controller.idleSystemActive)
  }

  @MainActor func testExternalDisablePausesLidAcquisitionUntilExplicitRetry() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    f.time = 5
    controller.tick()
    f.helper.finish(state: .idle, ok: false, error: "interrupted")
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(controller.idleSystemActive)
    f.time = 20
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire, .renew])
    XCTAssertEqual(controller.status, .interrupted)
    XCTAssertTrue(controller.closedLidInterrupted)
    var preferences = controller.preferences
    preferences.allowDisplaySleep = false
    controller.setPreferences(preferences)
    controller.resume()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire, .renew])
    let old = f.helper
    f.helper = ControllerHelper()
    controller.retryClosedLid()
    XCTAssertTrue(old.closed)
    XCTAssertEqual(f.helper.requests.last?.0, .status)
    f.helper.finish(state: .idle)
    XCTAssertEqual(f.helper.requests.last?.0, .acquire)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertTrue(controller.lidActive)
    XCTAssertFalse(controller.closedLidInterrupted)
  }

  @MainActor func testFailedCleanupResumesSavedIntentAfterVerifiedRecovery() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    let lostReply = f.helper.pending
    f.helper.pending = nil
    lostReply?(.failure(.deliveryUnknown))
    XCTAssertEqual(result, false)
    XCTAssertEqual(controller.status, .recoveryRequired)
    f.helper = ControllerHelper()
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status])
    XCTAssertFalse(controller.lidActive)
    f.helper.finish(state: .idle)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire])
    XCTAssertTrue(controller.idleSystemActive)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertEqual(controller.status, .active)
    XCTAssertTrue(controller.lidActive)
    XCTAssertEqual(result, false)
  }

  @MainActor func testConflictAfterLeaseRestorationDoesNotReleaseAnExternalOverride() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.helper.requests.last?.0, .renew)
    // The helper restored its own lease, then observed another controller.
    f.helper.finish(state: .conflict, ok: false, error: "ineligible")
    XCTAssertEqual(controller.status, .conflict)
    XCTAssertFalse(controller.lidActive)
    f.time = 6
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire, .renew])
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire, .renew])
  }

  @MainActor func testReenableDuringReleaseWaitsForANewVerifiedLease() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    let previous = UUID()
    f.helper.finish(state: .active, lease: previous)
    controller.setPreferences(.init(keepAwake: true, allowLidSleep: true))
    controller.setPreferences(.init(keepAwake: true, allowLidSleep: false))
    XCTAssertFalse(controller.lidActive)
    XCTAssertEqual(controller.status, .checking)
    f.helper.finish(state: .idle)
    XCTAssertEqual(f.helper.requests.last?.0, .acquire)
    XCTAssertFalse(controller.lidActive)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertTrue(controller.lidActive)
  }

  @MainActor func testRejectedAcquireWithVerifiedIdleDoesNotRequireRestoration() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .idle, ok: false, error: "ineligible")
    XCTAssertEqual(controller.status, .checking)
    XCTAssertFalse(controller.lidActive)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire])
  }

  @MainActor func testDisableWaitsForReadbackWithoutReportingFailure() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    controller.setPreferences(.init())
    XCTAssertEqual(controller.status, .restoring)
    XCTAssertFalse(controller.lidActive)
    XCTAssertFalse(controller.idleSystemActive)
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    f.helper.finish(state: .idle)
    XCTAssertEqual(controller.status, .off)
  }

  @MainActor func testMaintenanceReadbackIsVisibleNeverAutoClearedAndAllowsSafeQuit() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .maintenance)
    XCTAssertEqual(controller.status, .maintenance)
    XCTAssertFalse(controller.lidActive)
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .status])
    f.helper.finish(state: .maintenance)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertTrue(f.assertions.active.isEmpty)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .status])
  }

  @MainActor func testAnotherConnectionLeaseIsReportedAsConflictWithoutAdoption() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .active)
    XCTAssertEqual(controller.status, .conflict)
    XCTAssertFalse(controller.lidActive)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status])
  }

  @MainActor func testExplicitAcquireConflictDoesNotInventAnOwnedLease() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .conflict, ok: false, error: "conflict")
    XCTAssertEqual(controller.status, .conflict)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire])
  }

  @MainActor func testUnreadableHelperStatusDoesNotBecomeActiveOrCleanQuit() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .unavailable, ok: false)
    XCTAssertEqual(controller.status, .recoveryRequired)
    XCTAssertFalse(controller.lidActive)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    f.helper.finish(state: .unavailable, ok: false)
    XCTAssertEqual(result, false)
  }

  @MainActor func testLostAcquireReplyRequiresNewStatusBeforeAnyNewMutation() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    let old = f.helper
    let late = old.pending
    old.pending = nil
    late?(.failure(.deliveryUnknown))
    XCTAssertTrue(old.closed)
    XCTAssertFalse(controller.lidActive)
    XCTAssertEqual(controller.status, .recoveryRequired)
    f.helper = ControllerHelper()
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status])
    late?(
      .success(.init(v: 1, requestID: 2, ok: true, state: .active, leaseID: UUID(), error: nil)))
    XCTAssertFalse(controller.lidActive)
    f.helper.finish(state: .idle)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire])
  }

  @MainActor func testExternalConflictIsNeverReleasedAndOrdinaryFailureIsNotActive() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .conflict)
    XCTAssertEqual(controller.status, .conflict)
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertEqual(result, true)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status])
    let ordinary = f.controller(lid: false)
    f.assertions.rejectAcquire = .display
    ordinary.setPreferences(.init(keepAwake: true, allowDisplaySleep: false))
    XCTAssertEqual(ordinary.status, .recoveryRequired)
    XCTAssertEqual(f.assertions.active, [1])
  }

  @MainActor func testRevokedHelperApprovalImmediatelyReleasesExistingLease() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    f.available = false
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    f.helper.finish(state: .idle)
    XCTAssertEqual(controller.status, .setupRequired)
  }

  @MainActor func testTurningOffWhileAcquireIsPendingReleasesLateLease() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    controller.setPreferences(.init())
    let lease = UUID()
    f.helper.finish(state: .active, lease: lease)
    XCTAssertFalse(controller.lidActive)
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    f.helper.finish(state: .idle)
    XCTAssertEqual(controller.status, .off)
  }

  @MainActor func testQuitFailureFromOrdinaryAssertionCanBeRetriedWithoutHelper() {
    let f = PowerControllerFixture()
    let controller = f.controller(lid: false)
    controller.tick()
    f.assertions.rejectRelease = true
    var results: [Bool] = []
    controller.prepareToQuit { results.append($0) }
    XCTAssertEqual(results, [false])
    XCTAssertEqual(controller.status, .recoveryRequired)
    f.assertions.rejectRelease = false
    controller.prepareToQuit { results.append($0) }
    XCTAssertEqual(results, [false, true])
    XCTAssertTrue(f.helper.requests.isEmpty)
  }

  @MainActor func testRenewsWithoutWindowVisibilityOrPhoneConnection() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    XCTAssertEqual(f.helper.requests.map(\.0), [.status])
    XCTAssertFalse(controller.lidActive)
    f.helper.finish(state: .idle)
    XCTAssertEqual(f.helper.requests.map(\.0), [.status, .acquire])
    let lease = UUID()
    f.helper.finish(state: .active, lease: lease)
    XCTAssertTrue(controller.lidActive)
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.refreshes, 2)
    XCTAssertEqual(f.helper.requests.last?.0, .renew)
    XCTAssertEqual(f.helper.requests.last?.1, lease)
    XCTAssertEqual(f.assertions.active, [1])
  }

  @MainActor func testStaleServiceReleasesAndNeverShowsDesiredLidAsActive() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    f.eligibility = .init(
      power: .ac, desktopServiceVerified: true, statusFresh: false, isLaptop: true)
    controller.tick()
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(f.assertions.active.isEmpty)
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    f.helper.finish(state: .idle)
    XCTAssertEqual(controller.status, .waitingForService)
  }

  @MainActor func testMissingHelperKeepsOrdinaryProtectionWithoutClaimingLidProtection() {
    let f = PowerControllerFixture()
    f.available = false
    let controller = f.controller()
    controller.tick()
    XCTAssertEqual(f.assertions.active, [1])
    XCTAssertTrue(f.helper.requests.isEmpty)
    XCTAssertFalse(controller.lidActive)
    XCTAssertEqual(controller.status, .setupRequired)
  }

  @MainActor func testQuitWaitsForReleaseAndFailedRestorationStaysVisible() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.tick()
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    var result: Bool?
    controller.prepareToQuit { result = $0 }
    XCTAssertNil(result)
    XCTAssertTrue(f.assertions.active.isEmpty)
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    f.helper.finish(state: .recoveryRequired, ok: false)
    XCTAssertEqual(result, false)
    XCTAssertEqual(controller.status, .recoveryRequired)
    controller.prepareToQuit { result = $0 }
    f.helper.finish(state: .idle)
    XCTAssertEqual(result, true)
  }
  @MainActor func testBatteryChoiceSurvivesPowerTransitionsAndRequiresFreshRemoteAccess() {
    let f = PowerControllerFixture()
    let controller = f.controller(lid: false)
    controller.tick()
    controller.setPreferences(.init(keepAwake: true, keepAwakeOnBattery: true))
    f.eligibility = .init(
      power: .battery, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    controller.tick()
    XCTAssertEqual(controller.status, .active)
    XCTAssertTrue(controller.idleSystemActive)
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(f.helper.requests.isEmpty)
    controller.setPreferences(.init(keepAwake: true))
    XCTAssertEqual(controller.status, .waitingForPower)
    XCTAssertFalse(controller.idleSystemActive)
    controller.setPreferences(.init(keepAwake: true, keepAwakeOnBattery: true))
    f.eligibility = .init(
      power: .unknown, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    controller.tick()
    XCTAssertEqual(controller.status, .waitingForPower)
    XCTAssertFalse(controller.idleSystemActive)
    f.eligibility = .init(
      power: .battery, desktopServiceVerified: true, statusFresh: false, isLaptop: true)
    controller.tick()
    XCTAssertEqual(controller.status, .waitingForService)
    XCTAssertFalse(controller.idleSystemActive)
    f.eligibility = .init(
      power: .battery, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    controller.tick()
    XCTAssertEqual(controller.status, .active)
    XCTAssertTrue(controller.idleSystemActive)
    controller.setPreferences(.init(keepAwakeOnBattery: true))
    XCTAssertEqual(controller.status, .off)
    XCTAssertFalse(controller.idleSystemActive)
  }

  @MainActor func testUnpluggingWhileBatteryIdleIsAllowedReleasesLidLease() {
    let f = PowerControllerFixture()
    let controller = f.controller()
    controller.setPreferences(.init(
      keepAwake: true, keepAwakeOnBattery: true, allowLidSleep: false))
    f.helper.finish(state: .idle)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertTrue(controller.lidActive)
    f.eligibility = .init(
      power: .battery, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    controller.tick()
    XCTAssertEqual(f.helper.requests.last?.0, .release)
    XCTAssertFalse(controller.lidActive)
    XCTAssertTrue(controller.idleSystemActive)
    XCTAssertEqual(controller.status, .restoring)
    f.helper.finish(state: .idle)
    XCTAssertEqual(controller.status, .active)
    XCTAssertTrue(controller.idleSystemActive)
    XCTAssertFalse(controller.lidActive)
    f.eligibility = .init(
      power: .ac, desktopServiceVerified: true, statusFresh: true, isLaptop: true)
    f.time = 5
    controller.tick()
    XCTAssertEqual(f.helper.requests.last?.0, .acquire)
    XCTAssertFalse(controller.lidActive)
    f.helper.finish(state: .active, lease: UUID())
    XCTAssertTrue(controller.lidActive)
  }

}
