import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

@MainActor private final class MaintenanceService: PowerServiceRegistration {
  func checkLegacyInstallation() throws -> Bool { false }
  var status = PowerRegistrationStatus.enabled
  var onRemove: (() -> Void)?
  var pauseRemoval = false
  var failRemoval = false
  var pendingRemoval: CheckedContinuation<Void, Never>?
  func register() throws { status = .enabled }
  func unregister() async throws {
    if failRemoval { throw PowerClientFailure.unavailable }
    onRemove?()
    if pauseRemoval {
      await withCheckedContinuation { pendingRemoval = $0 }
    }
    status = .notRegistered
  }
}

@MainActor private final class MaintenanceTransport: PowerClientTransport {
  var onReply: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var closed = false
  func write(_ data: Data) throws {
    let request = try PowerRequest.decode(data, after: 0)
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
  func testFailedUnregisterOffersRecoveryWithoutControllerMaintenanceStatus() async {
    let service = MaintenanceService()
    service.failRemoval = true
    let transport = MaintenanceTransport()
    let actions = PowerMaintenanceActions(
      registration: PowerHelperRegistration(service: service),
      disableClosedLid: { true }, preparePower: { $0(true) }, finishPower: {},
      makeClient: { PowerClient(transport: transport, clock: FixtureClock()) })
    XCTAssertFalse(actions.offersRecovery(powerStatus: .active))
    XCTAssertTrue(actions.offersRecovery(powerStatus: .maintenance))
    await actions.remove()
    XCTAssertNotNil(actions.error)
    XCTAssertTrue(actions.offersRecovery(powerStatus: .active))
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
        disableClosedLid: {
          changedPower = true
          return true
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
      disableClosedLid: { true }, preparePower: { $0(true) }, finishPower: {},
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
      disableClosedLid: { true }, preparePower: { $0(true) },
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
      disableClosedLid: {
        events.append("disable")
        return true
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

  @MainActor func testFailedSaveOrCleanupCannotConnectOrUnregister() async {
    for saved in [false, true] {
      let service = MaintenanceService()
      let actions = PowerMaintenanceActions(
        registration: PowerHelperRegistration(service: service),
        disableClosedLid: { saved },
        preparePower: { $0(false) },
        finishPower: {},
        makeClient: {
          XCTFail("Must not contact helper")
          throw PowerClientFailure.unavailable
        })
      await actions.remove()
      XCTAssertEqual(service.status, .enabled)
      XCTAssertNotNil(actions.error)
      XCTAssertFalse(actions.busy)
    }
  }
}
