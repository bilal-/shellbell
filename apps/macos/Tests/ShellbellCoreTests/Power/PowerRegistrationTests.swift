import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

@MainActor
private final class RegistrationService: PowerServiceRegistration {
  var status = PowerRegistrationStatus.notRegistered
  var registrations = 0
  var removals = 0
  var ignoreRemoval = false
  var legacyPresent = false
  var legacyUnknown = false
  var registrationError: Error?
  var ignoreRegistration = false
  func checkLegacyInstallation() throws -> Bool {
    if legacyUnknown { throw PowerHelperRegistration.Failure.unavailable }
    return legacyPresent
  }
  func register() throws {
    registrations += 1
    if !ignoreRegistration { status = .requiresApproval }
    if let registrationError { throw registrationError }
  }
  func unregister() async throws {
    removals += 1
    if !ignoreRemoval { status = .notRegistered }
  }
}

@MainActor private final class RemovalTransport: PowerClientTransport {
  var onReply: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var closed = false
  var verbs: [PowerVerb] = []
  let token = UUID()
  var releaseVerified = true
  var releaseState = PowerRemoteState.idle
  let proof: Bool
  init(proof: Bool) { self.proof = proof }
  func write(_ data: Data) throws {
    let request = try PowerRequest.decode(data, after: 0)
    verbs.append(request.verb)
    if request.verb == .release {
      XCTAssertEqual(request.leaseID, token)
      XCTAssertNil(request.holdForRemoval)
      onReply?(
        try JSONEncoder().encode(
          PowerReply(
            v: 1, requestID: request.requestID, ok: releaseVerified,
            state: releaseVerified ? releaseState : .recoveryRequired,
            leaseID: nil, error: releaseVerified ? nil : "verificationFailed")))
      return
    }
    XCTAssertEqual(request.holdForRemoval, true)
    onReply?(
      try JSONEncoder().encode(
        PowerReply(
          v: 1, requestID: request.requestID, ok: true,
          state: proof ? .maintenance : .idle,
          leaseID: proof ? token : nil, error: nil)))
  }
  func close() { closed = true }
}

final class PowerRegistrationTests: XCTestCase {
  @MainActor func testClearedMaintenanceHoldMayReportAnExternalSleepConflict() async throws {
    let service = RegistrationService()
    service.status = .enabled
    let transport = RemovalTransport(proof: true)
    transport.releaseState = .conflict
    let registration = PowerHelperRegistration(service: service)
    try await registration.cancelRemoval(
      client: PowerClient(transport: transport, clock: FixtureClock()))
    XCTAssertEqual(transport.verbs, [.recover, .release])
    XCTAssertTrue(transport.closed)
    XCTAssertEqual(service.removals, 0)
    XCTAssertEqual(service.status, .enabled)
  }

  @MainActor func testNeverRegisteredServiceRequiresConsentAndCanEnterApproval() throws {
    let service = RegistrationService()
    service.status = .notFound
    let registration = PowerHelperRegistration(service: service)
    XCTAssertThrowsError(try registration.requestSetup(consented: false))
    XCTAssertEqual(service.registrations, 0)
    XCTAssertEqual(try registration.requestSetup(consented: true), .requiresApproval)
    XCTAssertEqual(service.registrations, 1)
  }

  @MainActor func testApprovalRequiredErrorIsAcceptedOnlyWithObservedPendingApproval() throws {
    let service = RegistrationService()
    service.status = .notFound
    service.registrationError = NSError(domain: "SMAppServiceErrorDomain", code: 1)
    let registration = PowerHelperRegistration(service: service)
    XCTAssertEqual(try registration.requestSetup(consented: true), .requiresApproval)

    service.status = .notFound
    service.ignoreRegistration = true
    XCTAssertThrowsError(try registration.requestSetup(consented: true))
    XCTAssertEqual(service.status, .notFound)
  }

  @MainActor func testUnobservedRegistrationNeverReportsSuccessfulSetup() throws {
    let service = RegistrationService()
    service.status = .notFound
    service.ignoreRegistration = true
    let registration = PowerHelperRegistration(service: service)
    XCTAssertThrowsError(try registration.requestSetup(consented: true))
    XCTAssertEqual(service.registrations, 1)
  }

  @MainActor func testUnavailableServiceDoesNotAttemptRegistration() throws {
    let service = RegistrationService()
    service.status = .unavailable
    let registration = PowerHelperRegistration(service: service)
    XCTAssertThrowsError(try registration.requestSetup(consented: true))
    XCTAssertEqual(service.registrations, 0)
  }

  @MainActor func testLegacyHelperPresenceAndUnknownStatusNeverRegisterNewHelper() throws {
    for unknown in [false, true] {
      let service = RegistrationService()
      service.legacyPresent = !unknown
      service.legacyUnknown = unknown
      let registration = PowerHelperRegistration(service: service)
      XCTAssertThrowsError(try registration.requestSetup(consented: true))
      XCTAssertEqual(service.registrations, 0)
    }
  }
  @MainActor func testExplicitCancellationReleasesOnlyVerifiedMaintenanceToken() async throws {
    for restored in [false, true] {
      let service = RegistrationService()
      service.status = .enabled
      let transport = RemovalTransport(proof: true)
      transport.releaseVerified = restored
      let registration = PowerHelperRegistration(service: service)
      do {
        try await registration.cancelRemoval(
          client: PowerClient(
            transport: transport, clock: FixtureClock()))
        XCTAssertTrue(restored)
      } catch {
        XCTAssertFalse(restored)
      }
      XCTAssertEqual(transport.verbs, [.recover, .release])
      XCTAssertTrue(transport.closed)
      XCTAssertEqual(service.removals, 0)
      XCTAssertEqual(service.status, .enabled)
    }
  }

  @MainActor func testManagedRemovalRequiresClientMaintenanceProofAndKeepsHold() async throws {
    for proof in [false, true] {
      let service = RegistrationService()
      service.status = .enabled
      let transport = RemovalTransport(proof: proof)
      let client = PowerClient(transport: transport, clock: FixtureClock())
      let registration = PowerHelperRegistration(service: service)
      do {
        try await registration.remove(client: client)
        XCTAssertTrue(proof)
      } catch {
        XCTAssertFalse(proof)
      }
      XCTAssertEqual(service.removals, proof ? 1 : 0)
      XCTAssertTrue(transport.closed)
      XCTAssertEqual(transport.verbs, [.recover])
    }
  }

  @MainActor func testSetupRequiresExplicitConsentAndDoesNotRepeatPendingApproval() throws {
    let service = RegistrationService()
    let registration = PowerHelperRegistration(service: service)
    XCTAssertThrowsError(try registration.requestSetup(consented: false))
    XCTAssertEqual(service.registrations, 0)
    XCTAssertEqual(try registration.requestSetup(consented: true), .requiresApproval)
    XCTAssertEqual(try registration.requestSetup(consented: true), .requiresApproval)
    XCTAssertEqual(service.registrations, 1)
  }

  @MainActor func testRemovalRequiresFreshRestorationAndChecksServiceStatus() async throws {
    let service = RegistrationService()
    service.status = .enabled
    let registration = PowerHelperRegistration(service: service)
    do {
      try await registration.remove(
        client: PowerClient(
          transport: RemovalTransport(proof: false), clock: FixtureClock()))
      XCTFail("Unverified restoration must prevent removal")
    } catch {}
    XCTAssertEqual(service.removals, 0)
    service.ignoreRemoval = true
    do {
      try await registration.remove(
        client: PowerClient(
          transport: RemovalTransport(proof: true), clock: FixtureClock()))
      XCTFail("OS success without status transition is not verified removal")
    } catch {}
    XCTAssertEqual(service.status, .enabled)
    service.ignoreRemoval = false
    try await registration.remove(
      client: PowerClient(
        transport: RemovalTransport(proof: true), clock: FixtureClock()))
    XCTAssertEqual(service.status, .notRegistered)
  }
}
