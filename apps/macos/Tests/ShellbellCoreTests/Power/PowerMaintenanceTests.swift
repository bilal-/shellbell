import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

@MainActor private final class MaintenanceService: PowerServiceRegistration {
  func checkLegacyInstallation() throws -> Bool { false }
  var status = PowerRegistrationStatus.enabled
  var onRemove: (() -> Void)?
  var pauseRemoval = false
  var removals = 0
  var failRemoval = false
  var pendingRemoval: CheckedContinuation<Void, Never>?
  func register() throws { status = .enabled }
  func unregister() async throws {
    removals += 1
    if failRemoval { throw PowerClientFailure.unavailable }
    onRemove?()
    if pauseRemoval {
      await withCheckedContinuation { pendingRemoval = $0 }
    }
    status = .notRegistered
  }
}

@MainActor private final class MaintenanceTransport: PowerClientTransport {
  var conflict = false
  var verbs: [PowerVerb] = []
  var onReply: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var closed = false
  func write(_ data: Data) throws {
    let request = try PowerRequest.decode(data, after: 0)
    verbs.append(request.verb)
    if conflict {
      onReply?(
        try JSONEncoder().encode(
          PowerReply(
            v: 1, requestID: request.requestID, ok: false, state: .conflict,
            leaseID: nil, error: "conflict")))
      return
    }
    onReply?(
      try JSONEncoder().encode(
        PowerReply(
          v: 1, requestID: request.requestID, ok: true,
          state: .maintenance, leaseID: UUID(), error: nil)))
  }
  func close() { closed = true }
}

final class PowerMaintenanceTests: XCTestCase {
  @MainActor
  func testRecoveryIsReachableWhileOnlyOrdinaryKeepAwakeIsActive() {
    let service = MaintenanceService()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in
        XCTFail("Availability must not change power intent")
        return
      },
      preparePower: { _ in XCTFail("Availability must not stop power controls") },
      finishPower: {},
      makeClient: {
        XCTFail("Availability must not contact the helper")
        throw PowerClientFailure.unavailable
      })
    // Active ordinary assertions do not prove the helper has no maintenance hold.
    XCTAssertTrue(actions.offersRecovery(powerStatus: .active, lidActive: false))
    XCTAssertFalse(actions.offersRecovery(powerStatus: .active, lidActive: true))
  }

  @MainActor
  func testRecoveryIsReachableForRegisteredHelperWhenPowerControlsArePaused() {
    let service = MaintenanceService()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in
        XCTFail("Observing recovery availability must not change intent")
        return
      },
      preparePower: { _ in XCTFail("Observing recovery availability must not stop power controls")
      },
      finishPower: {},
      makeClient: {
        XCTFail("Observing recovery availability must not contact the helper")
        throw PowerClientFailure.unavailable
      })
    for status in [PowerStatus.off, .waitingForPower, .waitingForService] {
      XCTAssertTrue(actions.offersRecovery(powerStatus: status, lidActive: false))
    }
    XCTAssertFalse(actions.offersRecovery(powerStatus: .active, lidActive: true))
    service.status = .requiresApproval
    actions.refresh()
    for status in [PowerStatus.off, .waitingForPower, .waitingForService] {
      XCTAssertFalse(actions.offersRecovery(powerStatus: status, lidActive: false))
    }
  }

  @MainActor func testExternalSleepConflictGivesAnActionableMaintenanceError() async {
    for removing in [true, false] {
      let service = MaintenanceService()
      let transport = MaintenanceTransport()
      transport.conflict = true
      let actions = PowerMaintenanceActions(
        registration: PowerHelperRegistration(service: service),
        setClosedLidEnabled: { _ in }, preparePower: { $0(true) }, finishPower: {},
        makeClient: { PowerClient(transport: transport, clock: FixtureClock()) })
      if removing { await actions.remove() } else { await actions.cancelRemoval() }
      XCTAssertTrue(actions.error?.contains("sleep-management") == true)
      XCTAssertTrue(actions.error?.contains("system sleep override") == true)
      XCTAssertEqual(service.removals, 0)
      XCTAssertEqual(service.status, .enabled)
      XCTAssertEqual(transport.verbs, [.recover])
      XCTAssertTrue(transport.closed)
    }
  }

  @MainActor
  func testFailedUnregisterOffersRecoveryWithoutControllerMaintenanceStatus() async {
    let service = MaintenanceService()
    service.failRemoval = true
    let transport = MaintenanceTransport()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in }, preparePower: { $0(true) }, finishPower: {},
      makeClient: { PowerClient(transport: transport, clock: FixtureClock()) })
    XCTAssertFalse(actions.offersRecovery(powerStatus: .active, lidActive: true))
    XCTAssertTrue(actions.offersRecovery(powerStatus: .maintenance, lidActive: false))
    await actions.remove()
    XCTAssertNotNil(actions.error)
    XCTAssertTrue(actions.offersRecovery(powerStatus: .active, lidActive: false))
    XCTAssertTrue(transport.closed)
  }

  @MainActor
  func testUnregisteredOrUnavailableHelperDoesNotOfferOrAttemptRemoval() async {
    for status in [PowerRegistrationStatus.notRegistered, .notFound, .unavailable] {
      let service = MaintenanceService()
      service.status = status
      var changedPower = false
      let actions = PowerMaintenanceActions(
        registration: PowerHelperRegistration(service: service),
        setClosedLidEnabled: { _ in
          changedPower = true
          return
        },
        preparePower: { $0(true) }, finishPower: {},
        makeClient: {
          XCTFail("No helper should be contacted")
          throw PowerClientFailure.unavailable
        })
      XCTAssertFalse(actions.canRemoveHelper)
      await actions.remove()
      XCTAssertFalse(changedPower)
      XCTAssertEqual(service.status, status)
    }
  }

  @MainActor
  func testRegisteredHelperOffersRemovalAndRefreshUpdatesAvailability() {
    let service = MaintenanceService()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in }, preparePower: { $0(true) }, finishPower: {},
      makeClient: { throw PowerClientFailure.unavailable })
    XCTAssertTrue(actions.canRemoveHelper)
    service.status = .requiresApproval
    actions.refresh()
    XCTAssertTrue(actions.canRemoveHelper)
    service.status = .unavailable
    actions.refresh()
    XCTAssertFalse(actions.canRemoveHelper)
  }
  @MainActor func testPendingOSRemovalKeepsConnectionAndRejectsConcurrentRecovery() async {
    let service = MaintenanceService()
    service.pauseRemoval = true
    let transport = MaintenanceTransport()
    var connections = 0
    var resumes = 0
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in }, preparePower: { $0(true) },
      finishPower: { resumes += 1 },
      makeClient: {
        connections += 1
        return PowerClient(transport: transport, clock: FixtureClock())
      })
    let operation = Task { await actions.remove() }
    for _ in 0..<1000 {
      if service.pendingRemoval != nil { break }
      await Task.yield()
    }
    XCTAssertNotNil(service.pendingRemoval)
    XCTAssertTrue(actions.busy)
    XCTAssertFalse(transport.closed)
    await actions.cancelRemoval()
        let concurrentEnable = await actions.enableClosedLid()
        XCTAssertNil(concurrentEnable)
    XCTAssertEqual(connections, 1)
    XCTAssertEqual(resumes, 0)
    service.pauseRemoval = false
    service.pendingRemoval?.resume()
    service.pendingRemoval = nil
    await operation.value
    XCTAssertEqual(resumes, 1)
    XCTAssertFalse(actions.busy)
    XCTAssertTrue(transport.closed)
  }

  @MainActor func testRemovalDisablesIntentAndWaitsForPowerCleanupBeforeUnregister() async {
    let service = MaintenanceService()
    let transport = MaintenanceTransport()
    var events: [String] = []
    service.onRemove = {
      XCTAssertFalse(transport.closed)
      events.append("unregister")
    }
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { _ in
        events.append("disable")
        return
      },
      preparePower: {
        events.append("restore")
        $0(true)
      },
      finishPower: { events.append("resume") },
      makeClient: {
        events.append("connect")
        return PowerClient(transport: transport, clock: FixtureClock())
      })
    await actions.remove()
    XCTAssertEqual(events, ["disable", "restore", "connect", "unregister", "resume"])
    XCTAssertEqual(actions.registrationStatus, .notRegistered)
    XCTAssertNil(actions.error)
    XCTAssertFalse(actions.busy)
    XCTAssertTrue(transport.closed)
  }

  @MainActor func testFailedCleanupCannotConnectOrUnregister() async {
    let service = MaintenanceService()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      setClosedLidEnabled: { XCTAssertFalse($0) },
      preparePower: { $0(false) }, finishPower: {},
      makeClient: { XCTFail("Must not contact the helper before cleanup succeeds"); throw PowerClientFailure.unavailable })
    await actions.remove()
    XCTAssertEqual(service.status, .enabled)
    XCTAssertNotNil(actions.error)
    XCTAssertFalse(actions.busy)
  }
}
